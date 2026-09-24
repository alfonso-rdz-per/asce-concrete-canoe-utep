import Link from "next/link";
import { startSessionAction } from "@/app/admin/(shell)/sessions/actions";
import { StartSessionButton } from "@/components/admin/SessionControls";
import { SessionStatusBadge } from "@/components/admin/SessionStatusBadge";
import { ButtonLink } from "@/components/ui/Button";
import type { SessionListItem } from "@/lib/data/sessions";
import { AUDIENCE_LABEL } from "@/lib/session-audience";
import { formatDateDotTime } from "@/lib/dates";

/**
 * Lista de sesiones: una sola tabla responsive. La primera columna reúne lo importante:
 *     Concrete Canoe Practice
 *     Started by Lesley
 *     Sep 19, 2026 · 7:42 PM
 * (el nombre sale de `display_name` del administrador que abrió el check-in; sin él, solo la fecha). Un borrador muestra cuándo
 * se creó. Las sesiones antiguas con ubicación la siguen mostrando; ya no se pide al crear.
 */
export function SessionList({ sessions, starters }: { sessions: SessionListItem[]; starters: ReadonlyMap<string, string> }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <caption className="sr-only">Sessions</caption>
        <thead className="border-b border-line bg-surface text-sm text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold sm:px-5">Session</th>
            <th scope="col" className="hidden px-5 py-3 font-semibold sm:table-cell">Required</th>
            <th scope="col" className="px-4 py-3 font-semibold sm:px-5">Status</th>
            <th scope="col" className="hidden px-5 py-3 font-semibold sm:table-cell">Attendance</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold sm:px-5">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {sessions.map((s) => {
            const startedBy = s.opened_by ? (starters.get(s.opened_by) ?? null) : null;
            return (
              <tr key={s.id}>
                <th scope="row" className="min-w-0 px-4 py-3 align-top font-semibold text-ink sm:px-5">
                  <Link href={`/admin/sessions/${s.id}`} className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
                    {s.title}
                  </Link>
                  {startedBy ? <span className="block text-sm font-normal text-muted">Started by {startedBy}</span> : null}
                  <span className="block text-sm font-normal text-muted">
                    {s.opened_at ? formatDateDotTime(s.opened_at) : `Created ${formatDateDotTime(s.scheduled_at)}`}
                  </span>
                  {s.location ? <span className="block text-sm font-normal text-muted">Location: {s.location}</span> : null}
                  <span className="block text-sm font-normal text-muted sm:hidden">{AUDIENCE_LABEL[s.audience]}</span>
                </th>
                <td className="hidden px-5 py-3 align-top sm:table-cell">{AUDIENCE_LABEL[s.audience]}</td>
                <td className="px-4 py-3 align-top sm:px-5">
                  <SessionStatusBadge status={s.status} />
                </td>
                <td className="hidden px-5 py-3 align-top tabular-nums sm:table-cell">{s.status === "draft" ? "—" : s.presentCount}</td>
                <td className="px-4 py-3 text-right align-top sm:px-5">
                  {s.status === "active" ? (
                    <ButtonLink href={`/admin/sessions/${s.id}/qr`} size="sm">
                      Open QR{" "}
                      <span className="sr-only">for {s.title}</span>
                    </ButtonLink>
                  ) : s.status === "draft" ? (
                    <StartSessionButton sessionId={s.id} sessionTitle={s.title} action={startSessionAction} size="sm" />
                  ) : (
                    <Link href={`/admin/sessions/${s.id}`} className="inline-flex min-h-11 items-center px-3 font-semibold text-blue underline-offset-4 hover:underline">
                      View{" "}
                      <span className="sr-only">{s.title}</span>
                    </Link>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
