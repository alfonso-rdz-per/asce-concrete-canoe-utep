/**
 * Guardián de la configuración de Supabase Auth.
 *
 * La regla "cualquier usuario válido de Auth es administrador" solo es segura mientras NADIE pueda
 * crearse una cuenta por su cuenta. Este módulo evalúa los ajustes públicos de Auth
 * (`/auth/v1/settings`) y devuelve los problemas. Lo usan:
 *   - el aviso del panel de administración, y
 *   - una prueba automática contra Supabase real que FALLA si:
 *       * el registro público está habilitado,
 *       * el inicio de sesión anónimo está habilitado,
 *       * aparece un proveedor OAuth no autorizado.
 *
 * Falla CERRADO: si `disable_signup` no es exactamente `true`, se considera que el registro está abierto.
 */
export interface AuthSettingsInput {
  disable_signup?: unknown;
  external?: Record<string, unknown> | null;
}

export type AuthSettingsProblemCode = "signup_enabled" | "anonymous_enabled" | "oauth_provider_enabled";

export interface AuthSettingsProblem {
  code: AuthSettingsProblemCode;
  /** Solo para `oauth_provider_enabled`. */
  provider?: string;
  message: string;
}

/** Proveedores OAuth autorizados. Ninguno: el acceso es solo correo + contraseña. */
export const AUTHORIZED_OAUTH_PROVIDERS: readonly string[] = [];

/** Claves de `external` que NO son proveedores OAuth. */
const NON_OAUTH_KEYS = new Set(["email", "phone", "anonymous_users"]);

export function evaluateAuthSettings(settings: AuthSettingsInput): { ok: boolean; problems: AuthSettingsProblem[] } {
  const problems: AuthSettingsProblem[] = [];

  if (settings.disable_signup !== true) {
    problems.push({
      code: "signup_enabled",
      message: "Public sign-ups are enabled in Supabase. Every new account would become an administrator.",
    });
  }

  const external = settings.external && typeof settings.external === "object" ? settings.external : {};

  if (external.anonymous_users === true) {
    problems.push({
      code: "anonymous_enabled",
      message: "Anonymous sign-ins are enabled in Supabase.",
    });
  }

  for (const [key, enabled] of Object.entries(external)) {
    if (NON_OAUTH_KEYS.has(key)) continue;
    if (enabled === true && !AUTHORIZED_OAUTH_PROVIDERS.includes(key)) {
      problems.push({
        code: "oauth_provider_enabled",
        provider: key,
        message: `The "${key}" sign-in provider is enabled in Supabase and is not authorized.`,
      });
    }
  }

  return { ok: problems.length === 0, problems };
}
