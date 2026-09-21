import { randomBytes } from "node:crypto";
import { hmacSha256 } from "@/lib/crypto/keys";

/**
 * Token de "Remember me on this device". Es un IDENTIFICADOR ALEATORIO de 256 bits (no una contraseña ni una credencial del
 * miembro): vive en una cookie HttpOnly del dispositivo y la base de datos guarda SOLO su HMAC-SHA256 con una clave derivada de
 * SERVER_SECRET (`device`). Un volcado de la tabla no sirve para reconstruir ningún token. NO sustituye al QR: el check-in sigue
 * exigiendo ticket, sesión activa, miembro activo y una asistencia por sesión.
 *
 * Módulo puro (sin cookies ni base de datos): se prueba sin red. El cableado real está en `checkin/server.ts` y `actions.ts`.
 */
export const DEVICE_COOKIE = "asce_device";
/** La cookie solo viaja a las páginas del estudiante (`/c/...`), nunca al panel de administración ni a la API. */
export const DEVICE_COOKIE_PATH = "/c";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Vida desde el último uso (se renueva en cada check-in hecho con ese dispositivo). */
export const DEVICE_TTL_MS = 180 * DAY_MS;
/** Tope absoluto desde la creación: pasado este tiempo hay que volver a identificarse aunque se use a diario. */
export const DEVICE_MAX_LIFETIME_MS = 365 * DAY_MS;
/** Dispositivos recordados vigentes por miembro; al añadir uno nuevo se revocan los más antiguos. */
export const MAX_DEVICES_PER_MEMBER = 5;

const TOKEN_RE = /^d1\.[A-Za-z0-9_-]{43}$/;

/** `d1.` + 32 bytes aleatorios (CSPRNG) en base64url. */
export function generateDeviceToken(): string {
  return `d1.${randomBytes(32).toString("base64url")}`;
}

export function isDeviceTokenFormat(value: unknown): value is string {
  return typeof value === "string" && TOKEN_RE.test(value);
}

/** HMAC en hex (64 caracteres, lo que exige la BD) con separación de dominio. Lanza si el token no tiene el formato esperado. */
export function hashDeviceToken(token: string, key: Buffer): string {
  if (!isDeviceTokenFormat(token)) throw new TypeError("Token de dispositivo con formato inválido.");
  return hmacSha256(key, `asce/device/v1|${token}`).toString("hex");
}

/** Nueva caducidad: `DEVICE_TTL_MS` desde ahora, sin pasar del tope absoluto contado desde la creación. */
export function deviceExpiryMs(nowMs: number, createdAtMs: number): number {
  return Math.min(nowMs + DEVICE_TTL_MS, createdAtMs + DEVICE_MAX_LIFETIME_MS);
}

/** ¿Sigue valiendo un dispositivo? (no revocado, no caducado y dentro del tope absoluto). Hora del SERVIDOR. */
export function isDeviceUsable(device: { createdAtMs: number; expiresAtMs: number; revoked: boolean }, nowMs: number): boolean {
  return !device.revoked && nowMs < device.expiresAtMs && nowMs < device.createdAtMs + DEVICE_MAX_LIFETIME_MS;
}
