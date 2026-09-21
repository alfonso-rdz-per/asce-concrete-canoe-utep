/**
 * Validación de Attendance contra Supabase REAL (requiere la migración 13 aplicada): historial de reuniones cerradas, roster de la población
 * esperada, corrección Present <-> Absent con auditoría, conteo en vivo de la sesión activa y seguridad de las vistas.
 *
 * Usa el MISMO código que la aplicación (src/lib/data/attendance.ts, src/lib/data/sessions.ts) con el JWT real de un administrador temporal y el de un
 * usuario revocado. Todo lo que crea lleva el prefijo ZZVAL- / "[VALIDACIÓN]". Las SESIONES se eliminan al terminar (cascada a check-ins y correcciones);
 * los MIEMBROS de prueba no se pueden borrar por la API (no hay permiso DELETE) y `audit_log` es de solo inserción: esos restos se limpian con
 * tests/supabase/cleanup.sql. No toca miembros ni sesiones reales: si hay una sesión ACTIVA que no es de validación, ABORTA sin modificar nada.
 * Los datos reales que ya existan (miembros, reuniones) también cuentan en las vistas, así que las aserciones de población son AUTOCONSISTENTES
 * (el resumen contra el roster que devuelve la propia base de datos) y solo se afirman valores absolutos sobre los miembros ZZVAL-.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attendancePercent } from "@/lib/attendance";
import { getSessionAttendanceDetail, listClosedMeetings, setMemberAttendance } from "@/lib/data/attendance";
import { closeSession, createAndStartSession, deleteSession, getSessionLive, listSessions } from "@/lib/data/sessions";
import { addDaysToDateOnly, todayInElPaso } from "@/lib/dates";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { loadState, type ValidationState } from "./state";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;
const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const PERMISSION_DENIED = "42501";
const PREFIX = "[VALIDACIÓN]";

const zzId = () => `ZZVAL-${randomBytes(4).toString("hex").toUpperCase()}`;
const title = (s: string) => `${PREFIX} ${s}`;
const nonceOf = () => randomBytes(16).toString("base64url");

const authAdmin = (method: "PUT", path: string, body: unknown) =>
  fetch(`${URL_}/auth/v1/admin${path}`, {
    method,
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

describe("Supabase REAL: Attendance (migración 13, roster y correcciones)", () => {
  let state: ValidationState;
  let anon: SupabaseClient;
  let admin: SupabaseClient;
  let outsider: SupabaseClient;
  let svc: SupabaseClient;
  let adminId: string;

  const sessions: string[] = []; // para eliminarlas al terminar
  let gm1: string; // general, activo, asiste
  let gm2: string; // general, activo, ausente (se corrige)
  let dm1: string; // Design Team, activo
  let gmFuture: string; // general, se une DESPUÉS de las reuniones
  let gmGone: string; // general, dado de baja ANTES de las reuniones
  let remar: string; // reunión cerrada del grupo general (check-ins: gm1 y dm1)
  let design: string; // reunión cerrada de Design Team (check-ins: dm1 y gm1)

  /** Cierra cualquier sesión de VALIDACIÓN que haya quedado abierta (de una corrida anterior o de esta). */
  async function closeOurActive() {
    const r = await svc.from("sessions").select("id, title").eq("status", "active");
    for (const s of (r.data ?? []) as Array<{ id: string; title: string }>) if (s.title.startsWith(PREFIX)) await admin.from("sessions").update({ status: "closed" }).eq("id", s.id);
  }

  const member = async (name: string, over: Record<string, unknown> = {}) => {
    const r = await admin.from("members").insert({ asce_id: zzId(), name: title(name), ...over }).select("id").single();
    expect(r.error, `crear miembro ${name}`).toBeNull();
    return r.data?.id as string;
  };

  /** Sesión de validación ACTIVA con los check-ins pedidos (los inserta `service_role`, como la ruta del estudiante). Devuelve el id. */
  async function startWithCheckins(label: string, audience: "design_team" | "remar_construction", who: string[]) {
    const r = await createAndStartSession(admin, { title: title(label), audience });
    if (!r.ok) throw new Error(JSON.stringify(r));
    sessions.push(r.data.id);
    for (const m of who) {
      const ins = await svc.from("checkins").insert({ session_id: r.data.id, member_id: m, token_slot: 1, ticket_nonce: nonceOf() });
      expect(ins.error, "check-in de prueba").toBeNull();
    }
    return r.data.id;
  }

  beforeAll(async () => {
    state = loadState();
    anon = createClient(URL_, ANON_KEY, CLIENT_OPTS);
    svc = createServiceRoleClient();
    admin = createClient(URL_, ANON_KEY, CLIENT_OPTS);
    outsider = createClient(URL_, ANON_KEY, CLIENT_OPTS);

    const a = await admin.auth.signInWithPassword({ email: state.admin.email, password: state.admin.password });
    expect(a.error, "login del administrador temporal").toBeNull();
    adminId = a.data.user?.id as string;
    // Igual que phase4.test.ts: se levanta el baneo previo, se inicia sesión y se REVOCA (baneo) para tener un usuario autenticado con JWT vigente que NO es administrador.
    expect((await authAdmin("PUT", `/users/${state.outsider.id}`, { ban_duration: "none" })).ok, "levantar el baneo previo").toBe(true);
    const o = await outsider.auth.signInWithPassword({ email: state.outsider.email, password: state.outsider.password });
    expect(o.error, "login del usuario temporal antes de revocarlo").toBeNull();
    expect((await authAdmin("PUT", `/users/${state.outsider.id}`, { ban_duration: "1h" })).ok, "baneo del usuario revocado").toBe(true);

    // PROTECCIÓN: nunca tocar una sesión activa que no sea de validación (la del equipo de verdad).
    const active = await svc.from("sessions").select("id, title").eq("status", "active");
    expect(active.error, "leer sesiones activas").toBeNull();
    const foreign = ((active.data ?? []) as Array<{ id: string; title: string }>).filter((s) => !s.title.startsWith(PREFIX));
    if (foreign.length > 0) throw new Error(`ABORTADO sin modificar nada: hay una sesión ACTIVA que no es de validación («${foreign[0].title}»). Ciérrala desde el panel y repite.`);
    await closeOurActive();

    // Miembros de prueba (todos con prefijo). joined_on por defecto = hoy (hora de El Paso).
    const today = todayInElPaso();
    gm1 = await member("General 1");
    gm2 = await member("General 2");
    dm1 = await member("Design 1", { is_design_team: true });
    gmFuture = await member("General se une despues", { joined_on: addDaysToDateOnly(today, 3650) });
    gmGone = await member("General dado de baja antes", { joined_on: addDaysToDateOnly(today, -60) });
    const gone = await admin.from("members").update({ active: false, deactivated_on: addDaysToDateOnly(today, -20) }).eq("id", gmGone).select("id");
    expect(gone.error, "dar de baja a gmGone").toBeNull();

    // Dos reuniones CERRADAS (una a la vez: solo puede haber una activa). En cada una asisten un miembro de cada grupo.
    remar = await startWithCheckins("Attendance Remar", "remar_construction", [gm1, dm1]);
    expect((await closeSession(admin, remar)).ok).toBe(true);
    design = await startWithCheckins("Attendance Design", "design_team", [dm1, gm1]);
    expect((await closeSession(admin, design)).ok).toBe(true);
  });

  afterAll(async () => {
    if (admin) await closeOurActive(); // por si una prueba falló a mitad: no dejar una sesión de validación activa
    // Se eliminan las sesiones creadas (cascada a sus check-ins y correcciones). Los miembros ZZVAL- y las filas de audit_log los limpia cleanup.sql.
    for (const id of sessions) {
      try {
        if (admin) await deleteSession(admin, id);
      } catch {
        /* la limpieza es de mejor esfuerzo: cleanup.sql también borra por prefijo */
      }
    }
    // Dejar el usuario temporal como se encontró (sin baneo): otros archivos de esta suite inician sesión con él.
    if (state) await authAdmin("PUT", `/users/${state.outsider.id}`, { ban_duration: "none" });
  });

  const detailOf = async (sessionId: string) => {
    const r = await getSessionAttendanceDetail(admin, sessionId);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return r.data;
  };

  // ===========================================================================================
  describe("A. migración 13 aplicada", () => {
    it("session_attendance_summary devuelve session_id, present_count, expected_count y rate (enteros) con las columnas explícitas de la aplicación", async () => {
      const r = await admin.from("session_attendance_summary").select("session_id, present_count, expected_count, rate").eq("session_id", remar).single();
      expect(r.error).toBeNull();
      expect(r.data).toEqual({ session_id: remar, present_count: expect.any(Number), expected_count: expect.any(Number), rate: expect.any(Number) });
      expect(Number.isInteger(r.data?.present_count) && Number.isInteger(r.data?.expected_count) && Number.isInteger(r.data?.rate)).toBe(true);
    });
  });

  // ===========================================================================================
  describe("B. roster = población esperada que decide la base de datos", () => {
    it("reunión general: aparecen gm1 (presente) y gm2 (ausente); NO dm1 (otro grupo, aunque hizo check-in), ni quien se une después, ni quien se dio de baja antes", async () => {
      const d = await detailOf(remar);
      const by = new Map(d.roster.map((r) => [r.memberId, r]));
      expect(by.get(gm1)).toMatchObject({ status: "present", source: "check_in" });
      expect(by.get(gm2)).toMatchObject({ status: "absent", source: "none" });
      for (const excluded of [dm1, gmFuture, gmGone]) expect(by.has(excluded), excluded).toBe(false);
      // AUTOCONSISTENCIA: el resumen es exactamente el roster que devuelve la base de datos (los miembros reales también cuentan en ambos).
      expect(d.summary.expected).toBe(d.roster.length);
      expect(d.summary.present).toBe(d.roster.filter((r) => r.status === "present").length);
      expect(d.summary.present).toBeLessThanOrEqual(d.summary.expected);
      expect(d.summary.rate).toBe(attendancePercent({ counted: d.summary.expected, attended: d.summary.present }));
      // El presente de dm1 existe como fila cruda, pero no cuenta para esta reunión.
      const raw = await admin.from("session_attendance").select("status, counts_toward_rate, for_member").eq("session_id", remar).eq("member_id", dm1).single();
      expect(raw.data).toEqual({ status: "present", counts_toward_rate: false, for_member: false });
    });

    it("reunión de Design Team: aparece dm1 (presente) y NO gm1, aunque asistió", async () => {
      const d = await detailOf(design);
      const by = new Map(d.roster.map((r) => [r.memberId, r]));
      expect(by.get(dm1)).toMatchObject({ status: "present", source: "check_in" });
      for (const excluded of [gm1, gm2, gmFuture, gmGone]) expect(by.has(excluded), excluded).toBe(false);
      expect(d.summary.expected).toBe(d.roster.length);
      expect(d.summary.present).toBe(d.roster.filter((r) => r.status === "present").length);
      expect(d.summary.present).toBeLessThanOrEqual(d.summary.expected);
    });

    it("el roster no expone secretos: solo nombre, ASCE ID, cargo, estado y origen (nada de email, tokens ni hashes)", async () => {
      const d = await detailOf(remar);
      expect(Object.keys(d.roster[0]).sort()).toEqual(["asceId", "memberId", "name", "position", "source", "status"]);
      const text = JSON.stringify(d);
      for (const forbidden of ["email", "pin", "ticket_nonce", "ip_hash", "token_slot", "scrypt$"]) expect(text, forbidden).not.toContain(forbidden);
    });
  });

  // ===========================================================================================
  describe("C. corrección Present <-> Absent (setMemberAttendance, la misma que usa la aplicación)", () => {
    it("Absent -> Present y Present -> Absent se reflejan en presentes / rate / roster, conservan el check-in, no borran nada y quedan auditados", async () => {
      const before = await detailOf(remar);

      // Absent -> Present (gm2)
      expect((await setMemberAttendance(admin, { sessionId: remar, memberId: gm2, status: "present" })).ok).toBe(true);
      let d = await detailOf(remar);
      expect(d.roster.find((r) => r.memberId === gm2)).toMatchObject({ status: "present", source: "manual" });
      expect(d.summary.present).toBe(before.summary.present + 1);
      expect(d.summary.expected).toBe(before.summary.expected); // corregir no cambia a quién se esperaba
      expect(d.summary.rate).toBe(attendancePercent({ counted: d.summary.expected, attended: d.summary.present }));

      // Present -> Absent (gm1, que SÍ tenía check-in)
      expect((await setMemberAttendance(admin, { sessionId: remar, memberId: gm1, status: "absent" })).ok).toBe(true);
      d = await detailOf(remar);
      expect(d.roster.find((r) => r.memberId === gm1)).toMatchObject({ status: "absent", source: "manual" });
      expect(d.summary.present).toBe(before.summary.present);
      const checkin = await svc.from("checkins").select("id").eq("session_id", remar).eq("member_id", gm1);
      expect(checkin.data).toHaveLength(1); // el check-in original SE CONSERVA

      // Present -> Absent otra vez (la misma fila de override se reutiliza)
      expect((await setMemberAttendance(admin, { sessionId: remar, memberId: gm2, status: "absent" })).ok).toBe(true);
      d = await detailOf(remar);
      expect(d.roster.find((r) => r.memberId === gm2)).toMatchObject({ status: "absent", source: "manual" });
      expect(d.summary.present).toBe(before.summary.present - 1);
      expect(d.summary.present).toBeGreaterThanOrEqual(0);

      // Nada se borra: una fila por (sesión, miembro) y el administrador no puede borrarlas.
      const overrides = await admin.from("attendance_overrides").select("member_id, status").eq("session_id", remar);
      expect((overrides.data ?? []).map((o) => o.member_id).sort()).toEqual([gm1, gm2].sort());
      const del = await admin.from("attendance_overrides").delete().eq("session_id", remar);
      expect(del.error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("attendance_overrides").select("member_id").eq("session_id", remar)).data).toHaveLength(2);

      // Auditoría (audit_log solo lo lee service_role aquí): quién, qué miembro, qué sesión, estado anterior y nuevo.
      const audit = await svc.from("audit_log").select("actor_id, detail").eq("action", "attendance.manual_change").eq("detail->>session_id", remar).order("id", { ascending: true });
      expect(audit.error).toBeNull();
      type Detail = { member_id: string; previous_status: string; new_status: string };
      expect((audit.data ?? []).map((r) => [(r.detail as Detail).member_id, (r.detail as Detail).previous_status, (r.detail as Detail).new_status])).toEqual([
        [gm2, "absent", "present"],
        [gm1, "present", "absent"],
        [gm2, "present", "absent"],
      ]);
      for (const r of audit.data ?? []) expect(r.actor_id).toBe(adminId);
    });

    it("una reunión ACTIVA no admite correcciones (la base de datos lo impone aunque alguien fuerce la petición)", async () => {
      const live = await startWithCheckins("Attendance En vivo (correccion)", "remar_construction", [gm1]);
      try {
        const r = await setMemberAttendance(admin, { sessionId: live, memberId: gm2, status: "present" });
        expect(r.ok).toBe(false);
      } finally {
        expect((await closeSession(admin, live)).ok).toBe(true);
      }
    });
  });

  // ===========================================================================================
  describe("D. historial /admin/attendance (listClosedMeetings)", () => {
    it("lista las reuniones cerradas con presentes / esperados / porcentaje coherentes y respeta el filtro por grupo", async () => {
      const all = await listClosedMeetings(admin, "all");
      expect(all.ok).toBe(true);
      if (!all.ok) return;
      const mine = all.data.meetings.filter((m) => [remar, design].includes(m.sessionId));
      expect(mine.map((m) => m.sessionId).sort()).toEqual([remar, design].sort());
      for (const m of all.data.meetings) {
        expect(m.present).toBeLessThanOrEqual(m.expected);
        expect(m.rate === null ? m.expected === 0 : m.rate >= 0 && m.rate <= 100).toBe(true);
        if (m.rate !== null) expect(m.rate).toBe(attendancePercent({ counted: m.expected, attended: m.present }));
      }
      // Cada fila coincide con el detalle de esa misma reunión.
      for (const m of mine) expect({ present: m.present, expected: m.expected, rate: m.rate }).toEqual((await detailOf(m.sessionId)).summary);
      // Orden: la más reciente primero.
      const dates = all.data.meetings.map((m) => Date.parse(m.heldAt));
      expect(dates).toEqual([...dates].sort((a, b) => b - a));

      const general = await listClosedMeetings(admin, "remar_construction");
      const designOnly = await listClosedMeetings(admin, "design_team");
      expect(general.ok && designOnly.ok).toBe(true);
      if (!general.ok || !designOnly.ok) return;
      expect(general.data.meetings.every((m) => m.audience === "remar_construction")).toBe(true);
      expect(designOnly.data.meetings.every((m) => m.audience === "design_team")).toBe(true);
      expect(general.data.meetings.some((m) => m.sessionId === remar)).toBe(true);
      expect(general.data.meetings.some((m) => m.sessionId === design)).toBe(false);
      expect(designOnly.data.meetings.some((m) => m.sessionId === design)).toBe(true);
      expect(designOnly.data.meetings.some((m) => m.sessionId === remar)).toBe(false);
    });

    it("una reunión ACTIVA no aparece en el historial y la lista de sesiones muestra su conteo EN VIVO (no 0)", async () => {
      const live = await startWithCheckins("Attendance En vivo", "remar_construction", [gm1, gm2]);
      try {
        const closed = await listClosedMeetings(admin, "all");
        expect(closed.ok && closed.data.meetings.some((m) => m.sessionId === live)).toBe(false);

        // El resumen aún no cuenta la sesión activa (0 de 0, sin porcentaje)...
        const summary = await admin.from("session_attendance_summary").select("present_count, expected_count, rate").eq("session_id", live).single();
        expect(summary.data).toEqual({ present_count: 0, expected_count: 0, rate: null });
        // ...pero el conteo en vivo (getSessionLive y la lista de sesiones) es el real: 2 check-ins.
        const liveNow = await getSessionLive(admin, live);
        expect(liveNow.ok && liveNow.data.count).toBe(2);
        const list = await listSessions(admin);
        expect(list.ok && list.data.find((s) => s.id === live)?.presentCount).toBe(2);
        // El detalle de Attendance de una sesión no cerrada no inventa nada.
        const detail = await detailOf(live);
        expect(detail).toEqual({ summary: { present: 0, expected: 0, rate: null }, roster: [] });
      } finally {
        expect((await closeSession(admin, live)).ok).toBe(true);
      }
      // Cerrada: ya cuenta (los dos del grupo general presentes).
      const after = await detailOf(live);
      expect(after.roster.filter((r) => [gm1, gm2].includes(r.memberId)).every((r) => r.status === "present")).toBe(true);
      expect(after.summary.present).toBe(after.roster.filter((r) => r.status === "present").length);
    });
  });

  // ===========================================================================================
  describe("E. seguridad y consistencia con el porcentaje individual", () => {
    it("anon y service_role no leen el resumen; un usuario autenticado que NO es administrador ve 0 filas (security_invoker + RLS); el administrador ve las reuniones", async () => {
      const q = (c: SupabaseClient) => c.from("session_attendance_summary").select("session_id, present_count, expected_count, rate").eq("session_id", remar);
      expect((await q(anon)).error?.code).toBe(PERMISSION_DENIED);
      expect((await q(svc)).error?.code).toBe(PERMISSION_DENIED);
      const revoked = await q(outsider);
      expect(revoked.error).toBeNull();
      expect(revoked.data).toEqual([]);
      expect((await q(admin)).data).toHaveLength(1);
      // Igual para el roster (session_attendance) y para las correcciones.
      expect((await outsider.from("session_attendance").select("member_id").eq("session_id", remar).eq("counts_toward_rate", true)).data).toEqual([]);
      expect((await outsider.from("attendance_overrides").select("member_id").eq("session_id", remar)).data).toEqual([]);
      const forced = await outsider.from("attendance_overrides").insert({ session_id: remar, member_id: gm2, status: "present" });
      expect(forced.error).not.toBeNull(); // un no administrador no puede corregir
      expect((await anon.from("attendance_overrides").insert({ session_id: remar, member_id: gm2, status: "present" })).error?.code).toBe(PERMISSION_DENIED);
    });

    it("Σ expected_count de todas las reuniones = Σ counted_meetings de todos los miembros, y Σ present_count = Σ attended_meetings (misma población)", async () => {
      const s = await admin.from("session_attendance_summary").select("expected_count, present_count").limit(1000);
      const m = await admin.from("member_attendance").select("counted_meetings, attended_meetings").limit(1000);
      expect(s.error).toBeNull();
      expect(m.error).toBeNull();
      expect((s.data ?? []).length).toBeLessThan(1000); // si se acercara al tope de PostgREST, la suma no sería fiable
      expect((m.data ?? []).length).toBeLessThan(1000);
      const sum = <T,>(rows: T[] | null, pick: (r: T) => number) => (rows ?? []).reduce((a, r) => a + pick(r), 0);
      expect(sum(s.data, (r) => r.expected_count)).toBe(sum(m.data, (r) => r.counted_meetings));
      expect(sum(s.data, (r) => r.present_count)).toBe(sum(m.data, (r) => r.attended_meetings));
    });

    it("el porcentaje individual no cambia de regla: attended <= counted y sin reuniones es «—»; un miembro que se une después no tiene reuniones contadas", async () => {
      const r = await admin.from("member_attendance").select("member_id, counted_meetings, attended_meetings").in("member_id", [gm1, gm2, dm1, gmFuture, gmGone]);
      expect(r.error).toBeNull();
      for (const row of r.data ?? []) expect(row.attended_meetings).toBeLessThanOrEqual(row.counted_meetings);
      const by = new Map((r.data ?? []).map((x) => [x.member_id, x]));
      expect(by.get(gmFuture)).toEqual({ member_id: gmFuture, counted_meetings: 0, attended_meetings: 0 });
      expect(attendancePercent({ counted: 0, attended: 0 })).toBeNull();
      // gm1 y dm1 asistieron a las dos reuniones, pero a cada uno solo le cuenta la de SU grupo (1 reunión propia + sus correcciones).
      expect(by.get(dm1)?.attended_meetings).toBeGreaterThanOrEqual(1);
      expect(by.get(gm1)?.counted_meetings).toBeGreaterThanOrEqual(1);
    });
  });
});
