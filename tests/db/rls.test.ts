import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonce, TestDb } from "./helpers";

const PERMISSION_DENIED = "42501";

// `public.admins` ya no existe (migración 3): el administrador se deduce de auth.users.
const TABLES = ["members", "sessions", "checkins", "checkin_attempts", "audit_log", "attendance_overrides", "member_devices"] as const;

// Una columna cualquiera de cada tabla (para probar UPDATE; el análisis SQL exige que exista).
const ANY_COLUMN: Record<(typeof TABLES)[number], string> = {
  members: "id",
  sessions: "id",
  checkins: "id",
  checkin_attempts: "at",
  audit_log: "at",
  attendance_overrides: "status",
  member_devices: "expires_at",
};

// Columnas de `members` que un administrador puede leer (ya no existe ninguna columna de PIN).
const SAFE_MEMBER_COLS = "id, asce_id, name, email, active, joined_on, deactivated_on, created_at, updated_at";

describe("RLS y permisos", () => {
  let db: TestDb;
  let adminId: string;
  let outsiderId: string; // existe en Supabase Auth pero NO es administrador (correo sin confirmar)
  let memberId: string;
  let sessionId: string;
  let checkinId: string;

  beforeAll(async () => {
    db = await TestDb.create();
    adminId = await db.adminUser();
    outsiderId = await db.authUser({ confirmed: false });
    memberId = await db.member({ asce_id: "ID100", name: "Daniel Pérez" });
    sessionId = await db.activeSession();
    const r = await db.query<{ id: string }>(
      "insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3) returning id",
      [sessionId, memberId, nonce("seed")],
    );
    checkinId = r.rows[0].id;
    await db.query(
      "insert into public.checkin_attempts (outcome, ticket_nonce) values ('bad_credentials', $1)",
      [nonce("attempt")],
    );
  });

  afterAll(async () => {
    await db.destroy();
  });

  describe("anon (visitante, incluye a cualquier estudiante)", () => {
    for (const table of TABLES) {
      it(`no puede leer ni escribir en ${table}`, async () => {
        const anon = { role: "anon" } as const;
        await expect(db.as(anon, (q) => q(`select * from public.${table}`))).rejects.toMatchObject({ code: PERMISSION_DENIED });
        await expect(db.as(anon, (q) => q(`delete from public.${table}`))).rejects.toMatchObject({ code: PERMISSION_DENIED });
        const col = ANY_COLUMN[table];
        await expect(db.as(anon, (q) => q(`update public.${table} set ${col} = ${col}`))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      });
    }

    it("no puede insertar miembros, sesiones ni check-ins", async () => {
      const anon = { role: "anon" } as const;
      await expect(
        db.as(anon, (q) => q("insert into public.members (asce_id, name) values ('ZZZ', 'x')")),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(
        db.as(anon, (q) => q("insert into public.sessions (title, scheduled_at) values ('x', now())")),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(
        db.as(anon, (q) =>
          q("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [sessionId, memberId, nonce("x")]),
        ),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });

    it("no puede llamar a las funciones del esquema privado", async () => {
      await expect(db.as({ role: "anon" }, (q) => q("select private.is_admin()"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });
  });

  describe("usuario autenticado que NO es administrador", () => {
    const outsider = () => ({ role: "authenticated", sub: outsiderId }) as const;

    it("is_admin() es false", async () => {
      const r = await db.as(outsider(), (q) => q<{ is_admin: boolean }>("select private.is_admin() as is_admin"));
      expect(r.rows[0].is_admin).toBe(false);
    });

    it("no ve ninguna fila", async () => {
      const members = await db.as(outsider(), (q) => q(`select ${SAFE_MEMBER_COLS} from public.members`));
      expect(members.rowCount).toBe(0);
      for (const t of ["sessions", "checkins", "checkin_attempts", "audit_log"]) {
        const r = await db.as(outsider(), (q) => q(`select * from public.${t}`));
        expect(r.rowCount, t).toBe(0);
      }
    });

    it("no puede insertar (RLS)", async () => {
      await expect(
        db.as(outsider(), (q) => q("insert into public.members (asce_id, name) values ('ZZZ', 'x')")),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(
        db.as(outsider(), (q) => q("insert into public.sessions (title, scheduled_at) values ('x', now())")),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });

    it("no puede modificar ni borrar (0 filas afectadas)", async () => {
      const upd = await db.as(outsider(), (q) => q("update public.members set name = 'hack' where id = $1", [memberId]));
      expect(upd.rowCount).toBe(0);
      const updS = await db.as(outsider(), (q) => q("update public.sessions set title = 'hack' where id = $1", [sessionId]));
      expect(updS.rowCount).toBe(0);
      const del = await db.as(outsider(), (q) => q("delete from public.checkins where id = $1", [checkinId]));
      expect(del.rowCount).toBe(0);
      const audit = await db.query("select count(*)::int as n from public.audit_log");
      expect(audit.rows[0].n).toBe(0);
    });
  });

  describe("administrador", () => {
    const admin = () => ({ role: "authenticated", sub: adminId }) as const;

    it("is_admin() es true", async () => {
      const r = await db.as(admin(), (q) => q<{ is_admin: boolean }>("select private.is_admin() as is_admin"));
      expect(r.rows[0].is_admin).toBe(true);
    });

    it("lee miembros (sin ninguna columna de PIN)", async () => {
      const r = await db.as(admin(), (q) => q(`select ${SAFE_MEMBER_COLS} from public.members`));
      expect(r.rowCount).toBe(1);
      expect(r.rows[0]).not.toHaveProperty("pin_hash");
    });

    it("la columna pin_hash YA NO EXISTE (ni para el administrador ni para nadie); select * no la trae", async () => {
      await expect(db.as(admin(), (q) => q("select pin_hash from public.members"))).rejects.toMatchObject({ code: "42703" }); // undefined_column
      const r = await db.as(admin(), (q) => q("select * from public.members"));
      expect(Object.keys(r.rows[0]).filter((k) => /pin/i.test(k))).toEqual([]);
    });

    it("crea un miembro (solo datos de identidad, sin PIN) y lee lo que insertó", async () => {
      const r = await db.as(admin(), (q) =>
        q("insert into public.members (asce_id, name, email) values ('ID201', 'María López', 'maria@example.test') returning id, asce_id", []),
      );
      expect(r.rows[0].asce_id).toBe("ID201");
    });

    it("no puede fijar columnas que no le corresponden (id, active al crear)", async () => {
      await expect(
        db.as(admin(), (q) => q("insert into public.members (id, asce_id, name) values (gen_random_uuid(), 'ID202', 'x')")),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(
        db.as(admin(), (q) => q("update public.members set id = gen_random_uuid() where id = $1", [memberId])),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });

    it("edita y desactiva miembros, pero no los borra", async () => {
      await db.as(admin(), (q) => q("update public.members set name = 'Daniel P.' where id = $1", [memberId]));
      await expect(db.as(admin(), (q) => q("delete from public.members where id = $1", [memberId]))).rejects.toMatchObject({ code: PERMISSION_DENIED });

      const other = await db.member({ asce_id: "ID300" });
      await expect(
        db.as(admin(), (q) => q("update public.members set active = false where id = $1", [other])),
      ).rejects.toMatchObject({ code: "23514" }); // exige deactivated_on
      await db.as(admin(), (q) => q("update public.members set active = false, deactivated_on = current_date where id = $1", [other]));
    });

    it("crea sesiones en draft con created_by = su id, o ya ACTIVAS (la BD fija opened_by/opened_at); no puede fijar las marcas de tiempo", async () => {
      const r = await db.as(admin(), (q) =>
        q<{ id: string; status: string; created_by: string }>(
          "insert into public.sessions (title, scheduled_at) values ('Nueva', now()) returning id, status, created_by",
        ),
      );
      expect(r.rows[0].status).toBe("draft");
      expect(r.rows[0].created_by).toBe(adminId);

      // Crear ya ACTIVA (un solo INSERT) está permitido por permisos; que la BD fije opened_by/opened_at y la regla de una sola
      // activa se prueban en sessions.test.ts (aquí ya hay una sesión activa de fixture).
      const priv = await db.query<{ can: boolean }>("select has_column_privilege('authenticated', 'public.sessions', 'status', 'insert') as can");
      expect(priv.rows[0].can).toBe(true);

      await expect(
        db.as(admin(), (q) => q("insert into public.sessions (title, scheduled_at, opened_at) values ('x', now(), now())")),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(
        db.as(admin(), (q) => q("update public.sessions set opened_at = now() where id = $1", [r.rows[0].id])),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });

    it("SÍ puede borrar sesiones (con RLS de administrador); el detalle del borrado está en session-delete.test.ts", async () => {
      const gone = await db.query<{ id: string }>("insert into public.sessions (title, scheduled_at) values ('Borrable', now()) returning id");
      const r = await db.as(admin(), (q) => q("delete from public.sessions where id = $1", [gone.rows[0].id]));
      expect(r.rowCount).toBe(1);
    });

    it("consulta check-ins, intentos y auditoría, pero no los crea ni edita", async () => {
      expect((await db.as(admin(), (q) => q("select * from public.checkins"))).rowCount).toBeGreaterThan(0);
      expect((await db.as(admin(), (q) => q("select * from public.checkin_attempts"))).rowCount).toBeGreaterThan(0);
      await db.as(admin(), (q) => q("select * from public.audit_log"));

      await expect(
        db.as(admin(), (q) =>
          q("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [sessionId, memberId, nonce("adm")]),
        ),
      ).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(admin(), (q) => q("update public.checkins set token_slot = 2"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(admin(), (q) => q("insert into public.checkin_attempts (outcome) values ('success')"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(admin(), (q) => q("insert into public.audit_log (action, entity_type) values ('x', 'y')"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(admin(), (q) => q("update public.audit_log set action = 'z'"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(admin(), (q) => q("delete from public.audit_log"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });

    it("eliminar un check-in queda SIEMPRE registrado en audit_log, con el administrador como actor", async () => {
      const m = await db.member();
      const s = await db.query<{ id: string }>("select id from public.sessions where status = 'active'");
      const ins = await db.query<{ id: string }>(
        "insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 7, $3) returning id",
        [s.rows[0].id, m, nonce("to-delete")],
      );
      const del = await db.as(admin(), (q) => q("delete from public.checkins where id = $1", [ins.rows[0].id]));
      expect(del.rowCount).toBe(1);

      const audit = await db.query(
        "select actor_id, action, entity_type, entity_id, detail from public.audit_log where entity_id = $1",
        [ins.rows[0].id],
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0]).toMatchObject({ actor_id: adminId, action: "checkin.delete", entity_type: "checkin" });
      expect(audit.rows[0].detail).toMatchObject({ session_id: s.rows[0].id, member_id: m, token_slot: 7 });
    });
  });

  describe("service_role (solo servidor)", () => {
    const svc = { role: "service_role" } as const;

    it("lee id, nombre y estado de los miembros (lo que necesita el check-in con ASCE ID + Name)", async () => {
      const r = await db.as(svc, (q) => q("select id, asce_id, name, active from public.members where asce_id = 'ID100'"));
      expect(r.rows[0]).toMatchObject({ asce_id: "ID100", active: true });
    });

    it("no puede crear, modificar ni borrar miembros o sesiones", async () => {
      await expect(db.as(svc, (q) => q("update public.members set name = 'x'"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(svc, (q) => q("delete from public.members"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(svc, (q) => q("insert into public.sessions (title, scheduled_at) values ('x', now())"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(svc, (q) => q("update public.sessions set status = 'closed'"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });

    it("crea check-ins e intentos y registra auditoría, pero no edita check-ins ni toca audit_log", async () => {
      const m = await db.member();
      await db.as(svc, (q) =>
        q("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [sessionId, m, nonce("svc")]),
      );
      await db.as(svc, (q) => q("insert into public.checkin_attempts (outcome, session_id) values ('success', $1)", [sessionId]));
      await db.as(svc, (q) => q("insert into public.audit_log (action, entity_type) values ('test', 'test')"));

      await expect(db.as(svc, (q) => q("update public.checkins set token_slot = 9"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(svc, (q) => q("delete from public.checkins"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(svc, (q) => q("update public.audit_log set action = 'z'"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
      await expect(db.as(svc, (q) => q("delete from public.audit_log"))).rejects.toMatchObject({ code: PERMISSION_DENIED });
    });
  });

  describe("higiene del esquema (protege migraciones futuras)", () => {
    it("TODAS las tablas de public tienen RLS habilitado", async () => {
      const r = await db.query<{ relname: string; relrowsecurity: boolean }>(
        `select c.relname, c.relrowsecurity
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relkind in ('r', 'p')`,
      );
      expect(r.rows.map((x) => x.relname).sort()).toEqual([...TABLES].sort());
      expect(r.rows.filter((x) => !x.relrowsecurity)).toEqual([]);
    });

    it("anon y PUBLIC no tienen ningún permiso sobre tablas ni secuencias de public", async () => {
      const r = await db.query(
        `select grantee, table_name, privilege_type
           from information_schema.role_table_grants
          where table_schema = 'public' and grantee in ('anon', 'PUBLIC')`,
      );
      expect(r.rows).toEqual([]);
      const cols = await db.query(
        `select grantee, table_name, column_name
           from information_schema.column_privileges
          where table_schema = 'public' and grantee in ('anon', 'PUBLIC')`,
      );
      expect(cols.rows).toEqual([]);
    });

    it("members no tiene ninguna columna de PIN", async () => {
      const r = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'members'");
      expect(r.rows.map((c) => c.column_name).filter((c) => /pin/i.test(c))).toEqual([]);
    });

    it("public.admins ya no existe", async () => {
      const r = await db.query<{ t: string | null }>("select to_regclass('public.admins')::text as t");
      expect(r.rows[0].t).toBeNull();
    });

    it("no hay funciones expuestas en public", async () => {
      const r = await db.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'`,
      );
      expect(r.rows).toEqual([]);
    });

    it("cualquier tabla NUEVA en public nace sin acceso para anon/authenticated/service_role", async () => {
      await db.query("create table public.tabla_futura (id int)");
      const r = await db.query<{ role: string; can: boolean }>(
        `select r as role, has_table_privilege(r, 'public.tabla_futura', 'select') as can
           from unnest(array['anon', 'authenticated', 'service_role']) r`,
      );
      expect(r.rows.filter((x) => x.can)).toEqual([]);
      await db.query("drop table public.tabla_futura");
    });
  });
});
