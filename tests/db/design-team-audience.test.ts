/**
 * Migraciones 11, 12, 14 y 15 sobre Postgres real:
 *   - members.is_design_team (false por defecto, permisos por columna, RLS igual que el resto);
 *   - sessions.audience (enum de TRES valores: design_team, remar_construction y both) en lugar del booleano `required`;
 *   - los porcentajes cuentan las reuniones del GRUPO de cada miembro; una reunión "both" (los dos equipos) cuenta para TODOS;
 *   - conversión de los datos existentes (required true/false -> remar_construction) probada sobre una base con datos antiguos.
 */
import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, inject } from "vitest";
import { nonce, TestDb, type Query } from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const INVALID_ENUM = "22P02";
const ROOT = path.resolve(import.meta.dirname, "../..");

describe("Design Team y grupo de la sesión", () => {
  let db: TestDb;
  let seq = 0;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const asAdmin = async <T>(adminId: string, fn: (q: Query) => Promise<T>) => db.as({ role: "authenticated", sub: adminId }, fn);
  const setDesign = (memberId: string, value = true) => db.query("update public.members set is_design_team = $2 where id = $1", [memberId, value]);

  /** Sesión CERRADA del grupo indicado con los check-ins pedidos. */
  async function closedSession(audience: "design_team" | "remar_construction" | "both", present: string[] = []): Promise<string> {
    const r = await db.query<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ($1, now(), $2) returning id", [`Reunión ${++seq}`, audience]);
    const id = r.rows[0].id;
    await db.query("update public.sessions set status = 'active' where id = $1", [id]);
    try {
      for (const m of present) await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, m, nonce(`dt${++seq}`)]);
    } finally {
      await db.closeSession(id);
    }
    return id;
  }
  const rate = async (memberId: string) => {
    const r = await db.query<{ counted_meetings: number; attended_meetings: number }>("select counted_meetings, attended_meetings from public.member_attendance where member_id = $1", [memberId]);
    return { counted: r.rows[0].counted_meetings, attended: r.rows[0].attended_meetings };
  };

  describe("members.is_design_team (migración 11)", () => {
    it("un miembro nuevo queda con false por defecto", async () => {
      const id = await db.member();
      const r = await db.query<{ is_design_team: boolean }>("select is_design_team from public.members where id = $1", [id]);
      expect(r.rows[0].is_design_team).toBe(false);
    });

    it("un administrador la lee, la fija al crear y la edita con su sesión (permisos por columna + RLS)", async () => {
      const admin = await db.adminUser();
      const created = await asAdmin(admin, (q) =>
        q<{ id: string; is_design_team: boolean }>("insert into public.members (asce_id, name, is_design_team) values ($1, 'Ana', true) returning id, is_design_team", [`77${++seq}`.padEnd(7, "0")]),
      );
      expect(created.rows[0].is_design_team).toBe(true);
      const id = created.rows[0].id;
      await asAdmin(admin, (q) => q("update public.members set is_design_team = false where id = $1", [id]));
      const read = await asAdmin(admin, (q) => q<{ is_design_team: boolean }>("select is_design_team from public.members where id = $1", [id]));
      expect(read.rows[0].is_design_team).toBe(false);
      // Sin indicar la casilla, sigue en false.
      const plain = await asAdmin(admin, (q) => q<{ is_design_team: boolean }>("insert into public.members (asce_id, name) values ($1, 'Bea') returning is_design_team", [`88${++seq}`.padEnd(7, "0")]));
      expect(plain.rows[0].is_design_team).toBe(false);
    });

    it("anon y un usuario que NO es administrador no la leen ni la escriben; service_role solo la lee", async () => {
      const id = await db.member();
      const outsider = await db.authUser({ confirmed: false });
      await expect(db.as({ role: "anon" }, (q) => q("select is_design_team from public.members"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(db.as({ role: "anon" }, (q) => q("update public.members set is_design_team = true where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      expect((await asAdmin(outsider, (q) => q("select is_design_team from public.members"))).rowCount).toBe(0);
      const upd = await asAdmin(outsider, (q) => q("update public.members set is_design_team = true where id = $1", [id]));
      expect(upd.rowCount).toBe(0); // RLS: no ve la fila
      const svc = { role: "service_role" } as const;
      expect((await db.as(svc, (q) => q("select is_design_team from public.members where id = $1", [id]))).rowCount).toBe(1);
      await expect(db.as(svc, (q) => q("update public.members set is_design_team = true where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it("no admite nulos ni valores que no sean booleanos", async () => {
      const id = await db.member();
      await expect(db.query("update public.members set is_design_team = null where id = $1", [id])).rejects.toMatchObject({ code: "23502" });
      await expect(db.query("update public.members set is_design_team = 'quizas' where id = $1", [id])).rejects.toMatchObject({ code: "22P02" });
    });
  });

  describe("sessions.audience (migraciones 12 y 14)", () => {
    it("es un enum de EXACTAMENTE tres valores (los dos equipos y \"both\") y `required` ya no existe", async () => {
      const labels = await db.query<{ enumlabel: string }>(
        "select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'session_audience' order by e.enumsortorder",
      );
      expect(labels.rows.map((r) => r.enumlabel)).toEqual(["design_team", "remar_construction", "both"]);
      const cols = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'sessions'");
      const names = cols.rows.map((c) => c.column_name);
      expect(names).toContain("audience");
      expect(names).not.toContain("required");
    });

    it("por defecto es Rowing & Construction (remar_construction); solo acepta los tres valores; no admite nulo", async () => {
      const def = await db.query<{ audience: string }>("insert into public.sessions (title, scheduled_at) values ('Sin grupo', now()) returning audience");
      expect(def.rows[0].audience).toBe("remar_construction");
      for (const bad of ["everyone", "required", "true", "Design Team", "Both", ""]) {
        await expect(db.query("insert into public.sessions (title, scheduled_at, audience) values ('x', now(), $1)", [bad]), bad).rejects.toMatchObject({ code: INVALID_ENUM });
      }
      await expect(db.query("insert into public.sessions (title, scheduled_at, audience) values ('x', now(), null)")).rejects.toMatchObject({ code: "23502" });
    });

    it("un administrador lo fija al crear (también ya activa) y lo edita; anon y no administradores, no", async () => {
      const admin = await db.adminUser();
      const created = await asAdmin(admin, (q) => q<{ id: string; audience: string }>("insert into public.sessions (title, scheduled_at, audience) values ('Diseño', now(), 'design_team') returning id, audience"));
      expect(created.rows[0].audience).toBe("design_team");
      await asAdmin(admin, (q) => q("update public.sessions set audience = 'remar_construction' where id = $1", [created.rows[0].id]));
      expect((await db.query<{ audience: string }>("select audience from public.sessions where id = $1", [created.rows[0].id])).rows[0].audience).toBe("remar_construction");

      const direct = await asAdmin(admin, (q) => q<{ id: string; audience: string; status: string }>("insert into public.sessions (title, scheduled_at, audience, status) values ('Directa DT', now(), 'design_team', 'active') returning id, audience, status"));
      expect(direct.rows[0]).toMatchObject({ audience: "design_team", status: "active" });
      await db.closeSession(direct.rows[0].id);

      const outsider = await db.authUser({ confirmed: false });
      await expect(db.as({ role: "anon" }, (q) => q("update public.sessions set audience = 'design_team'"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asAdmin(outsider, (q) => q("insert into public.sessions (title, scheduled_at, audience) values ('x', now(), 'design_team')"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it("un administrador puede crear y editar una sesión dirigida a LOS DOS equipos (both); anon y no administradores, no", async () => {
      const admin = await db.adminUser();
      const direct = await asAdmin(admin, (q) => q<{ id: string; audience: string; status: string }>("insert into public.sessions (title, scheduled_at, audience, status) values ('Ambos', now(), 'both', 'active') returning id, audience, status"));
      expect(direct.rows[0]).toMatchObject({ audience: "both", status: "active" });
      await db.closeSession(direct.rows[0].id);

      const draft = await asAdmin(admin, (q) => q<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ('Editable', now(), 'design_team') returning id"));
      await asAdmin(admin, (q) => q("update public.sessions set audience = 'both' where id = $1", [draft.rows[0].id]));
      expect((await db.query<{ audience: string }>("select audience from public.sessions where id = $1", [draft.rows[0].id])).rows[0].audience).toBe("both");

      const outsider = await db.authUser({ confirmed: false });
      await expect(db.as({ role: "anon" }, (q) => q("update public.sessions set audience = 'both'"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asAdmin(outsider, (q) => q("insert into public.sessions (title, scheduled_at, audience) values ('x', now(), 'both')"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it("service_role puede leer el grupo (lo necesita la ruta del estudiante) pero no escribirlo", async () => {
      const id = await db.draftSession("Lectura");
      const svc = { role: "service_role" } as const;
      expect((await db.as(svc, (q) => q<{ audience: string }>("select audience from public.sessions where id = $1", [id]))).rows[0].audience).toBe("remar_construction");
      await expect(db.as(svc, (q) => q("update public.sessions set audience = 'design_team' where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });

  describe("porcentajes por grupo (vistas de asistencia)", () => {
    // Los porcentajes cuentan TODAS las reuniones cerradas de la base: cada prueba usa una base limpia.
    let sharedDb: TestDb;
    beforeEach(async () => {
      sharedDb = db;
      db = await TestDb.create();
    });
    afterEach(async () => {
      await db.destroy();
      db = sharedDb;
    });

    it("un miembro del grupo general cuenta SOLO las reuniones de Remar and Construction", async () => {
      const m = await db.member();
      await closedSession("remar_construction", [m]); // cuenta, presente
      await closedSession("remar_construction"); // cuenta, ausente
      await closedSession("design_team", [m]); // otro grupo: NO cuenta aunque asistió
      await closedSession("design_team");
      expect(await rate(m)).toEqual({ counted: 2, attended: 1 });
    });

    it("un miembro del Design Team cuenta SOLO las reuniones de Design Team", async () => {
      const m = await db.member();
      await setDesign(m);
      await closedSession("design_team", [m]);
      await closedSession("design_team", [m]);
      await closedSession("design_team");
      await closedSession("remar_construction"); // otro grupo: no cuenta
      await closedSession("remar_construction", [m]); // otro grupo: no cuenta aunque asistió
      expect(await rate(m)).toEqual({ counted: 3, attended: 2 });
    });

    it("una reunión dirigida a LOS DOS equipos (both) cuenta para TODOS los miembros, del grupo general y del Design Team", async () => {
      const general = await db.member();
      const design = await db.member();
      await setDesign(design);
      const both = await closedSession("both", [general]); // el del grupo general asistió; el del Design Team no
      await closedSession("both", [general, design]); // asistieron los dos
      await closedSession("design_team", [design]); // solo cuenta para el Design Team
      await closedSession("remar_construction", [general]); // solo cuenta para el grupo general
      expect(await rate(general)).toEqual({ counted: 3, attended: 3 }); // both, both, remar
      expect(await rate(design)).toEqual({ counted: 3, attended: 2 }); // both (ausente), both, design_team

      const rows = await db.query<{ member_id: string; for_member: boolean; counts_toward_rate: boolean; status: string; session_audience: string }>(
        "select member_id, for_member, counts_toward_rate, status, session_audience from public.session_attendance where session_id = $1",
        [both],
      );
      expect(rows.rows.every((r) => r.session_audience === "both" && r.for_member && r.counts_toward_rate)).toBe(true);
      expect(new Map(rows.rows.map((r) => [r.member_id, r.status]))).toEqual(new Map([[general, "present"], [design, "absent"]]));

      // El resumen por reunión: esperados = todos los miembros; presentes solo los que asistieron.
      const summary = await db.query<{ present_count: number; expected_count: number; rate: number }>("select present_count, expected_count, rate from public.session_attendance_summary where session_id = $1", [both]);
      expect(summary.rows[0]).toEqual({ present_count: 1, expected_count: 2, rate: 50 });
    });

    it("una reunión both respeta la pertenencia al equipo (joined_on / deactivated_on) igual que las de un solo grupo, y una asistencia real nunca se descarta", async () => {
      const [member, late] = await db.members(2);
      await db.query("update public.members set joined_on = current_date + 30 where id = $1", [late]);
      await closedSession("both", [member, late]);
      await closedSession("both", [member]);
      expect(await rate(member)).toEqual({ counted: 2, attended: 2 });
      expect(await rate(late)).toEqual({ counted: 1, attended: 1 }); // la reunión a la que no asistió es anterior a su ingreso: no cuenta
    });

    it("cambiar la casilla cambia lo que cuenta (la regla se evalúa en la vista, no se guarda)", async () => {
      const m = await db.member();
      const general = await closedSession("remar_construction", [m]);
      const design = await closedSession("design_team");
      expect(await rate(m)).toEqual({ counted: 1, attended: 1 }); // como grupo general: cuenta la reunión general a la que asistió
      await setDesign(m);
      expect(await rate(m)).toEqual({ counted: 1, attended: 0 }); // como Design Team: ya no cuenta esa, y cuenta la de Design Team (ausente)
      // Como Design Team ya no cuenta la reunión general a la que asistió, y sí cuenta la de Design Team (ausente).
      const rows = await db.query<{ session_id: string; for_member: boolean; counts_toward_rate: boolean }>("select session_id, for_member, counts_toward_rate from public.session_attendance where member_id = $1", [m]);
      const by = new Map(rows.rows.map((r) => [r.session_id, r]));
      expect(by.get(general)).toMatchObject({ for_member: false, counts_toward_rate: false });
      expect(by.get(design)).toMatchObject({ for_member: true, counts_toward_rate: true });
    });

    it("una corrección manual sigue funcionando y solo cuenta si la reunión es del grupo del miembro", async () => {
      const admin = await db.adminUser();
      const m = await db.member();
      const own = await closedSession("remar_construction");
      const other = await closedSession("design_team");
      for (const s of [own, other]) await asAdmin(admin, (q) => q("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'present')", [s, m]));
      const eff = await db.query<{ session_id: string; status: string; source: string; counts_toward_rate: boolean }>("select session_id, status, source, counts_toward_rate from public.session_attendance where member_id = $1", [m]);
      const by = new Map(eff.rows.map((r) => [r.session_id, r]));
      expect(by.get(own)).toMatchObject({ status: "present", source: "manual", counts_toward_rate: true });
      expect(by.get(other)).toMatchObject({ status: "present", source: "manual", counts_toward_rate: false });
      expect(await rate(m)).toEqual({ counted: 1, attended: 1 });
    });

    it("el porcentaje nunca supera el 100 % (el numerador es un subconjunto del denominador)", async () => {
      const m = await db.member();
      await setDesign(m);
      for (let i = 0; i < 3; i++) await closedSession("design_team", [m]);
      const r = await rate(m);
      expect(r.attended).toBeLessThanOrEqual(r.counted);
      expect(r).toEqual({ counted: 3, attended: 3 });
    });

    it("las vistas siguen siendo solo para administradores (RLS): anon y service_role, no; un usuario sin rol de administrador, sin filas", async () => {
      await closedSession("remar_construction", [await db.member()]);
      const outsider = await db.authUser({ confirmed: false });
      for (const view of ["session_attendance", "member_attendance", "session_attendance_summary"]) {
        await expect(db.as({ role: "anon" }, (q) => q(`select * from public.${view}`)), view).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
        expect((await asAdmin(outsider, (q) => q(`select * from public.${view}`))).rowCount, view).toBe(0);
      }
      const admin = await db.adminUser();
      expect((await asAdmin(admin, (q) => q("select session_id, member_id, for_member, session_audience from public.session_attendance limit 1"))).rowCount).toBeGreaterThan(0);
    });

    it("session_attendance_summary sigue contando los presentes por sesión", async () => {
      const [a, b] = await db.members(2);
      const s = await closedSession("remar_construction", [a, b]);
      const r = await db.query<{ present_count: number }>("select present_count from public.session_attendance_summary where session_id = $1", [s]);
      expect(r.rows[0].present_count).toBe(2);
    });
  });
});

describe("conversión de datos existentes (migraciones 11 y 12 sobre una base con datos antiguos)", () => {
  it("required=true y required=false pasan a remar_construction; los miembros existentes quedan en false; nada se pierde", async () => {
    const port = inject("pgPort");
    const name = `t_conv_${Math.random().toString(16).slice(2, 10)}`;
    const admin = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" });
    await admin.connect();
    await admin.query(`create database ${name}`);
    await admin.end();

    const c = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: name });
    await c.connect();
    try {
      await c.query(fs.readFileSync(path.join(ROOT, "tests/db/supabase-shim.sql"), "utf8"));
      const dir = path.join(ROOT, "supabase/migrations");
      const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
      const before = files.filter((f) => f < "20260919001000");
      for (const f of before) await c.query(fs.readFileSync(path.join(dir, f), "utf8"));

      // Datos "antiguos": esquema con `required` booleano y sin la casilla Design Team.
      const m1 = (await c.query<{ id: string }>("insert into public.members (asce_id, name) values ('1234567', 'Ana') returning id")).rows[0].id;
      const m2 = (await c.query<{ id: string }>("insert into public.members (asce_id, name) values ('7654321', 'Bea') returning id")).rows[0].id;
      const mk = async (title: string, required: boolean) => {
        const s = (await c.query<{ id: string }>("insert into public.sessions (title, scheduled_at, required) values ($1, now(), $2) returning id", [title, required])).rows[0].id;
        await c.query("update public.sessions set status = 'active' where id = $1", [s]);
        await c.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [s, m1, nonce(title)]);
        await c.query("update public.sessions set status = 'closed' where id = $1", [s]);
        return s;
      };
      const req = await mk("Obligatoria", true);
      const opt = await mk("Opcional", false);
      const oldRate = (await c.query("select counted_meetings, attended_meetings from public.member_attendance where member_id = $1", [m1])).rows[0];
      expect(oldRate).toEqual({ counted_meetings: 1, attended_meetings: 1 }); // solo la obligatoria contaba

      for (const f of files.filter((f) => f >= "20260919001000")) await c.query(fs.readFileSync(path.join(dir, f), "utf8"));

      const sessions = (await c.query<{ id: string; audience: string; title: string; status: string }>("select id, audience, title, status from public.sessions order by title")).rows;
      expect(sessions.map((s) => [s.title, s.audience, s.status])).toEqual([["Obligatoria", "remar_construction", "closed"], ["Opcional", "remar_construction", "closed"]]);
      const members = (await c.query<{ id: string; is_design_team: boolean }>("select id, is_design_team from public.members")).rows;
      expect(members.map((m) => m.is_design_team)).toEqual([false, false]);
      expect(members.map((m) => m.id).sort()).toEqual([m1, m2].sort());
      // Los check-ins siguen ahí y la asistencia efectiva no se pierde.
      expect((await c.query("select count(*)::int as n from public.checkins")).rows[0].n).toBe(2);
      const eff = (await c.query<{ session_id: string; status: string }>("select session_id, status from public.session_attendance where member_id = $1 order by session_id", [m1])).rows;
      expect(eff.filter((e) => e.status === "present").map((e) => e.session_id).sort()).toEqual([req, opt].sort());
      // Efecto documentado en la migración: la reunión antes OPCIONAL ahora cuenta como cualquier reunión del grupo general.
      const newRate = (await c.query("select counted_meetings, attended_meetings from public.member_attendance where member_id = $1", [m1])).rows[0];
      expect(newRate).toEqual({ counted_meetings: 2, attended_meetings: 2 });
      expect((await c.query("select count(*)::int as n from information_schema.columns where table_schema='public' and table_name='sessions' and column_name='required'")).rows[0].n).toBe(0);
    } finally {
      await c.end();
      const drop = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database: "postgres" });
      await drop.connect();
      await drop.query(`drop database if exists ${name} with (force)`);
      await drop.end();
    }
  });
});
