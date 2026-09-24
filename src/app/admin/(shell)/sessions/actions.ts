"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import type { ActionState } from "@/lib/action-state";
import { requireAdmin } from "@/lib/auth/session";
import { closeSession, createAndStartSession, deleteSession, startSession } from "@/lib/data/sessions";
import { NOT_FOUND_SESSION, type UserFacingError } from "@/lib/errors";
import { isTeamGroup } from "@/lib/session-audience";
import { idSchema } from "@/lib/validation/member";
import { parseSessionForm } from "@/lib/validation/session";

/**
 * Server Actions de sesiones. Son alcanzables por POST directo, así que CADA una: 1. vuelve a comprobar al
 * administrador (`requireAdmin`), 2. valida la entrada en el servidor, 3. usa el cliente con la sesión del
 * administrador (RLS) y 4. devuelve solo mensajes en inglés. "Una sola sesión activa" y el ciclo de vida de la sesión los
 * impone la base de datos; aquí solo se traducen sus errores.
 */
function echoValues(formData: FormData): Record<string, string> {
  const title = formData.get("title");
  // Las casillas marcadas (una o las dos) se devuelven separadas por comas para volver a pintar el formulario.
  const audience = formData.getAll("audience").filter(isTeamGroup);
  return { title: typeof title === "string" ? title.slice(0, 300) : "", audience: audience.join(",") };
}

function errorState(error: UserFacingError, formData?: FormData): ActionState {
  if (error.field) {
    return { status: "error", message: "Please fix the highlighted field.", fieldErrors: { [error.field]: error.message }, values: formData ? echoValues(formData) : undefined };
  }
  return { status: "error", message: error.message, values: formData ? echoValues(formData) : undefined };
}

function sessionId(formData: FormData): string | null {
  const parsed = idSchema.safeParse(formData.get("id"));
  return parsed.success ? parsed.data : null;
}

function revalidateSessions(id?: string) {
  revalidatePath("/admin");
  revalidatePath("/admin/sessions");
  if (id) revalidatePath(`/admin/sessions/${id}`);
}

/**
 * "Start Check-In": crea la sesión YA ACTIVA (un solo INSERT: la BD fija opened_at/opened_by y rechaza una segunda activa) y lleva
 * al administrador a la pantalla del QR. No hay borrador intermedio.
 */
export async function createSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  // Solo se lee el nombre y el grupo ("Required"): cualquier otro campo enviado a mano (descripción, ubicación, fecha, estado) se ignora.
  const parsed = parseSessionForm(formData);
  if (!parsed.ok) {
    return { status: "error", message: "Please fix the highlighted field.", fieldErrors: parsed.fieldErrors, values: echoValues(formData) };
  }

  const created = await createAndStartSession(supabase, parsed.data);
  if (!created.ok) return errorState(created.error, formData);

  revalidateSessions(created.data.id);
  redirect(`/admin/sessions/${created.data.id}/qr`);
}

/** draft -> active (solo borradores HISTÓRICOS). Ya hay otra activa: la base de datos lo rechaza y se muestra el aviso (no se crea un duplicado). */
export async function startSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  const id = sessionId(formData);
  if (!id) return { status: "error", message: NOT_FOUND_SESSION };

  const result = await startSession(supabase, id);
  if (!result.ok) return { status: "error", message: result.error.message };

  revalidateSessions(id);
  redirect(`/admin/sessions/${id}/qr`);
}

/** active -> closed (definitivo). Desde ese instante el servidor rechaza el QR, los tickets y los check-ins. */
export async function closeSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  const id = sessionId(formData);
  if (!id) return { status: "error", message: NOT_FOUND_SESSION };

  const result = await closeSession(supabase, id);
  if (!result.ok) return { status: "error", message: result.error.message };

  revalidateSessions(id);
  return { status: "success", message: "Check-in closed." };
}

/**
 * Elimina la sesión y sus registros de asistencia (con confirmación explícita en la interfaz). Solo un administrador autenticado
 * (`requireAdmin` + RLS). La base de datos borra en cascada check-ins y correcciones, deja el rastro `session.delete` en
 * `audit_log` y conserva los intentos de check-in sin sesión. Si estaba activa, deja de aceptar QR/tickets/check-ins al instante.
 */
export async function deleteSessionAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  const { supabase } = await requireAdmin();

  const id = sessionId(formData);
  if (!id) return { status: "error", message: NOT_FOUND_SESSION };

  const result = await deleteSession(supabase, id);
  if (!result.ok) return { status: "error", message: result.error.message };

  revalidateSessions();
  redirect("/admin/sessions");
}
