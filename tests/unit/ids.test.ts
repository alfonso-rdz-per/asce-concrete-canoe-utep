import { describe, expect, it } from "vitest";
import { b64ToUuid, fromBase36, isUuid, toBase36, uuidToB64 } from "@/lib/crypto/ids";
import { SESSION_A } from "../helpers/clock";

describe("uuid <-> base64url", () => {
  it("ida y vuelta, con 22 caracteres", () => {
    const b64 = uuidToB64(SESSION_A);
    expect(b64).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(b64ToUuid(b64)).toBe(SESSION_A);
  });

  it("normaliza a minúsculas", () => {
    expect(b64ToUuid(uuidToB64(SESSION_A.toUpperCase()))).toBe(SESSION_A);
  });

  it("rechaza no-UUIDs al codificar", () => {
    for (const bad of ["", "abc", "not-a-uuid", SESSION_A + "0", "3f2c9a4e7b1d4c6a9e5f0a1b2c3d4e5f"]) {
      expect(() => uuidToB64(bad), bad).toThrow(TypeError);
    }
    expect(isUuid(SESSION_A)).toBe(true);
    expect(isUuid(123)).toBe(false);
  });

  it("al decodificar exige la forma canónica (sin variantes con bits sobrantes)", () => {
    const canonical = uuidToB64(SESSION_A);
    // El 22.º carácter aporta 2 bits útiles (los 2 más significativos) y 4 bits sobrantes.
    // Cambiar solo los sobrantes decodifica a los MISMOS bytes, pero no es la forma canónica.
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const value = (c: string) => alphabet.indexOf(c);
    const last = canonical[21];
    const sameBytesOtherForm = [...alphabet].filter((c) => c !== last && value(c) >> 4 === value(last) >> 4);
    expect(sameBytesOtherForm).toHaveLength(15);
    for (const c of sameBytesOtherForm) {
      expect(b64ToUuid(canonical.slice(0, 21) + c), c).toBeNull();
    }
    // Cambiar los bits útiles da OTRO uuid distinto (nunca el original).
    for (const c of [...alphabet].filter((c) => value(c) >> 4 !== value(last) >> 4)) {
      expect(b64ToUuid(canonical.slice(0, 21) + c)).not.toBe(SESSION_A);
    }
    expect(b64ToUuid("")).toBeNull();
    expect(b64ToUuid(canonical + "A")).toBeNull();
    expect(b64ToUuid(canonical.slice(0, 21))).toBeNull();
    expect(b64ToUuid("!".repeat(22))).toBeNull();
  });
});

describe("base 36 canónico", () => {
  it("ida y vuelta", () => {
    for (const n of [0, 1, 35, 36, 180_000_000, Number.MAX_SAFE_INTEGER]) {
      const s = toBase36(n);
      if (s.length <= 10) expect(fromBase36(s)).toBe(n);
    }
  });

  it("rechaza formas no canónicas o fuera de rango", () => {
    for (const bad of ["", "01", "00", "A1", "a b", "1.5", "-1", "+1", "zzzzzzzzzzz", "١٢٣"]) {
      expect(fromBase36(bad), bad).toBeNull();
    }
  });

  it("toBase36 rechaza negativos, decimales y no seguros", () => {
    for (const bad of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => toBase36(bad)).toThrow(RangeError);
    }
  });
});
