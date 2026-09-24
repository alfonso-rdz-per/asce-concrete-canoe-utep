/**
 * Traduce errores de la base de datos / PostgREST a mensajes EN INGLÉS para el usuario.
 * Nunca se muestra un error crudo de Postgres, de PostgREST ni de Supabase Auth.
 */
export type ErrorField = "asceId" | "name" | "email" | "joinedOn" | "position" | "customPosition" | "title" | "description" | "location" | "scheduledAt" | "audience";

export interface UserFacingError {
  message: string;
  field?: ErrorField;
}

export const GENERIC_ERROR = "Something went wrong. Please try again.";
export const NOT_FOUND_MEMBER = "That member no longer exists.";
export const NO_PERMISSION = "You don't have permission to do that. Try signing in again.";
export const NOT_FOUND_ATTENDANCE = "That meeting or member no longer exists.";
export const NOT_FOUND_SESSION = "That session no longer exists.";
export const CHECKIN_ALREADY_ACTIVE = "A check-in is already in progress. Close it before starting another one.";

interface DbErrorLike {
  code?: string | null;
  message?: string | null;
  details?: string | null;
}

export function describeDbError(err: DbErrorLike | null | undefined): UserFacingError {
  if (!err) return { message: GENERIC_ERROR };
  const code = err.code ?? "";
  const text = `${err.message ?? ""} ${err.details ?? ""}`;

  // Correcciones manuales de asistencia (errores `asce:*` de los triggers y de set_member_attendance).
  if (text.includes("asce:attendance_session_not_closed")) return { message: "Attendance can only be edited for closed meetings." };
  if (text.includes("asce:attendance_no_change")) return { message: "That attendance is already set to that status." };
  if (code === "23503" && text.includes("attendance_overrides")) return { message: NOT_FOUND_ATTENDANCE };

  // Sesiones: una sola activa a la vez y ciclo draft -> active -> closed (los impone la base de datos).
  if (code === "23505" && text.includes("sessions_single_active")) return { message: CHECKIN_ALREADY_ACTIVE };
  if (text.includes("asce:session_closed_is_final")) return { message: "That session is already closed." };
  if (text.includes("asce:session_invalid_transition") || text.includes("asce:session_must_start_as_draft")) {
    return { message: "That session can't be changed that way." };
  }
  if (code === "23514") {
    if (text.includes("sessions_title_length")) return { field: "title", message: "Title must be between 1 and 160 characters." };
    if (text.includes("sessions_description_length")) return { field: "description", message: "Description must be 2000 characters or fewer." };
    if (text.includes("sessions_location_valid")) return { field: "location", message: "Enter a valid location (1–120 characters)." };
  }

  if (code === "23505" && text.includes("members_asce_id_key")) {
    return { field: "asceId", message: "That ASCE ID is already registered." };
  }
  if (code === "23514") {
    if (text.includes("members_asce_id_format")) return { field: "asceId", message: "ASCE ID must be 3–32 letters, numbers or hyphens." };
    if (text.includes("members_name_length")) return { field: "name", message: "Name must be between 1 and 120 characters." };
    if (text.includes("members_email_format")) return { field: "email", message: "Enter a valid email address." };
    if (text.includes("members_position_valid")) return { field: "customPosition", message: "Enter a valid position (1–60 characters)." };
    if (text.includes("members_deactivated_after_joined")) {
      return { field: "joinedOn", message: "The join date can't be later than the deactivation date." };
    }
    return { message: "Some of the values are not valid." };
  }
  if (code === "42501") return { message: NO_PERMISSION };
  if (code === "PGRST116") return { message: NOT_FOUND_MEMBER };
  return { message: GENERIC_ERROR };
}
