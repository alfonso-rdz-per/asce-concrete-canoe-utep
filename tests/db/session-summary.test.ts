/**
 * Migración 13 sobre Postgres real: `session_attendance_summary` = session_id, present_count, expected_count, rate.
 *
 * La población ESPERADA es la que ya alimenta el porcentaje individual: `session_attendance.counts_toward_rate` (sesión cerrada + dirigida al
 * grupo del miembro + pertenencia vigente en la fecha de la reunión, o asistencia real que nunca se descarta). Aquí solo se cuenta sobre esa marca.
 * NO se usa «miembros activos hoy»: una baja posterior no cambia el historial y quien se une después no aparece como ausente en reuniones anteriores.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import { attendancePercent } from "../../src/lib/attendance";
import { nonce, TestDb } from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const ROOT = path.resolve(import.meta.dirname, "../..");
const MIGRATION_13 = "20260919001200_session_summary_expected_rate.sql";
const TODAY = "(now() at time zone 'America/Denver')::date";

interface Summary {
  session_id: string;
  present_count: number;
  expected_count: number;
  rate: number | null;
}

let seq = 0;
const SUMMARY_SQL = "select session_id, present_count, expected_count, rate from public.session_attendance_summary";

async function summaryOf(db: TestDb, sessionId: string): Promise<Summary | undefined> {
  return (await db.query<Summary>(`${SUMMARY_SQL} where session_id = $1`, [sessionId])).rows[0];
}

/** Sesión del grupo indicado con los check-ins pedidos; termina CERRADA (o activa si `close` es false). */
async function session(db: TestDb, audience: "design_team" | "remar_construction", present: string[] = [], close = true): Promise<string> {
  const id = (await db.query<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ($1, now(), $2) returning id", [`Reunión ${++seq}`, audience])).rows[0].id;
  await db.query("update public.sessions set status = 'active' where id = $1", [id]);
  for (const m of present) await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, m, nonce(`sum${++seq}`)]);
  if (close) await db.closeSession(id);
  return id;
}

const override = (db: TestDb, sessionId: string, memberId: string, status: "present" | "absent") =>
  db.query("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, $3)", [sessionId, memberId, status]);

/**
 * La matriz de la Fase B. Miembros:
 *   G1, G2, G3  grupo general, activos, en el equipo desde hace 60 días
 *   D1, D2      Design Team, activos
 *   GI          general, INACTIVO desde hace 20 días (la reunión ocurrió después de su baja)
 *   GX          general, dado de baja HOY, después de las reuniones (su pertenencia sigue vigente en la fecha de cada una)
 *   GN          general, ACTIVO, pero se une después de las reuniones (joined_on futuro)
 */
async function buildMatrix(db: TestDb) {
  const set = async (id: string, sql: string, design = false) => db.query(`update public.members set is_design_team = $2, ${sql} where id = $1`, [id, design]);
  const [G1, G2, G3, D1, D2, GI, GX, GN] = await db.members(8);
  for (const g of [G1, G2, G3, GX]) await set(g, `joined_on = ${TODAY} - 60`);
  for (const d of [D1, D2]) await set(d, `joined_on = ${TODAY} - 60`, true);
  await set(GI, `joined_on = ${TODAY} - 60, active = false, deactivated_on = ${TODAY} - 20`);
  await set(GN, "joined_on = date '2999-01-01'");

  const S = {
    remarSinCheckins: await session(db, "remar_construction"),
    remarCasiTodos: await session(db, "remar_construction", [G1, G2, G3, GX]),
    remarConCorreccionOtroGrupo: await session(db, "remar_construction", [G1]),
    designSinCheckins: await session(db, "design_team"),
    designTodos: await session(db, "design_team", [D1, D2]),
    remarConDesignPresente: await session(db, "remar_construction", [G1, D1]),
    designConGeneralPresente: await session(db, "design_team", [D1, D2, G1]),
  };
  // El check-in exige miembro activo: la baja de GX ocurre DESPUÉS de las reuniones.
  await db.query(`update public.members set active = false, deactivated_on = ${TODAY} where id = $1`, [GX]);
  // Correcciones manuales (solo sesiones cerradas): G3 pasa de Present a Absent; D2 (otro grupo) figura Present en una reunión general.
  await override(db, S.remarCasiTodos, G3, "absent");
  await override(db, S.remarConCorreccionOtroGrupo, D2, "present");
  return { S, m: { G1, G2, G3, D1, D2, GI, GX, GN } };
}

describe("Migración 13: session_attendance_summary", () => {
  let db: TestDb;
  let matrix: Awaited<ReturnType<typeof buildMatrix>>;

  beforeAll(async () => {
    db = await TestDb.create();
    matrix = await buildMatrix(db);
  });
  afterAll(async () => {
    await db.destroy();
  });

  // ---------------------------------------------------------------------------
  describe("A. columnas", () => {
    it("tiene exactamente session_id, present_count, expected_count y rate, con esos tipos y en ese orden", async () => {
      const r = await db.query<{ attname: string; type: string }>(
        `select a.attname, format_type(a.atttypid, a.atttypmod) as type
           from pg_attribute a
          where a.attrelid = 'public.session_attendance_summary'::regclass and a.attnum > 0 and not a.attisdropped
          order by a.attnum`,
      );
      expect(r.rows).toEqual([
        { attname: "session_id", type: "uuid" },
        { attname: "present_count", type: "integer" },
        { attname: "expected_count", type: "integer" },
        { attname: "rate", type: "integer" },
      ]);
    });
  });

  // ---------------------------------------------------------------------------
  describe("B. seguridad", () => {
    it("security_invoker = true y SELECT solo para authenticated (sin grants a anon, service_role ni PUBLIC)", async () => {
      const r = await db.query<{ opts: string; acl: string }>("select reloptions::text as opts, relacl::text as acl from pg_class where oid = 'public.session_attendance_summary'::regclass");
      expect(r.rows[0].opts).toContain("security_invoker=true");
      expect(r.rows[0].acl).toContain("authenticated=r/"); // r = SELECT y nada más
      expect(r.rows[0].acl).not.toMatch(/anon=|service_role=|[{,]=/);

      const can = async (role: string, priv: string) => (await db.query<{ ok: boolean }>("select has_table_privilege($1, 'public.session_attendance_summary', $2) as ok", [role, priv])).rows[0].ok;
      expect(await can("authenticated", "SELECT")).toBe(true);
      for (const priv of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) expect(await can("authenticated", priv), priv).toBe(false);
      for (const role of ["anon", "service_role"]) for (const priv of ["SELECT", "INSERT", "UPDATE", "DELETE"]) expect(await can(role, priv), `${role} ${priv}`).toBe(false);
    });

    it("anon y service_role no leen nada (mismo comportamiento documentado que las otras vistas); un no administrador ve 0 filas; un administrador ve las sesiones", async () => {
      const asRole = (actor: Parameters<TestDb["as"]>[0]) => db.as(actor, (q) => q(SUMMARY_SQL));
      await expect(asRole({ role: "anon" })).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asRole({ role: "service_role" })).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      const outsiders = [await db.authUser({ confirmed: false }), await db.authUser({ anonymous: true, email: null }), await db.authUser({ deleted: true })];
      for (const sub of outsiders) expect((await asRole({ role: "authenticated", sub })).rowCount).toBe(0);
      const admin = await db.adminUser();
      expect((await asRole({ role: "authenticated", sub: admin })).rowCount).toBe(Object.keys(matrix.S).length);
    });

    it("las otras dos vistas mantienen sus permisos (solo authenticated) y NO hay ninguna función en public", async () => {
      for (const view of ["session_attendance", "member_attendance"]) {
        const r = await db.query<{ acl: string; opts: string }>("select relacl::text as acl, reloptions::text as opts from pg_class where oid = $1::regclass", [`public.${view}`]);
        expect(r.rows[0].opts, view).toContain("security_invoker=true");
        expect(r.rows[0].acl, view).toContain("authenticated=r/");
        expect(r.rows[0].acl, view).not.toMatch(/anon=|service_role=|[{,]=/);
      }
      const fns = await db.query("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'");
      expect(fns.rows).toEqual([]);
    });

    it("el archivo de la migración 13 solo crea/reemplaza esa vista: sin funciones, sin tocar otras vistas ni tablas, sin select *, sin repetir la lógica de pertenencia", () => {
      const code = fs
        .readFileSync(path.join(ROOT, "supabase/migrations", MIGRATION_13), "utf8")
        .split("\n")
        .filter((l) => !l.trim().startsWith("--"))
        .join("\n");
      expect(code.match(/create or replace view/gi)).toHaveLength(1);
      expect(code).toMatch(/create or replace view public\.session_attendance_summary with \(security_invoker = true\)/);
      expect(code).toMatch(/grant select on public\.session_attendance_summary to authenticated;/);
      expect(code).not.toMatch(/\bcreate view\b|\bdrop\b|\balter\b|\brevoke\b|create (or replace )?function|create (table|type|trigger|policy|index|unique)/i);
      expect(code).not.toMatch(/select\s+\*/i);
      expect(code).not.toMatch(/\banon\b|service_role/);
      // Fuente de verdad única: solo lee session_attendance y cuenta sobre counts_toward_rate.
      expect(code).toMatch(/from public\.session_attendance sa/);
      expect(code).toMatch(/counts_toward_rate/);
      expect(code).not.toMatch(/public\.(members|sessions|checkins|attendance_overrides|member_attendance)\b/);
      expect(code).not.toMatch(/joined_on|deactivated_on|opened_at|scheduled_at|audience|is_design_team|America\/Denver/);
    });
  });

  // ---------------------------------------------------------------------------
  describe("C. casos funcionales (la matriz de la Fase B)", () => {
    it("1. Remar sin check-ins: esperados 4, presentes 0, rate 0", async () => {
      expect(await summaryOf(db, matrix.S.remarSinCheckins)).toMatchObject({ expected_count: 4, present_count: 0, rate: 0 });
    });

    it("2. Remar casi todos (una corrección Present→Absent): esperados 4, presentes 3, rate 75", async () => {
      expect(await summaryOf(db, matrix.S.remarCasiTodos)).toMatchObject({ expected_count: 4, present_count: 3, rate: 75 });
    });

    it("3. la corrección a un miembro de OTRO grupo no infla present_count ni expected_count; los inactivos fuera de su pertenencia y quien se une después tampoco", async () => {
      const s = await summaryOf(db, matrix.S.remarConCorreccionOtroGrupo);
      expect(s).toMatchObject({ expected_count: 4, present_count: 1, rate: 25 }); // G1, G2, G3 y GX; solo G1 presente. D2 (Design, con Present manual) NO cuenta.
      // La fila cruda SÍ tiene a D2 presente: lo que cambia es que no cuenta para el porcentaje.
      const raw = await db.query<{ member_id: string; status: string; counts_toward_rate: boolean }>("select member_id, status, counts_toward_rate from public.session_attendance where session_id = $1", [matrix.S.remarConCorreccionOtroGrupo]);
      const by = new Map(raw.rows.map((r) => [r.member_id, r]));
      expect(by.get(matrix.m.D2)).toMatchObject({ status: "present", counts_toward_rate: false });
      expect(by.get(matrix.m.GI)).toMatchObject({ status: "absent", counts_toward_rate: false }); // inactivo desde antes de la reunión
      expect(by.get(matrix.m.GN)).toMatchObject({ status: "absent", counts_toward_rate: false }); // se une después de la reunión
      expect(raw.rows.filter((r) => r.status === "present")).toHaveLength(2); // el antiguo present_count habría dado 2
    });

    it("4. Design sin check-ins: esperados 2, presentes 0, rate 0", async () => {
      expect(await summaryOf(db, matrix.S.designSinCheckins)).toMatchObject({ expected_count: 2, present_count: 0, rate: 0 });
    });

    it("5. Design todos presentes: esperados 2, presentes 2, rate 100", async () => {
      expect(await summaryOf(db, matrix.S.designTodos)).toMatchObject({ expected_count: 2, present_count: 2, rate: 100 });
    });

    it("6. sesión Remar con un miembro Design presente: el miembro Design NO aumenta present_count", async () => {
      expect(await summaryOf(db, matrix.S.remarConDesignPresente)).toMatchObject({ expected_count: 4, present_count: 1, rate: 25 }); // solo G1
    });

    it("7. sesión Design con un miembro general presente: el miembro general NO aumenta present_count (antes daba 3 de 2 = 150 %)", async () => {
      expect(await summaryOf(db, matrix.S.designConGeneralPresente)).toMatchObject({ expected_count: 2, present_count: 2, rate: 100 });
    });

    it("una baja POSTERIOR no cambia el historial: GX (dado de baja hoy) sigue esperado en las reuniones donde pertenecía", async () => {
      const before = await summaryOf(db, matrix.S.remarCasiTodos);
      expect(before?.expected_count).toBe(4); // G1, G2, G3 y GX (GX asistió y hoy está inactivo)
      const c = new pg.Client({ host: "127.0.0.1", port: inject("pgPort"), user: "postgres", password: "postgres", database: db.name });
      await c.connect();
      try {
        await c.query("begin");
        await c.query(`update public.members set active = false, deactivated_on = ${TODAY} where id = any($1::uuid[])`, [[matrix.m.D1, matrix.m.D2]]);
        // Design Team completo dado de baja hoy: las reuniones de Design Team YA cerradas conservan su historial (con «activos hoy» quedarían en 0 esperados).
        const after = await c.query<Summary>(`${SUMMARY_SQL} where session_id = $1`, [matrix.S.designTodos]);
        expect(after.rows[0]).toMatchObject({ expected_count: 2, present_count: 2, rate: 100 });
        await c.query("rollback");
      } finally {
        await c.end();
      }
    });

    it("8. expected_count = 0: rate es NULL y nunca hay división por cero", async () => {
      const fresh = await TestDb.create();
      try {
        await fresh.member(); // existe al menos un miembro (si no hay ninguno, la sesión no tiene filas: ver F)
        const designSinMiembros = await session(fresh, "design_team"); // no hay nadie del Design Team
        expect(await summaryOf(fresh, designSinMiembros)).toEqual({ session_id: designSinMiembros, present_count: 0, expected_count: 0, rate: null });
        // También si hay miembros del grupo pero su pertenencia no cubre la fecha de la reunión (se unen en el futuro).
        const m = await fresh.member();
        await fresh.query("update public.members set is_design_team = true, joined_on = date '2999-01-01' where id = $1", [m]);
        const s2 = await session(fresh, "design_team");
        expect(await summaryOf(fresh, s2)).toEqual({ session_id: s2, present_count: 0, expected_count: 0, rate: null });
      } finally {
        await fresh.destroy();
      }
    });

    it("una presencia REAL fuera de la pertenencia del miembro SÍ cuenta (igual que en su porcentaje individual): nunca se descarta", async () => {
      const fresh = await TestDb.create();
      try {
        const [a, b] = await fresh.members(2);
        const gone = await fresh.member();
        await fresh.query(`update public.members set joined_on = ${TODAY} - 60, active = false, deactivated_on = ${TODAY} - 20 where id = $1`, [gone]);
        const s = await session(fresh, "remar_construction", [a]);
        await override(fresh, s, gone, "present"); // corrección manual: inactivo desde antes de la reunión
        void b;
        expect(await summaryOf(fresh, s)).toMatchObject({ expected_count: 3, present_count: 2, rate: 67 }); // a, b y gone; presentes a y gone
        const ind = await fresh.query<{ counted_meetings: number; attended_meetings: number }>("select counted_meetings, attended_meetings from public.member_attendance where member_id = $1", [gone]);
        expect(ind.rows[0]).toEqual({ counted_meetings: 1, attended_meetings: 1 }); // mismo criterio en member_attendance
      } finally {
        await fresh.destroy();
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("D. límites", () => {
    it("present_count <= expected_count y 0 <= rate <= 100 en todas las sesiones; ninguna llega al 150 %", async () => {
      const rows = (await db.query<Summary>(SUMMARY_SQL)).rows;
      expect(rows.length).toBe(Object.keys(matrix.S).length);
      for (const r of rows) {
        expect(r.present_count).toBeLessThanOrEqual(r.expected_count);
        expect(r.present_count).toBeGreaterThanOrEqual(0);
        if (r.expected_count === 0) expect(r.rate).toBeNull();
        else {
          expect(r.rate).not.toBeNull();
          expect(r.rate as number).toBeGreaterThanOrEqual(0);
          expect(r.rate as number).toBeLessThanOrEqual(100);
          expect(Number.isInteger(r.rate)).toBe(true);
        }
      }
      expect(Math.max(...rows.map((r) => r.rate ?? 0))).toBeLessThan(150);
    });
  });

  // ---------------------------------------------------------------------------
  describe("E. consistencia con member_attendance", () => {
    /**
     * Ambas vistas cuentan sobre la MISMA marca (counts_toward_rate), así que no hace falta ninguna condición extra: la suma sobre TODAS las sesiones
     * de expected_count es igual a la suma sobre TODOS los miembros de counted_meetings (member_attendance incluye también a los inactivos y a los que
     * se unen después: simplemente tienen 0 reuniones contadas).
     */
    const reconcile = async (d: TestDb) => {
      const s = (await d.query<{ e: number; p: number }>("select coalesce(sum(expected_count), 0)::int as e, coalesce(sum(present_count), 0)::int as p from public.session_attendance_summary")).rows[0];
      const m = (await d.query<{ c: number; a: number }>("select coalesce(sum(counted_meetings), 0)::int as c, coalesce(sum(attended_meetings), 0)::int as a from public.member_attendance")).rows[0];
      return { s, m };
    };

    it("Σ expected_count = Σ counted_meetings y Σ present_count = Σ attended_meetings (matriz)", async () => {
      const { s, m } = await reconcile(db);
      expect(s.e).toBe(m.c);
      expect(s.p).toBe(m.a);
      expect(s.e).toBeGreaterThan(0);
    });

    it("por sesión: coincide con contar counts_toward_rate (y presentes) en session_attendance", async () => {
      const raw = await db.query<{ session_id: string; e: number; p: number }>(
        `select session_id, (count(*) filter (where counts_toward_rate))::int as e, (count(*) filter (where counts_toward_rate and status = 'present'))::int as p
           from public.session_attendance group by session_id`,
      );
      for (const r of raw.rows) expect(await summaryOf(db, r.session_id)).toMatchObject({ expected_count: r.e, present_count: r.p });
    });

    it("escenarios aleatorios (semilla fija): invariantes de consistencia, límites y paridad del rate con la función de la aplicación", async () => {
      // PRNG determinista (mulberry32) para que un fallo sea reproducible.
      let state = 20260920;
      const rand = () => {
        state = (state + 0x6d2b79f5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
      for (let round = 0; round < 3; round++) {
        const d = await TestDb.create();
        try {
          const ids = await d.members(14);
          const futureJoiners = new Set<string>();
          for (const id of ids) {
            const design = rand() < 0.4;
            const future = rand() < 0.2;
            if (future) futureJoiners.add(id);
            await d.query(`update public.members set is_design_team = $2, joined_on = ${future ? "date '2999-01-01'" : `${TODAY} - 60`} where id = $1`, [id, design]);
          }
          const sessions: string[] = [];
          const present = new Map<string, Set<string>>();
          for (let i = 0; i < 10; i++) {
            const who = ids.filter(() => rand() < 0.5);
            const s = await session(d, rand() < 0.5 ? "design_team" : "remar_construction", who);
            sessions.push(s);
            present.set(s, new Set(who));
          }
          // Bajas posteriores (con y sin la fecha de la reunión dentro de su pertenencia).
          for (const id of ids.filter((m) => !futureJoiners.has(m) && rand() < 0.25)) {
            await d.query(`update public.members set active = false, deactivated_on = ${rand() < 0.5 ? TODAY : `${TODAY} - 10`} where id = $1`, [id]);
          }
          // Correcciones manuales: siempre al estado contrario del natural.
          for (const s of sessions) for (const m of ids) if (rand() < 0.15) await override(d, s, m, present.get(s)!.has(m) ? "absent" : "present");

          const rows = (await d.query<Summary>(SUMMARY_SQL)).rows;
          expect(rows.length).toBe(sessions.length);
          for (const r of rows) {
            expect(r.present_count).toBeLessThanOrEqual(r.expected_count);
            expect(r.rate).toBe(attendancePercent({ counted: r.expected_count, attended: r.present_count })); // null cuando expected = 0
          }
          const { s, m } = await (async () => {
            const a = (await d.query<{ e: number; p: number }>("select coalesce(sum(expected_count),0)::int as e, coalesce(sum(present_count),0)::int as p from public.session_attendance_summary")).rows[0];
            const b = (await d.query<{ c: number; a: number }>("select coalesce(sum(counted_meetings),0)::int as c, coalesce(sum(attended_meetings),0)::int as a from public.member_attendance")).rows[0];
            return { s: a, m: b };
          })();
          expect(s.e).toBe(m.c);
          expect(s.p).toBe(m.a);
        } finally {
          await d.destroy();
        }
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("F. sesiones no cerradas", () => {
    it("una sesión ACTIVA aparece con 0 esperados, 0 presentes y rate NULL aunque ya tenga check-ins; al cerrarla pasa a contar", async () => {
      const d = await TestDb.create();
      try {
        const [a, b, c] = await d.members(3);
        const s = await session(d, "remar_construction", [a, b], false); // ACTIVA con 2 check-ins
        expect(await summaryOf(d, s)).toEqual({ session_id: s, present_count: 0, expected_count: 0, rate: null });
        await d.closeSession(s);
        expect(await summaryOf(d, s)).toEqual({ session_id: s, present_count: 2, expected_count: 3, rate: 67 });
        void c;
      } finally {
        await d.destroy();
      }
    });

    it("un BORRADOR no tiene fila (como antes); una sesión cerrada sin ningún miembro en la base tampoco (sin filas que contar)", async () => {
      const d = await TestDb.create();
      try {
        const draft = (await d.query<{ id: string }>("insert into public.sessions (title, scheduled_at) values ('Borrador', now()) returning id")).rows[0].id;
        expect(await summaryOf(d, draft)).toBeUndefined();
        const sinMiembros = await session(d, "remar_construction");
        expect(await summaryOf(d, sinMiembros)).toBeUndefined(); // no hay miembros: session_attendance no tiene filas (el consumidor trata la ausencia como 0)
      } finally {
        await d.destroy();
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("G. redondeo idéntico al de la aplicación: Math.round(attended / counted * 100)", () => {
    /** Crea `expected` miembros del grupo general y una reunión cerrada a la que asisten `present` de ellos. */
    async function rounding(expected: number, present: number): Promise<Summary> {
      const d = await TestDb.create();
      try {
        const ids = (await d.query<{ id: string }>("insert into public.members (asce_id, name) select 'P' || lpad(g::text, 5, '0'), 'Miembro ' || g from generate_series(1, $1::int) g returning id", [expected])).rows.map((r) => r.id);
        const s = (await d.query<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ('Redondeo', now(), 'remar_construction') returning id")).rows[0].id;
        await d.query("update public.sessions set status = 'active' where id = $1", [s]);
        await d.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) select $1, m, 1, 'N' || lpad(o::text, 21, '0') from unnest($2::uuid[]) with ordinality as t(m, o)", [s, ids.slice(0, present)]);
        await d.closeSession(s);
        return (await summaryOf(d, s)) as Summary;
      } finally {
        await d.destroy();
      }
    }

    // [presentes, esperados]. 23/40 y 29/200 son los casos donde round(a * 100.0 / c) (numeric exacto) daría 58 y 15, y la aplicación 57 y 14.
    // 1/8, 3/8 y 5/8 son mitades exactas (12,5 / 37,5 / 62,5): las dos reglas redondean hacia arriba.
    it.each([
      [23, 40, 57],
      [29, 200, 14],
      [1, 8, 13],
      [3, 8, 38],
      [5, 8, 63],
      [1, 3, 33],
      [2, 3, 67],
      [7, 7, 100],
      [0, 5, 0],
    ])("%i presentes de %i esperados = %i %%", async (a, c, expected) => {
      const r = await rounding(c, a);
      expect(r).toMatchObject({ present_count: a, expected_count: c });
      expect(r.rate).toBe(expected);
      expect(r.rate).toBe(Math.round((a / c) * 100)); // exactamente la regla de la aplicación
      expect(r.rate).toBe(attendancePercent({ counted: c, attended: a })); // y su función real (src/lib/attendance.ts)
    });
  });
});

// -----------------------------------------------------------------------------
describe("Migración 13 aplicada sobre una base en el estado de la migración 12", () => {
  it("conserva grants, security_invoker y las otras dos vistas idénticas; cambia solo lo previsto en session_attendance_summary", async () => {
    const port = inject("pgPort");
    const name = `t_m13_${Math.random().toString(16).slice(2, 10)}`;
    const ctl = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" });
    await ctl.connect();
    await ctl.query(`create database ${name}`);
    await ctl.end();

    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: name });
    await c.connect();
    try {
      await c.query(fs.readFileSync(path.join(ROOT, "tests/db/supabase-shim.sql"), "utf8"));
      const dir = path.join(ROOT, "supabase/migrations");
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      expect(files).toContain(MIGRATION_13); // se aplica sola, encima del estado de la 12 (las migraciones posteriores no se cargan aquí)
      for (const f of files.filter((f) => f < MIGRATION_13)) await c.query(fs.readFileSync(path.join(dir, f), "utf8"));

      // Datos en el estado de la migración 12: una reunión general cerrada a la que asisten un miembro general y uno del Design Team.
      const general = (await c.query<{ id: string }>("insert into public.members (asce_id, name) values ('1234567', 'Ana') returning id")).rows[0].id;
      const design = (await c.query<{ id: string }>("insert into public.members (asce_id, name, is_design_team) values ('7654321', 'Bea', true) returning id")).rows[0].id;
      const sid = (await c.query<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ('General', now(), 'remar_construction') returning id")).rows[0].id;
      await c.query("update public.sessions set status = 'active' where id = $1", [sid]);
      for (const m of [general, design]) await c.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [sid, m, nonce(`up${m}`)]);
      await c.query("update public.sessions set status = 'closed' where id = $1", [sid]);

      const snapshot = async () =>
        (
          await c.query<{ acl: string; opts: string; sa: string; ma: string }>(
            `select relacl::text as acl, reloptions::text as opts,
                    pg_get_viewdef('public.session_attendance'::regclass) as sa, pg_get_viewdef('public.member_attendance'::regclass) as ma
               from pg_class where oid = 'public.session_attendance_summary'::regclass`,
          )
        ).rows[0];
      const cols = async () => (await c.query<{ attname: string }>("select a.attname from pg_attribute a where a.attrelid = 'public.session_attendance_summary'::regclass and a.attnum > 0 and not a.attisdropped order by a.attnum")).rows.map((r) => r.attname);

      const before = await snapshot();
      expect(await cols()).toEqual(["session_id", "present_count"]);
      expect((await c.query("select present_count from public.session_attendance_summary")).rows).toEqual([{ present_count: 2 }]); // semántica antigua: todos los presentes

      await c.query(fs.readFileSync(path.join(dir, MIGRATION_13), "utf8"));

      const after = await snapshot();
      expect(after.acl).toBe(before.acl); // grants idénticos
      expect(after.opts).toBe(before.opts); // security_invoker conservado
      expect(after.sa).toBe(before.sa); // session_attendance intacta
      expect(after.ma).toBe(before.ma); // member_attendance intacta
      expect(await cols()).toEqual(["session_id", "present_count", "expected_count", "rate"]);
      // Cambio intencional de semántica: el presente del Design Team en una reunión general ya no cuenta.
      expect((await c.query("select session_id, present_count, expected_count, rate from public.session_attendance_summary")).rows).toEqual([{ session_id: sid, present_count: 1, expected_count: 1, rate: 100 }]);
      // Datos intactos.
      expect((await c.query("select count(*)::int as n from public.checkins")).rows[0].n).toBe(2);
    } finally {
      await c.end();
      const drop = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" });
      await drop.connect();
      await drop.query(`drop database if exists ${name} with (force)`);
      await drop.end();
    }
  });
});
