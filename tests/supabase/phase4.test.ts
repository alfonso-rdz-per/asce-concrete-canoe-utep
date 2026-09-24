/**
 * Validación de la Fase 4 contra Supabase REAL (requiere la migración 7 aplicada): sesiones, ubicación, una sola sesión
 * activa, autorización, QR + ticket contra el estado real de la sesión y asistencia en vivo.
 *
 * Se ejecuta con `npm run test:supabase -- phase4` (después de scripts/supabase-validation/prepare.mjs). Usa el MISMO código
 * que la aplicación (src/lib/data/sessions.ts, src/lib/checkin/gate.ts), con el JWT real de un administrador temporal y el de
 * un usuario revocado, y con `service_role` solo donde la ruta del estudiante lo usa. No debilita RLS: si algo falla, falla.
 *
 * Todos los datos llevan el prefijo ZZVAL- / "[VALIDACIÓN]" y se limpian con tests/supabase/cleanup.sql. No toca usuarios reales
 * ni sesiones que no sean de validación: si ya hay una sesión ACTIVA legítima, ABORTA sin modificarla. Nada de esto imprime claves.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appKeys } from "@/lib/crypto/server-keys";
import { redeemQr, checkTicket, type LoadSession } from "@/lib/checkin/gate";
import { loadSessionAsService } from "@/lib/checkin/server";
import {
  closeSession,
  createAndStartSession,
  deleteSession,
  getActiveSession,
  getSession,
  getSessionLive,
  listSessions,
  SESSION_COLUMNS,
  startSession,
  type Session,
} from "@/lib/data/sessions";
import { serverEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { QR_SLOT_MS, issueQrTokens, slotAt } from "@/lib/tokens";
import { parseSessionForm } from "@/lib/validation/session";
import type { SessionAudience } from "@/lib/session-audience";
import { loadState, type ValidationState } from "./state";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;
const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const PERMISSION_DENIED = "42501";
const PREFIX = "[VALIDACIÓN]";

const zzId = () => `ZZVAL-${randomBytes(4).toString("hex").toUpperCase()}`;
const title = (s: string) => `${PREFIX} ${s}`;

const authAdmin = (method: "PUT", path: string, body: unknown) =>
  fetch(`${URL_}/auth/v1/admin${path}`, {
    method,
    headers: { apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/** Entrada validada por el MISMO analizador que usa la aplicación: New Session solo pide el nombre y Required. */
function sessionInput(over: Record<string, string> = {}) {
  const fd = new FormData();
  const values: Record<string, string> = { title: title("Team meeting"), audience: "remar_construction", ...over };
  for (const [k, v] of Object.entries(values)) if (v !== "") fd.set(k, v);
  const parsed = parseSessionForm(fd);
  if (!parsed.ok) throw new Error(`entrada de prueba inválida: ${JSON.stringify(parsed.fieldErrors)}`);
  return parsed.data;
}

/**
 * Crea un BORRADOR histórico. La interfaz ya no crea borradores (New Session abre el check-in directamente), pero la base de datos
 * los sigue admitiendo y las sesiones antiguas deben seguir funcionando: por eso estas pruebas los siguen usando.
 */
async function createSession(sb: SupabaseClient, input: { title: string; audience: SessionAudience }) {
  const { data, error } = await sb
    .from("sessions")
    .insert({ title: input.title, scheduled_at: new Date().toISOString(), audience: input.audience })
    .select(SESSION_COLUMNS)
    .single();
  return error ? { ok: false as const, error } : { ok: true as const, data: data as unknown as Session };
}

describe("Supabase REAL: Fase 4 (sesiones, QR, ticket, asistencia en vivo)", () => {
  let state: ValidationState;
  let anon: SupabaseClient;
  let admin: SupabaseClient;
  let outsider: SupabaseClient;
  let svc: SupabaseClient;
  let adminId: string;
  const env = () => serverEnv();

  const graceMs = () => env().QR_GRACE_MS;
  const ticketTtl = () => env().TICKET_TTL_SECONDS * 1000;
  const qrToken = (sessionId: string, now = Date.now()) => issueQrTokens({ key: appKeys().qr, sessionId, now }).current.token;
  const redeem = (token: unknown, now = Date.now(), loadSession: LoadSession = loadSessionAsService) =>
    redeemQr({ token, now, qrKey: appKeys().qr, ticketKey: appKeys().ticket, graceMs: graceMs(), ticketTtlMs: ticketTtl(), loadSession });
  const check = (ticket: unknown, now = Date.now()) => checkTicket({ ticket, now, ticketKey: appKeys().ticket, ticketTtlMs: ticketTtl(), loadSession: loadSessionAsService });

  /** Cierra cualquier sesión de VALIDACIÓN que haya quedado abierta (de una corrida anterior o de esta). */
  async function closeOurActive() {
    const r = await svc.from("sessions").select("id, title").eq("status", "active");
    for (const s of (r.data ?? []) as Array<{ id: string; title: string }>) {
      if (s.title.startsWith(PREFIX)) await admin.from("sessions").update({ status: "closed" }).eq("id", s.id);
    }
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
    // Otros archivos de esta suite (real.test.ts) ya banearon a este usuario temporal: se levanta el baneo para poder iniciar
    // sesión y se vuelve a aplicar justo después (así el orden de los archivos no importa).
    expect((await authAdmin("PUT", `/users/${state.outsider.id}`, { ban_duration: "none" })).ok, "levantar el baneo previo").toBe(true);
    const o = await outsider.auth.signInWithPassword({ email: state.outsider.email, password: state.outsider.password });
    expect(o.error, "login del usuario temporal antes de revocarlo").toBeNull();
    // Con el modelo de la migración 3 todo usuario confirmado es administrador: se REVOCA (baneo) tras iniciar sesión para tener
    // un usuario autenticado, con JWT vigente, que NO lo es.
    expect((await authAdmin("PUT", `/users/${state.outsider.id}`, { ban_duration: "1h" })).ok, "baneo del usuario revocado").toBe(true);


    // PROTECCIÓN: nunca tocar una sesión activa que no sea de validación (la del equipo de verdad).
    const active = await svc.from("sessions").select("id, title").eq("status", "active");
    expect(active.error, "leer sesiones activas").toBeNull();
    const foreign = ((active.data ?? []) as Array<{ id: string; title: string }>).filter((s) => !s.title.startsWith(PREFIX));
    if (foreign.length > 0) {
      throw new Error(`ABORTADO sin modificar nada: hay una sesión ACTIVA que no es de validación («${foreign[0].title}»). Ciérrala desde el panel y repite.`);
    }
    await closeOurActive();
  });

  afterAll(async () => {
    if (admin) await closeOurActive(); // por si una prueba falló a mitad: no dejar una sesión de validación activa
    // Dejar el usuario temporal como se encontró (sin baneo): otros archivos de esta suite inician sesión con él.
    if (state) await authAdmin("PUT", `/users/${state.outsider.id}`, { ban_duration: "none" });
  });

  // ===========================================================================================
  describe("A. Migración 7 aplicada", () => {
    it("sessions.location existe (lectura con service_role) y la vista session_attendance_summary existe (con RLS del administrador)", async () => {
      const col = await svc.from("sessions").select("id, location").limit(1);
      expect(col.error, "sessions.location").toBeNull();
      const view = await admin.from("session_attendance_summary").select("session_id, present_count").limit(1);
      expect(view.error, "vista session_attendance_summary").toBeNull();
    });

    it("anon y service_role NO tienen acceso a la vista (solo administradores)", async () => {
      expect((await anon.from("session_attendance_summary").select("session_id").limit(1)).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("session_attendance_summary").select("session_id").limit(1)).error?.code).toBe(PERMISSION_DENIED);
    });

    it("la restricción de ubicación es real: vacío, demasiado larga o con caracteres invisibles se rechazan", async () => {
      const draft = await createSession(admin, sessionInput());
      expect(draft.ok).toBe(true);
      if (!draft.ok) return;
      for (const bad of ["", "   ", "x".repeat(121), "Lab\u202e", "La\u200bb"]) {
        const r = await admin.from("sessions").update({ location: bad }).eq("id", draft.data.id);
        expect(r.error?.code, JSON.stringify(bad)).toBe("23514");
      }
      expect((await admin.from("sessions").update({ location: "Room B" }).eq("id", draft.data.id)).error).toBeNull();
    });
  });

  // ===========================================================================================
  describe("B. Crear, Draft, Active, Closed y una sola sesión activa (código real de la aplicación)", () => {
    it("crear una sesión con SOLO nombre + Required (grupo): Draft, fecha/hora del SERVIDOR, sin ubicación ni descripción", async () => {
      const before = Date.now();
      const required = await createSession(admin, sessionInput());
      const optional = await createSession(admin, sessionInput({ title: title("Design review"), audience: "design_team" }));
      const after = Date.now();
      expect(required.ok && optional.ok).toBe(true);
      if (!required.ok || !optional.ok) return;

      expect(required.data).toMatchObject({ status: "draft", audience: "remar_construction", location: null, description: null, opened_at: null, opened_by: null, closed_at: null });
      expect(optional.data).toMatchObject({ status: "draft", audience: "design_team" });
      // scheduled_at lo puso el servidor de la aplicación (no un formulario): está entre el inicio y el fin de la prueba.
      const scheduled = Date.parse(required.data.scheduled_at);
      expect(scheduled).toBeGreaterThanOrEqual(before - 1_000);
      expect(scheduled).toBeLessThanOrEqual(after + 1_000);

      const list = await listSessions(admin);
      expect(list.ok).toBe(true);
      if (list.ok) expect(list.data.find((s) => s.id === required.data.id)).toMatchObject({ status: "draft", presentCount: 0 });
    });

    it("COMPATIBILIDAD: una sesión antigua con ubicación sigue leyéndose y funcionando (la columna se conserva)", async () => {
      const s = await createSession(admin, sessionInput({ title: title("Sesión antigua") }));
      if (!s.ok) throw new Error("no se pudo crear");
      expect((await admin.from("sessions").update({ location: "Construction Workshop" }).eq("id", s.data.id)).error).toBeNull();
      expect(await getSession(admin, s.data.id)).toMatchObject({ ok: true, data: { location: "Construction Workshop", status: "draft" } });
      expect((await startSession(admin, s.data.id)).ok).toBe(true);
      expect((await closeSession(admin, s.data.id)).ok).toBe(true);
    });

    it("un Draft NO se puede saltar a Closed", async () => {
      const draft = await createSession(admin, sessionInput());
      if (!draft.ok) return;
      expect(await closeSession(admin, draft.data.id)).toMatchObject({ ok: false, error: { message: "That check-in hasn't started yet." } });
      expect(await getSession(admin, draft.data.id)).toMatchObject({ ok: true, data: { status: "draft" } });
    });

    it("Active: opened_at y opened_by los pone la BD (el administrador real); una segunda activa se RECHAZA con el mensaje en inglés", async () => {
      const first = await createSession(admin, sessionInput({ title: title("Primera") }));
      const second = await createSession(admin, sessionInput({ title: title("Segunda") }));
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      const started = await startSession(admin, first.data.id);
      expect(started.ok).toBe(true);
      if (started.ok) {
        expect(started.data.status).toBe("active");
        expect(started.data.opened_at).not.toBeNull();
        const raw = await svc.from("sessions").select("opened_by").eq("id", first.data.id).single();
        expect(raw.data?.opened_by).toBe(adminId);
      }

      const blocked = await startSession(admin, second.data.id);
      expect(blocked).toMatchObject({ ok: false, error: { message: "A check-in is already in progress. Close it before starting another one." } });
      expect(await getSession(admin, second.data.id)).toMatchObject({ ok: true, data: { status: "draft" } });
      const active = await getActiveSession(admin);
      expect(active.ok && active.data?.id).toBe(first.data.id);

      // Solo UNA activa en toda la base de datos (comprobado con la clave de servicio).
      const all = await svc.from("sessions").select("id").eq("status", "active");
      expect(all.data).toHaveLength(1);

      // Cerrar la primera libera el hueco: la segunda ya puede empezar (y se cierra de nuevo).
      expect((await closeSession(admin, first.data.id)).ok).toBe(true);
      expect((await startSession(admin, second.data.id)).ok).toBe(true);
      expect((await closeSession(admin, second.data.id)).ok).toBe(true);
    });

    it("Closed es DEFINITIVO: closed_at lo pone la BD, no se reabre y cerrar dos veces es idempotente", async () => {
      const s = await createSession(admin, sessionInput({ title: title("Cierre") }));
      if (!s.ok) throw new Error("no se pudo crear");
      expect((await startSession(admin, s.data.id)).ok).toBe(true);
      const closed = await closeSession(admin, s.data.id);
      expect(closed.ok && closed.data.status).toBe("closed");
      expect(closed.ok && closed.data.closed_at).not.toBeNull();
      expect(await closeSession(admin, s.data.id)).toMatchObject({ ok: true }); // doble clic / dos pestañas

      expect(await startSession(admin, s.data.id)).toMatchObject({ ok: false, error: { message: "That session is already closed." } });
      const raw = await admin.from("sessions").update({ status: "active" }).eq("id", s.data.id);
      expect(raw.error?.message).toContain("asce:session_closed_is_final");
    });

    it("el administrador no puede fijar quién/cuándo ni crear una sesión ya CERRADA (permisos por columna y trigger reales)", async () => {
      // Crear una sesión ya ACTIVA SÍ está permitido desde la migración 9 (se prueba en la sección F); lo que sigue prohibido es elegir las
      // marcas de tiempo o el autor, y nacer cerrada.
      for (const extra of [{ opened_by: adminId }, { opened_at: new Date().toISOString() }, { closed_at: new Date().toISOString() }]) {
        const r = await admin.from("sessions").insert({ title: title("Trampa"), scheduled_at: new Date().toISOString(), ...extra });
        expect(r.error?.code, JSON.stringify(extra)).toBe(PERMISSION_DENIED);
      }
      const closed = await admin.from("sessions").insert({ title: title("Trampa cerrada"), scheduled_at: new Date().toISOString(), status: "closed" });
      expect(closed.error?.message ?? "").toContain("asce:session_must_start_as_draft");
      const s = await createSession(admin, sessionInput({ title: title("Trampa 2") }));
      if (!s.ok) throw new Error("no se pudo crear");
      for (const patch of [{ opened_by: adminId }, { opened_at: new Date().toISOString() }, { closed_at: new Date().toISOString() }]) {
        expect((await admin.from("sessions").update(patch).eq("id", s.data.id)).error?.code, JSON.stringify(patch)).toBe(PERMISSION_DENIED);
      }
    });
  });

  // ===========================================================================================
  describe("C. Autorización de administrador (RLS real)", () => {
    let activeId: string;

    beforeAll(async () => {
      const s = await createSession(admin, sessionInput({ title: title("Autorización") }));
      if (!s.ok) throw new Error("no se pudo crear");
      activeId = s.data.id;
      await admin.from("sessions").update({ location: "Construction Workshop" }).eq("id", activeId); // sesión antigua: service_role debe leer la ubicación
      expect((await startSession(admin, activeId)).ok).toBe(true);
    });
    afterAll(async () => {
      await closeSession(admin, activeId);
    });

    it("un usuario que YA NO es administrador (JWT vigente, baneado) no puede crear, ver, empezar ni cerrar sesiones", async () => {
      expect(await createSession(outsider, sessionInput({ title: title("Intruso") }))).toMatchObject({ ok: false });
      const list = await listSessions(outsider);
      expect(list.ok && list.data).toEqual([]);
      expect(await getSession(outsider, activeId)).toMatchObject({ ok: false });
      expect((await startSession(outsider, activeId)).ok).toBe(false);
      expect((await closeSession(outsider, activeId)).ok).toBe(false);

      const stillActive = await svc.from("sessions").select("status").eq("id", activeId).single();
      expect(stillActive.data?.status).toBe("active"); // el intento no cambió nada
    });

    it("anon (un estudiante o cualquier visitante) no puede leer ni escribir sesiones", async () => {
      expect((await anon.from("sessions").select("id").limit(1)).error?.code).toBe(PERMISSION_DENIED);
      expect((await anon.from("sessions").update({ status: "closed" }).eq("id", activeId)).error?.code).toBe(PERMISSION_DENIED);
      expect((await anon.from("sessions").insert({ title: "x", scheduled_at: new Date().toISOString() })).error?.code).toBe(PERMISSION_DENIED);
    });

    it("service_role (solo la ruta del estudiante) LEE la sesión pero no puede modificarla", async () => {
      const read = await svc.from("sessions").select("id, title, location, status").eq("id", activeId).single();
      expect(read.error).toBeNull();
      expect(read.data).toMatchObject({ status: "active", location: "Construction Workshop" });
      expect((await svc.from("sessions").update({ status: "closed" }).eq("id", activeId)).error?.code).toBe(PERMISSION_DENIED);
    });
  });

  // ===========================================================================================
  describe("D. QR y ticket contra la sesión REAL (claves reales, hora del servidor inyectada)", () => {
    let sessionId: string;
    let otherId: string;

    beforeAll(async () => {
      const s = await createSession(admin, sessionInput({ title: title("QR y ticket") }));
      const o = await createSession(admin, sessionInput({ title: title("Otra sesión") }));
      if (!s.ok || !o.ok) throw new Error("no se pudo crear");
      sessionId = s.data.id;
      await admin.from("sessions").update({ location: "Construction Workshop" }).eq("id", sessionId); // sesión antigua con ubicación
      otherId = o.data.id; // se queda en borrador
      expect((await startSession(admin, sessionId)).ok).toBe(true);
    });
    afterAll(async () => {
      await closeSession(admin, sessionId);
    });

    it("un QR vigente emite un ticket y devuelve título y ubicación LEÍDOS de la base de datos real", async () => {
      const r = await redeem(qrToken(sessionId));
      expect(r).toMatchObject({ ok: true, session: { id: sessionId, title: title("QR y ticket"), location: "Construction Workshop" } });
      if (r.ok) expect(r.ticket).toMatch(/^t1\./);
    });

    it("el QR cambia cada 10 s y la gracia real es de ~5 s", async () => {
      const now = Date.now();
      const slot = slotAt(now);
      const a = qrToken(sessionId, now);
      const b = qrToken(sessionId, now + QR_SLOT_MS);
      expect(a).not.toBe(b);
      expect(issueQrTokens({ key: appKeys().qr, sessionId, now }).next.token).toBe(b);
      expect(env().QR_GRACE_MS).toBeGreaterThanOrEqual(4_000);
      expect(env().QR_GRACE_MS).toBeLessThanOrEqual(6_000);

      const slotEnd = (slot + 1) * QR_SLOT_MS;
      expect((await redeem(a, slotEnd - 1)).ok).toBe(true); // dentro del intervalo
      expect((await redeem(a, slotEnd + graceMs() - 1)).ok).toBe(true); // dentro de la gracia
      expect(await redeem(a, slotEnd + graceMs())).toEqual({ ok: false, reason: "expired" }); // pasada la gracia
      expect(await redeem(a, slotEnd + 60_000)).toEqual({ ok: false, reason: "expired" });
    });

    it("token modificado, de otra sesión, de una sesión en borrador o inexistente: todos fallan", async () => {
      const good = qrToken(sessionId);
      const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
      expect(await redeem(tampered)).toEqual({ ok: false, reason: "invalid" });
      expect(await redeem(good.replace(/^v1\.[^.]+\./, `v1.${qrToken(otherId).split(".")[1]}.`))).toEqual({ ok: false, reason: "invalid" }); // sessionId cambiado, MAC reutilizado
      expect(await redeem(qrToken(otherId))).toEqual({ ok: false, reason: "closed" }); // MAC válido, pero la sesión es un borrador
      expect(await redeem(qrToken("00000000-0000-4000-8000-000000000000"))).toEqual({ ok: false, reason: "invalid" }); // sin fila
      for (const junk of ["", "v1", "abc", null, undefined]) expect(await redeem(junk), String(junk)).toEqual({ ok: false, reason: "invalid" });
    });

    it("el TICKET dura ~3 min medidos con la hora del servidor: válido hasta +179,999 s, caducado a +180 s", async () => {
      const t0 = Date.now();
      const r = await redeem(qrToken(sessionId, t0), t0);
      if (!r.ok) throw new Error("se esperaba un ticket");
      expect(env().TICKET_TTL_SECONDS).toBe(180);
      expect((await check(r.ticket, t0 + 1_000)).ok).toBe(true);
      expect((await check(r.ticket, t0 + 179_999)).ok).toBe(true);
      expect(await check(r.ticket, t0 + 180_000)).toEqual({ ok: false, reason: "expired" });
      expect(await check(r.ticket, t0 + 600_000)).toEqual({ ok: false, reason: "expired" });
    });

    it("el ticket es INDEPENDIENTE de la rotación: escaneado en el segundo 8 sigue valiendo 60–90 s después, aunque el QR haya cambiado varias veces", async () => {
      const slotStart = Math.floor(Date.now() / QR_SLOT_MS) * QR_SLOT_MS;
      const scanAt = slotStart + 8_000;
      const r = await redeem(qrToken(sessionId, scanAt), scanAt);
      if (!r.ok) throw new Error("se esperaba un ticket");
      const qrAtScan = qrToken(sessionId, scanAt);
      for (const later of [12_000, 25_000, 60_000, 90_000, 170_000]) {
        expect(await redeem(qrAtScan, scanAt + later)).toMatchObject({ ok: false }); // el QR original ya no sirve…
        expect(await check(r.ticket, scanAt + later), `ticket +${later / 1000}s`).toMatchObject({ ok: true, sessionId }); // …pero el ticket sí
      }
    });

    it("ticket modificado o de otra sesión: falla", async () => {
      const r = await redeem(qrToken(sessionId));
      if (!r.ok) throw new Error("se esperaba un ticket");
      const tampered = r.ticket.slice(0, -1) + (r.ticket.endsWith("A") ? "B" : "A");
      expect(await check(tampered)).toEqual({ ok: false, reason: "invalid" });
      const parts = r.ticket.split(".");
      const forged = [parts[0], qrToken(otherId).split(".")[1], ...parts.slice(2)].join(".");
      expect(await check(forged)).toEqual({ ok: false, reason: "invalid" });
      expect(await check(qrToken(sessionId))).toEqual({ ok: false, reason: "invalid" }); // un QR no vale como ticket
    });

    it("los QR y tickets NO se guardan en la base de datos: ninguna tabla contiene un token tras varias emisiones", async () => {
      for (let i = 0; i < 5; i++) await redeem(qrToken(sessionId));
      for (const table of ["audit_log", "checkin_attempts", "checkins", "sessions"]) {
        const r = await svc.from(table).select("*").limit(500);
        if (r.error) continue; // service_role puede no tener permiso en alguna tabla: no hay nada que comprobar ahí
        expect(JSON.stringify(r.data), table).not.toMatch(/"v1\.[A-Za-z0-9_-]{22}\.|"t1\.[A-Za-z0-9_-]{22}\./);
      }
    });

    it("al CERRAR la sesión, un QR con MAC válido y un ticket vigente dejan de aceptarse AL INSTANTE", async () => {
      const r = await redeem(qrToken(sessionId));
      if (!r.ok) throw new Error("se esperaba un ticket");
      const liveQr = qrToken(sessionId);
      expect((await check(r.ticket)).ok).toBe(true);

      expect((await closeSession(admin, sessionId)).ok).toBe(true);

      expect(await redeem(liveQr)).toEqual({ ok: false, reason: "closed" });
      expect(await check(r.ticket)).toEqual({ ok: false, reason: "closed" });
      // Y la base de datos tampoco admite check-ins (trigger), aunque alguien tuviera un ticket válido.
      const member = await admin.from("members").insert({ asce_id: zzId(), name: title("Miembro") }).select("id").single();
      const ins = await svc.from("checkins").insert({ session_id: sessionId, member_id: member.data?.id, token_slot: 1, ticket_nonce: randomBytes(16).toString("base64url") });
      expect(ins.error?.message).toContain("asce:session_not_active");
    });
  });

  // ===========================================================================================
  describe("E. Asistencia en vivo (la consulta real de la API del administrador)", () => {
    let sessionId: string;
    let memberId: string;
    let memberName: string;

    beforeAll(async () => {
      const s = await createSession(admin, sessionInput({ title: title("Asistencia en vivo") }));
      if (!s.ok) throw new Error("no se pudo crear");
      sessionId = s.data.id;
      expect((await startSession(admin, sessionId)).ok).toBe(true);

      memberName = title("Maria Lopez");
      const m = await admin.from("members").insert({ asce_id: zzId(), name: memberName, position: "Safety Officer" }).select("id").single();
      expect(m.error).toBeNull();
      memberId = m.data?.id as string;

      // Un check-in REAL, con el ticket que emite el propio flujo (así el nonce y el slot son auténticos).
      const t = await redeem(qrToken(sessionId));
      if (!t.ok) throw new Error("se esperaba un ticket");
      const verified = await check(t.ticket);
      if (!verified.ok) throw new Error("ticket inválido");
      const ins = await svc.from("checkins").insert({ session_id: sessionId, member_id: memberId, token_slot: verified.tokenSlot, ticket_nonce: verified.nonce });
      expect(ins.error, "check-in real").toBeNull();
    });
    afterAll(async () => {
      await closeSession(admin, sessionId);
    });

    it("el administrador ve al asistente con nombre, cargo y hora; el conteo y el total son correctos", async () => {
      const live = await getSessionLive(admin, sessionId);
      expect(live.ok).toBe(true);
      if (!live.ok) return;
      expect(live.data.session).toMatchObject({ id: sessionId, status: "active" });
      expect(live.data.count).toBe(1);
      expect(live.data.total).toBeGreaterThanOrEqual(1);
      expect(live.data.attendees).toEqual([{ id: expect.any(String), name: memberName, position: "Safety Officer", checkedInAt: expect.any(String) }]);
    });

    it("NO se devuelve ningún PIN ni información sensible del miembro (ni ASCE ID, ni id de miembro, ni nonce, ni hash de IP)", async () => {
      const live = await getSessionLive(admin, sessionId);
      const text = JSON.stringify(live);
      for (const forbidden of ["pin", "scrypt$", "asce_id", "ZZVAL-", "member_id", "ticket_nonce", "ip_hash", "token_slot"]) expect(text, forbidden).not.toContain(forbidden);
      expect(Object.keys((live.ok && live.data.attendees[0]) || {}).sort()).toEqual(["checkedInAt", "id", "name", "position"]);
    });

    it("la columna pin_hash YA NO EXISTE: ninguna forma de consulta la puede leer (migración 10)", async () => {
      for (const query of [
        admin.from("members").select("pin_hash").limit(1),
        admin.from("members").select("id").order("pin_hash").limit(1),
        admin.from("checkins").select("id, members(pin_hash)").eq("session_id", sessionId),
      ]) {
        expect((await query).error, "debe fallar: la columna no existe").not.toBeNull();
      }
      const all = await admin.from("members").select("*").limit(1);
      expect(all.error).toBeNull();
      expect(Object.keys((all.data ?? [])[0] ?? {}).filter((k) => /pin/i.test(k))).toEqual([]);
    });

    it("un usuario que NO es administrador (revocado) y anon no ven la asistencia", async () => {
      expect(await getSessionLive(outsider, sessionId)).toMatchObject({ ok: false });
      expect((await outsider.from("checkins").select("id").eq("session_id", sessionId)).data ?? []).toEqual([]);
      expect((await anon.from("checkins").select("id").eq("session_id", sessionId)).error?.code).toBe(PERMISSION_DENIED);
    });

    it("solo se listan los check-ins de la sesión pedida", async () => {
      const other = await createSession(admin, sessionInput({ title: title("Otra") }));
      if (!other.ok) throw new Error("no se pudo crear");
      const live = await getSessionLive(admin, other.data.id); // borrador: sin asistentes
      expect(live.ok && live.data.attendees).toEqual([]);
    });

    it("el resumen por sesión (migración 13) solo cuenta reuniones CERRADAS: la activa aún no cuenta (su conteo en vivo sale de getSessionLive) y la cerrada conserva la asistencia", async () => {
      // ACTIVA: el resumen dice 0 de 0 sin porcentaje aunque ya haya un check-in; el conteo en vivo es el de getSessionLive.
      const before = await admin.from("session_attendance_summary").select("present_count, expected_count, rate").eq("session_id", sessionId).single();
      expect(before.error).toBeNull();
      expect(before.data).toEqual({ present_count: 0, expected_count: 0, rate: null });
      const live = await getSessionLive(admin, sessionId);
      expect(live.ok && live.data.count).toBe(1);

      expect((await closeSession(admin, sessionId)).ok).toBe(true);
      const after = await getSessionLive(admin, sessionId);
      expect(after.ok && after.data.session.status).toBe("closed");
      expect(after.ok && after.data.count).toBe(1);
      // CERRADA: el miembro del grupo general que asistió cuenta como presente dentro de la población esperada.
      const closed = await admin.from("session_attendance_summary").select("present_count, expected_count, rate").eq("session_id", sessionId).single();
      expect(closed.data?.present_count).toBe(1);
      expect(closed.data?.expected_count).toBeGreaterThanOrEqual(1);
      expect(closed.data?.rate).toBeGreaterThan(0);
      expect(closed.data?.rate).toBeLessThanOrEqual(100);
    });
  });

  // ===========================================================================================
  describe("F. Migración 9: New Session crea ya ACTIVA (sin borrador) y eliminar sesiones", () => {
    it("createAndStartSession: una sola sentencia, activa, con opened_by = el administrador y opened_at/scheduled_at de la hora del SERVIDOR", async () => {
      const before = Date.now();
      const r = await createAndStartSession(admin, { title: title("Directa"), audience: "design_team" });
      expect(r.ok, JSON.stringify(r)).toBe(true);
      if (!r.ok) return;
      try {
        expect(r.data).toMatchObject({ status: "active", audience: "design_team", closed_at: null, opened_by: adminId, description: null, location: null });
        expect(Date.parse(r.data.opened_at as string)).toBeGreaterThan(before - 60_000);
        expect(Math.abs(Date.parse(r.data.scheduled_at) - before)).toBeLessThan(60_000);
        const raw = await svc.from("sessions").select("opened_by, opened_at, status").eq("id", r.data.id).single();
        expect(raw.data).toMatchObject({ opened_by: adminId, status: "active" });
      } finally {
        await closeSession(admin, r.data.id);
      }
    });

    it("el grupo Design Team se guarda y se lee", async () => {
      const r = await createAndStartSession(admin, { title: title("Design Team directa"), audience: "design_team" });
      if (!r.ok) throw new Error(JSON.stringify(r));
      try {
        expect(r.data.audience).toBe("design_team");
      } finally {
        await closeSession(admin, r.data.id);
      }
    });

    it("con otra sesión activa, la BD lo rechaza de forma atómica (sin dejar un borrador de más)", async () => {
      const first = await createAndStartSession(admin, { title: title("Primera directa"), audience: "remar_construction" });
      if (!first.ok) throw new Error(JSON.stringify(first));
      try {
        const count = async () => ((await svc.from("sessions").select("id").like("title", `${PREFIX} Segunda directa%`)).data ?? []).length;
        const second = await createAndStartSession(admin, { title: title("Segunda directa"), audience: "remar_construction" });
        expect(second).toMatchObject({ ok: false, error: { message: "A check-in is already in progress. Close it before starting another one." } });
        expect(await count()).toBe(0); // no quedó ninguna fila
      } finally {
        await closeSession(admin, first.data.id);
      }
    });

    it("un usuario que NO es administrador (revocado) no puede crear sesiones activas", async () => {
      const r = await createAndStartSession(outsider, { title: title("Intruso directo"), audience: "remar_construction" });
      expect(r.ok).toBe(false);
    });

    it("los borradores HISTÓRICOS siguen existiendo y se pueden iniciar (compatibilidad)", async () => {
      const d = await createSession(admin, sessionInput({ title: title("Borrador antiguo") }));
      if (!d.ok) throw new Error("no se pudo crear");
      expect(d.data.status).toBe("draft");
      expect((await startSession(admin, d.data.id)).ok).toBe(true);
      expect((await closeSession(admin, d.data.id)).ok).toBe(true);
    });

    it("ELIMINAR una sesión cerrada con asistencia: se van sus check-ins, queda rastro en audit_log y no quedan filas huérfanas", async () => {
      const s = await createAndStartSession(admin, { title: title("Para eliminar"), audience: "remar_construction" });
      if (!s.ok) throw new Error(JSON.stringify(s));
      const m = await admin.from("members").insert({ asce_id: zzId(), name: title("Asistente a eliminar") }).select("id").single();
      const ticket = await redeem(qrToken(s.data.id));
      if (!ticket.ok) throw new Error("se esperaba un ticket");
      const ins = await svc.from("checkins").insert({ session_id: s.data.id, member_id: m.data?.id, token_slot: 1, ticket_nonce: randomBytes(16).toString("base64url") });
      expect(ins.error).toBeNull();
      expect((await closeSession(admin, s.data.id)).ok).toBe(true);
      // Una corrección manual (override) de OTRO miembro: el borrado en cascada también se la lleva (prueba la migración 9 de verdad).
      const other = await admin.from("members").insert({ asce_id: zzId(), name: title("Corregido a mano") }).select("id").single();
      const correction = await admin.from("attendance_overrides").insert({ session_id: s.data.id, member_id: other.data?.id, status: "present" });
      expect(correction.error).toBeNull();
      expect((await admin.from("attendance_overrides").select("session_id").eq("session_id", s.data.id)).data).toHaveLength(1);

      const del = await deleteSession(admin, s.data.id);
      expect(del).toEqual({ ok: true, data: { id: s.data.id } });

      expect((await svc.from("sessions").select("id").eq("id", s.data.id)).data).toEqual([]);
      expect((await svc.from("checkins").select("id").eq("session_id", s.data.id)).data).toEqual([]);
      // (service_role no lee esa tabla: se comprueba con la sesión del administrador, que sí la ve por RLS)
      const overrides = await admin.from("attendance_overrides").select("session_id").eq("session_id", s.data.id);
      expect(overrides.error).toBeNull();
      expect(overrides.data).toEqual([]);

      const audit = await admin.from("audit_log").select("action, actor_id, detail").eq("entity_id", s.data.id).eq("action", "session.delete");
      expect(audit.error).toBeNull();
      expect(audit.data).toHaveLength(1);
      expect(audit.data?.[0]).toMatchObject({ actor_id: adminId, detail: { status: "closed", audience: "remar_construction", deleted_checkins: 1, deleted_corrections: 1 } });
    });

    it("ELIMINAR una sesión ACTIVA: su QR y su ticket dejan de valer AL INSTANTE y ya se puede abrir otra", async () => {
      const s = await createAndStartSession(admin, { title: title("Activa a eliminar"), audience: "remar_construction" });
      if (!s.ok) throw new Error(JSON.stringify(s));
      const liveQr = qrToken(s.data.id);
      const t = await redeem(liveQr);
      if (!t.ok) throw new Error("se esperaba un ticket");
      expect((await check(t.ticket)).ok).toBe(true);

      expect((await deleteSession(admin, s.data.id)).ok).toBe(true);

      expect((await redeem(liveQr)).ok).toBe(false);
      expect((await check(t.ticket)).ok).toBe(false);
      const member = await admin.from("members").insert({ asce_id: zzId(), name: title("Tarde") }).select("id").single();
      const late = await svc.from("checkins").insert({ session_id: s.data.id, member_id: member.data?.id, token_slot: 1, ticket_nonce: randomBytes(16).toString("base64url") });
      expect(late.error).not.toBeNull(); // la sesión ya no existe

      const next = await createAndStartSession(admin, { title: title("Después de eliminar"), audience: "remar_construction" });
      expect(next.ok).toBe(true);
      if (next.ok) await closeSession(admin, next.data.id);
    });

    it("eliminar una sesión inexistente da el mensaje en inglés; un usuario revocado no puede eliminar nada", async () => {
      expect(await deleteSession(admin, crypto.randomUUID())).toMatchObject({ ok: false, error: { message: "That session no longer exists." } });
      const s = await createSession(admin, sessionInput({ title: title("Intocable") }));
      if (!s.ok) throw new Error("no se pudo crear");
      expect(await deleteSession(outsider, s.data.id)).toMatchObject({ ok: false }); // RLS: no ve la fila, no borra nada
      expect((await svc.from("sessions").select("id").eq("id", s.data.id)).data).toHaveLength(1);
      expect((await anon.from("sessions").delete().eq("id", s.data.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("sessions").delete().eq("id", s.data.id)).error?.code).toBe(PERMISSION_DENIED); // ni siquiera service_role
    });
  });

  // ===========================================================================================
  describe("G. Migraciones 11 y 12 reales: Design Team y el grupo de la sesión (Required)", () => {
    const nonceOf = () => randomBytes(16).toString("base64url");

    it("members.is_design_team: false por defecto, se fija al crear y se edita (administrador); anon, usuario revocado y service_role, no", async () => {
      const plain = await admin.from("members").insert({ asce_id: zzId(), name: title("Sin casilla") }).select("id, is_design_team").single();
      expect(plain.error).toBeNull();
      expect(plain.data?.is_design_team).toBe(false);
      const design = await admin.from("members").insert({ asce_id: zzId(), name: title("Con casilla"), is_design_team: true }).select("id, is_design_team").single();
      expect(design.data?.is_design_team).toBe(true);
      const off = await admin.from("members").update({ is_design_team: false }).eq("id", design.data?.id).select("is_design_team").single();
      expect(off.data?.is_design_team).toBe(false);

      expect((await anon.from("members").select("is_design_team").limit(1)).error?.code).toBe(PERMISSION_DENIED);
      expect((await outsider.from("members").insert({ asce_id: zzId(), name: title("intruso"), is_design_team: true })).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("members").select("is_design_team").limit(1)).error).toBeNull(); // el envío del estudiante puede leerla
      expect((await svc.from("members").update({ is_design_team: true }).eq("id", plain.data?.id)).error?.code).toBe(PERMISSION_DENIED);
    });

    it("todos los miembros anteriores a la casilla quedaron en false (migración 11): ninguno tiene null", async () => {
      const nulls = await svc.from("members").select("id").is("is_design_team", null);
      expect(nulls.error).toBeNull();
      expect(nulls.data).toEqual([]);
    });

    it("sessions.audience: enum de EXACTAMENTE tres valores (los dos equipos y both, migraciones 14 y 15); el booleano required ya no existe", async () => {
      const bad = await admin.from("sessions").insert({ title: title("Grupo inválido"), scheduled_at: new Date().toISOString(), audience: "everyone" });
      expect(bad.error?.code).toBe("22P02");
      const legacy = await admin.from("sessions").insert({ title: title("Booleano viejo"), scheduled_at: new Date().toISOString(), required: true });
      expect(legacy.error, "la columna required ya no existe").not.toBeNull();
      expect((await svc.from("sessions").select("required").limit(1)).error).not.toBeNull();
      expect((await svc.from("sessions").select("audience").limit(1)).error).toBeNull();
      // Todas las sesiones existentes tienen un grupo válido (la conversión no dejó nulos).
      const all = await svc.from("sessions").select("audience");
      expect((all.data ?? []).every((r) => r.audience === "design_team" || r.audience === "remar_construction" || r.audience === "both")).toBe(true);
    });

    it("una sesión puede ir dirigida a LOS DOS equipos: el analizador de New Session convierte las dos casillas en \"both\" y la base de datos lo acepta", async () => {
      const fd = new FormData();
      fd.set("title", title("Ambos equipos"));
      fd.append("audience", "design_team");
      fd.append("audience", "remar_construction");
      const parsed = parseSessionForm(fd);
      expect(parsed).toMatchObject({ ok: true, data: { audience: "both" } });
      if (!parsed.ok) return;
      const created = await createAndStartSession(admin, parsed.data);
      expect(created.ok).toBe(true);
      if (created.ok) {
        expect(created.data).toMatchObject({ status: "active", audience: "both" });
        expect((await closeSession(admin, created.data.id)).ok).toBe(true);
      }
    });

    it("asistencia en vivo: el denominador ('12 / 25') son los miembros ACTIVOS del grupo de la sesión", async () => {
      await admin.from("members").insert({ asce_id: zzId(), name: title("Diseño activo"), is_design_team: true });
      const designCount = (await svc.from("members").select("id", { count: "exact", head: true }).eq("active", true).eq("is_design_team", true)).count ?? 0;
      const generalCount = (await svc.from("members").select("id", { count: "exact", head: true }).eq("active", true).eq("is_design_team", false)).count ?? 0;
      expect(designCount).toBeGreaterThanOrEqual(1);
      const d = await createSession(admin, sessionInput({ title: title("En vivo Design"), audience: "design_team" }));
      const g = await createSession(admin, sessionInput({ title: title("En vivo General"), audience: "remar_construction" }));
      if (!d.ok || !g.ok) throw new Error("no se pudo crear");
      const liveD = await getSessionLive(admin, d.data.id);
      const liveG = await getSessionLive(admin, g.data.id);
      expect(liveD.ok && liveD.data.total).toBe(designCount);
      expect(liveG.ok && liveG.data.total).toBe(generalCount);
      expect(liveD.ok && liveD.data.session.audience).toBe("design_team");
    });

    it("porcentajes por grupo con las vistas reales: cada miembro cuenta las reuniones cerradas de SU grupo", async () => {
      const dm = await admin.from("members").insert({ asce_id: zzId(), name: title("Miembro Design"), is_design_team: true }).select("id").single();
      const gm = await admin.from("members").insert({ asce_id: zzId(), name: title("Miembro General") }).select("id").single();
      const closedSessionFor = async (audience: "design_team" | "remar_construction", label: string) => {
        const r = await createAndStartSession(admin, { title: title(label), audience });
        if (!r.ok) throw new Error(JSON.stringify(r));
        try {
          for (const m of [dm.data?.id, gm.data?.id]) {
            const ins = await svc.from("checkins").insert({ session_id: r.data.id, member_id: m, token_slot: 1, ticket_nonce: nonceOf() });
            expect(ins.error).toBeNull();
          }
        } finally {
          expect((await closeSession(admin, r.data.id)).ok).toBe(true);
        }
        return r.data.id;
      };
      const designSession = await closedSessionFor("design_team", "Cuenta Design");
      const generalSession = await closedSessionFor("remar_construction", "Cuenta General");

      const rows = await admin.from("session_attendance").select("session_id, member_id, for_member, counts_toward_rate, status, session_audience").in("session_id", [designSession, generalSession]);
      expect(rows.error).toBeNull();
      const pick = (session: string, member: string | undefined) => (rows.data ?? []).find((r) => r.session_id === session && r.member_id === member);
      // Los DOS asistieron a las dos reuniones, pero solo cuenta la de su grupo.
      expect(pick(designSession, dm.data?.id)).toMatchObject({ for_member: true, counts_toward_rate: true, status: "present", session_audience: "design_team" });
      expect(pick(generalSession, dm.data?.id)).toMatchObject({ for_member: false, counts_toward_rate: false, status: "present" });
      expect(pick(generalSession, gm.data?.id)).toMatchObject({ for_member: true, counts_toward_rate: true, status: "present" });
      expect(pick(designSession, gm.data?.id)).toMatchObject({ for_member: false, counts_toward_rate: false, status: "present" });

      const counts = await admin.from("member_attendance").select("member_id, counted_meetings, attended_meetings").in("member_id", [dm.data?.id, gm.data?.id]);
      expect(counts.error).toBeNull();
      for (const c of counts.data ?? []) expect(c.attended_meetings).toBeLessThanOrEqual(c.counted_meetings);
      // Migración 13: en la reunión de Design Team solo cuenta el miembro del Design Team; el miembro general que también hizo check-in
      // NO infla present_count (antes daba 2). Presentes <= esperados y el porcentaje va de 0 a 100.
      const summary = await admin.from("session_attendance_summary").select("present_count, expected_count, rate").eq("session_id", designSession).single();
      expect(summary.data?.present_count).toBe(1);
      expect(summary.data?.expected_count).toBeGreaterThanOrEqual(1);
      expect(summary.data?.present_count).toBeLessThanOrEqual(summary.data?.expected_count as number);
      expect(summary.data?.rate).toBeGreaterThan(0);
      expect(summary.data?.rate).toBeLessThanOrEqual(100);
    });

    it("las vistas de asistencia siguen siendo solo para administradores: anon y service_role, no", async () => {
      for (const view of ["session_attendance", "member_attendance", "session_attendance_summary"]) {
        expect((await anon.from(view).select("*").limit(1)).error?.code, view).toBe(PERMISSION_DENIED);
        expect((await svc.from(view).select("*").limit(1)).error?.code, view).toBe(PERMISSION_DENIED);
        expect((await admin.from(view).select("*").limit(1)).error, view).toBeNull();
      }
    });
  });
});
