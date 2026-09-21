/**
 * Destino tras iniciar sesión (`?next=`). Solo se aceptan rutas internas bajo /admin:
 * cualquier otra cosa (URLs absolutas, `//host`, `\host`, `javascript:`, controles) cae al valor
 * por defecto. Evita el "open redirect".
 */
const DEFAULT_TARGET = "/admin";
const MAX_LENGTH = 200;

export function safeAdminRedirect(next: unknown, fallback: string = DEFAULT_TARGET): string {
  if (typeof next !== "string") return fallback;
  if (next.length === 0 || next.length > MAX_LENGTH) return fallback;
  if (!next.startsWith("/") || next.startsWith("//")) return fallback;
  // Barra invertida y cualquier carácter de control (\p{Cc}).
  if (/[\\\p{Cc}]/u.test(next)) return fallback;

  let url: URL;
  try {
    url = new URL(next, "http://internal.invalid");
  } catch {
    return fallback;
  }
  if (url.origin !== "http://internal.invalid") return fallback;

  const path = url.pathname;
  const insideAdmin = path === "/admin" || path.startsWith("/admin/");
  if (!insideAdmin) return fallback;
  if (path === "/admin/login" || path.startsWith("/admin/login/")) return fallback; // evita bucles

  return path + url.search;
}
