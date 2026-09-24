import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Result } from "@/lib/data/members";
import { describeDbError, NOT_FOUND_SESSION, type UserFacingError } from "@/lib/errors";
import type { SessionAudience } from "@/lib/session-audience";
import type { SessionInput } from "@/lib/validation/session";

/**
 * Acceso a datos de sesiones (solo servidor). Todo va con el cliente de la SESIÓN del administrador: RLS aplica
 * de verdad. La regla "una sola sesión activa" y el ciclo draft -> active -> closed los impone la BASE DE DATOS
 * (índice único y trigger); aquí solo se traducen sus errores a mensajes en inglés.
 */
export const SESSION_COLUMNS = "id, title, description, location, scheduled_at, status, audience, opened_at, opened_by, closed_at, created_at";

/** Tope defensivo de las listas (un semestre son decenas de reuniones). */
export const SESSION_LIST_LIMIT = 200;
export const LIVE_ATTENDEE_LIMIT = 500;

export type SessionStatus = "draft" | "active" | "closed";

export interface Session {
  id: string;
  title: string;
  description: string | null;
  location: string | null;
  scheduled_at: string;
  status: SessionStatus;
  /** A qué equipo(s) va dirigida (el "Required" de New Session): Design Team, Rowing & Construction o los dos ("both"). */
  audience: SessionAudience;
  opened_at: string | null;
  /** Administrador que abrió el check-in (lo fija la BD al activarla). null en borradores o si ese usuario se borró. */
  opened_by: string | null;
  closed_at: string | null;
  created_at: string;
}

export interface SessionListItem extends Session {
  /**
   * Asistentes. ACTIVA: check-ins en vivo (la misma fuente de getSessionLive). CERRADA: presentes de la población esperada
   * (`session_attendance_summary.present_count`, que solo cuenta reuniones cerradas). 0 para un borrador.
   */
  presentCount: number;
}

const fail = (error: UserFacingError): { ok: false; error: UserFacingError } => ({ ok: false, error });

export async function listSessions(sb: SupabaseClient): Promise<Result<SessionListItem[]>> {
  const [sessions, summary] = await Promise.all([
    sb.from("sessions").select(SESSION_COLUMNS).order("scheduled_at", { ascending: false }).limit(SESSION_LIST_LIMIT),
    sb.from("session_attendance_summary").select("session_id, present_count").limit(SESSION_LIST_LIMIT * 2),
  ]);
  if (sessions.error) return fail(describeDbError(sessions.error));
  if (summary.error) return fail(describeDbError(summary.error));

  const counts = new Map<string, number>();
  for (const row of (summary.data ?? []) as Array<{ session_id: string; present_count: number }>) counts.set(row.session_id, row.present_count);
  const rows = (sessions.data ?? []) as unknown as Session[];

  // El resumen solo cuenta reuniones CERRADAS: una sesión ACTIVA aparecería en 0. Su conteo en vivo es el número de check-ins (hay una sola activa a la vez).
  const live = await Promise.all(
    rows.filter((s) => s.status === "active").map(async (s) => ({ id: s.id, result: await sb.from("checkins").select("id", { count: "exact", head: true }).eq("session_id", s.id) })),
  );
  for (const { id, result } of live) {
    if (result.error) return fail(describeDbError(result.error));
    counts.set(id, result.count ?? 0);
  }
  return { ok: true, data: rows.map((s) => ({ ...s, presentCount: counts.get(s.id) ?? 0 })) };
}

export async function getSession(sb: SupabaseClient, id: string): Promise<Result<Session>> {
  const { data, error } = await sb.from("sessions").select(SESSION_COLUMNS).eq("id", id).maybeSingle();
  if (error) return fail(describeDbError(error));
  if (!data) return fail({ message: NOT_FOUND_SESSION });
  return { ok: true, data: data as unknown as Session };
}

/** La sesión activa (a lo sumo una: lo garantiza el índice único), o null. */
export async function getActiveSession(sb: SupabaseClient): Promise<Result<Session | null>> {
  const { data, error } = await sb.from("sessions").select(SESSION_COLUMNS).eq("status", "active").limit(1);
  if (error) return fail(describeDbError(error));
  return { ok: true, data: ((data ?? [])[0] as unknown as Session | undefined) ?? null };
}

/**
 * Alta DIRECTA: la sesión se crea ya ACTIVA en una sola sentencia (no hay borrador intermedio). Solo se guardan el NOMBRE y si es
 * obligatoria; la fecha/hora (`scheduled_at`, obligatoria en el esquema) la pone el SERVIDOR (`nowMs`). Quién/cuándo empezó el
 * check-in (`opened_by`, `opened_at`) lo fija la base de datos en el propio INSERT (su reloj y `auth.uid()`), y el índice único
 * `sessions_single_active` decide de forma atómica si ya había otra activa (sin dejar nada a medias). Descripción y ubicación
 * quedan vacías (ya no se piden).
 */
export async function createAndStartSession(
  sb: SupabaseClient,
  input: Pick<SessionInput, "title" | "audience">,
  nowMs: number = Date.now(),
): Promise<Result<Session>> {
  const { data, error } = await sb
    .from("sessions")
    .insert({
      title: input.title,
      scheduled_at: new Date(nowMs).toISOString(),
      audience: input.audience,
      status: "active",
    })
    .select(SESSION_COLUMNS)
    .single();
  if (error) return fail(describeDbError(error));
  return { ok: true, data: data as unknown as Session };
}

async function transition(sb: SupabaseClient, id: string, from: SessionStatus, to: SessionStatus): Promise<Result<Session>> {
  const { data, error } = await sb.from("sessions").update({ status: to }).eq("id", id).eq("status", from).select(SESSION_COLUMNS);
  if (error) return fail(describeDbError(error));
  if (data && data.length > 0) return { ok: true, data: data[0] as unknown as Session };

  // Ninguna fila cambió: la sesión no existe o ya no estaba en el estado esperado. Se explica sin adivinar.
  const current = await getSession(sb, id);
  if (!current.ok) return current;
  if (current.data.status === to) return current; // idempotente (doble clic / dos pestañas)
  if (current.data.status === "closed") return fail({ message: "That session is already closed." });
  return fail({ message: to === "active" ? "That session can't be started." : "That check-in hasn't started yet." });
}

/** draft -> active (solo para borradores HISTÓRICOS: la interfaz ya no crea borradores). Si ya hay otra activa, la BD lo rechaza. */
export async function startSession(sb: SupabaseClient, id: string): Promise<Result<Session>> {
  return transition(sb, id, "draft", "active");
}

/** active -> closed (definitivo). Desde ese instante el servidor rechaza QR, tickets y check-ins de la sesión. */
export async function closeSession(sb: SupabaseClient, id: string): Promise<Result<Session>> {
  return transition(sb, id, "active", "closed");
}

export interface LiveAttendee {
  /** Id del check-in (solo para la clave de la lista). */
  id: string;
  name: string;
  position: string;
  checkedInAt: string;
}

export interface SessionLive {
  session: Pick<Session, "id" | "title" | "location" | "status" | "audience" | "scheduled_at" | "opened_by">;
  /** Check-ins de esta sesión. */
  count: number;
  /** Miembros activos DEL GRUPO (o de los dos grupos, si es "both") al que va dirigida la sesión (denominador de "12 / 25"). */
  total: number;
  attendees: LiveAttendee[];
}

/** Miembros activos esperados en una sesión según su audiencia: un grupo, o la suma de los dos si va dirigida a ambos equipos. */
function activeMembersFor(audience: SessionAudience, designTeam: number, general: number): number {
  if (audience === "both") return designTeam + general;
  return audience === "design_team" ? designTeam : general;
}

/**
 * Asistencia en vivo de UNA sesión (la del id recibido). Solo nombre, cargo y hora: nunca el ASCE ID ni tokens (ni siquiera
 * se seleccionan esas columnas) ni credenciales. RLS: un usuario que no es administrador no ve nada.
 */
export async function getSessionLive(sb: SupabaseClient, id: string): Promise<Result<SessionLive>> {
  const [session, checkins, designTeam, general] = await Promise.all([
    sb.from("sessions").select("id, title, location, status, audience, scheduled_at, opened_by").eq("id", id).maybeSingle(),
    sb
      .from("checkins")
      .select("id, checked_in_at, members(name, position)")
      .eq("session_id", id)
      .order("checked_in_at", { ascending: false })
      .limit(LIVE_ATTENDEE_LIMIT),
    // Miembros activos de cada grupo: el denominador es el del grupo al que va dirigida la sesión.
    sb.from("members").select("id", { count: "exact", head: true }).eq("active", true).eq("is_design_team", true),
    sb.from("members").select("id", { count: "exact", head: true }).eq("active", true).eq("is_design_team", false),
  ]);
  if (session.error) return fail(describeDbError(session.error));
  if (!session.data) return fail({ message: NOT_FOUND_SESSION });
  if (checkins.error) return fail(describeDbError(checkins.error));
  if (designTeam.error) return fail(describeDbError(designTeam.error));
  if (general.error) return fail(describeDbError(general.error));

  type Row = { id: string; checked_in_at: string; members: { name: string; position: string } | { name: string; position: string }[] | null };
  const attendees: LiveAttendee[] = [];
  for (const row of (checkins.data ?? []) as unknown as Row[]) {
    const member = Array.isArray(row.members) ? row.members[0] : row.members;
    if (!member) continue; // un check-in cuyo miembro no es visible no se lista
    attendees.push({ id: row.id, name: member.name, position: member.position, checkedInAt: row.checked_in_at });
  }
  return {
    ok: true,
    data: {
      session: session.data as unknown as SessionLive["session"],
      count: attendees.length,
      total: activeMembersFor((session.data as { audience: SessionAudience }).audience, designTeam.count ?? 0, general.count ?? 0),
      attendees,
    },
  };
}

/**
 * Elimina la sesión (solo un administrador autenticado: RLS + permiso de tabla). La base de datos borra en cascada sus check-ins y
 * correcciones manuales, conserva los intentos de check-in sin sesión y deja el rastro `session.delete` en `audit_log`. Una sesión
 * ACTIVA también se puede eliminar: al desaparecer, el servidor deja de aceptar su QR, tickets y check-ins.
 */
export async function deleteSession(sb: SupabaseClient, id: string): Promise<Result<{ id: string }>> {
  const { data, error } = await sb.from("sessions").delete().eq("id", id).select("id");
  if (error) return fail(describeDbError(error));
  if (!data || data.length === 0) return fail({ message: NOT_FOUND_SESSION });
  return { ok: true, data: { id } };
}
