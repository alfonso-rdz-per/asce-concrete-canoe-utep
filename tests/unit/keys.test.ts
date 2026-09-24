import { describe, expect, it } from "vitest";
import { deriveKey, hmacSha256, safeEqual } from "@/lib/crypto/keys";

const SECRET = "una-clave-maestra-de-prueba-con-32+chars";

describe("deriveKey", () => {
  it("es determinista y produce 32 bytes", () => {
    const a = deriveKey(SECRET, "qr");
    expect(a).toHaveLength(32);
    expect(a.equals(deriveKey(SECRET, "qr"))).toBe(true);
  });

  it("cada propósito produce una clave distinta (separación de dominio)", () => {
    const keys = (["qr", "ticket", "ip", "device"] as const).map((p) => deriveKey(SECRET, p).toString("hex"));
    expect(new Set(keys).size).toBe(4);
  });

  it("un secreto distinto produce claves distintas", () => {
    expect(deriveKey(SECRET, "qr").equals(deriveKey(SECRET + "x", "qr"))).toBe(false);
  });

  it("rechaza secretos cortos o de tipo incorrecto", () => {
    expect(() => deriveKey("corto", "qr")).toThrow(RangeError);
    expect(() => deriveKey("x".repeat(31), "qr")).toThrow(RangeError);
    expect(() => deriveKey(undefined as unknown as string, "qr")).toThrow(RangeError);
    expect(() => deriveKey("x".repeat(32), "qr")).not.toThrow();
  });
});

describe("hmacSha256 / safeEqual", () => {
  it("HMAC estable y dependiente de la clave y del mensaje", () => {
    const k1 = deriveKey(SECRET, "qr");
    const k2 = deriveKey(SECRET, "ticket");
    expect(hmacSha256(k1, "m").equals(hmacSha256(k1, "m"))).toBe(true);
    expect(hmacSha256(k1, "m").equals(hmacSha256(k1, "n"))).toBe(false);
    expect(hmacSha256(k1, "m").equals(hmacSha256(k2, "m"))).toBe(false);
  });

  it("safeEqual compara contenido y devuelve false con longitudes distintas (sin lanzar)", () => {
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abc"))).toBe(true);
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abd"))).toBe(false);
    expect(safeEqual(Buffer.from("abc"), Buffer.from("abcd"))).toBe(false);
    expect(safeEqual(Buffer.alloc(0), Buffer.alloc(0))).toBe(true);
  });
});
