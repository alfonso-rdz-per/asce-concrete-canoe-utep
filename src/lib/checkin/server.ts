import "server-only";
import { checkTicket, redeemQr, type GateSession, type LoadSession } from "@/lib/checkin/gate";
import { submitCheckin, type CheckinStore, type DeviceRecord, type InsertCheckinResult } from "@/lib/checkin/submit";
import { appKeys } from "@/lib/crypto/server-keys";
import { hmacSha256 } from "@/lib/crypto/keys";
import {
  deviceExpiryMs,
  generateDeviceToken,
  hashDeviceToken,
  isDeviceTokenFormat,
  isDeviceUsable,
  MAX_DEVICES_PER_MEMBER,
} from "@/lib/device-token";
import { serverEnv } from "@/lib/env";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { systemClock } from "@/lib/time";

/**
 * Cableado de producción de la puerta de check-in: hora del SERVIDOR, claves derivadas de los secretos de entorno y
 * lectura/escritura con `service_role` (el estudiante nunca habla con Supabase). Solo servidor.
 */
export const loadSessionAsService: LoadSession = async (sessionId) => {
  const { data, error } = await createServiceRoleClient()
    .from("sessions")
    .select("id, title, location, status")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw new Error("No se pudo leer la sesión."); // sin detalles: ni claves ni mensajes de la base de datos
  return (data as GateSession | null) ?? null;
};

export function redeemQrOnServer(token: unknown) {
  const env = serverEnv();
  const keys = appKeys();
  return redeemQr({
    token,
    now: systemClock.now(),
    qrKey: keys.qr,
    ticketKey: keys.ticket,
    graceMs: env.QR_GRACE_MS,
    ticketTtlMs: env.TICKET_TTL_SECONDS * 1000,
    loadSession: loadSessionAsService,
  });
}

export function checkTicketOnServer(ticket: unknown) {
  const env = serverEnv();
  return checkTicket({
    ticket,
    now: systemClock.now(),
    ticketKey: appKeys().ticket,
    ticketTtlMs: env.TICKET_TTL_SECONDS * 1000,
    loadSession: loadSessionAsService,
  });
}

/** HMAC de la IP (hex de 64 caracteres, lo que exige la BD): nunca se guarda la IP en claro. `null` si no hay IP. */
export function hashIp(ip: string | null): string | null {
  if (!ip) return null;
  return hmacSha256(appKeys().ip, `asce/ip/v1|${ip}`).toString("hex");
}

/**
 * Dispositivos recordados ("Remember me"). Solo se guarda el HMAC del token; la tabla solo la lee `service_role`.
 * Ninguna de estas funciones devuelve el token, su hash ni el ASCE ID del miembro.
 */
async function findDeviceRow(tokenHash: string): Promise<DeviceRecord | null> {
  const { data, error } = await createServiceRoleClient()
    .from("member_devices")
    .select("id, created_at, expires_at, revoked_at, members!inner(id, name, active)")
    .eq("token_hash", tokenHash)
    .maybeSingle();
  if (error) throw new Error("No se pudo leer el dispositivo.");
  if (!data) return null;
  const row = data as unknown as {
    id: string;
    created_at: string;
    expires_at: string;
    revoked_at: string | null;
    members: { id: string; name: string; active: boolean } | Array<{ id: string; name: string; active: boolean }>;
  };
  const member = Array.isArray(row.members) ? row.members[0] : row.members;
  if (!member) return null;
  return {
    deviceId: row.id,
    createdAtMs: Date.parse(row.created_at),
    expiresAtMs: Date.parse(row.expires_at),
    revoked: row.revoked_at !== null,
    member,
  };
}

/** Miembro reconocido por el token de la cookie (para saludarlo en la página), o `null`. Nunca lanza por un token malo. */
export async function lookupRememberedMember(token: string | null | undefined): Promise<{ name: string } | null> {
  if (!isDeviceTokenFormat(token)) return null;
  const device = await findDeviceRow(hashDeviceToken(token, appKeys().device));
  if (!device || !device.member.active || !isDeviceUsable(device, systemClock.now())) return null;
  return { name: device.member.name };
}

/** Revoca el dispositivo de ese token (no falla si no existe). "Not you? Switch member". */
export async function revokeDeviceOnServer(token: string | null | undefined): Promise<void> {
  if (!isDeviceTokenFormat(token)) return;
  const { error } = await createServiceRoleClient()
    .from("member_devices")
    .update({ revoked_at: new Date(systemClock.now()).toISOString() })
    .eq("token_hash", hashDeviceToken(token, appKeys().device))
    .is("revoked_at", null);
  if (error) throw new Error("No se pudo revocar el dispositivo.");
}

const PURGE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Registra este dispositivo para el miembro (tras un check-in CORRECTO con "Remember me"). Revoca el token anterior de esta cookie
 * (si lo había: no se acumulan), conserva como máximo `MAX_DEVICES_PER_MEMBER` vigentes por miembro y purga filas viejas.
 * Devuelve el token nuevo (solo para la cookie) y su vida en segundos.
 */
export async function rememberDeviceOnServer(memberId: string, previousToken: string | null | undefined): Promise<{ token: string; maxAgeSeconds: number }> {
  const sb = createServiceRoleClient();
  const now = systemClock.now();
  const key = appKeys().device;

  await revokeDeviceOnServer(previousToken);

  const token = generateDeviceToken();
  const expiresAtMs = deviceExpiryMs(now, now);
  const { error } = await sb.from("member_devices").insert({
    member_id: memberId,
    token_hash: hashDeviceToken(token, key),
    last_used_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAtMs).toISOString(),
  });
  if (error) throw new Error("No se pudo recordar el dispositivo.");

  // Mantenimiento: es opcional, así que un fallo aquí no debe impedir que el dispositivo quede recordado.
  try {
    const { data } = await sb
      .from("member_devices")
      .select("id")
      .eq("member_id", memberId)
      .is("revoked_at", null)
      .order("created_at", { ascending: false })
      .limit(50);
    const surplus = ((data ?? []) as Array<{ id: string }>).slice(MAX_DEVICES_PER_MEMBER).map((d) => d.id);
    if (surplus.length > 0) await sb.from("member_devices").update({ revoked_at: new Date(now).toISOString() }).in("id", surplus);
    const cutoff = new Date(now - PURGE_AFTER_MS).toISOString();
    await sb.from("member_devices").delete().lt("expires_at", cutoff);
    await sb.from("member_devices").delete().lt("revoked_at", cutoff);
  } catch {
    /* mantenimiento opcional */
  }

  return { token, maxAgeSeconds: Math.floor((expiresAtMs - now) / 1000) };
}

const FAILURE_OUTCOMES = ["bad_credentials", "member_inactive"];
const FAILURE_COLUMN = { ticket: "ticket_nonce", asce_id: "asce_id_tried", ip: "ip_hash" } as const;

/** Acceso a datos del envío con `service_role` (permisos mínimos: ver la migración de seguridad). */
export function createServiceCheckinStore(): CheckinStore {
  const sb = createServiceRoleClient();
  return {
    loadSession: loadSessionAsService,

    async findMember(asceId) {
      const { data, error } = await sb.from("members").select("id, name, active").eq("asce_id", asceId).maybeSingle();
      if (error) throw new Error("No se pudo leer el miembro.");
      return (data as { id: string; name: string; active: boolean } | null) ?? null;
    },

    findDevice: findDeviceRow,

    async touchDevice(deviceId, createdAtMs, nowMs) {
      const { error } = await sb
        .from("member_devices")
        .update({ last_used_at: new Date(nowMs).toISOString(), expires_at: new Date(deviceExpiryMs(nowMs, createdAtMs)).toISOString() })
        .eq("id", deviceId);
      if (error) throw new Error("No se pudo renovar el dispositivo.");
    },

    async countFailures(by, value, sinceMs) {
      const { count, error } = await sb
        .from("checkin_attempts")
        .select("id", { count: "exact", head: true })
        .in("outcome", FAILURE_OUTCOMES)
        .eq(FAILURE_COLUMN[by], value)
        .gte("at", new Date(sinceMs).toISOString());
      if (error) throw new Error("No se pudieron contar los intentos.");
      return count ?? 0;
    },

    async recordAttempt(a) {
      const { error } = await sb.from("checkin_attempts").insert({
        outcome: a.outcome,
        session_id: a.sessionId,
        asce_id_tried: a.asceId === null ? null : a.asceId.slice(0, 64),
        ticket_nonce: a.nonce,
        ip_hash: a.ipHash,
      });
      if (error) throw new Error("No se pudo registrar el intento.");
    },

    async insertCheckin(row): Promise<InsertCheckinResult> {
      const { data, error } = await sb
        .from("checkins")
        .insert({ session_id: row.sessionId, member_id: row.memberId, token_slot: row.tokenSlot, ticket_nonce: row.nonce, ip_hash: row.ipHash })
        .select("checked_in_at")
        .single();
      if (!error) return { ok: true, checkedInAt: (data as { checked_in_at: string }).checked_in_at };

      const text = `${error.message ?? ""} ${error.details ?? ""}`;
      if (error.code === "23505" && text.includes("checkins_ticket_single_use")) return { ok: false, kind: "ticket_reused" };
      if (error.code === "23505" && text.includes("checkins_one_per_member_per_session")) return { ok: false, kind: "already_checked_in" };
      if (text.includes("asce:session_not_active")) return { ok: false, kind: "session_not_active" };
      if (text.includes("asce:member_not_active")) return { ok: false, kind: "member_not_active" };
      throw new Error("No se pudo registrar la asistencia."); // sin detalles hacia fuera
    },
  };
}

/** Envío del check-in con la hora del servidor, las claves reales y `service_role`. */
export function submitCheckInOnServer(args: {
  ticket: unknown;
  /** ASCE ID + Name, o el token (ya con formato válido) de la cookie del dispositivo recordado. */
  credential: { kind: "identity"; asceId: string; name: string } | { kind: "device"; token: string };
  ip: string | null;
}) {
  const env = serverEnv();
  return submitCheckin({
    ticket: args.ticket,
    credential:
      args.credential.kind === "identity"
        ? args.credential
        : { kind: "device", tokenHash: hashDeviceToken(args.credential.token, appKeys().device) },
    ipHash: hashIp(args.ip),
    now: systemClock.now(),
    ticketKey: appKeys().ticket,
    ticketTtlMs: env.TICKET_TTL_SECONDS * 1000,
    store: createServiceCheckinStore(),
  });
}
