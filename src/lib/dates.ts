/** Zona horaria del equipo (El Paso, TX). Todas las fechas "de calendario" se calculan aquí. */
export const APP_TIME_ZONE = "America/Denver";

const DATE_ONLY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Hoy en El Paso como AAAA-MM-DD, calculado con la hora del servidor recibida. */
export function todayInElPaso(nowMs: number = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: APP_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(nowMs);
}

/** true solo para fechas de calendario reales (rechaza 2026-02-30, 2026-13-01, etc.). */
export function isValidDateOnly(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const m = DATE_ONLY_RE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/** "Sep 19, 2026". La fecha es de calendario (sin hora): se formatea en UTC para no desplazarla. */
export function formatDateOnly(value: string): string {
  if (!isValidDateOnly(value)) return "—";
  const [y, mo, d] = value.split("-").map(Number);
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: "UTC" }).format(Date.UTC(y, mo - 1, d));
}

/** "Sep 19, 2026" para un instante (ISO 8601), en la zona horaria del equipo. "—" si no es una fecha válida. */
export function formatMeetingDate(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: APP_TIME_ZONE }).format(ms);
}

/** "Sep 19, 2026, 6:00 PM" para un instante (ISO 8601), en la zona horaria del equipo. "—" si no es válido. */
export function formatMeetingDateTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: APP_TIME_ZONE }).format(ms);
}

/** "Sep 19, 2026 · 7:42 PM" (hora de El Paso). "—" si no es una fecha válida. */
export function formatDateDotTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const date = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeZone: APP_TIME_ZONE }).format(ms);
  const time = new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: APP_TIME_ZONE }).format(ms);
  return `${date} · ${time}`;
}

/** "6:04 PM" (hora de El Paso) para un instante ISO. */
export function formatClockTime(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: APP_TIME_ZONE }).format(ms);
}

const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Diferencia (ms) entre la hora de pared de El Paso y UTC en un instante dado (negativa al oeste de UTC). */
function zoneOffsetMs(instantMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: APP_TIME_ZONE,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instantMs);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const wallAsUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return wallAsUtc - Math.floor(instantMs / 1000) * 1000;
}

/**
 * "2026-09-19T18:00" (valor de <input type="datetime-local">, hora de El Paso) -> instante ISO UTC.
 * null si no es una fecha y hora reales (rechaza 2026-02-30T10:00, 25:00, etc.).
 */
export function elPasoLocalToIso(local: unknown): string | null {
  if (typeof local !== "string") return null;
  const m = LOCAL_DATETIME_RE.exec(local);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const wallAsUtc = Date.UTC(y, mo - 1, d, h, mi);
  const check = new Date(wallAsUtc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d || check.getUTCHours() !== h || check.getUTCMinutes() !== mi) {
    return null;
  }
  // La compensación depende del propio instante (horario de verano): se converge en dos pasos.
  let instant = wallAsUtc - zoneOffsetMs(wallAsUtc);
  instant = wallAsUtc - zoneOffsetMs(instant);
  return new Date(instant).toISOString();
}

/** Instante -> "2026-09-19T18:00" en hora de El Paso (valor inicial de un <input type="datetime-local">). */
export function toElPasoLocal(nowMs: number = Date.now()): string {
  const wall = new Date(nowMs + zoneOffsetMs(nowMs));
  return wall.toISOString().slice(0, 16);
}

/** Suma días a una fecha de calendario AAAA-MM-DD. */
export function addDaysToDateOnly(value: string, days: number): string {
  const [y, mo, d] = value.split("-").map(Number);
  return new Date(Date.UTC(y, mo - 1, d + days)).toISOString().slice(0, 10);
}

/** La mayor de dos fechas AAAA-MM-DD (comparación léxica válida para este formato). */
export function maxDateOnly(a: string, b: string): string {
  return a >= b ? a : b;
}
