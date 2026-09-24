/**
 * Token QR dinámico (firmado con HMAC, sin almacenamiento).
 *
 * Formato:  v1.<sessionId>.<slot>.<mac>
 *   sessionId  UUID de la sesión, 16 bytes en base64url (22 caracteres)
 *   slot       floor(hora_servidor_ms / 10 000), en base 36
 *   mac        HMAC-SHA256(clave "qr", "asce/qr/v1|<sessionId>|<slot>") truncado a 128 bits
 *
 * QUÉ DEMUESTRA: que quien lo presenta tuvo acceso al QR que el administrador
 * mostraba en pantalla hace unos segundos. NO es una prueba de distancia física
 * ni impide que un cómplice presente reenvíe el QR en vivo dentro de la ventana.
 *
 * DISEÑO:
 *  - Multiuso dentro de su ventana: el QR se muestra a una sala entera, así que
 *    un token de un solo uso dejaría fuera a casi todos. La unicidad se exige
 *    después: un miembro por sesión, y un ticket por check-in.
 *  - Este módulo solo prueba AUTENTICIDAD y VIGENCIA. El llamador debe comprobar
 *    además, contra la base de datos, que la sesión siga `active`.
 *  - Toda la hora es la del servidor (`now` inyectado). Ningún reloj de teléfono
 *    interviene en la validez.
 *
 * VENTANA DE VALIDEZ (slotInicio = slot * 10 s):
 *    slotInicio - EARLY  <=  now  <  slotInicio + 10 s + gracia
 *  Con la gracia por defecto (5 s) un token se ve 10 s y se acepta hasta 16 s
 *  (1 s de tolerancia previa por el desfase de dibujado en la pantalla del admin).
 */
import { b64ToUuid, fromBase36, isUuid, toBase36, uuidToB64 } from "@/lib/crypto/ids";
import { hmacSha256, safeEqual } from "@/lib/crypto/keys";
import { assertNowMs } from "@/lib/time";

export const QR_SLOT_MS = 10_000;
export const QR_EARLY_MS = 1_000;
export const QR_MAX_GRACE_MS = 15_000;
export const QR_DEFAULT_GRACE_MS = 5_000;

const MAC_BYTES = 16;
const MAX_TOKEN_LENGTH = 128;
const PREFIX = "v1";

export type QrTokenFailure = "malformed" | "bad_mac" | "not_yet_valid" | "expired";

export type QrTokenVerification =
  | { ok: true; sessionId: string; slot: number }
  | { ok: false; reason: QrTokenFailure };

export interface QrTokenWindow {
  slot: number;
  token: string;
  /** Inicio del intervalo en que el token se muestra (ms, hora del servidor). */
  startsAtMs: number;
  /** Fin del intervalo visible (ms, hora del servidor). La gracia no está incluida. */
  endsAtMs: number;
}

export function slotAt(nowMs: number): number {
  assertNowMs(nowMs);
  return Math.floor(nowMs / QR_SLOT_MS);
}

export function assertGraceMs(graceMs: number): void {
  if (!Number.isInteger(graceMs) || graceMs < 0 || graceMs > QR_MAX_GRACE_MS) {
    throw new RangeError(`La gracia debe ser un entero entre 0 y ${QR_MAX_GRACE_MS} ms.`);
  }
}

function macFor(key: Buffer, sidB64: string, slotStr: string): Buffer {
  return hmacSha256(key, `asce/qr/v1|${sidB64}|${slotStr}`).subarray(0, MAC_BYTES);
}

export function issueQrToken(args: { key: Buffer; sessionId: string; slot: number }): string {
  const { key, sessionId, slot } = args;
  if (!isUuid(sessionId)) throw new TypeError("sessionId debe ser un UUID.");
  const slotStr = toBase36(slot);
  const sidB64 = uuidToB64(sessionId);
  const mac = macFor(key, sidB64, slotStr).toString("base64url");
  return `${PREFIX}.${sidB64}.${slotStr}.${mac}`;
}

function windowFor(key: Buffer, sessionId: string, slot: number): QrTokenWindow {
  return {
    slot,
    token: issueQrToken({ key, sessionId, slot }),
    startsAtMs: slot * QR_SLOT_MS,
    endsAtMs: (slot + 1) * QR_SLOT_MS,
  };
}

/**
 * Token del intervalo actual y del siguiente. La pantalla del administrador
 * pide ambos a la vez para cambiar de QR sin esperar a la red en el límite.
 */
export function issueQrTokens(args: { key: Buffer; sessionId: string; now: number }): {
  serverNow: number;
  current: QrTokenWindow;
  next: QrTokenWindow;
} {
  const slot = slotAt(args.now);
  return {
    serverNow: args.now,
    current: windowFor(args.key, args.sessionId, slot),
    next: windowFor(args.key, args.sessionId, slot + 1),
  };
}

export function verifyQrToken(args: {
  key: Buffer;
  token: unknown;
  now: number;
  graceMs: number;
}): QrTokenVerification {
  const { key, token, now, graceMs } = args;
  assertNowMs(now);
  assertGraceMs(graceMs);

  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_LENGTH) {
    return { ok: false, reason: "malformed" };
  }
  const parts = token.split(".");
  if (parts.length !== 4 || parts[0] !== PREFIX) return { ok: false, reason: "malformed" };
  const [, sidB64, slotStr, macB64] = parts;

  const sessionId = b64ToUuid(sidB64);
  const slot = fromBase36(slotStr);
  if (sessionId === null || slot === null || !/^[A-Za-z0-9_-]{22}$/.test(macB64)) {
    return { ok: false, reason: "malformed" };
  }
  const presented = Buffer.from(macB64, "base64url");
  if (presented.length !== MAC_BYTES || presented.toString("base64url") !== macB64) {
    return { ok: false, reason: "malformed" };
  }

  // Primero autenticidad (tiempo constante), después vigencia.
  if (!safeEqual(presented, macFor(key, sidB64, slotStr))) {
    return { ok: false, reason: "bad_mac" };
  }

  const startsAt = slot * QR_SLOT_MS;
  if (now < startsAt - QR_EARLY_MS) return { ok: false, reason: "not_yet_valid" };
  if (now >= startsAt + QR_SLOT_MS + graceMs) return { ok: false, reason: "expired" };

  return { ok: true, sessionId, slot };
}
