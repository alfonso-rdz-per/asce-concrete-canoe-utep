"use server";

import { revalidatePath } from "next/cache";
import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/auth/session";
import { isAttendanceStatus, statusLabel } from "@/lib/attendance";
import { setMemberAttendance } from "@/lib/data/attendance";
import { createMember, setMemberActive, updateMember } from "@/lib/data/members";
import { todayInElPaso } from "@/lib/dates";
import { NOT_FOUND_ATTENDANCE, NOT_FOUND_MEMBER, type UserFacingError } from "@/lib/errors";
import { idSchema, parseMemberForm, type MemberField } from "@/lib/validation/member";

/**
 * Server Actions de miembros. Son alcanzables por POST directo, así que CADA una:
 *   1. vuelve a comprobar al administrador (`requireAdmin`), 2. valida la entrada en el servidor,
 *   3. usa el cliente con la sesión del administrador (RLS), 4. devuelve solo mensajes en inglés.
 */
const ECHO_FIELDS: MemberField[] = ["asceId", "name", "email", "joinedOn", "position", "customPosition"];

function echoValues(formData: FormData): Partial<Record<MemberField, string>> {
  const values: Partial<Record<MemberField, string>> = {};
  for (const key of ECHO_FIELDS) {
    const v = formData.get(key);
    if (typeof v === "string") values[key] = v.slice(0, 300);
  }
  // Una casilla desmarcada no se envía: se devuelve explícitamente para no volver al valor guardado tras un error.
  values.designTeam = formData.get("designTeam") === "on" ? "on" : "off";
  return values;
}

function errorState(error: UserFacingError, formData?: FormData): ActionState {
  if (error.field) {
    return {
      status: "error",
      message: "Please fix the highlighted field.",
      fieldErrors: { [error.field]: error.message },
      values: formData ? echoValues(formData) : undefined,
    };
  }
  return { status: "error", message: error.message, values: formData ? echoValues(formData) : undefined };
}

function memberId(formData: FormData): string | null {
  const parsed = idSchema.safeParse(formData.get("id"));
  return parsed.success ? parsed.data : null;
}

export async function createMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  const parsed = parseMemberForm(formData, { mode: "create", today: todayInElPaso() });
  if (!parsed.ok) {
    return { status: "error", message: "Please fix the highlighted fields.", fieldErrors: parsed.fieldErrors, values: echoValues(formData) };
  }

  const result = await createMember(supabase, parsed.data);
  if (!result.ok) return errorState(result.error, formData);

  revalidatePath("/admin");
  revalidatePath("/admin/members");
  return { status: "success", message: `${result.data.member.name} was added.` };
}

export async function updateMemberAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  const id = memberId(formData);
  if (!id) return { status: "error", message: NOT_FOUND_MEMBER };

  const parsed = parseMemberForm(formData, { mode: "edit", today: todayInElPaso() });
  if (!parsed.ok) {
    return { status: "error", message: "Please fix the highlighted fields.", fieldErrors: parsed.fieldErrors, values: echoValues(formData) };
  }

  const result = await updateMember(supabase, id, parsed.data);
  if (!result.ok) return errorState(result.error, formData);

  revalidatePath("/admin");
  revalidatePath("/admin/members");
  revalidatePath(`/admin/members/${id}/edit`);
  return { status: "success", message: "Changes saved." };
}

export async function setMemberActiveAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  const id = memberId(formData);
  if (!id) return { status: "error", message: NOT_FOUND_MEMBER };
  const active = formData.get("active") === "true";

  const result = await setMemberActive(supabase, id, active);
  if (!result.ok) return { status: "error", message: result.error.message };

  revalidatePath("/admin");
  revalidatePath("/admin/members");
  revalidatePath(`/admin/members/${id}/edit`);
  return { status: "success", message: `${result.data.name} was ${active ? "reactivated" : "deactivated"}.` };
}

/**
 * Corrección manual de asistencia (Present <-> Absent) en una reunión cerrada. No borra ningún registro:
 * la base de datos guarda la decisión aparte y deja el rastro en `audit_log`.
 */
export async function setAttendanceAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  const id = memberId(formData);
  if (!id) return { status: "error", message: NOT_FOUND_MEMBER };
  const sessionId = idSchema.safeParse(formData.get("sessionId"));
  const status = formData.get("status");
  if (!sessionId.success || !isAttendanceStatus(status)) return { status: "error", message: NOT_FOUND_ATTENDANCE };

  const result = await setMemberAttendance(supabase, { sessionId: sessionId.data, memberId: id, status });
  if (!result.ok) return { status: "error", message: result.error.message };

  revalidatePath("/admin");
  revalidatePath(`/admin/members/${id}/edit`);
  // También se corrige desde el roster de la sesión: su página, el historial de Attendance y la lista de sesiones muestran estos números.
  revalidatePath(`/admin/sessions/${sessionId.data}`);
  revalidatePath("/admin/attendance");
  revalidatePath("/admin/sessions");
  return { status: "success", message: `Marked as ${statusLabel(status)}.` };
}
