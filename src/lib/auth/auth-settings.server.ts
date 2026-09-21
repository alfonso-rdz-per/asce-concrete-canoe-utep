import "server-only";
import { evaluateAuthSettings, type AuthSettingsProblem } from "@/lib/auth/auth-settings";
import { serverEnv } from "@/lib/env";

/**
 * Consulta los ajustes PÚBLICOS de Supabase Auth (en caché 5 min) y devuelve los problemas de
 * configuración que abrirían la puerta de administrador (ver auth-settings.ts).
 * Devuelve `null` si no se pudo comprobar (no se muestra ningún aviso por un fallo de red).
 */
export async function getAuthSettingsProblems(): Promise<AuthSettingsProblem[] | null> {
  try {
    const env = serverEnv();
    const res = await fetch(`${env.NEXT_PUBLIC_SUPABASE_URL.replace(/\/$/, "")}/auth/v1/settings`, {
      headers: { apikey: env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY },
      next: { revalidate: 300 },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    const settings: unknown = await res.json();
    if (!settings || typeof settings !== "object") return null;
    return evaluateAuthSettings(settings as Parameters<typeof evaluateAuthSettings>[0]).problems;
  } catch {
    return null;
  }
}
