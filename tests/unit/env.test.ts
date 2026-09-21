import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env";

const SECRET_A = "a".repeat(20) + "SECRETO-DE-PRUEBA-A" + "1234";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "pub",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  SERVER_SECRET: SECRET_A,
};

describe("parseServerEnv", () => {
  it("acepta una configuración válida y aplica los valores por defecto", () => {
    const env = parseServerEnv(valid);
    expect(env.QR_GRACE_MS).toBe(5_000);
    expect(env.TICKET_TTL_SECONDS).toBe(180);
  });

  it("convierte y valida los ajustes numéricos", () => {
    const env = parseServerEnv({ ...valid, QR_GRACE_MS: "3000", TICKET_TTL_SECONDS: "120" });
    expect(env.QR_GRACE_MS).toBe(3_000);
    expect(env.TICKET_TTL_SECONDS).toBe(120);
  });

  it("una variable vacía cuenta como no definida (no como 0)", () => {
    const env = parseServerEnv({ ...valid, QR_GRACE_MS: "", TICKET_TTL_SECONDS: "" });
    expect(env.QR_GRACE_MS).toBe(5_000);
    expect(env.TICKET_TTL_SECONDS).toBe(180);
  });

  it("rechaza valores fuera de rango", () => {
    for (const bad of ["-1", "15001", "abc", "1.5"]) {
      expect(() => parseServerEnv({ ...valid, QR_GRACE_MS: bad }), `grace ${bad}`).toThrow(/QR_GRACE_MS/);
    }
    for (const bad of ["59", "601", "x"]) {
      expect(() => parseServerEnv({ ...valid, TICKET_TTL_SECONDS: bad }), `ttl ${bad}`).toThrow(/TICKET_TTL_SECONDS/);
    }
  });

  it("rechaza secretos cortos, ausentes o con el valor de ejemplo", () => {
    expect(() => parseServerEnv({ ...valid, SERVER_SECRET: "corto" })).toThrow(/SERVER_SECRET/);
    expect(() => parseServerEnv({ ...valid, SERVER_SECRET: "replace-me" + "x".repeat(30) })).toThrow(/SERVER_SECRET/);
    expect(() => parseServerEnv({ ...valid, SUPABASE_SERVICE_ROLE_KEY: "replace-me" })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
  });

  it("ya no existe PIN_PEPPER: no se exige ni se lee (un .env.local antiguo que aún lo tenga sigue funcionando)", () => {
    const env = parseServerEnv({ ...valid, PIN_PEPPER: "un-valor-antiguo-que-ya-no-se-usa-en-absoluto" });
    expect(env).not.toHaveProperty("PIN_PEPPER");
  });

  it("exige una URL de Supabase válida", () => {
    expect(() => parseServerEnv({ ...valid, NEXT_PUBLIC_SUPABASE_URL: "no-es-url" })).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
  });

  it("el mensaje de error NUNCA incluye valores recibidos (podrían ser secretos)", () => {
    let message = "";
    try {
      parseServerEnv({ ...valid, SERVER_SECRET: "clave-corta-secreta", QR_GRACE_MS: "valor-raro" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/SERVER_SECRET/);
    expect(message).not.toContain("clave-corta-secreta");
    expect(message).not.toContain("valor-raro");
  });

  it("informa de todos los problemas a la vez", () => {
    let message = "";
    try {
      parseServerEnv({});
    } catch (e) {
      message = (e as Error).message;
    }
    for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SERVER_SECRET"]) {
      expect(message).toContain(name);
    }
  });
});
