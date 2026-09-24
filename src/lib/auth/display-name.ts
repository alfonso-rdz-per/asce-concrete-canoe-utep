/**
 * Nombre visible del administrador. La aplicación SOLO LEE `user.user_metadata.display_name`
 * (se gestiona desde Supabase); no hay pantalla para editarlo.
 *
 * `user_metadata` lo puede modificar el propio usuario, así que se trata como texto NO confiable:
 * se limpian caracteres de control y de reordenación bidireccional, se colapsan espacios y se
 * limita la longitud. Nunca se usa para autorizar nada.
 */
export interface NameSource {
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
}

export const DISPLAY_NAME_MAX = 60;
const FALLBACK = "Admin";

// Cc = controles C0/C1 · Cf = formato (ancho cero, marcas y anulaciones bidireccionales, BOM)
// Zl/Zp = separadores de línea y de párrafo.
const UNSAFE_CHARS = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

function cleanText(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(UNSAFE_CHARS, " ").replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return null;
  return Array.from(cleaned).slice(0, DISPLAY_NAME_MAX).join("").trim() || null;
}

/** Parte anterior al `@` del correo (respaldo cuando no hay display_name). */
function emailLocalPart(email: unknown): string | null {
  if (typeof email !== "string") return null;
  const at = email.indexOf("@");
  return cleanText(at > 0 ? email.slice(0, at) : email);
}

export function getDisplayName(user: NameSource | null | undefined): string {
  if (!user) return FALLBACK;
  return cleanText(user.user_metadata?.display_name) ?? emailLocalPart(user.email) ?? FALLBACK;
}

/** Primera palabra del display_name (para "Welcome, Lesley"); sin display_name, la parte local del correo. */
export function getFirstName(user: NameSource | null | undefined): string {
  if (!user) return FALLBACK;
  const display = cleanText(user.user_metadata?.display_name);
  if (display) return display.split(" ")[0];
  return emailLocalPart(user.email) ?? FALLBACK;
}

/** Hasta 2 iniciales en mayúsculas para el avatar. */
export function getInitials(user: NameSource | null | undefined): string {
  const display = user ? cleanText(user.user_metadata?.display_name) : null;
  const words = (display ?? emailLocalPart(user?.email) ?? FALLBACK).split(/[\s._-]+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => Array.from(w)[0]?.toUpperCase() ?? "");
  return letters.join("") || "A";
}
