/**
 * Espejo en JS de `private.is_admin()` (migración 3). Es SOLO para la experiencia de usuario
 * (mostrar el panel o redirigir al login): la autoridad real es RLS en la base de datos.
 * Una prueba de paridad (tests/db/admin-rule.test.ts) ejecuta la MISMA matriz de usuarios
 * contra la función SQL y contra esta, y exige el mismo resultado.
 *
 * Regla: correo presente y confirmado, no anónimo, no borrado y sin baneo vigente.
 * Ante cualquier dato ilegible falla CERRADO (no es administrador).
 */
export interface AdminCandidate {
  email?: string | null;
  email_confirmed_at?: string | null;
  is_anonymous?: boolean | null;
  banned_until?: string | null;
  deleted_at?: string | null;
}

export function isAdminUser(user: AdminCandidate | null | undefined, nowMs: number): boolean {
  if (!user) return false;
  if (typeof user.email !== "string" || user.email.length === 0) return false;
  if (typeof user.email_confirmed_at !== "string" || user.email_confirmed_at.length === 0) return false;
  if (user.is_anonymous === true) return false;
  if (user.deleted_at) return false;

  if (user.banned_until) {
    const until = Date.parse(user.banned_until);
    if (!Number.isFinite(until)) return false; // baneo ilegible: se trata como vigente
    if (!Number.isFinite(nowMs)) return false;
    if (until > nowMs) return false;
  }
  return true;
}
