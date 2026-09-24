const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

/** UUID -> 16 bytes en base64url (22 caracteres). Mantiene el QR de baja densidad. */
export function uuidToB64(uuid: string): string {
  if (!isUuid(uuid)) throw new TypeError("UUID inválido.");
  return Buffer.from(uuid.replaceAll("-", ""), "hex").toString("base64url");
}

/**
 * Inversa estricta de `uuidToB64`: exige forma canónica (sin variantes con
 * bits sobrantes) y devuelve el UUID en minúsculas, o null si no es válido.
 */
export function b64ToUuid(b64: string): string | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(b64)) return null;
  const bytes = Buffer.from(b64, "base64url");
  if (bytes.length !== 16 || bytes.toString("base64url") !== b64) return null;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Entero >= 0 en base 36 canónico (minúsculas, sin ceros a la izquierda). */
export function toBase36(n: number): string {
  if (!Number.isSafeInteger(n) || n < 0) throw new RangeError("Entero no negativo requerido.");
  return n.toString(36);
}

const BASE36_RE = /^(0|[1-9a-z][0-9a-z]{0,9})$/;

export function fromBase36(s: string): number | null {
  if (!BASE36_RE.test(s)) return null;
  const n = parseInt(s, 36);
  return Number.isSafeInteger(n) ? n : null;
}
