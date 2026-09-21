/**
 * Envío del check-in del estudiante: ticket + ASCE ID + Name. Núcleo PURO: la hora, las claves y el acceso a la base de datos se
 * INYECTAN (`store`), así que se prueba a fondo sin red y el navegador no decide nada.
 *
 *   QR válido ──▶ ticket vigente (3 min, firmado) ──▶ sesión `active` en la BD ──▶ límites de intentos
 *     ──▶ identidad del miembro (ASCE ID + Name, o el dispositivo recordado) ──▶ miembro ACTIVO ──▶ INSERT
 *
 * La identidad puede venir de DOS credenciales, y ninguna se salta el resto de la cadena:
 *   - `identity`: ASCE ID + Name (el nombre es un secreto DÉBIL a propósito).
 *   - `device`: el token de "Remember me" de este dispositivo (cookie HttpOnly; aquí llega ya como HMAC). Solo dice QUIÉN es el
 *     miembro: el ticket sigue siendo obligatorio, la sesión sigue activa, el miembro sigue activo y sigue habiendo una
 *     asistencia por miembro y sesión. Un token inexistente, caducado, revocado o de un miembro inactivo cuenta como fallo y
 *     se pide ASCE ID + Name de nuevo (`device_unrecognized`).
 *
 * SEGURIDAD:
 *  - Estar frente al QR sigue siendo la puerta: sin un ticket auténtico y vigente de una sesión activa no se llega a mirar a nadie.
 *  - Límites de FALLOS: por ticket, por ASCE ID y por IP (HMAC, nunca la IP en claro). Superarlos devuelve `rate_limited`.
 *  - ANTI-ENUMERACIÓN: ASCE ID inexistente, miembro inactivo y nombre incorrecto devuelven EXACTAMENTE lo mismo
 *    (`bad_credentials`) y hacen el mismo trabajo (una consulta de miembro + un registro de intento). Solo el registro
 *    interno distingue `member_inactive`.
 *  - Una asistencia por miembro y sesión (UNIQUE en la BD) y un ticket produce como máximo UN check-in (UNIQUE de nonce).
 *  - Cada intento con un ticket auténtico queda en `checkin_attempts` (auditoría y base de los límites).
 */
import { checkTicket, type LoadSession } from "@/lib/checkin/gate";
import { isDeviceUsable } from "@/lib/device-token";
import { nameMatches } from "@/lib/member-name";

export type AttemptOutcome =
  | "success"
  | "bad_credentials"
  | "member_inactive"
  | "ticket_invalid"
  | "ticket_expired"
  | "session_not_active"
  | "already_checked_in"
  | "rate_limited";

export interface AttemptRecord {
  outcome: AttemptOutcome;
  sessionId: string | null;
  /** ASCE ID escrito (normalizado). `null` si se identificó con el dispositivo recordado. */
  asceId: string | null;
  nonce: string | null;
  ipHash: string | null;
}

export interface NewCheckin {
  sessionId: string;
  memberId: string;
  tokenSlot: number;
  nonce: string;
  ipHash: string | null;
}

export type InsertCheckinResult =
  | { ok: true; checkedInAt: string }
  | { ok: false; kind: "already_checked_in" | "ticket_reused" | "session_not_active" | "member_not_active" };

export interface MemberRecord {
  id: string;
  name: string;
  active: boolean;
}

/** Un dispositivo recordado tal como lo guarda la BD (la decisión de si sigue valiendo la toma `submitCheckin`, con la hora del servidor). */
export interface DeviceRecord {
  deviceId: string;
  createdAtMs: number;
  expiresAtMs: number;
  revoked: boolean;
  member: MemberRecord;
}

/** Cómo se identifica quien envía. */
export type Credential = { kind: "identity"; asceId: string; name: string } | { kind: "device"; tokenHash: string };

/** Todo el acceso a datos que necesita el envío (en producción, `service_role`; en pruebas, un doble). */
export interface CheckinStore {
  loadSession: LoadSession;
  findMember(asceId: string): Promise<MemberRecord | null>;
  /** Busca un dispositivo recordado por el HMAC de su token (o `null`). Un token desconocido no tiene fila. */
  findDevice(tokenHash: string): Promise<DeviceRecord | null>;
  /** Renueva la caducidad del dispositivo tras un check-in correcto (última vez usado = ahora). */
  touchDevice(deviceId: string, createdAtMs: number, nowMs: number): Promise<void>;
  /** Fallos (bad_credentials + member_inactive) desde `sinceMs` (hora del servidor) para ese ticket, ASCE ID o IP. */
  countFailures(by: "ticket" | "asce_id" | "ip", value: string, sinceMs: number): Promise<number>;
  recordAttempt(attempt: AttemptRecord): Promise<void>;
  /** Devuelve un resultado para las violaciones ESPERADAS de restricciones; cualquier otro error debe lanzar. */
  insertCheckin(row: NewCheckin): Promise<InsertCheckinResult>;
}

export interface CheckinLimits {
  perTicket: { max: number; windowMs: number };
  perAsceId: { max: number; windowMs: number };
  perIp: { max: number; windowMs: number };
}

/** Fallos permitidos ANTES de bloquear. La ventana por ticket es su propia vida (3 min por defecto). */
export const DEFAULT_LIMITS = {
  perTicket: { max: 5 },
  perAsceId: { max: 8, windowMs: 15 * 60_000 },
  perIp: { max: 20, windowMs: 15 * 60_000 },
} as const;

export type CheckinFailure = "bad_credentials" | "device_unrecognized" | "already_checked_in" | "ticket_expired" | "ticket_invalid" | "session_closed" | "rate_limited";

export type CheckinResult =
  | {
      ok: true;
      checkedInAt: string;
      session: { id: string; title: string };
      /** El miembro identificado (nombre REGISTRADO) y, si entró con un dispositivo recordado, cuál. */
      member: { id: string; name: string };
      deviceId?: string;
    }
  | { ok: false; reason: CheckinFailure };

export async function submitCheckin(args: {
  /** Ticket recibido en el CUERPO de la petición (nunca cookie ni URL). */
  ticket: unknown;
  /** Ya validada (formato): ASCE ID + Name normalizados, o el HMAC del token del dispositivo recordado. */
  credential: Credential;
  ipHash: string | null;
  /** Hora del SERVIDOR. */
  now: number;
  ticketKey: Buffer;
  ticketTtlMs: number;
  store: CheckinStore;
  limits?: { perTicket: { max: number }; perAsceId: { max: number; windowMs: number }; perIp: { max: number; windowMs: number } };
}): Promise<CheckinResult> {
  const { ticket, credential, ipHash, now, ticketKey, ticketTtlMs, store } = args;
  const limits = args.limits ?? DEFAULT_LIMITS;
  const asceId = credential.kind === "identity" ? credential.asceId : null;

  // 1. Ticket: autenticidad, vigencia de 3 min y sesión `active` en la BD.
  const t = await checkTicket({ ticket, now, ticketKey, ticketTtlMs, loadSession: store.loadSession });
  if (!t.ok) {
    if (t.reason === "invalid") return { ok: false, reason: "ticket_invalid" }; // no auténtico: no se escribe nada (evita amplificar escrituras)
    const outcome: AttemptOutcome = t.reason === "expired" ? "ticket_expired" : "session_not_active";
    await store.recordAttempt({ outcome, sessionId: null, asceId, nonce: null, ipHash });
    return { ok: false, reason: t.reason === "expired" ? "ticket_expired" : "session_closed" };
  }

  // 2. Límites de fallos (por ticket, por ASCE ID y por IP). No se registra el bloqueo: cada fallo previo ya quedó registrado.
  const overTicket = (await store.countFailures("ticket", t.nonce, now - ticketTtlMs)) >= limits.perTicket.max;
  const overAsceId = asceId !== null && (await store.countFailures("asce_id", asceId, now - limits.perAsceId.windowMs)) >= limits.perAsceId.max;
  const overIp = ipHash !== null && (await store.countFailures("ip", ipHash, now - limits.perIp.windowMs)) >= limits.perIp.max;
  if (overTicket || overAsceId || overIp) return { ok: false, reason: "rate_limited" };

  const attempt = (outcome: AttemptOutcome): AttemptRecord => ({ outcome, sessionId: t.sessionId, asceId, nonce: t.nonce, ipHash });

  // 3. Identidad. ASCE ID + Name: miembro EXISTENTE, ACTIVO y con ese nombre (los tres fallos son indistinguibles hacia fuera).
  //    Dispositivo recordado: token vigente (no revocado ni caducado) de un miembro ACTIVO.
  let member: MemberRecord;
  let device: DeviceRecord | null = null;
  if (credential.kind === "identity") {
    const found = await store.findMember(credential.asceId);
    if (!found || !found.active || !nameMatches(credential.name, found.name)) {
      await store.recordAttempt(attempt(found && !found.active ? "member_inactive" : "bad_credentials"));
      return { ok: false, reason: "bad_credentials" };
    }
    member = found;
  } else {
    device = await store.findDevice(credential.tokenHash);
    if (!device || !isDeviceUsable(device, now) || !device.member.active) {
      await store.recordAttempt(attempt(device && !device.member.active ? "member_inactive" : "bad_credentials"));
      return { ok: false, reason: "device_unrecognized" };
    }
    member = device.member;
  }

  // 4. Asistencia: la BD impone una por miembro y sesión, un ticket por check-in y sesión/miembro activos (triggers).
  const inserted = await store.insertCheckin({ sessionId: t.sessionId, memberId: member.id, tokenSlot: t.tokenSlot, nonce: t.nonce, ipHash });
  if (inserted.ok) {
    await store.recordAttempt(attempt("success"));
    // Renovar el dispositivo es una comodidad: si falla, la asistencia ya está registrada y no debe deshacerse ni reportarse como error.
    if (device) await store.touchDevice(device.deviceId, device.createdAtMs, now).catch(() => undefined);
    return {
      ok: true,
      checkedInAt: inserted.checkedInAt,
      session: { id: t.session.id, title: t.session.title },
      member: { id: member.id, name: member.name },
      deviceId: device?.deviceId,
    };
  }
  switch (inserted.kind) {
    case "already_checked_in":
      await store.recordAttempt(attempt("already_checked_in"));
      return { ok: false, reason: "already_checked_in" };
    case "ticket_reused":
      await store.recordAttempt(attempt("ticket_invalid"));
      return { ok: false, reason: "ticket_invalid" };
    case "session_not_active":
      await store.recordAttempt(attempt("session_not_active"));
      return { ok: false, reason: "session_closed" };
    case "member_not_active":
      await store.recordAttempt(attempt("member_inactive"));
      return { ok: false, reason: credential.kind === "device" ? "device_unrecognized" : "bad_credentials" };
  }
}
