/**
 * Ticket de check-in (firmado con HMAC, sin almacenamiento).
 *
 * Se emite cuando un token QR vigente se canjea al escanear, y permite terminar
 * de escribir ASCE ID + Name sin la prisa de los 10 s del QR.
 *
 * Formato:  t1.<sessionId>.<nonce>.<emitidoEn>.<slot>.<mac>
 *   nonce      16 bytes aleatorios, base64url (22 caracteres)
 *   emitidoEn  hora del servidor al canjear, ms en base 36
 *   slot       slot del token QR canjeado (para auditoría)
 *   mac        HMAC-SHA256(clave "ticket", "asce/ticket/v1|...") truncado a 128 bits
 *
 * IMPORTANTE — QUÉ NO ES:
 *  - NO es una prueba adicional de proximidad. La única señal de presencia es
 *    haber presentado un token QR vigente al canjearlo; el ticket solo evita
 *    que el formulario tenga que completarse dentro de la ventana del QR.
 *  - NO es una defensa absoluta contra replay. Dentro de su vida (3 min por
 *    defecto) puede usarse varias veces para INTENTAR credenciales; ese abuso lo
 *    acota el rate limiting del check-in (por ticket, por ASCE ID y por IP; ver checkin/submit.ts).
 *
 * QUÉ SÍ ES:
 *  - Firmado y ligado a una sesión concreta (el MAC cubre sessionId, nonce,
 *    emisión y slot; alterar cualquiera lo invalida).
 *  - Con expiración medida con la hora del servidor.
 *  - Sujeto a que la sesión siga `active` (lo comprueba el llamador en la BD).
 *  - Asociado al check-in: `nonce` y `slot` se guardan en `checkins`.
 *  - De un solo uso EXITOSO: `UNIQUE(session_id, ticket_nonce)` en la base de
 *    datos impide que un mismo ticket produzca dos asistencias.
 */
import { randomBytes } from "node:crypto";
import { b64ToUuid, fromBase36, isUuid, toBase36, uuidToB64 } from "@/lib/crypto/ids";
import { hmacSha256, safeEqual } from "@/lib/crypto/keys";
import { assertNowMs } from "@/lib/time";

export const TICKET_DEFAULT_TTL_MS = 180_000;
export const TICKET_MAX_TTL_MS = 3_600_000;
/** Tolerancia entre instancias del servidor si `emitidoEn` queda ligeramente en el futuro. */
export const TICKET_FUTURE_SKEW_MS = 2_000;

const MAC_BYTES = 16;
const MAX_TICKET_LENGTH = 160;
const PREFIX = "t1";

export type TicketFailure = "malformed" | "bad_mac" | "not_yet_valid" | "expired";

export type TicketVerification =
  | {
      ok: true;
      sessionId: string;
      nonce: string;
      issuedAtMs: number;
      tokenSlot: number;
      expiresAtMs: number;
    }
  | { ok: false; reason: TicketFailure };

function assertTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > TICKET_MAX_TTL_MS) {
    throw new RangeError(`El TTL del ticket debe ser un entero entre 1 y ${TICKET_MAX_TTL_MS} ms.`);
  }
}

function macFor(key: Buffer, sid: string, nonce: string, iat: string, slot: string): Buffer {
  return hmacSha256(key, `asce/ticket/v1|${sid}|${nonce}|${iat}|${slot}`).subarray(0, MAC_BYTES);
}

export function issueTicket(args: {
  key: Buffer;
  sessionId: string;
  tokenSlot: number;
  now: number;
  ttlMs?: number;
}): { ticket: string; nonce: string; expiresAtMs: number } {
  const { key, sessionId, tokenSlot, now, ttlMs = TICKET_DEFAULT_TTL_MS } = args;
  if (!isUuid(sessionId)) throw new TypeError("sessionId debe ser un UUID.");
  assertNowMs(now);
  assertTtl(ttlMs);

  const sid = uuidToB64(sessionId);
  const nonce = randomBytes(16).toString("base64url");
  const iat = toBase36(now);
  const slot = toBase36(tokenSlot);
  const mac = macFor(key, sid, nonce, iat, slot).toString("base64url");

  return {
    ticket: `${PREFIX}.${sid}.${nonce}.${iat}.${slot}.${mac}`,
    nonce,
    expiresAtMs: now + ttlMs,
  };
}

export function verifyTicket(args: {
  key: Buffer;
  ticket: unknown;
  now: number;
  ttlMs?: number;
}): TicketVerification {
  const { key, ticket, now, ttlMs = TICKET_DEFAULT_TTL_MS } = args;
  assertNowMs(now);
  assertTtl(ttlMs);

  if (typeof ticket !== "string" || ticket.length === 0 || ticket.length > MAX_TICKET_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = ticket.split(".");
  if (parts.length !== 6 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const [, sid, nonce, iatStr, slotStr, macB64] = parts;

  const sessionId = b64ToUuid(sid);
  const issuedAtMs = fromBase36(iatStr);
  const tokenSlot = fromBase36(slotStr);
  if (
    sessionId === null ||
    issuedAtMs === null ||
    tokenSlot === null ||
    !/^[A-Za-z0-9_-]{22}$/.test(nonce) ||
    !/^[A-Za-z0-9_-]{22}$/.test(macB64)
  ) {
    return { ok: false, reason: "malformed" };
  }
  const presented = Buffer.from(macB64, "base64url");
  if (presented.length !== MAC_BYTES || presented.toString("base64url") !== macB64) {
    return { ok: false, reason: "malformed" };
  }

  if (!safeEqual(presented, macFor(key, sid, nonce, iatStr, slotStr))) {
    return { ok: false, reason: "bad_mac" };
  }

  if (issuedAtMs > now + TICKET_FUTURE_SKEW_MS) return { ok: false, reason: "not_yet_valid" };
  if (now >= issuedAtMs + ttlMs) return { ok: false, reason: "expired" };

  return { ok: true, sessionId, nonce, issuedAtMs, tokenSlot, expiresAtMs: issuedAtMs + ttlMs };
}
