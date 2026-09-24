import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttendanceCounts, AttendanceGroup, AttendanceSource, AttendanceStatus, MeetingSummary, RosterRow } from "@/lib/attendance";
import { describeDbError } from "@/lib/errors";
import type { SessionAudience } from "@/lib/session-audience";
import { listMembers, MEMBER_LIST_LIMIT, type Member, type Result } from "@/lib/data/members";
import { SESSION_LIST_LIMIT } from "@/lib/data/sessions";

/**
 * Acceso a datos de asistencia (solo servidor). Todo va con el cliente de la SESIÓN del administrador
 * (RLS aplica). El conteo de reuniones lo hacen las vistas de la base de datos (`member_attendance`,
 * `session_attendance`): aquí no se suman check-ins a mano (PostgREST corta a 1000 filas).
 */
const fail = (error: ReturnType<typeof describeDbError>): { ok: false; error: ReturnType<typeof describeDbError> } => ({ ok: false, error });

/** Tope defensivo del historial por miembro (un semestre son decenas de reuniones). */
export const HISTORY_LIMIT = 200;

export interface DashboardData {
  /** Miembros activos (el roster del equipo), ordenados por nombre. */
  members: Member[];
  /** Conteos de asistencia por member_id. Un miembro sin entrada no tiene reuniones que cuenten. */
  counts: Map<string, AttendanceCounts>;
  /** Reuniones cerradas (ya celebradas). */
  totalMeetings: number;
  activeSession: { id: string; title: string } | null;
}

export async function getDashboardData(sb: SupabaseClient): Promise<Result<DashboardData>> {
  const [membersResult, attendance, closed, active] = await Promise.all([
    listMembers(sb),
    sb.from("member_attendance").select("member_id, counted_meetings, attended_meetings").limit(MEMBER_LIST_LIMIT),
    sb.from("sessions").select("id", { count: "exact", head: true }).eq("status", "closed"),
    sb.from("sessions").select("id, title").eq("status", "active").limit(1),
  ]);

  if (!membersResult.ok) return membersResult;
  if (attendance.error) return fail(describeDbError(attendance.error));
  if (closed.error) return fail(describeDbError(closed.error));
  if (active.error) return fail(describeDbError(active.error));

  const counts = new Map<string, AttendanceCounts>();
  for (const row of (attendance.data ?? []) as Array<{ member_id: string; counted_meetings: number; attended_meetings: number }>) {
    counts.set(row.member_id, { counted: row.counted_meetings, attended: row.attended_meetings });
  }
  const activeRow = (active.data ?? [])[0] as { id: string; title: string } | undefined;

  return {
    ok: true,
    data: {
      members: membersResult.data.filter((m) => m.active),
      counts,
      totalMeetings: closed.count ?? 0,
      activeSession: activeRow ? { id: activeRow.id, title: activeRow.title } : null,
    },
  };
}

export interface AttendanceHistoryRow {
  sessionId: string;
  title: string;
  /** Cuándo ocurrió la reunión (apertura real; si no, la fecha programada). ISO 8601. */
  heldAt: string;
  sessionStatus: "active" | "closed";
  /** A qué equipo(s) iba dirigida la reunión (Design Team / Rowing & Construction / los dos). */
  audience: SessionAudience;
  /** ¿Iba dirigida al grupo de ESTE miembro? Si no, no cuenta para su porcentaje. */
  forMember: boolean;
  status: AttendanceStatus;
  source: AttendanceSource;
}

/** Historial de un miembro: una fila por reunión no borrador, la más reciente primero. */
export async function getMemberAttendanceHistory(sb: SupabaseClient, memberId: string): Promise<Result<AttendanceHistoryRow[]>> {
  const { data, error } = await sb
    .from("session_attendance")
    .select("session_id, session_title, session_held_at, session_status, session_audience, for_member, status, source")
    .eq("member_id", memberId)
    .order("session_held_at", { ascending: false })
    .limit(HISTORY_LIMIT);
  if (error) return fail(describeDbError(error));

  const rows = (data ?? []) as Array<{
    session_id: string;
    session_title: string;
    session_held_at: string;
    session_status: "active" | "closed";
    session_audience: SessionAudience;
    for_member: boolean;
    status: AttendanceStatus;
    source: AttendanceSource;
  }>;
  return {
    ok: true,
    data: rows.map((r) => ({
      sessionId: r.session_id,
      title: r.session_title,
      heldAt: r.session_held_at,
      sessionStatus: r.session_status,
      audience: r.session_audience,
      forMember: r.for_member,
      status: r.status,
      source: r.source,
    })),
  };
}

type WriteError = { code?: string | null; message?: string | null; details?: string | null } | null;

/**
 * Cambia Present <-> Absent de un miembro en una reunión CERRADA. No borra nada: actualiza la fila de
 * `attendance_overrides` o, si aún no existe, la crea; un trigger deja el rastro en `audit_log` (actor,
 * miembro, sesión, estado anterior y nuevo, fecha). Corre con la RLS y los permisos por columna del
 * administrador que la llama (no hay ninguna función expuesta en `public`).
 */
export async function setMemberAttendance(
  sb: SupabaseClient,
  input: { sessionId: string; memberId: string; status: AttendanceStatus },
): Promise<Result<null>> {
  const write = async (): Promise<WriteError> => {
    const updated = await sb
      .from("attendance_overrides")
      .update({ status: input.status })
      .eq("session_id", input.sessionId)
      .eq("member_id", input.memberId)
      .select("status");
    if (updated.error) return updated.error;
    if ((updated.data ?? []).length > 0) return null;

    const inserted = await sb.from("attendance_overrides").insert({ session_id: input.sessionId, member_id: input.memberId, status: input.status });
    return inserted.error;
  };

  let error = await write();
  // Dos administradores pueden cambiar la misma fila a la vez: el segundo INSERT choca con la clave primaria
  // (23505) y se reintenta UNA vez, ya como UPDATE.
  if (error?.code === "23505") error = await write();
  if (error) return fail(describeDbError(error));
  return { ok: true, data: null };
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Attendance (reuniones CERRADAS): historial y detalle con roster
// ---------------------------------------------------------------------------------------------------------------------------------
// Fuente de verdad: la base de datos. `session_attendance_summary` da presentes / esperados / porcentaje de cada reunión CERRADA y
// `session_attendance.counts_toward_rate` marca quién estaba esperado en ella (la MISMA marca que alimenta el porcentaje individual). Aquí no se
// reconstruye ninguna regla de pertenencia: ni "activo hoy", ni fechas de ingreso/baja, ni grupo. Una reunión ACTIVA no pasa por aquí (su conteo en
// vivo sale de getSessionLive): el resumen la trata como "aún no cuenta".

const SUMMARY_COLUMNS = "session_id, present_count, expected_count, rate";
/** Ids por consulta `in.(...)`: mantiene la URL de PostgREST corta (50 UUID ≈ 2 KB) aunque haya cientos de reuniones. */
const SUMMARY_CHUNK = 50;

/** Tope defensivo del historial (mismo que la lista de sesiones): las más recientes primero. */
export const MEETING_LIST_LIMIT = SESSION_LIST_LIMIT;

export type { MeetingSummary, RosterRow };

export interface MeetingRow extends MeetingSummary {
  sessionId: string;
  title: string;
  /** Cuándo ocurrió (apertura real; si no, la fecha programada). ISO 8601. */
  heldAt: string;
  audience: SessionAudience;
}

type SummaryDbRow = { session_id: string; present_count: number; expected_count: number; rate: number | null };

/** Una reunión sin fila en el resumen (p. ej. no hay ningún miembro en la base de datos) es 0 de 0 y sin porcentaje. */
const EMPTY_SUMMARY: MeetingSummary = { present: 0, expected: 0, rate: null };
const toSummary = (r: SummaryDbRow): MeetingSummary => ({ present: r.present_count, expected: r.expected_count, rate: r.rate });

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Reuniones CERRADAS (las más recientes primero), opcionalmente de un solo equipo (incluye las dirigidas a los dos), con presentes / esperados / porcentaje. */
export async function listClosedMeetings(sb: SupabaseClient, group: AttendanceGroup): Promise<Result<{ meetings: MeetingRow[]; truncated: boolean }>> {
  let query = sb.from("sessions").select("id, title, audience, opened_at, scheduled_at").eq("status", "closed");
  if (group !== "all") query = query.in("audience", [group, "both"]);
  const sessions = await query.order("opened_at", { ascending: false }).limit(MEETING_LIST_LIMIT);
  if (sessions.error) return fail(describeDbError(sessions.error));

  const rows = (sessions.data ?? []) as Array<{ id: string; title: string; audience: SessionAudience; opened_at: string | null; scheduled_at: string }>;
  const summaries = await Promise.all(chunk(rows.map((r) => r.id), SUMMARY_CHUNK).map((ids) => sb.from("session_attendance_summary").select(SUMMARY_COLUMNS).in("session_id", ids)));
  const bySession = new Map<string, MeetingSummary>();
  for (const result of summaries) {
    if (result.error) return fail(describeDbError(result.error));
    for (const row of (result.data ?? []) as SummaryDbRow[]) bySession.set(row.session_id, toSummary(row));
  }

  return {
    ok: true,
    data: {
      meetings: rows.map((r) => ({ sessionId: r.id, title: r.title, heldAt: r.opened_at ?? r.scheduled_at, audience: r.audience, ...(bySession.get(r.id) ?? EMPTY_SUMMARY) })),
      truncated: rows.length >= MEETING_LIST_LIMIT,
    },
  };
}

export interface SessionAttendanceDetail {
  summary: MeetingSummary;
  /** Solo la población esperada de esa reunión (filas con `counts_toward_rate`), por nombre. */
  roster: RosterRow[];
}

/**
 * Detalle de una reunión CERRADA: el resumen y el roster de los miembros esperados. El roster NO se reconstruye con `members.active` ni con
 * fechas: se pide a la base de datos exactamente las filas de `session_attendance` con `counts_toward_rate` (un miembro de otro grupo, o que no
 * pertenecía al equipo ese día y no asistió, no aparece y por tanto no se puede corregir desde la interfaz).
 */
export async function getSessionAttendanceDetail(sb: SupabaseClient, sessionId: string): Promise<Result<SessionAttendanceDetail>> {
  const [summary, population, members] = await Promise.all([
    sb.from("session_attendance_summary").select(SUMMARY_COLUMNS).eq("session_id", sessionId).maybeSingle(),
    sb.from("session_attendance").select("member_id, status, source").eq("session_id", sessionId).eq("counts_toward_rate", true).limit(MEMBER_LIST_LIMIT),
    listMembers(sb),
  ]);
  if (summary.error) return fail(describeDbError(summary.error));
  if (population.error) return fail(describeDbError(population.error));
  if (!members.ok) return members;

  const byId = new Map(members.data.map((m) => [m.id, m]));
  const roster: RosterRow[] = [];
  for (const row of (population.data ?? []) as Array<{ member_id: string; status: AttendanceStatus; source: AttendanceSource }>) {
    const m = byId.get(row.member_id);
    if (m) roster.push({ memberId: m.id, name: m.name, asceId: m.asce_id, position: m.position, status: row.status, source: row.source });
  }
  roster.sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }) || a.asceId.localeCompare(b.asceId));

  return { ok: true, data: { summary: summary.data ? toSummary(summary.data as SummaryDbRow) : EMPTY_SUMMARY, roster } };
}
