/**
 * Validación del formulario de check-in del estudiante (servidor): ASCE ID + Name. Los mensajes van en inglés (se muestran).
 * Solo se pide el NOMBRE (no el apellido). Estos errores son de FORMATO: no dicen nada sobre si un miembro existe.
 */
import { parseAsceId } from "@/lib/validation/member";

export type CheckinField = "asceId" | "name";
export type CheckinFieldErrors = Partial<Record<CheckinField, string>>;

export const STUDENT_NAME_MAX = 120;
const CONTROL_OR_FORMAT = /[\p{Cc}\p{Cf}]/u;

export function parseStudentName(raw: string): { value?: string; error?: string } {
  const value = raw.replace(/\s+/g, " ").trim();
  if (value.length === 0) return { error: "Enter your name." };
  if (value.length > STUDENT_NAME_MAX) return { error: `Name must be ${STUDENT_NAME_MAX} characters or fewer.` };
  if (CONTROL_OR_FORMAT.test(value)) return { error: "Name contains invalid characters." };
  return { value };
}

export type ParsedCheckin =
  | { ok: true; data: { asceId: string; name: string; remember: boolean } }
  | { ok: false; fieldErrors: CheckinFieldErrors };

function text(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export function parseCheckinForm(formData: FormData): ParsedCheckin {
  const asceId = parseAsceId(text(formData, "asceId"));
  const name = parseStudentName(text(formData, "name"));
  const fieldErrors: CheckinFieldErrors = {};
  if (asceId.error) fieldErrors.asceId = asceId.error;
  if (name.error) fieldErrors.name = name.error;
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  // Una casilla marcada envía "on"; desmarcada no envía nada. Solo cuenta si el check-in sale bien.
  return { ok: true, data: { asceId: asceId.value as string, name: name.value as string, remember: formData.get("remember") === "on" } };
}
