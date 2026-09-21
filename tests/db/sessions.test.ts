/**
 * Fase 4 sobre Postgres real: ubicación (solo texto), una sola sesión activa, ciclo de vida iniciado por el administrador
 * (con su RLS), cierre que bloquea check-ins, y lectura de asistencia autorizada / no autorizada.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonce, TestDb, type Query } from "./helpers";

const CHECK_VIOLATION = "23514";
const UNIQUE_VIOLATION = "23505";
const INSUFFICIENT_PRIVILEGE = "42501";

describe("Sesiones, QR y asistencia en vivo (Fase 4)", () => {
  let db: TestDb;
  let seq = 0;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const asAdmin = <T>(adminId: string, fn: (q: Query) => Promise<T>) => db.as({ role: "authenticated", sub: adminId }, fn);

  /** Crea un borrador como ese administrador (con su RLS y permisos por columna, igual que la aplicación). */
  async function createDraft(adminId: string, location: string | null = null, title = `Meeting ${++seq}`): Promise<string> {
    const r = await asAdmin(adminId, (q) =>
      q<{ id: string }>("insert into public.sessions (title, description, location, scheduled_at, audience) values ($1, null, $2, now(), 'remar_construction') returning id", [title, location]),
    );
    return r.rows[0].id;
  }
  const setStatus = (adminId: string, id: string, status: string) =>
    asAdmin(adminId, (q) => q("update public.sessions set status = $2 where id = $1 and status <> $2", [id, status]));

  // ---------------------------------------------------------------------------
  describe("sessions.location: SOLO texto", () => {
    it("es opcional (nulo) y acepta 1–120 caracteres", async () => {
      const admin = await db.adminUser();
      const none = await createDraft(admin, null);
      const some = await createDraft(admin, "Construction Workshop");
      const rows = await db.query<{ id: string; location: string | null }>("select id, location from public.sessions where id = any($1)", [[none, some]]);
      expect(new Map(rows.rows.map((r) => [r.id, r.location]))).toEqual(new Map([[none, null], [some, "Construction Workshop"]]));
      await db.query("update public.sessions set location = $2 where id = $1", [none, "x".repeat(120)]);
    });

    it("rechaza vacío, solo espacios, más de 120, controles y caracteres invisibles/bidireccionales (constraint sessions_location_valid)", async () => {
      const id = await db.draftSession();
      const set = (value: string) => db.query("update public.sessions set location = $2 where id = $1", [id, value]);
      for (const bad of ["", "   ", "x".repeat(121), "Lab\u0007", "Lab\nRoom", "Lab\tRoom", "Lab\u007f", "Lab\u202e", "La\u200bb", "\ufeffLab"]) {
        await expect(set(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "sessions_location_valid" });
      }
    });

    it("unas coordenadas se guardan como TEXTO sin más: la base de datos no tiene ninguna columna de geolocalización", async () => {
      const id = await db.draftSession();
      await db.query("update public.sessions set location = '31.7700, -106.5040' where id = $1", [id]);
      const cols = await db.query<{ column_name: string; data_type: string }>(
        "select column_name, data_type from information_schema.columns where table_schema = 'public' and table_name = 'sessions' order by ordinal_position",
      );
      expect(cols.rows.map((c) => c.column_name)).toEqual([
        "id", "title", "description", "scheduled_at", "status", "opened_at", "closed_at", "opened_by", "created_by", "created_at", "location", "audience",
      ]);
      expect(cols.rows.find((c) => c.column_name === "location")?.data_type).toBe("text");
    });

    it("un administrador la escribe con su sesión (RLS + permiso por columna); anon y no administradores, no", async () => {
      const admin = await db.adminUser();
      const id = await createDraft(admin, "Room A");
      await asAdmin(admin, (q) => q("update public.sessions set location = 'Room B' where id = $1", [id]));
      expect((await db.query<{ location: string }>("select location from public.sessions where id = $1", [id])).rows[0].location).toBe("Room B");

      await expect(db.as({ role: "anon" }, (q) => q("update public.sessions set location = 'x' where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(db.as({ role: "anon" }, (q) => q("select location from public.sessions"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });

      const outsider = await db.authUser({ confirmed: false });
      await expect(
        asAdmin(outsider, (q) => q("insert into public.sessions (title, location, scheduled_at, audience) values ('x', 'y', now(), 'remar_construction')")),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      const seen = await asAdmin(outsider, (q) => q("select location from public.sessions"));
      expect(seen.rowCount).toBe(0);
    });

    it("service_role (canje del QR) LEE título, ubicación y estado, pero no escribe sesiones", async () => {
      const admin = await db.adminUser();
      const id = await createDraft(admin, "Workshop");
      const r = await db.as({ role: "service_role" }, (q) => q<{ title: string; location: string; status: string }>("select title, location, status from public.sessions where id = $1", [id]));
      expect(r.rows[0]).toMatchObject({ location: "Workshop", status: "draft" });
      await expect(db.as({ role: "service_role" }, (q) => q("update public.sessions set location = 'x' where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });

  // ---------------------------------------------------------------------------
  describe("una sola sesión activa y ciclo de vida (lo impone la base de datos)", () => {
    it("un administrador puede crear una sesión YA ACTIVA (la BD fija quién y cuándo), pero no fijar esas marcas él mismo", async () => {
      const admin = await db.adminUser();
      const direct = await asAdmin(admin, (q) =>
        q<{ id: string; status: string; opened_by: string; opened_at: string | null; closed_at: string | null }>(
          "insert into public.sessions (title, scheduled_at, audience, status) values ('Directa', now(), 'design_team', 'active') returning id, status, opened_by, opened_at, closed_at",
        ),
      );
      expect(direct.rows[0]).toMatchObject({ status: "active", opened_by: admin, closed_at: null });
      expect(direct.rows[0].opened_at).not.toBeNull();
      await setStatus(admin, direct.rows[0].id, "closed");

      // Una sesión NO puede nacer cerrada, ni con marcas de tiempo o autor elegidos por el cliente.
      await expect(asAdmin(admin, (q) => q("insert into public.sessions (title, scheduled_at, audience, status) values ('x', now(), 'remar_construction', 'closed')"))).rejects.toThrow(/asce:session_must_start_as_draft/);
      await expect(asAdmin(admin, (q) => q("insert into public.sessions (title, scheduled_at, opened_at) values ('x', now(), now())"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      const id = await createDraft(admin);
      for (const col of ["opened_at = now()", "closed_at = now()", `opened_by = '${admin}'`]) {
        await expect(asAdmin(admin, (q) => q(`update public.sessions set ${col} where id = $1`, [id])), col).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      }
    });

    it("draft -> active: opened_at y opened_by los pone la BD (el administrador que la abrió)", async () => {
      const admin = await db.adminUser();
      const id = await createDraft(admin);
      await setStatus(admin, id, "active");
      const r = await db.query<{ status: string; opened_by: string; opened_at: string | null; closed_at: string | null }>("select status, opened_by, opened_at, closed_at from public.sessions where id = $1", [id]);
      expect(r.rows[0]).toMatchObject({ status: "active", opened_by: admin, closed_at: null });
      expect(r.rows[0].opened_at).not.toBeNull();
      await setStatus(admin, id, "closed");
    });

    it("NO SE DUPLICAN: con una sesión activa, activar otra falla con sessions_single_active", async () => {
      const admin = await db.adminUser();
      const first = await createDraft(admin);
      const second = await createDraft(admin);
      await setStatus(admin, first, "active");
      try {
        await expect(setStatus(admin, second, "active")).rejects.toMatchObject({ code: UNIQUE_VIOLATION, constraint: "sessions_single_active" });
        expect((await db.query<{ status: string }>("select status from public.sessions where id = $1", [second])).rows[0].status).toBe("draft");
      } finally {
        await setStatus(admin, first, "closed");
      }
      await setStatus(admin, second, "active"); // cerrada la primera, la segunda ya puede empezar
      await setStatus(admin, second, "closed");
    });

    it("CARRERA REAL: dos administradores empiezan a la vez dos sesiones distintas -> exactamente UNA queda activa", async () => {
      const adminA = await db.adminUser();
      const adminB = await db.adminUser();
      const a = await createDraft(adminA);
      const b = await createDraft(adminB);
      const [clientA, clientB] = await Promise.all([db.connectAs({ role: "authenticated", sub: adminA }), db.connectAs({ role: "authenticated", sub: adminB })]);
      try {
        const results = await Promise.allSettled([
          clientA.query("update public.sessions set status = 'active' where id = $1", [a]),
          clientB.query("update public.sessions set status = 'active' where id = $1", [b]),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
        expect(rejected.reason).toMatchObject({ code: UNIQUE_VIOLATION, constraint: "sessions_single_active" });
        const active = await db.query("select id from public.sessions where status = 'active'");
        expect(active.rowCount).toBe(1);
      } finally {
        await clientA.end();
        await clientB.end();
        await db.query("update public.sessions set status = 'closed' where status = 'active'");
      }
    });

    it("active -> closed es DEFINITIVO: una sesión cerrada no se reabre (ni siquiera el administrador)", async () => {
      const admin = await db.adminUser();
      const id = await createDraft(admin);
      await setStatus(admin, id, "active");
      await setStatus(admin, id, "closed");
      const closed = await db.query<{ closed_at: string | null }>("select closed_at from public.sessions where id = $1", [id]);
      expect(closed.rows[0].closed_at).not.toBeNull();
      await expect(setStatus(admin, id, "active")).rejects.toMatchObject({ message: expect.stringContaining("asce:session_closed_is_final") });
      await expect(setStatus(admin, id, "draft")).rejects.toMatchObject({ message: expect.stringContaining("asce:session_closed_is_final") });
    });

    it("no se puede pasar de borrador a cerrada sin haber estado activa", async () => {
      const admin = await db.adminUser();
      const id = await createDraft(admin);
      await expect(setStatus(admin, id, "closed")).rejects.toMatchObject({ message: expect.stringContaining("asce:session_invalid_transition") });
    });

    it("solo administradores cambian el estado: sin confirmar, baneado, anónimo o borrado -> ninguna fila cambia", async () => {
      const admin = await db.adminUser();
      const id = await createDraft(admin);
      const nonAdmins = [
        await db.authUser({ confirmed: false }),
        await db.authUser({ bannedUntil: new Date(Date.now() + 86_400_000).toISOString() }),
        await db.authUser({ anonymous: true, email: null }),
        await db.authUser({ deleted: true }),
      ];
      for (const user of nonAdmins) {
        const r = await asAdmin(user, (q) => q("update public.sessions set status = 'active' where id = $1", [id]));
        expect(r.rowCount).toBe(0);
      }
      expect((await db.query<{ status: string }>("select status from public.sessions where id = $1", [id])).rows[0].status).toBe("draft");
    });

    it("SESIÓN CERRADA o borrador: el servidor NO puede registrar check-ins (trigger)", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const draft = await createDraft(admin);
      const closed = await createDraft(admin);
      await setStatus(admin, closed, "active");
      await setStatus(admin, closed, "closed");
      for (const id of [draft, closed]) {
        await expect(
          db.as({ role: "service_role" }, (q) => q("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, member, nonce(++seq)])),
        ).rejects.toMatchObject({ message: expect.stringContaining("asce:session_not_active") });
      }
    });

    it("al CERRAR mientras entran check-ins: ninguno posterior al cierre (serialización por bloqueo de fila)", async () => {
      const admin = await db.adminUser();
      const members = await db.members(6);
      const id = await createDraft(admin);
      await setStatus(admin, id, "active");
      const svc = await Promise.all(members.map(() => db.connectAs({ role: "service_role" })));
      const closer = await db.connectAs({ role: "authenticated", sub: admin });
      try {
        const attempts = members.map((m, i) =>
          svc[i].query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, m, nonce(++seq)]),
        );
        const closing = closer.query("update public.sessions set status = 'closed' where id = $1", [id]);
        await Promise.allSettled([...attempts, closing]);
        const late = await db.query(
          "select 1 from public.checkins c join public.sessions s on s.id = c.session_id where s.id = $1 and c.checked_in_at > s.closed_at",
          [id],
        );
        expect(late.rowCount).toBe(0);
      } finally {
        await Promise.all([...svc, closer].map((c) => c.end()));
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("los QR y los tickets NO se almacenan en la base de datos", () => {
    it("ninguna tabla ni vista de public tiene una columna para tokens: solo el slot, el nonce de 22 caracteres y el HMAC (nunca el token) de los dispositivos recordados", async () => {
      const cols = await db.query<{ table_name: string; column_name: string; data_type: string }>(
        `select table_name, column_name, data_type from information_schema.columns
          where table_schema = 'public' and (column_name ~* '(token|qr|ticket|mac|hmac|secret)')
          order by table_name, column_name`,
      );
      expect(cols.rows.map((c) => `${c.table_name}.${c.column_name}:${c.data_type}`)).toEqual([
        "checkin_attempts.ticket_nonce:text",
        "checkins.ticket_nonce:text",
        "checkins.token_slot:bigint",
        "member_devices.token_hash:text", // HMAC-SHA256 en hex (64 caracteres, lo exige un CHECK): jamás el token de la cookie
      ]);
    });

    it("aunque alguien lo intentara, la BD rechaza guardar un token o ticket COMPLETO como nonce (solo 22 caracteres base64url)", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const id = await createDraft(admin);
      await setStatus(admin, id, "active");
      try {
        for (const whole of ["v1.AAAAAAAAAAAAAAAAAAAAAA.2z60w0.jd1u1VZ6L8DwLQAZNh3UMg", "t1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.abc.def.CCCCCCCCCCCCCCCCCCCCCC"]) {
          await expect(
            db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, member, whole]),
            whole.slice(0, 3),
          ).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "checkins_nonce_format" });
        }
      } finally {
        await setStatus(admin, id, "closed");
      }
    });
  });

  // ---------------------------------------------------------------------------
  describe("conteo de asistentes por sesión (vista)", () => {
    it("un administrador ve los presentes de cada sesión; un borrador no aparece", async () => {
      const admin = await db.adminUser();
      const [m1, m2] = await db.members(2);
      const id = await createDraft(admin);
      const draft = await createDraft(admin);
      await setStatus(admin, id, "active");
      for (const m of [m1, m2]) await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, m, nonce(++seq)]);
      await setStatus(admin, id, "closed");

      const r = await asAdmin(admin, (q) => q<{ session_id: string; present_count: number }>("select session_id, present_count from public.session_attendance_summary where session_id = any($1)", [[id, draft]]));
      expect(r.rows).toEqual([{ session_id: id, present_count: 2 }]);
    });

    it("anon y no administradores: sin acceso / sin filas", async () => {
      await expect(db.as({ role: "anon" }, (q) => q("select * from public.session_attendance_summary"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      const outsider = await db.authUser({ confirmed: false });
      expect((await asAdmin(outsider, (q) => q("select * from public.session_attendance_summary"))).rowCount).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  describe("asistencia en vivo: forma exacta de la consulta que hace la API del administrador", () => {
    const LIVE_SQL = `select c.id, c.checked_in_at, m.name, m.position
                        from public.checkins c join public.members m on m.id = c.member_id
                       where c.session_id = $1 order by c.checked_in_at desc`;

    async function activeSessionWithCheckins() {
      const admin = await db.adminUser();
      const members = await db.members(3);
      const id = await createDraft(admin);
      await setStatus(admin, id, "active");
      for (const m of members) await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, m, nonce(++seq)]);
      return { admin, id, members };
    }

    it("un ADMINISTRADOR lee nombre, cargo y hora de los asistentes de SU sesión", async () => {
      const { admin, id } = await activeSessionWithCheckins();
      try {
        const r = await asAdmin(admin, (q) => q<{ name: string; position: string }>(LIVE_SQL, [id]));
        expect(r.rowCount).toBe(3);
        expect(r.rows.every((row) => typeof row.name === "string" && row.position === "Member")).toBe(true);
      } finally {
        await setStatus(admin, id, "closed");
      }
    });

    it("un usuario que NO es administrador no ve ningún asistente", async () => {
      const { admin, id } = await activeSessionWithCheckins();
      try {
        for (const outsider of [await db.authUser({ confirmed: false }), await db.authUser({ anonymous: true, email: null }), await db.authUser({ deleted: true })]) {
          expect((await asAdmin(outsider, (q) => q(LIVE_SQL, [id]))).rowCount, outsider).toBe(0);
        }
        await expect(db.as({ role: "anon" }, (q) => q(LIVE_SQL, [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      } finally {
        await setStatus(admin, id, "closed");
      }
    });

    it("no existe ninguna columna de PIN: ninguna forma de consulta puede devolver un hash", async () => {
      const { admin, id } = await activeSessionWithCheckins();
      try {
        await expect(
          asAdmin(admin, (q) => q("select m.pin_hash from public.checkins c join public.members m on m.id = c.member_id where c.session_id = $1", [id])),
        ).rejects.toMatchObject({ code: "42703" }); // undefined_column
        for (const sql of [
          "select m.* from public.checkins c join public.members m on m.id = c.member_id where c.session_id = $1",
          "select row_to_json(m) from public.checkins c join public.members m on m.id = c.member_id where c.session_id = $1",
        ]) {
          const r = await asAdmin(admin, (q) => q(sql, [id]));
          expect(JSON.stringify(r.rows), sql).not.toMatch(/pin|scrypt/i);
        }
      } finally {
        await setStatus(admin, id, "closed");
      }
    });

    it("solo se ven los check-ins de la sesión pedida (no los de otras)", async () => {
      const a = await activeSessionWithCheckins();
      await setStatus(a.admin, a.id, "closed");
      const b = await activeSessionWithCheckins();
      try {
        const r = await asAdmin(b.admin, (q) => q(LIVE_SQL, [b.id]));
        expect(r.rowCount).toBe(3);
        const ofA = await asAdmin(b.admin, (q) => q(LIVE_SQL, [a.id]));
        expect(ofA.rowCount).toBe(3); // cada consulta devuelve SOLO los de su sesión (filtro por session_id)
        const all = await asAdmin(b.admin, (q) => q<{ session_id: string }>("select session_id from public.checkins where session_id = $1", [b.id]));
        expect(all.rows.every((row) => row.session_id === b.id)).toBe(true);
      } finally {
        await setStatus(b.admin, b.id, "closed");
      }
    });
  });
});
