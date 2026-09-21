import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies, headers } from "next/headers";
import { serverEnv } from "@/lib/env";
import { hardenCookieOptions, isSecureRequest } from "@/lib/supabase/cookies";

/**
 * Cliente de Supabase ligado a la sesión (cookies) del administrador. Aplica RLS con su JWT:
 * es el cliente que usa TODO el panel. Solo servidor (no hay cliente de Supabase en el navegador).
 * Debe crearse por petición (no reutilizar entre peticiones).
 */
export async function createSupabaseServerClient() {
  const env = serverEnv();
  const store = await cookies();
  const secure = isSecureRequest(await headers());

  return createServerClient(env.NEXT_PUBLIC_SUPABASE_URL, env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => store.getAll().map(({ name, value }) => ({ name, value })),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) {
            store.set(name, value, hardenCookieOptions(options, secure));
          }
        } catch {
          // Desde un Server Component no se pueden escribir cookies: el refresco lo hace src/proxy.ts.
        }
      },
    },
  });
}
