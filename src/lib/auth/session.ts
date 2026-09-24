import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { redirect } from "next/navigation";
import { cache } from "react";
import { isAdminUser, type AdminCandidate } from "@/lib/auth/is-admin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Capa de acceso a datos (DAL) de autenticación. Aquí está la comprobación AUTORITATIVA en la
 * aplicación: `getUser()` valida el JWT contra Supabase Auth (no se confía en la cookie tal cual).
 * `proxy.ts` solo hace una comprobación optimista; la base de datos (RLS) es la autoridad final.
 *
 * Toda página, Server Action y Route Handler del panel debe llamar a `requireAdmin()` /
 * `getAdmin()` por sí misma (las Server Actions son alcanzables por POST directo).
 */
export interface AdminContext {
  user: User;
  supabase: SupabaseClient;
}

/** Una sola verificación por petición (memoizada con `cache` de React). */
export const getAdmin = cache(async (): Promise<AdminContext | null> => {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return null;
  if (!isAdminUser(data.user as unknown as AdminCandidate, Date.now())) return null;
  return { user: data.user, supabase };
});

/** Para páginas: sin administrador válido, redirige al login. */
export async function requireAdmin(): Promise<AdminContext> {
  const admin = await getAdmin();
  if (!admin) redirect("/admin/login?reason=signin");
  return admin;
}
