/**
 * Cargo de los miembros y corrección manual de asistencia (migraciones 5 y 6), sobre Postgres real.
 * Cubre: permisos/RLS, auditoría por trigger, guardas de integridad y las reglas del porcentaje.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nonce, TestDb, type Query } from "./helpers";

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";

// Hoy en la zona horaria del equipo (la misma que usan las vistas).
const TODAY_DENVER = "(now() at time zone 'America/Denver')::date";

describe("Cargo y asistencia manual", () => {
  let db: TestDb;
  let seq = 0;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const asAdmin = async <T>(adminId: string, fn: (q: Query) => Promise<T>) => db.as({ role: "authenticated", sub: adminId }, fn);

  /** Sesión CERRADA con check-ins de los miembros indicados (se crea activa, se registran y se cierra). */
  async function closedSession(opts: { title?: string; audience?: "design_team" | "remar_construction"; present?: string[] } = {}): Promise<string> {
    const r = await db.query<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ($1, now(), $2) returning id", [
      opts.title ?? `Meeting ${++seq}`,
      opts.audience ?? "remar_construction",
    ]);
    const id = r.rows[0].id;
    await db.query("update public.sessions set status = 'active' where id = $1", [id]);
    try {
      for (const memberId of opts.present ?? []) {
        await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, memberId, nonce(++seq)]);
      }
    } finally {
      await db.closeSession(id); // pase lo que pase, no dejar una sesión activa (solo puede haber una)
    }
    return id;
  }

  const audit = (sessionId: string, memberId: string) =>
    db.query<{ actor_id: string | null; detail: Record<string, string>; recent: boolean }>(
      `select actor_id, detail, (at > now() - interval '1 minute') as recent from public.audit_log
        where action = 'attendance.manual_change' and detail->>'session_id' = $1 and detail->>'member_id' = $2 order by id`,
      [sessionId, memberId],
    );

  const effective = async (sessionId: string, memberId: string) =>
    (await db.query<{ status: string; source: string }>("select status, source from public.session_attendance where session_id = $1 and member_id = $2", [sessionId, memberId])).rows[0];

  /**
   * Las MISMAS dos sentencias que ejecuta la capa de datos (src/lib/data/attendance.ts) con la sesión del
   * administrador: UPDATE de la fila y, si no existía, INSERT. Sin funciones en `public`: solo tabla + RLS + triggers.
   */
  const setAttendance = (adminId: string, sessionId: string, memberId: string, status: "present" | "absent") =>
    asAdmin(adminId, async (q) => {
      const updated = await q("update public.attendance_overrides set status = $3 where session_id = $1 and member_id = $2", [sessionId, memberId, status]);
      if (updated.rowCount === 0) {
        await q("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, $3)", [sessionId, memberId, status]);
      }
    });

  const rate = async (memberId: string) =>
    (await db.query<{ counted_meetings: number; attended_meetings: number }>("select counted_meetings, attended_meetings from public.member_attendance where member_id = $1", [memberId])).rows[0];

  // ---------------------------------------------------------------------------
  describe("members.position", () => {
    it("los miembros nuevos son 'Member' por defecto", async () => {
      const id = await db.member();
      const r = await db.query<{ position: string }>("select position from public.members where id = $1", [id]);
      expect(r.rows[0].position).toBe("Member");
    });

    it("solo acepta un texto de 1–60 caracteres sin caracteres de control", async () => {
      const id = await db.member();
      const set = (value: string) => db.query("update public.members set position = $2 where id = $1", [id, value]);
      // (El byte NUL ni siquiera llega al constraint: Postgres lo rechaza antes por codificación. La app lo filtra con \p{Cc}.)
      for (const bad of ["", "   ", "x".repeat(61), "Project\u0007Manager", "Line\nbreak", "Tab\there", "Del\u007fete", "Lead\u202e", "Le\u200bad", "\ufeffLead"]) {
        await expect(set(bad), JSON.stringify(bad)).rejects.toMatchObject({ code: CHECK_VIOLATION, constraint: "members_position_valid" });
      }
      await set("x".repeat(60));
      await set("Aesthetics & QA/QC Officer");
      await set("Outreach Lead"); // cargo personalizado (con "Other" se guarda el texto libre)
    });

    it("un administrador lo lee, lo crea y lo edita con su sesión", async () => {
      const admin = await db.adminUser();
      const created = await asAdmin(admin, (q) =>
        q<{ id: string }>("insert into public.members (asce_id, name, position) values ($1, 'Ana', 'Safety Officer') returning id", [`POS${++seq}`]),
      );
      const id = created.rows[0].id;
      await asAdmin(admin, (q) => q("update public.members set position = 'Testing Engineer' where id = $1", [id]));
      const read = await asAdmin(admin, (q) => q<{ position: string }>("select position from public.members where id = $1", [id]));
      expect(read.rows[0].position).toBe("Testing Engineer");
    });

    it("anon no puede leer ni escribir el cargo", async () => {
      const id = await db.member();
      await expect(db.as({ role: "anon" }, (q) => q("select position from public.members"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(db.as({ role: "anon" }, (q) => q("update public.members set position = 'x' where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });
  });

  // ---------------------------------------------------------------------------
  describe("corrección manual de asistencia", () => {
    it("Absent -> Present: crea el override, no toca check-ins y deja auditoría completa", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const session = await closedSession();

      expect(await effective(session, member)).toMatchObject({ status: "absent", source: "none" });
      await setAttendance(admin, session, member, "present");
      expect(await effective(session, member)).toMatchObject({ status: "present", source: "manual" });

      // No se fabricó ningún check-in.
      const checkins = await db.query("select 1 from public.checkins where session_id = $1 and member_id = $2", [session, member]);
      expect(checkins.rowCount).toBe(0);

      const log = await audit(session, member);
      expect(log.rows).toHaveLength(1);
      expect(log.rows[0].actor_id).toBe(admin);
      expect(log.rows[0].detail).toMatchObject({ session_id: session, member_id: member, previous_status: "absent", new_status: "present" });
      expect(log.rows[0].recent).toBe(true);

      const row = await db.query<{ changed_by: string }>("select changed_by from public.attendance_overrides where session_id = $1 and member_id = $2", [session, member]);
      expect(row.rows[0].changed_by).toBe(admin);
    });

    it("Present -> Absent -> Present: el check-in original se CONSERVA, la fila de override se reutiliza y cada cambio se audita", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const session = await closedSession({ present: [member] });
      expect(await effective(session, member)).toMatchObject({ status: "present", source: "check_in" });

      await setAttendance(admin, session, member, "absent");
      expect(await effective(session, member)).toMatchObject({ status: "absent", source: "manual" });
      await setAttendance(admin, session, member, "present");
      expect(await effective(session, member)).toMatchObject({ status: "present", source: "manual" });

      expect((await db.query("select 1 from public.checkins where session_id = $1 and member_id = $2", [session, member])).rowCount).toBe(1);
      expect((await db.query("select 1 from public.attendance_overrides where session_id = $1 and member_id = $2", [session, member])).rowCount).toBe(1);

      const log = await audit(session, member);
      expect(log.rows.map((r) => [r.detail.previous_status, r.detail.new_status])).toEqual([
        ["present", "absent"],
        ["absent", "present"],
      ]);
      expect(log.rows.every((r) => r.actor_id === admin)).toBe(true);
    });

    it("un cambio que no cambia nada no deja auditoría vacía: se rechaza al crearlo y es un no-op al repetirlo", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const session = await closedSession({ present: [member] });

      // Ya está presente por su check-in: crear un override 'present' no aporta nada.
      await expect(setAttendance(admin, session, member, "present")).rejects.toMatchObject({ message: expect.stringContaining("asce:attendance_no_change") });
      expect((await audit(session, member)).rows).toHaveLength(0);

      await setAttendance(admin, session, member, "absent");
      // Repetirlo (p. ej. doble clic o dos administradores a la vez) es idempotente: sin error y sin auditoría duplicada.
      await setAttendance(admin, session, member, "absent");
      expect((await audit(session, member)).rows).toHaveLength(1);
      expect(await effective(session, member)).toMatchObject({ status: "absent", source: "manual" });
    });

    it("solo reuniones CERRADAS: una activa o en borrador se rechaza (también por escritura directa)", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const draft = await db.draftSession();
      await expect(setAttendance(admin, draft, member, "present")).rejects.toMatchObject({ message: expect.stringContaining("asce:attendance_session_not_closed") });

      const active = await db.activeSession();
      try {
        await expect(setAttendance(admin, active, member, "present")).rejects.toMatchObject({ message: expect.stringContaining("asce:attendance_session_not_closed") });
        await expect(
          db.query("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'present')", [active, member]),
        ).rejects.toMatchObject({ message: expect.stringContaining("asce:attendance_session_not_closed") });
      } finally {
        await db.closeSession(active); // una sola sesión activa a la vez: no dejar ninguna abierta para las demás pruebas
      }
    });

    it("un miembro o una sesión inexistentes se rechazan", async () => {
      const admin = await db.adminUser();
      const session = await closedSession();
      const ghost = "00000000-0000-4000-8000-000000000000";
      await expect(setAttendance(admin, session, ghost, "present")).rejects.toMatchObject({ code: "23503" });
      await expect(setAttendance(admin, ghost, await db.member(), "present")).rejects.toMatchObject({ message: expect.stringContaining("asce:attendance_session_not_closed") });
    });

    it("un miembro inactivo también se puede corregir (es historial)", async () => {
      const admin = await db.adminUser();
      const member = await db.member({ active: false });
      const session = await closedSession();
      await setAttendance(admin, session, member, "present");
      expect(await effective(session, member)).toMatchObject({ status: "present" });
    });

    it("nadie puede BORRAR ni truncar overrides (ni el propietario); el administrador ni siquiera tiene el permiso", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const session = await closedSession();
      await setAttendance(admin, session, member, "present");

      await expect(db.query("delete from public.attendance_overrides where member_id = $1", [member])).rejects.toMatchObject({
        message: expect.stringContaining("asce:attendance_overrides_are_permanent"),
      });
      await expect(db.query("truncate public.attendance_overrides")).rejects.toMatchObject({ message: expect.stringContaining("asce:attendance_overrides_are_permanent") });
      await expect(asAdmin(admin, (q) => q("delete from public.attendance_overrides where member_id = $1", [member]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      expect((await db.query("select 1 from public.attendance_overrides where member_id = $1", [member])).rowCount).toBe(1);
    });

    it("la clave (sesión, miembro) es definitiva y el cliente no puede escribir quién/cuándo", async () => {
      const admin = await db.adminUser();
      const other = await db.adminUser();
      const member = await db.member();
      const session = await closedSession();
      await setAttendance(admin, session, member, "present");

      await expect(db.query("update public.attendance_overrides set member_id = $1 where member_id = $2", [await db.member(), member])).rejects.toMatchObject({
        message: expect.stringContaining("asce:attendance_key_is_final"),
      });
      // Sin permiso de columna para changed_by / changed_at (ni en INSERT ni en UPDATE).
      await expect(asAdmin(admin, (q) => q("update public.attendance_overrides set changed_by = $1 where member_id = $2", [other, member]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(asAdmin(admin, (q) => q("update public.attendance_overrides set changed_at = now() - interval '9 days' where member_id = $1", [member]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      const forged = await closedSession();
      await expect(
        asAdmin(admin, (q) => q("insert into public.attendance_overrides (session_id, member_id, status, changed_by) values ($1, $2, 'present', $3)", [forged, member, other])),
      ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it("al escribir directamente (sin la función) la auditoría y las guardas siguen funcionando", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const session = await closedSession();
      await asAdmin(admin, (q) => q("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'present')", [session, member]));
      const log = await audit(session, member);
      expect(log.rows).toHaveLength(1);
      expect(log.rows[0].actor_id).toBe(admin);
    });

    it("borrar al administrador que hizo un cambio NO se bloquea (changed_by pasa a NULL) y la auditoría conserva al actor", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const session = await closedSession();
      await setAttendance(admin, session, member, "present");

      await db.query("delete from auth.users where id = $1", [admin]);
      const row = await db.query<{ changed_by: string | null; status: string }>("select changed_by, status from public.attendance_overrides where session_id = $1 and member_id = $2", [session, member]);
      expect(row.rows[0]).toEqual({ changed_by: null, status: "present" });
      expect((await audit(session, member)).rows[0].actor_id).toBe(admin);
      // El borrado del usuario no generó auditoría extra (no hubo cambio de estado).
      expect((await audit(session, member)).rows).toHaveLength(1);
    });

    it("los check-ins siguen siendo inmutables", async () => {
      const member = await db.member();
      const session = await closedSession({ present: [member] });
      await expect(db.query("update public.checkins set member_id = member_id where session_id = $1", [session])).rejects.toMatchObject({
        message: expect.stringContaining("asce:checkins_are_immutable"),
      });
    });
  });

  // ---------------------------------------------------------------------------
  describe("autorización", () => {
    it("anon: sin acceso a la tabla ni a las vistas", async () => {
      const member = await db.member();
      const session = await closedSession();
      const anon = (sql: string, params?: unknown[]) => db.as({ role: "anon" }, (q) => q(sql, params));
      await expect(anon("select * from public.attendance_overrides")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(anon("select * from public.session_attendance")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(anon("select * from public.member_attendance")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(anon("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'present')", [session, member])).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(anon("update public.attendance_overrides set status = 'absent'")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it("service_role (la ruta de check-in del estudiante) no tiene ningún permiso sobre overrides ni las vistas", async () => {
      const svc = (sql: string, params?: unknown[]) => db.as({ role: "service_role" }, (q) => q(sql, params));
      await expect(svc("select * from public.attendance_overrides")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(svc("select * from public.session_attendance")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await expect(svc("update public.attendance_overrides set status = 'absent'")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    });

    it("usuarios que NO son administradores (sin confirmar, baneado, anónimo, borrado) no ven ni cambian nada", async () => {
      const member = await db.member();
      const session = await closedSession();
      const admin = await db.adminUser();
      await setAttendance(admin, session, member, "present");

      const nonAdmins = [
        await db.authUser({ confirmed: false }),
        await db.authUser({ bannedUntil: new Date(Date.now() + 86_400_000).toISOString() }),
        await db.authUser({ anonymous: true, email: null }),
        await db.authUser({ deleted: true }),
      ];
      for (const user of nonAdmins) {
        const seen = await asAdmin(user, (q) => q("select * from public.attendance_overrides"));
        expect(seen.rowCount).toBe(0);
        expect((await asAdmin(user, (q) => q("select * from public.session_attendance"))).rowCount).toBe(0);
        await expect(setAttendance(user, session, await db.member(), "present")).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
        await expect(
          asAdmin(user, (q) => q("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'present')", [session, member])),
        ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
        await expect(asAdmin(user, (q) => q("update public.attendance_overrides set status = 'absent'"))).resolves.toMatchObject({ rowCount: 0 });
      }
      // El override del administrador no cambió.
      expect(await effective(session, member)).toMatchObject({ status: "present", source: "manual" });
    });

    it("no queda ninguna columna de PIN en las vistas de asistencia", async () => {
      const cols = await db.query<{ column_name: string }>(
        "select column_name from information_schema.columns where table_schema = 'public' and table_name in ('session_attendance', 'member_attendance')",
      );
      expect(cols.rows.map((c) => c.column_name)).not.toContain("pin_hash");
    });
  });

  // ---------------------------------------------------------------------------
  describe("porcentaje de asistencia (vistas)", () => {
    // Cada prueba usa una base NUEVA: un miembro que ingresó hoy cuenta TODAS las reuniones de hoy, así que
    // las reuniones de otras pruebas alterarían los conteos.
    let sharedDb: TestDb;
    beforeEach(async () => {
      sharedDb = db;
      db = await TestDb.create();
    });
    afterEach(async () => {
      await db.destroy();
      db = sharedDb;
    });

    it("solo cuentan reuniones CERRADAS dirigidas al grupo del miembro (Remar and Construction para el grupo general)", async () => {
      const member = await db.member();
      await closedSession({ present: [member] }); // obligatoria, presente
      await closedSession({ present: [] }); // obligatoria, ausente
      await closedSession({ present: [member], audience: "design_team" }); // de OTRO grupo (Design Team): no cuenta, aunque asistió
      await db.draftSession(); // borrador: no cuenta
      const active = await db.activeSession(); // activa: no cuenta
      let counts;
      try {
        counts = await rate(member);
      } finally {
        await db.closeSession(active);
      }
      expect(counts).toEqual({ counted_meetings: 2, attended_meetings: 1 });
    });

    it("un miembro sin reuniones tiene 0 contadas (la app muestra «—», nunca 0 %)", async () => {
      const member = await db.member();
      expect(await rate(member)).toEqual({ counted_meetings: 0, attended_meetings: 0 });
    });

    it("no cuenta lo ocurrido ANTES de joined_on ni DESPUÉS de deactivated_on", async () => {
      const early = await db.member();
      const late = await db.member();
      const gone = await db.member();
      await db.query(`update public.members set joined_on = ${TODAY_DENVER} + 5 where id = $1`, [early]); // ingresa en el futuro
      await db.query(`update public.members set joined_on = ${TODAY_DENVER} - 20, active = false, deactivated_on = ${TODAY_DENVER} - 10 where id = $1`, [gone]); // se dio de baja
      await closedSession();
      expect(await rate(early)).toEqual({ counted_meetings: 0, attended_meetings: 0 });
      expect(await rate(gone)).toEqual({ counted_meetings: 0, attended_meetings: 0 });
      expect((await rate(late)).counted_meetings).toBeGreaterThan(0); // control: un miembro normal sí cuenta
    });

    it("una asistencia REAL fuera del rango se cuenta en numerador y denominador (nunca se descarta)", async () => {
      const early = await db.member();
      await db.query(`update public.members set joined_on = ${TODAY_DENVER} + 5 where id = $1`, [early]);
      await closedSession({ present: [early] });
      expect(await rate(early)).toEqual({ counted_meetings: 1, attended_meetings: 1 });
    });

    it("el override cambia el porcentaje: Present -> Absent baja el numerador; Absent -> Present lo sube", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const s1 = await closedSession({ present: [member] });
      const s2 = await closedSession();
      expect(await rate(member)).toEqual({ counted_meetings: 2, attended_meetings: 1 });
      await setAttendance(admin, s1, member, "absent");
      expect(await rate(member)).toEqual({ counted_meetings: 2, attended_meetings: 0 });
      await setAttendance(admin, s2, member, "present");
      await setAttendance(admin, s1, member, "present");
      expect(await rate(member)).toEqual({ counted_meetings: 2, attended_meetings: 2 });
    });

    it("NUNCA supera el 100 %: en toda la base, asistidas <= contadas", async () => {
      const admin = await db.adminUser();
      const members = await db.members(3);
      await db.query(`update public.members set joined_on = ${TODAY_DENVER} + 9 where id = $1`, [members[0]]);
      const s = await closedSession({ present: members });
      await closedSession({ present: [members[1]] });
      await setAttendance(admin, s, members[1], "absent");
      const bad = await db.query("select member_id from public.member_attendance where attended_meetings > counted_meetings");
      expect(bad.rowCount).toBe(0);
    });

    it("la vista de historial etiqueta el origen (check_in / manual / none) y trae los datos de la reunión", async () => {
      const admin = await db.adminUser();
      const member = await db.member();
      const withCheckin = await closedSession({ title: "Kickoff", present: [member] });
      const manual = await closedSession({ title: "Workshop", audience: "design_team" });
      const none = await closedSession({ title: "Design review" });
      await setAttendance(admin, manual, member, "present");

      const rows = await asAdmin(admin, (q) =>
        q<{ session_id: string; source: string; status: string; session_title: string; session_audience: string; for_member: boolean; session_status: string }>(
          "select session_id, source, status, session_title, session_audience, for_member, session_status from public.session_attendance where member_id = $1",
          [member],
        ),
      );
      const by = new Map(rows.rows.map((r) => [r.session_id, r]));
      expect(by.get(withCheckin)).toMatchObject({ source: "check_in", status: "present", session_title: "Kickoff", session_status: "closed" });
      expect(by.get(manual)).toMatchObject({ source: "manual", status: "present", session_audience: "design_team", for_member: false });
      expect(by.get(withCheckin)).toMatchObject({ session_audience: "remar_construction", for_member: true });
      expect(by.get(none)).toMatchObject({ source: "none", status: "absent" });
    });
  });
});
