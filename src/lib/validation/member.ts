/**
 * Validación del formulario de miembros (servidor). Los mensajes están en inglés porque se
 * muestran al usuario. Las reglas reflejan las restricciones de la base de datos (que siguen
 * siendo la última línea de defensa).
 */
import { z } from "zod";
import { addDaysToDateOnly, isValidDateOnly } from "@/lib/dates";
import { canonicalPreset, DEFAULT_POSITION, OTHER_POSITION, POSITION_MAX, POSITION_OPTIONS } from "@/lib/positions";

export type MemberField = "asceId" | "name" | "email" | "joinedOn" | "position" | "customPosition" | "designTeam";
export type FieldErrors = Partial<Record<MemberField, string>>;

export interface MemberInput {
  asceId: string;
  name: string;
  email: string | null;
  /** null = usar el valor por defecto de la base de datos (hoy, en El Paso). */
  joinedOn: string | null;
  /** Cargo final: uno de los predefinidos o, con "Other", el texto personalizado. */
  position: string;
  /** Casilla "Design Team" (por defecto apagada): el miembro pertenece al Design Team. */
  isDesignTeam: boolean;
}

export type ParsedMember = { ok: true; data: MemberInput } | { ok: false; fieldErrors: FieldErrors };

/** El ASCE ID son SOLO números (los ceros iniciales cuentan: "001234"). La misma regla en el navegador, en el servidor y en el check-in. */
export const ASCE_ID_DIGITS = /^[0-9]+$/;
export const ASCE_ID_PATTERN = /^[0-9]{3,32}$/;
export const NAME_MAX = 120;
export const EARLIEST_JOIN_DATE = "2000-01-01";

const CONTROL_CHARS = /\p{Cc}/u;
/** Control + caracteres de formato invisibles (ancho cero, reordenación bidireccional): un cargo no debe poder "disfrazarse". */
const CONTROL_OR_FORMAT_CHARS = /[\p{Cc}\p{Cf}]/u;

const emailSchema = z.email();
export const idSchema = z.uuid();

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export function parseAsceId(raw: string): { value?: string; error?: string } {
  const value = raw.trim();
  if (value.length === 0) return { error: "Enter the ASCE ID." };
  if (!ASCE_ID_DIGITS.test(value)) return { error: "ASCE ID must contain numbers only." };
  if (!ASCE_ID_PATTERN.test(value)) return { error: "ASCE ID must have 3 to 32 digits." };
  return { value };
}

export function parseName(raw: string): { value?: string; error?: string } {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length === 0) return { error: "Enter the full name." };
  if (value.length > NAME_MAX) return { error: `Name must be ${NAME_MAX} characters or fewer.` };
  if (CONTROL_CHARS.test(value)) return { error: "Name contains invalid characters." };
  return { value };
}

export function parseEmail(raw: string): { value?: string | null; error?: string } {
  const value = raw.trim().toLowerCase();
  if (value.length === 0) return { value: null };
  if (value.length > 254 || !emailSchema.safeParse(value).success) return { error: "Enter a valid email address." };
  return { value };
}

export function parseJoinedOn(raw: string, mode: "create" | "edit", today: string): { value?: string | null; error?: string } {
  const value = raw.trim();
  if (value.length === 0) return mode === "create" ? { value: null } : { error: "Enter the join date." };
  if (!isValidDateOnly(value)) return { error: "Enter a valid date." };
  if (value < EARLIEST_JOIN_DATE) return { error: "The join date can't be before 2000." };
  if (value > addDaysToDateOnly(today, 366)) return { error: "The join date can't be more than a year in the future." };
  return { value };
}

/**
 * Cargo. `preset` es la opción del desplegable; `custom` solo cuenta con "Other" y entonces ES el valor guardado.
 * Un cargo vacío (formulario antiguo) equivale al predeterminado, "Member".
 */
export function parsePosition(preset: string, custom: string): { value?: string; field?: "position" | "customPosition"; error?: string } {
  const chosen = preset.trim();
  if (chosen === "") return { value: DEFAULT_POSITION };
  if (!(POSITION_OPTIONS as readonly string[]).includes(chosen)) return { field: "position", error: "Choose a position from the list." };
  if (chosen !== OTHER_POSITION) return { value: chosen };

  const value = custom.replace(/\s+/g, " ").trim();
  if (value.length === 0) return { field: "customPosition", error: "Enter the custom position." };
  if (value.length > POSITION_MAX) return { field: "customPosition", error: `Position must be ${POSITION_MAX} characters or fewer.` };
  if (CONTROL_OR_FORMAT_CHARS.test(value)) return { field: "customPosition", error: "Position contains invalid characters." };
  if (value.toLowerCase() === OTHER_POSITION.toLowerCase()) return { field: "customPosition", error: "Enter the specific position instead of “Other”." };
  // Un texto libre que coincide con un cargo de la lista se guarda con la grafía canónica.
  return { value: canonicalPreset(value) ?? value };
}

export function parseMemberForm(formData: FormData, opts: { mode: "create" | "edit"; today: string }): ParsedMember {
  const asceId = parseAsceId(text(formData, "asceId"));
  const name = parseName(text(formData, "name"));
  const email = parseEmail(text(formData, "email"));
  const joinedOn = parseJoinedOn(text(formData, "joinedOn"), opts.mode, opts.today);
  const position = parsePosition(text(formData, "position"), text(formData, "customPosition"));

  const fieldErrors: FieldErrors = {};
  if (asceId.error) fieldErrors.asceId = asceId.error;
  if (name.error) fieldErrors.name = name.error;
  if (email.error) fieldErrors.email = email.error;
  if (joinedOn.error) fieldErrors.joinedOn = joinedOn.error;
  if (position.error && position.field) fieldErrors[position.field] = position.error;
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };

  return {
    ok: true,
    data: {
      asceId: asceId.value as string,
      name: name.value as string,
      email: (email.value ?? null) as string | null,
      joinedOn: (joinedOn.value ?? null) as string | null,
      position: position.value as string,
      // Una casilla marcada envía "on"; desmarcada no envía nada (por defecto: apagada).
      isDesignTeam: formData.get("designTeam") === "on",
    },
  };
}
