/**
 * Reglas de presentación de la asistencia. Módulo SIN dependencias (lo usan servidor y pruebas).
 *
 * El CONTEO (qué reuniones cuentan para cada miembro y quién se espera en cada reunión) lo hace la base de datos en las vistas
 * `session_attendance` / `member_attendance` / `session_attendance_summary`: solo reuniones CERRADAS dirigidas al grupo del miembro
 * (`counts_toward_rate`), desde joined_on hasta deactivated_on en la fecha de la reunión, y una asistencia real nunca se descarta.
 * Aquí solo se convierte ese conteo en un porcentaje y se da formato.
 */
import { TEAM_GROUPS, type TeamGroup } from "@/lib/session-audience";

export type AttendanceStatus = "present" | "absent";
export type AttendanceSource = "check_in" | "manual" | "none";

export interface AttendanceCounts {
  counted: number;
  attended: number;
}

/** Porcentaje entero 0–100, o null si el miembro aún no tiene reuniones que cuenten. Nunca supera 100. */
export function attendancePercent({ counted, attended }: AttendanceCounts): number | null {
  if (!Number.isFinite(counted) || !Number.isFinite(attended) || counted <= 0) return null;
  const pct = Math.round((Math.max(0, attended) / counted) * 100);
  return Math.min(100, Math.max(0, pct));
}

/** Promedio de los porcentajes individuales (solo miembros con al menos una reunión que cuente). */
export function averageAttendance(all: AttendanceCounts[]): number | null {
  const percents = all.map(attendancePercent).filter((p): p is number => p !== null);
  if (percents.length === 0) return null;
  return Math.min(100, Math.round(percents.reduce((sum, p) => sum + p, 0) / percents.length));
}

export function otherStatus(status: AttendanceStatus): AttendanceStatus {
  return status === "present" ? "absent" : "present";
}

export function statusLabel(status: AttendanceStatus): string {
  return status === "present" ? "Present" : "Absent";
}

export function isAttendanceStatus(value: unknown): value is AttendanceStatus {
  return value === "present" || value === "absent";
}

/** Presentes / esperados / porcentaje de una reunión CERRADA (los calcula la base de datos en `session_attendance_summary`). */
export interface MeetingSummary {
  /** Presentes DENTRO de la población esperada (nunca supera a `expected`). */
  present: number;
  /** Miembros esperados en esa reunión. */
  expected: number;
  /** 0-100, o null cuando no había nadie esperado (la pantalla muestra «—», no «0 %»). */
  rate: number | null;
}

/** Una fila del roster de una reunión cerrada: un miembro esperado con su estado efectivo. */
export interface RosterRow {
  memberId: string;
  name: string;
  asceId: string;
  position: string;
  /** Estado EFECTIVO: corrección manual si existe; si no, check-in; si no, ausente. */
  status: AttendanceStatus;
  source: AttendanceSource;
}

/** Filtro por grupo de la pantalla Attendance: todas las reuniones o las de un equipo (incluidas las dirigidas a los dos equipos). */
export const ATTENDANCE_GROUPS = ["all", ...TEAM_GROUPS] as const;
export type AttendanceGroup = "all" | TeamGroup;

/** Valor de `?group=` de la URL -> filtro válido. Cualquier otra cosa (ausente, repetido, manipulado) es "all". */
export function parseAttendanceGroup(value: unknown): AttendanceGroup {
  return typeof value === "string" && (ATTENDANCE_GROUPS as readonly string[]).includes(value) ? (value as AttendanceGroup) : "all";
}

/**
 * `rate` de `session_attendance_summary` (entero 0-100, o NULL cuando no había nadie esperado) -> texto. NULL es "—", nunca "0%".
 * Aunque la base de datos ya garantiza 0-100, aquí también se acota: la pantalla nunca muestra más de 100 %.
 */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return "—";
  return `${Math.min(100, Math.max(0, Math.round(rate)))}%`;
}
