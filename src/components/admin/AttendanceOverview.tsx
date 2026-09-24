import Link from "next/link";
import { ATTENDANCE_GROUPS, formatRate, type AttendanceGroup } from "@/lib/attendance";
import type { MeetingRow } from "@/lib/data/attendance";
import { formatMeetingDate } from "@/lib/dates";
import { AUDIENCE_LABEL } from "@/lib/session-audience";

const FILTER_LABEL: Record<AttendanceGroup, string> = {
  all: "All",
  design_team: AUDIENCE_LABEL.design_team,
  remar_construction: AUDIENCE_LABEL.remar_construction,
};

/** Filtro por grupo: enlaces (GET), así funciona sin JavaScript, se puede compartir la URL y los botones son cómodos al tacto en iPhone. */
export function AttendanceGroupFilter({ group }: { group: AttendanceGroup }) {
  return (
    <nav aria-label="Filter by group">
      <ul className="flex flex-wrap gap-2">
        {ATTENDANCE_GROUPS.map((g) => {
          const active = g === group;
          return (
            <li key={g}>
              <Link
                href={g === "all" ? "/admin/attendance" : `/admin/attendance?group=${g}`}
                aria-current={active ? "page" : undefined}
                className={`inline-flex min-h-11 items-center rounded-full border px-4 text-sm font-semibold ${
                  active ? "border-navy bg-navy text-white" : "border-line bg-white text-ink hover:bg-surface"
                }`}
              >
                {FILTER_LABEL[g]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Historial de reuniones cerradas. Una tarjeta-enlace por reunión (móvil primero; en pantallas anchas la misma fila se reparte a izquierda y derecha):
 *     Concrete Canoe Meeting                          8 / 10   80%
 *     Design Team · Sep 19, 2026
 * Sin nadie esperado, el porcentaje es «—» (nunca «0 %»).
 */
export function AttendanceMeetingList({ meetings }: { meetings: MeetingRow[] }) {
  return (
    <ul className="divide-y divide-line">
      {meetings.map((m) => (
        <li key={m.sessionId}>
          <Link
            href={`/admin/sessions/${m.sessionId}`}
            className="flex min-h-11 flex-wrap items-center justify-between gap-x-6 gap-y-2 px-4 py-4 hover:bg-surface sm:px-5"
          >
            <span className="min-w-0 flex-1 basis-56">
              <span className="block break-words font-semibold text-ink">{m.title}</span>
              <span className="block text-sm text-muted">
                {AUDIENCE_LABEL[m.audience]} · {formatMeetingDate(m.heldAt)}
              </span>
            </span>
            <span className="flex items-baseline gap-4 tabular-nums">
              <span aria-hidden="true" className="text-muted">
                <span className="font-semibold text-ink">{m.present}</span> / {m.expected}
              </span>
              <span aria-hidden="true" className="min-w-[3.5rem] text-right text-lg font-bold text-navy">
                {formatRate(m.rate)}
              </span>
              <span className="sr-only">
                {m.present} of {m.expected} present, attendance rate {formatRate(m.rate)}
              </span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
