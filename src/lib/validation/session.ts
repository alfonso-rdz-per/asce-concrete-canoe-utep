/** Server validation: name and exactly one session type. Other fields are ignored. */
import { DEFAULT_AUDIENCE, isSelectableAudience, type SessionAudience } from "@/lib/session-audience";

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

const AUDIENCE_ERROR = "Choose one option: Rowing & Construction, Design Team or Optional.";

/** Reject missing or multiple choices, including manipulated POSTs. */
export function parseAudience(raw: readonly string[]): { value?: SessionAudience; error?: string } {
  if (raw.length !== 1 || !isSelectableAudience(raw[0])) return { error: AUDIENCE_ERROR };
  return { value: raw[0] };
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
