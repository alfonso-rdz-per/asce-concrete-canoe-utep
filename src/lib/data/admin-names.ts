import "server-only";
import { cache } from "react";
import { getFirstName } from "@/lib/auth/display-name";
import { createServiceRoleClient } from "@/lib/supabase/admin";

/**
 * Nombres de los administradores para mostrar "Started by Lesley". El nombre sale de `user.user_metadata.display_name` (la
 * aplicación solo lo LEE; no hay pantalla para editarlo) y, si no existe, del respaldo actual basado en el correo. Se limpia
 * como texto no confiable (`getFirstName`).
 *
 * La base de datos nunca se consulta en `auth.users`: se pregunta a la API de administración de Auth desde el servidor
 * (solo lectura, clave de servicio en módulo `server-only`). Solo hay usuarios que son administradores (sin registro público).
 * Si la consulta falla, no se rompe nada: simplemente no se muestra quién empezó la sesión.
 */
export async function fetchAdminFirstNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const { data, error } = await createServiceRoleClient().auth.admin.listUsers({ page: 1, perPage: 200 });
    if (error) return names;
    for (const user of data.users) names.set(user.id, getFirstName(user));
  } catch {
    // Sin nombres: la interfaz omite "Started by".
  }
  return names;
}

/** Una sola consulta por petición (memoizada), aunque varias partes de la página pidan nombres. */
export const getAdminFirstNames = cache(fetchAdminFirstNames);
