/**
 * Content-Security-Policy con nonce por petición (la genera src/proxy.ts).
 *
 * - `script-src` con nonce + `'strict-dynamic'`: solo se ejecutan los scripts que Next marca con el nonce.
 * - El navegador solo habla con NUESTRO origen (`connect-src 'self'`): no hay cliente de Supabase en el
 *   navegador. Sin fuentes ni imágenes externas.
 * - Sin estilos ni scripts en línea sin nonce en producción.
 */
export function buildCsp({ nonce, isDev }: { nonce: string; isDev: boolean }): string {
  const directives = [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${isDev ? " 'unsafe-eval'" : ""}`,
    isDev ? "style-src 'self' 'unsafe-inline'" : `style-src 'self' 'nonce-${nonce}'`,
    "img-src 'self' data:",
    "font-src 'self'",
    `connect-src 'self'${isDev ? " ws: wss:" : ""}`,
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ];
  return directives.join("; ");
}
