import { createHmac, hkdfSync, timingSafeEqual } from "node:crypto";

/**
 * Cada finalidad usa su propia subclave (separación de dominio): un MAC válido
 * para un propósito jamás lo es para otro, aunque compartan secreto maestro.
 *
 * Todas se derivan de SERVER_SECRET: `qr` y `ticket` firman el QR y el ticket; `ip` firma la IP (solo se guarda su HMAC);
 * `device` firma el token de "Remember me" (solo se guarda su HMAC).
 */
export type KeyPurpose = "qr" | "ticket" | "ip" | "device";

export const MIN_SECRET_LENGTH = 32;

const HKDF_SALT = Buffer.from("asce-attendance/v1", "utf8");

export function deriveKey(secret: string, purpose: KeyPurpose): Buffer {
  if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
    throw new RangeError(`El secreto debe tener al menos ${MIN_SECRET_LENGTH} caracteres.`);
  }
  const okm = hkdfSync(
    "sha256",
    Buffer.from(secret, "utf8"),
    HKDF_SALT,
    Buffer.from(`key/${purpose}`, "utf8"),
    32,
  );
  return Buffer.from(okm);
}

export function hmacSha256(key: Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data, "utf8").digest();
}

/** Comparación en tiempo constante; devuelve false si las longitudes difieren. */
export function safeEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}
