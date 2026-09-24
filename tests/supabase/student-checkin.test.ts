/**
 * Check-in del estudiante (ASCE ID + Name, SIN PIN) contra Supabase REAL: éxito, nombre incorrecto, ASCE ID inexistente, miembro
 * inactivo, duplicados, ticket caducado, sesión cerrada, QR/ticket inválido, límites de intentos y auditoría de intentos.
 *
 *   npm run test:supabase -- student-checkin      (después de scripts/supabase-validation/prepare.mjs)
 *
 * Usa el MISMO código que la aplicación (src/lib/checkin/submit.ts + el almacén con service_role de src/lib/checkin/server.ts).
 * Todos los ASCE ID de prueba empiezan por ZZVAL-, así que tests/supabase/cleanup.sql (miembros, check-ins e intentos) los limpia.
 * Si ya hay una sesión ACTIVA que no es de validación, ABORTA sin tocarla. No imprime claves.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { redeemQr } from "@/lib/checkin/gate";
import {
  createServiceCheckinStore,
  hashIp,
  loadSessionAsService,
  lookupRememberedMember,
  rememberDeviceOnServer,
  revokeDeviceOnServer,
  submitCheckInOnServer,
} from "@/lib/checkin/server";
import { DEFAULT_LIMITS, submitCheckin } from "@/lib/checkin/submit";
import { appKeys } from "@/lib/crypto/server-keys";
import { closeSession, createAndStartSession, getSessionLive } from "@/lib/data/sessions";
import { todayInElPaso } from "@/lib/dates";
import { serverEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { hashDeviceToken } from "@/lib/device-token";
import { issueQrTokens } from "@/lib/tokens";
import { parseSessionForm } from "@/lib/validation/session";
import { loadState, type ValidationState } from "./state";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;
const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };
const PREFIX = "[VALIDACIÓN]";
const RAW_IP = "203.0.113.10"; // documentación (TEST-NET-3): la IP en claro NUNCA debe aparecer en la base de datos

const rid = () => randomBytes(4).toString("hex").toUpperCase();

describe("Supabase REAL: check-in del estudiante (ASCE ID + Name)", () => {
  let state: ValidationState;
  let admin: SupabaseClient;
  let anon: SupabaseClient;
  let svc: SupabaseClient;
  let sessionId: string;

  const ids = { max: `ZZVAL-MAX${rid()}`, lily: `ZZVAL-LILY${rid()}`, sam: `ZZVAL-SAM${rid()}`, old: `ZZVAL-OLD${rid()}`, ghost: `ZZVAL-NONE${rid()}` };
  let maxMemberId: string;
  let usedTicket: string;

  const env = () => serverEnv();
  const ticketTtl = () => env().TICKET_TTL_SECONDS * 1000;
  const qr = () => issueQrTokens({ key: appKeys().qr, sessionId, now: Date.now() }).current.token;
  const newTicket = async (): Promise<string> => {
    const r = await redeemQr({ token: qr(), now: Date.now(), qrKey: appKeys().qr, ticketKey: appKeys().ticket, graceMs: env().QR_GRACE_MS, ticketTtlMs: ticketTtl(), loadSession: loadSessionAsService });
    if (!r.ok) throw new Error(`se esperaba un ticket: ${r.reason}`);
    return r.ticket;
  };
  /** Envío con la hora real y el almacén real; `now`/`ip` se pueden fijar para probar caducidad y límites. */
  const submit = (ticket: unknown, asceId: string, name: string, opts: { now?: number; ip?: string | null } = {}) =>
    submitCheckin({
      ticket,
      credential: { kind: "identity", asceId, name },
      ipHash: hashIp(opts.ip === undefined ? RAW_IP : opts.ip),
      now: opts.now ?? Date.now(),
      ticketKey: appKeys().ticket,
      ticketTtlMs: ticketTtl(),
      store: createServiceCheckinStore(),
    });
  const attemptsOf = async (asceId: string) => {
    const r = await svc.from("checkin_attempts").select("outcome, session_id, ticket_nonce, ip_hash, asce_id_tried").eq("asce_id_tried", asceId).order("id");
    expect(r.error).toBeNull();
    return (r.data ?? []) as Array<{ outcome: string; session_id: string | null; ticket_nonce: string | null; ip_hash: string | null; asce_id_tried: string }>;
  };
  const checkinsOf = async (memberId: string) => {
    const r = await svc.from("checkins").select("id, session_id, token_slot, ticket_nonce, ip_hash").eq("member_id", memberId).eq("session_id", sessionId);
    expect(r.error).toBeNull();
    return r.data ?? [];
  };

  async function closeOurActive() {
    const r = await svc.from("sessions").select("id, title").eq("status", "active");
    for (const s of (r.data ?? []) as Array<{ id: string; title: string }>) {
      if (s.title.startsWith(PREFIX)) await admin.from("sessions").update({ status: "closed" }).eq("id", s.id);
    }
  }

  beforeAll(async () => {
    state = loadState();
    admin = createClient(URL_, ANON_KEY, CLIENT_OPTS);
    anon = createClient(URL_, ANON_KEY, CLIENT_OPTS);
    svc = createServiceRoleClient();
    const a = await admin.auth.signInWithPassword({ email: state.admin.email, password: state.admin.password });
    expect(a.error, "login del administrador temporal").toBeNull();

    const active = await svc.from("sessions").select("id, title").eq("status", "active");
    const foreign = ((active.data ?? []) as Array<{ id: string; title: string }>).filter((s) => !s.title.startsWith(PREFIX));
    if (foreign.length > 0) throw new Error(`ABORTADO sin modificar nada: hay una sesión ACTIVA que no es de validación («${foreign[0].title}»). Ciérrala desde el panel y repite.`);
    await closeOurActive();

    const insert = async (asceId: string, name: string) => {
      const r = await admin.from("members").insert({ asce_id: asceId, name }).select("id").single();
      expect(r.error, `crear ${asceId}`).toBeNull();
      return r.data?.id as string;
    };
    maxMemberId = await insert(ids.max, "Max Verstappen");
    await insert(ids.lily, "Lily Nguyen");
    await insert(ids.sam, "María José Pérez");
    const oldId = await insert(ids.old, "Old Member");
    expect((await admin.from("members").update({ active: false, deactivated_on: todayInElPaso() }).eq("id", oldId)).error, "desactivar").toBeNull();

    const fd = new FormData();
    fd.set("title", `${PREFIX} Check-in del estudiante`);
    fd.set("audience", "remar_construction");
    const parsed = parseSessionForm(fd);
    if (!parsed.ok) throw new Error("entrada inválida");
    const s = await createAndStartSession(admin, parsed.data); // "Start Check-In": crea la sesión YA activa
    if (!s.ok) throw new Error("no se pudo crear la sesión");
    sessionId = s.data.id;
    expect(s.data.status).toBe("active");
  });

  afterAll(async () => {
    if (admin) await closeOurActive();
    // Los dispositivos recordados de prueba se borran aquí mismo (service_role puede): así no dependen de tests/supabase/cleanup.sql.
    if (svc) {
      const members = await svc.from("members").select("id").like("asce_id", "ZZVAL-%");
      const memberIds = ((members.data ?? []) as Array<{ id: string }>).map((m) => m.id);
      if (memberIds.length > 0) await svc.from("member_devices").delete().in("member_id", memberIds);
    }
  });

  // ===========================================================================================
  describe("A. ASCE ID + Name correctos", () => {
    it("registra la asistencia; 'Max' basta para 'Max Verstappen'; el intento queda auditado sin la IP en claro", async () => {
      usedTicket = await newTicket();
      const r = await submit(usedTicket, ids.max, "Max");
      expect(r).toMatchObject({ ok: true, session: { id: sessionId } });

      const rows = await checkinsOf(maxMemberId);
      expect(rows).toHaveLength(1);
      expect(rows[0].ip_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].ip_hash).toBe(hashIp(RAW_IP));

      const attempts = await attemptsOf(ids.max);
      expect(attempts.map((x) => x.outcome)).toEqual(["success"]);
      expect(attempts[0]).toMatchObject({ session_id: sessionId, ticket_nonce: rows[0].ticket_nonce });
      expect(JSON.stringify([rows, attempts])).not.toContain(RAW_IP); // solo el HMAC de la IP
    });

    it("la asistencia aparece en la API de asistencia en vivo del administrador (solo nombre, cargo y hora)", async () => {
      const live = await getSessionLive(admin, sessionId);
      expect(live.ok).toBe(true);
      if (!live.ok) return;
      expect(live.data.count).toBe(1);
      expect(live.data.attendees[0]).toMatchObject({ name: "Max Verstappen", position: "Member" });
      expect(JSON.stringify(live)).not.toMatch(/pin|scrypt|asce_id|ZZVAL/i);
    });

    it("insensible a mayúsculas y acentos: 'maria jose' entra como 'María José Pérez'", async () => {
      expect((await submit(await newTicket(), ids.sam, "maria jose")).ok).toBe(true);
    });

    it("no interviene ningún PIN: la columna ya no existe; el envío solo lee id, name y active", async () => {
      const r = await svc.from("members").select("id, name, active").eq("asce_id", ids.lily).single(); // lo único que lee el envío
      expect(Object.keys(r.data ?? {}).sort()).toEqual(["active", "id", "name"]);
      expect((await svc.from("members").select("pin_hash").limit(1)).error, "la columna pin_hash se eliminó").not.toBeNull();
      const viaApi = await submitCheckInOnServer({ ticket: await newTicket(), credential: { kind: "identity", asceId: ids.lily, name: "Lily" }, ip: null });
      expect(viaApi.ok).toBe(true); // el punto de entrada de producción, sin PIN
    });
  });

  // ===========================================================================================
  describe("B. Rechazos", () => {
    it("NOMBRE INCORRECTO: rechazo genérico, sin asistencia, intento registrado", async () => {
      const id = `ZZVAL-BAD${rid()}`;
      await admin.from("members").insert({ asce_id: id, name: "Zed Person" });
      const r = await submit(await newTicket(), id, "Lewis");
      expect(r).toEqual({ ok: false, reason: "bad_credentials" });
      expect((await attemptsOf(id)).map((a) => a.outcome)).toEqual(["bad_credentials"]);
      const m = await svc.from("members").select("id").eq("asce_id", id).single();
      expect(await checkinsOf(m.data?.id as string)).toHaveLength(0);
    });

    it("ASCE ID INEXISTENTE, nombre incorrecto y miembro INACTIVO devuelven EXACTAMENTE lo mismo (no se puede enumerar)", async () => {
      const wrong = await submit(await newTicket(), ids.lily, "Nobody"); // (Lily ya entró, pero el nombre falla ANTES)
      const ghost = await submit(await newTicket(), ids.ghost, "Max");
      const inactive = await submit(await newTicket(), ids.old, "Old Member"); // inactivo con el nombre CORRECTO
      expect(wrong).toEqual({ ok: false, reason: "bad_credentials" });
      expect(ghost).toEqual(wrong);
      expect(inactive).toEqual(wrong);
      expect((await attemptsOf(ids.ghost)).map((a) => a.outcome)).toEqual(["bad_credentials"]);
      expect((await attemptsOf(ids.old)).map((a) => a.outcome)).toEqual(["member_inactive"]); // solo el registro interno distingue
      const old = await svc.from("members").select("id").eq("asce_id", ids.old).single();
      expect(await checkinsOf(old.data?.id as string)).toHaveLength(0);
    });

    it("DUPLICADO: el mismo miembro no puede registrarse dos veces en la sesión (UNIQUE de la BD)", async () => {
      expect(await submit(await newTicket(), ids.max, "Max")).toEqual({ ok: false, reason: "already_checked_in" });
      expect(await checkinsOf(maxMemberId)).toHaveLength(1);
      expect((await attemptsOf(ids.max)).map((a) => a.outcome)).toEqual(["success", "already_checked_in"]);
    });

    it("ANTI-REPLAY: el ticket ya usado no sirve para otro miembro (UNIQUE de nonce en la BD)", async () => {
      const id = `ZZVAL-RE${rid()}`;
      await admin.from("members").insert({ asce_id: id, name: "Rey Play" });
      expect(await submit(usedTicket, id, "Rey")).toEqual({ ok: false, reason: "ticket_invalid" });
      const m = await svc.from("members").select("id").eq("asce_id", id).single();
      expect(await checkinsOf(m.data?.id as string)).toHaveLength(0);
    });

    it("TICKET CADUCADO (más de 3 min con la hora del servidor): rechazado, registrado, sin asistencia", async () => {
      const id = `ZZVAL-EXP${rid()}`;
      await admin.from("members").insert({ asce_id: id, name: "Exp Ired" });
      const ticket = await newTicket();
      expect(await submit(ticket, id, "Exp", { now: Date.now() + ticketTtl() + 1_000 })).toEqual({ ok: false, reason: "ticket_expired" });
      expect((await attemptsOf(id)).map((a) => a.outcome)).toEqual(["ticket_expired"]);
      expect((await submit(ticket, id, "Exp")).ok).toBe(true); // el mismo ticket aún valía a la hora real
    });

    it("QR/TICKET INVÁLIDO (alterado, basura, token QR): 'ticket_invalid' y NO se escribe nada", async () => {
      const good = await newTicket();
      const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
      const before = await attemptsOf(ids.ghost);
      for (const bad of [tampered, "garbage", "", null, undefined, qr()]) {
        expect(await submit(bad, ids.ghost, "Max"), String(bad).slice(0, 10)).toEqual({ ok: false, reason: "ticket_invalid" });
      }
      expect(await attemptsOf(ids.ghost)).toHaveLength(before.length);
    });
  });

  // ===========================================================================================
  describe("C. Límites de intentos (rate limiting real, con checkin_attempts)", () => {
    it("POR TICKET: tras 5 fallos, incluso las credenciales correctas se bloquean y el bloqueo no escribe filas", async () => {
      const id = `ZZVAL-RLT${rid()}`;
      await admin.from("members").insert({ asce_id: id, name: "Rate Ticket" });
      const ticket = await newTicket();
      for (let i = 0; i < DEFAULT_LIMITS.perTicket.max; i++) expect((await submit(ticket, id, "Wrong", { ip: null })).ok).toBe(false);
      const rows = (await attemptsOf(id)).length;
      expect(await submit(ticket, id, "Rate", { ip: null })).toEqual({ ok: false, reason: "rate_limited" });
      expect(await attemptsOf(id)).toHaveLength(rows);
      const m = await svc.from("members").select("id").eq("asce_id", id).single();
      expect(await checkinsOf(m.data?.id as string)).toHaveLength(0);
      // Un ticket NUEVO (otro escaneo) no queda bloqueado por el anterior.
      expect((await submit(await newTicket(), id, "Rate", { ip: null })).ok).toBe(true);
    });

    it("POR ASCE ID: 8 fallos con tickets distintos bloquean ese ID (aunque el nombre sea el correcto)", async () => {
      const id = `ZZVAL-RLA${rid()}`;
      await admin.from("members").insert({ asce_id: id, name: "Rate Asce" });
      for (let i = 0; i < DEFAULT_LIMITS.perAsceId.max; i++) await submit(await newTicket(), id, "Wrong", { ip: null });
      expect(await submit(await newTicket(), id, "Rate", { ip: null })).toEqual({ ok: false, reason: "rate_limited" });
      // Un ID inexistente con el mismo número de fallos se bloquea IGUAL: el bloqueo no revela si el ID existe.
      const ghost = `ZZVAL-RLG${rid()}`;
      for (let i = 0; i < DEFAULT_LIMITS.perAsceId.max; i++) await submit(await newTicket(), ghost, "Wrong", { ip: null });
      expect(await submit(await newTicket(), ghost, "Rate", { ip: null })).toEqual({ ok: false, reason: "rate_limited" });
    });

    it("POR IP: 20 fallos desde la misma IP (contra IDs distintos) la bloquean; otra IP no", async () => {
      const ip = "198.51.100.77"; // TEST-NET-2
      for (let i = 0; i < DEFAULT_LIMITS.perIp.max; i++) await submit(await newTicket(), `ZZVAL-IP${rid()}`, "Wrong", { ip });
      expect(await submit(await newTicket(), ids.sam, "Maria", { ip })).toEqual({ ok: false, reason: "rate_limited" });
      const other = await submit(await newTicket(), `ZZVAL-IP${rid()}`, "Wrong", { ip: "198.51.100.78" });
      expect(other).toEqual({ ok: false, reason: "bad_credentials" });
    });
  });

  // ===========================================================================================
  describe("D. Auditoría y permisos", () => {
    it("los intentos son visibles para un administrador y NO para anon; sin la IP en claro ni tokens", async () => {
      const rows = await admin.from("checkin_attempts").select("*").eq("asce_id_tried", ids.max);
      expect(rows.error).toBeNull();
      expect((rows.data ?? []).length).toBeGreaterThanOrEqual(2);
      expect(JSON.stringify(rows.data)).not.toMatch(new RegExp(`${RAW_IP.replaceAll(".", "\\.")}|v1\\.[A-Za-z0-9_-]{22}|t1\\.[A-Za-z0-9_-]{22}`));
      expect((await anon.from("checkin_attempts").select("id").limit(1)).error?.code).toBe("42501");
    });

    it("service_role solo tiene los permisos mínimos: no puede modificar ni borrar check-ins", async () => {
      expect((await svc.from("checkins").update({ token_slot: 0 }).eq("member_id", maxMemberId)).error).not.toBeNull();
      expect((await svc.from("checkins").delete().eq("member_id", maxMemberId)).error).not.toBeNull();
    });
  });

  // ===========================================================================================
  describe("D2. Remember me on this device (migración 8)", () => {
    const newMember = async (name: string) => {
      const asceId = `ZZVAL-DEV${rid()}`;
      const r = await admin.from("members").insert({ asce_id: asceId, name }).select("id").single();
      expect(r.error, "crear miembro").toBeNull();
      return { asceId, id: r.data?.id as string, name };
    };
    // (un ticket `null`/`undefined` debe llegar TAL CUAL al envío: por eso no se usa `??`, sino un marcador explícito de "ticket nuevo")
    const viaDevice = async (token: string, ...explicitTicket: [unknown?]) =>
      submitCheckInOnServer({ ticket: explicitTicket.length === 0 ? await newTicket() : explicitTicket[0], credential: { kind: "device", token }, ip: null });
    const deviceRows = async (memberId: string) => {
      const r = await svc.from("member_devices").select("id, token_hash, expires_at, revoked_at, last_used_at").eq("member_id", memberId);
      expect(r.error).toBeNull();
      return (r.data ?? []) as Array<{ id: string; token_hash: string; expires_at: string; revoked_at: string | null; last_used_at: string | null }>;
    };

    it("primer check-in con 'Remember me': se crea un token opaco; en la BD solo queda su HMAC (jamás el token) y el miembro es reconocido", async () => {
      const m = await newMember("Dev Uno");
      const first = await submitCheckInOnServer({ ticket: await newTicket(), credential: { kind: "identity", asceId: m.asceId, name: "Dev" }, ip: null });
      expect(first.ok).toBe(true);
      const { token, maxAgeSeconds } = await rememberDeviceOnServer(m.id, null);

      expect(token).toMatch(/^d1\.[A-Za-z0-9_-]{43}$/);
      expect(maxAgeSeconds).toBeGreaterThan(179 * 86_400);
      expect(maxAgeSeconds).toBeLessThanOrEqual(180 * 86_400);
      const rows = await deviceRows(m.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].token_hash).toBe(hashDeviceToken(token, appKeys().device));
      expect(JSON.stringify(rows)).not.toContain(token.slice(3));
      expect(await lookupRememberedMember(token)).toEqual({ name: "Dev Uno" }); // la página saluda con el nombre REGISTRADO
      expect(await lookupRememberedMember("d1." + "A".repeat(43))).toBeNull();
      expect(await lookupRememberedMember("basura")).toBeNull();
    });

    it("la siguiente reunión: el dispositivo recordado registra la asistencia SIN teclear ASCE ID ni Name (con QR/ticket) y renueva su caducidad", async () => {
      const m = await newMember("Dev Dos");
      const { token } = await rememberDeviceOnServer(m.id, null);
      const before = (await deviceRows(m.id))[0];
      const r = await viaDevice(token);
      expect(r).toMatchObject({ ok: true, member: { id: m.id, name: "Dev Dos" } });
      expect(await checkinsOf(m.id)).toHaveLength(1);
      const after = (await deviceRows(m.id))[0];
      expect(after.last_used_at).not.toBeNull();
      expect(Date.parse(after.expires_at)).toBeGreaterThanOrEqual(Date.parse(before.expires_at));
      // El intento queda auditado con el resultado, sin ASCE ID (no se tecleó) ni token.
      const attempts = await svc.from("checkin_attempts").select("outcome, asce_id_tried, ticket_nonce").eq("session_id", sessionId).is("asce_id_tried", null).eq("outcome", "success");
      expect((attempts.data ?? []).length).toBeGreaterThanOrEqual(1);
    });

    it("el token NO sustituye al QR: sin ticket válido (alterado, basura, vacío) no entra ni gasta nada", async () => {
      const m = await newMember("Dev Tres");
      const { token } = await rememberDeviceOnServer(m.id, null);
      const good = await newTicket();
      const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
      for (const bad of [tampered, "garbage", "", null, undefined, qr()]) {
        expect(await viaDevice(token, bad), String(bad).slice(0, 10)).toEqual({ ok: false, reason: "ticket_invalid" });
      }
      expect(await checkinsOf(m.id)).toHaveLength(0);
    });

    it("ticket CADUCADO con un dispositivo válido: rechazado; una sola asistencia por miembro y sesión; y un ticket ya usado no vale (anti-replay)", async () => {
      const m = await newMember("Dev Cuatro");
      const { token } = await rememberDeviceOnServer(m.id, null);
      const ticket = await newTicket();
      const expired = await submitCheckin({
        ticket,
        credential: { kind: "device", tokenHash: hashDeviceToken(token, appKeys().device) },
        ipHash: null,
        now: Date.now() + ticketTtl() + 1_000,
        ticketKey: appKeys().ticket,
        ticketTtlMs: ticketTtl(),
        store: createServiceCheckinStore(),
      });
      expect(expired).toEqual({ ok: false, reason: "ticket_expired" });
      expect((await viaDevice(token, ticket)).ok).toBe(true); // el mismo ticket aún valía a la hora real
      expect(await viaDevice(token)).toEqual({ ok: false, reason: "already_checked_in" }); // ticket nuevo, mismo miembro
      const other = await newMember("Dev Cinco");
      const otherDevice = await rememberDeviceOnServer(other.id, null);
      expect(await viaDevice(otherDevice.token, ticket)).toEqual({ ok: false, reason: "ticket_invalid" }); // ticket ya gastado
      expect(await checkinsOf(m.id)).toHaveLength(1);
      expect(await checkinsOf(other.id)).toHaveLength(0);
    });

    it("token inventado o de otro formato: 'device_unrecognized' y no se escribe asistencia", async () => {
      const r = await submitCheckInOnServer({ ticket: await newTicket(), credential: { kind: "device", token: "d1." + "Z".repeat(43) }, ip: null });
      expect(r).toEqual({ ok: false, reason: "device_unrecognized" });
    });

    it("REVOCADO ('Not you? Switch member'): el token deja de valer y el miembro debe identificarse otra vez", async () => {
      const m = await newMember("Dev Seis");
      const { token } = await rememberDeviceOnServer(m.id, null);
      await revokeDeviceOnServer(token);
      expect((await deviceRows(m.id))[0].revoked_at).not.toBeNull();
      expect(await lookupRememberedMember(token)).toBeNull();
      expect(await viaDevice(token)).toEqual({ ok: false, reason: "device_unrecognized" });
      expect(await checkinsOf(m.id)).toHaveLength(0);
      // ...y con ASCE ID + Name sí puede (el flujo normal sigue igual).
      expect((await submit(await newTicket(), m.asceId, "Dev")).ok).toBe(true);
    });

    it("CADUCADO: un dispositivo pasado de fecha ya no reconoce a nadie", async () => {
      const m = await newMember("Dev Siete");
      const { token } = await rememberDeviceOnServer(m.id, null);
      const row = (await deviceRows(m.id))[0];
      // (created_at + 1 s: la BD exige expires_at > created_at, así que se caduca poniendo la creación aún más atrás)
      expect((await svc.from("member_devices").update({ created_at: new Date(Date.now() - 2 * 86_400_000).toISOString(), expires_at: new Date(Date.now() - 86_400_000).toISOString() }).eq("id", row.id)).error).toBeNull();
      expect(await lookupRememberedMember(token)).toBeNull();
      expect(await viaDevice(token)).toEqual({ ok: false, reason: "device_unrecognized" });
      expect(await checkinsOf(m.id)).toHaveLength(0);
    });

    it("miembro INACTIVO: desactivarlo revoca sus dispositivos (trigger) y no entra; reactivarlo NO los revive", async () => {
      const m = await newMember("Dev Ocho");
      const { token } = await rememberDeviceOnServer(m.id, null);
      expect((await admin.from("members").update({ active: false, deactivated_on: todayInElPaso() }).eq("id", m.id)).error).toBeNull();
      expect((await deviceRows(m.id))[0].revoked_at).not.toBeNull();
      expect(await lookupRememberedMember(token)).toBeNull();
      expect(await viaDevice(token)).toEqual({ ok: false, reason: "device_unrecognized" });
      expect((await admin.from("members").update({ active: true, deactivated_on: null }).eq("id", m.id)).error).toBeNull();
      expect(await viaDevice(token)).toEqual({ ok: false, reason: "device_unrecognized" });
      expect(await checkinsOf(m.id)).toHaveLength(0);
    });

    it("cambiar de miembro en el mismo dispositivo: el token anterior queda revocado y solo el nuevo vale; máximo 5 dispositivos vigentes por miembro", async () => {
      const a = await newMember("Dev Nueve");
      const b = await newMember("Dev Diez");
      const first = await rememberDeviceOnServer(a.id, null);
      const second = await rememberDeviceOnServer(b.id, first.token); // mismo teléfono, otro miembro
      expect(await lookupRememberedMember(first.token)).toBeNull();
      expect(await lookupRememberedMember(second.token)).toEqual({ name: "Dev Diez" });

      const many = await newMember("Dev Once");
      const tokens: string[] = [];
      for (let i = 0; i < 7; i++) tokens.push((await rememberDeviceOnServer(many.id, null)).token);
      const active = (await deviceRows(many.id)).filter((d) => d.revoked_at === null);
      expect(active).toHaveLength(5);
      expect(await lookupRememberedMember(tokens[0])).toBeNull(); // los más antiguos se revocaron
      expect(await lookupRememberedMember(tokens[6])).toEqual({ name: "Dev Once" });
    });

    it("rate limiting: tokens malos repetidos con el mismo ticket bloquean incluso a un dispositivo válido", async () => {
      const m = await newMember("Dev Doce");
      const { token } = await rememberDeviceOnServer(m.id, null);
      const ticket = await newTicket();
      for (let i = 0; i < DEFAULT_LIMITS.perTicket.max; i++) {
        expect(await viaDevice("d1." + String.fromCharCode(65 + i).repeat(43), ticket)).toEqual({ ok: false, reason: "device_unrecognized" });
      }
      expect(await viaDevice(token, ticket)).toEqual({ ok: false, reason: "rate_limited" });
      expect(await checkinsOf(m.id)).toHaveLength(0);
    });

    it("member_devices no es visible para anon ni para administradores (solo service_role)", async () => {
      expect((await anon.from("member_devices").select("id").limit(1)).error?.code).toBe("42501");
      expect((await admin.from("member_devices").select("id").limit(1)).error?.code).toBe("42501");
    });
  });

  // ===========================================================================================
  describe("E. Sesión cerrada", () => {
    it("al cerrar la sesión, un ticket auténtico y vigente ya no registra asistencia: 'session_closed'", async () => {
      const ticket = await newTicket();
      const id = `ZZVAL-CLS${rid()}`;
      await admin.from("members").insert({ asce_id: id, name: "Closed Case" });
      expect((await closeSession(admin, sessionId)).ok).toBe(true);

      expect(await submit(ticket, id, "Closed")).toEqual({ ok: false, reason: "session_closed" });
      expect((await attemptsOf(id)).map((a) => a.outcome)).toEqual(["session_not_active"]);
      const m = await svc.from("members").select("id").eq("asce_id", id).single();
      expect(await checkinsOf(m.data?.id as string)).toHaveLength(0);

      // Tampoco entra por el punto de entrada de producción.
      expect(await submitCheckInOnServer({ ticket, credential: { kind: "identity", asceId: id, name: "Closed" }, ip: null })).toEqual({ ok: false, reason: "session_closed" });
    });
  });
});
