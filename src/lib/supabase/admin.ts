import "server-only";
import { createClient } from "@supabase/supabase-js";
import { serverEnv } from "@/lib/env";

/**
 * Cliente con `service_role`: OMITE RLS. Reservado a la ruta de check-in del
 * estudiante y a tareas internas del servidor. Jamás debe importarse desde un
 * componente de cliente (`server-only` hace fallar el build si ocurre) ni
 * exponerse la clave con prefijo NEXT_PUBLIC_.
 */
export function createServiceRoleClient() {
  const env = serverEnv();
  return createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}
