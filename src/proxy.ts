import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";
import { hardenCookieOptions, isSecureRequest } from "@/lib/supabase/cookies";

/**
 * Proxy (antes "middleware"). Hace tres cosas, y NINGUNA es la autoridad de seguridad:
 *   1. Genera el nonce por petición y fija la Content-Security-Policy.
 *   2. Refresca la sesión de administrador (cookies) leyendo solo la cookie (sin base de datos).
 *   3. Comprobación OPTIMISTA: sin sesión, /admin/* redirige al login.
 * La autoridad real es `requireAdmin()` (getUser contra Supabase Auth) en cada página/acción, y RLS.
 * Aquí se usa process.env directamente (el proxy no debe depender de módulos compartidos).
 */
export async function proxy(request: NextRequest) {
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp({ nonce, isDev: process.env.NODE_ENV === "development" });

  // Next lee el nonce de la CSP de la PETICIÓN al renderizar; x-nonce queda para quien lo necesite.
  const requestHeadersWithCsp = () => {
    const h = new Headers(request.headers);
    h.set("x-nonce", nonce);
    h.set("Content-Security-Policy", csp);
    return h;
  };
  const finalize = (res: NextResponse) => {
    res.headers.set("Content-Security-Policy", csp);
    return res;
  };

  const { pathname } = request.nextUrl;
  const inAdminArea = pathname === "/admin" || pathname.startsWith("/admin/");
  if (!inAdminArea) return finalize(NextResponse.next({ request: { headers: requestHeadersWithCsp() } }));

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return finalize(NextResponse.next({ request: { headers: requestHeadersWithCsp() } }));

  const secure = isSecureRequest(request.headers, request.nextUrl.href);
  let response = NextResponse.next({ request: { headers: requestHeadersWithCsp() } });

  const supabase = createServerClient(url, key, {
    cookies: {
      getAll: () => request.cookies.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (list, cacheHeaders) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request: { headers: requestHeadersWithCsp() } });
        for (const { name, value, options } of list) response.cookies.set(name, value, hardenCookieOptions(options, secure));
        for (const [k, v] of Object.entries(cacheHeaders)) response.headers.set(k, v);
      },
    },
  });

  // Refresca el token si hace falta. No valida contra la red: eso lo hace requireAdmin().
  const {
    data: { session },
  } = await supabase.auth.getSession();

  const isLogin = pathname === "/admin/login" || pathname.startsWith("/admin/login/");
  if (!session && !isLogin) {
    const login = request.nextUrl.clone();
    login.pathname = "/admin/login";
    login.search = "";
    login.searchParams.set("next", pathname + request.nextUrl.search);
    const redirect = NextResponse.redirect(login);
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    response.headers.forEach((v, k) => {
      if (k.toLowerCase() === "cache-control" || k.toLowerCase() === "pragma" || k.toLowerCase() === "expires") redirect.headers.set(k, v);
    });
    return finalize(redirect);
  }

  return finalize(response);
}

export const config = {
  matcher: [
    {
      // Todo salvo estáticos e imágenes; sin prefetch (no necesita nonce).
      source: "/((?!_next/static|_next/image|favicon.ico|brand/).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
