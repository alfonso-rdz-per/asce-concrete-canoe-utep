/**
 * Validación del formulario de nueva sesión (servidor). Los mensajes están en inglés (se muestran al usuario).
 *
 * El formulario SOLO pide el nombre de la sesión (`title`) y a qué grupo(s) va dirigida (`audience`, la opción "Required": dos casillas,
 * Design Team y Rowing & Construction, que se pueden marcar a la vez; ya no es un booleano). NO pide descripción, ubicación ni
 * fecha/hora: la fecha la pone el SERVIDOR al crear y quién/cuándo empezó lo fija la base de datos al activarla. Aunque alguien
 * envíe esos campos a mano, aquí se ignoran (la ubicación de las sesiones antiguas sigue existiendo, solo que ya no se pide).
 */
import { audienceFromGroups, DEFAULT_AUDIENCE, isTeamGroup, type SessionAudience, type TeamGroup } from "@/lib/session-audience";

export type SessionField = "title" | "audience";
export type SessionFieldErrors = Partial<Record<SessionField, string>>;

export interface SessionInput {
  title: string;
  audience: SessionAudience;
}

export type ParsedSession = { ok: true; data: SessionInput } | { ok: false; fieldErrors: SessionFieldErrors };

export const TITLE_MAX = 160;

/** Control + caracteres de formato invisibles (ancho cero, reordenación bidireccional). */
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export function parseTitle(raw: string): { value?: string; error?: string } {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length === 0) return { error: "Enter a session name." };
  if (value.length > TITLE_MAX) return { error: `Session name must be ${TITLE_MAX} characters or fewer.` };
  if (CONTROL_OR_FORMAT.test(value)) return { error: "Session name contains invalid characters." };
  return { value };
}

const AUDIENCE_ERROR = "Choose at least one team: Design Team or Rowing & Construction.";

/**
 * Cada casilla marcada envía UN valor `audience` (design_team / remar_construction). Uno o los dos valores son válidos (los dos = ambos
 * equipos); cualquier otro valor (o ninguno) se rechaza en el servidor.
 */
export function parseAudience(raw: readonly string[]): { value?: SessionAudience; error?: string } {
  const groups = new Set<TeamGroup>();
  for (const item of raw) {
    if (!isTeamGroup(item)) return { error: AUDIENCE_ERROR };
    groups.add(item);
  }
  const value = audienceFromGroups(groups);
  return value ? { value } : { error: AUDIENCE_ERROR };
}

function textList(formData: FormData, key: string): string[] {
  return formData.getAll(key).map((v) => (typeof v === "string" ? v : ""));
}

export function parseSessionForm(formData: FormData): ParsedSession {
  const title = parseTitle(text(formData, "title"));
  const audience = parseAudience(textList(formData, "audience"));
  const fieldErrors: SessionFieldErrors = {};
  if (title.error) fieldErrors.title = title.error;
  if (audience.error) fieldErrors.audience = audience.error;
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  return { ok: true, data: { title: title.value as string, audience: audience.value ?? DEFAULT_AUDIENCE } };
}
