import type { CookieOptions } from "@supabase/ssr";

/**
 * Las cookies de sesión de administrador se fuerzan a HttpOnly + SameSite=Lax + Secure (en HTTPS).
 * No existe cliente de Supabase en el navegador, así que JavaScript nunca necesita leerlas.
 */
export function hardenCookieOptions(options: CookieOptions | undefined, secure: boolean): CookieOptions {
  return { ...options, path: "/", httpOnly: true, sameSite: "lax", secure };
}

/** HTTPS detrás de proxy (Vercel envía x-forwarded-proto) o URL https. En http://localhost no se marca Secure. */
export function isSecureRequest(headers: { get(name: string): string | null }, url?: string): boolean {
  const proto = headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  if (proto) return proto === "https";
  return typeof url === "string" && url.toLowerCase().startsWith("https:");
}
