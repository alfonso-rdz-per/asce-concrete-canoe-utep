import { describe, expect, it } from "vitest";
import { AUTHORIZED_OAUTH_PROVIDERS, evaluateAuthSettings } from "@/lib/auth/auth-settings";

/** Forma real de /auth/v1/settings (recortada). */
const SAFE = {
  disable_signup: true,
  mailer_autoconfirm: false,
  external: { email: true, phone: false, anonymous_users: false, google: false, github: false, apple: false },
};

describe("guardián de la configuración de Supabase Auth", () => {
  it("la configuración actual (registros cerrados, sin anónimos, sin OAuth) es correcta", () => {
    expect(evaluateAuthSettings(SAFE)).toEqual({ ok: true, problems: [] });
  });

  it("FALLA si el registro público está habilitado", () => {
    const r = evaluateAuthSettings({ ...SAFE, disable_signup: false });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toEqual(["signup_enabled"]);
  });

  it("falla CERRADO: si disable_signup falta o no es exactamente true, se considera abierto", () => {
    for (const v of [undefined, null, "true", 1, 0, "false", {}]) {
      const r = evaluateAuthSettings({ ...SAFE, disable_signup: v });
      expect(r.ok, String(v)).toBe(false);
      expect(r.problems[0].code).toBe("signup_enabled");
    }
    expect(evaluateAuthSettings({ external: SAFE.external }).ok).toBe(false);
  });

  it("FALLA si el inicio de sesión anónimo está habilitado", () => {
    const r = evaluateAuthSettings({ ...SAFE, external: { ...SAFE.external, anonymous_users: true } });
    expect(r.ok).toBe(false);
    expect(r.problems.map((p) => p.code)).toEqual(["anonymous_enabled"]);
  });

  it("FALLA si aparece un proveedor OAuth no autorizado (y dice cuál)", () => {
    expect(AUTHORIZED_OAUTH_PROVIDERS).toEqual([]);
    for (const provider of ["google", "github", "apple", "azure", "discord", "custom_provider_x"]) {
      const r = evaluateAuthSettings({ ...SAFE, external: { ...SAFE.external, [provider]: true } });
      expect(r.ok, provider).toBe(false);
      expect(r.problems).toEqual([expect.objectContaining({ code: "oauth_provider_enabled", provider })]);
    }
  });

  it("acumula varios problemas a la vez", () => {
    const r = evaluateAuthSettings({ disable_signup: false, external: { email: true, anonymous_users: true, github: true } });
    expect(r.problems.map((p) => p.code).sort()).toEqual(["anonymous_enabled", "oauth_provider_enabled", "signup_enabled"]);
  });

  it("correo y teléfono no cuentan como proveedores OAuth", () => {
    expect(evaluateAuthSettings({ ...SAFE, external: { email: true, phone: true } }).ok).toBe(true);
  });

  it("tolera `external` ausente o de tipo raro sin lanzar", () => {
    expect(evaluateAuthSettings({ disable_signup: true }).ok).toBe(true);
    expect(evaluateAuthSettings({ disable_signup: true, external: null }).ok).toBe(true);
    expect(evaluateAuthSettings({ disable_signup: true, external: "x" as unknown as Record<string, unknown> }).ok).toBe(true);
  });

  it("los mensajes están en inglés y explican el riesgo", () => {
    const r = evaluateAuthSettings({ disable_signup: false, external: { anonymous_users: true, github: true } });
    for (const p of r.problems) expect(p.message).toMatch(/^[\x20-\x7E]+$/);
    expect(r.problems.find((p) => p.code === "signup_enabled")?.message).toMatch(/administrator/i);
  });
});
