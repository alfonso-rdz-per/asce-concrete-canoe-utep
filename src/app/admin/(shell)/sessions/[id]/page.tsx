import { ArrowLeft, QrCode } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setAttendanceAction } from "@/app/admin/(shell)/members/actions";
import { closeSessionAction, deleteSessionAction, startSessionAction } from "@/app/admin/(shell)/sessions/actions";
import { CloseSessionControl, DeleteSessionControl, StartSessionButton } from "@/components/admin/SessionControls";
import { SessionAttendance } from "@/components/admin/SessionAttendance";
import { SessionStatusBadge } from "@/components/admin/SessionStatusBadge";
import { Alert, Card, PageHeader } from "@/components/ui/Display";
import { ButtonLink } from "@/components/ui/Button";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminFirstNames } from "@/lib/data/admin-names";
import { getSessionAttendanceDetail } from "@/lib/data/attendance";
import { getSession, getSessionLive } from "@/lib/data/sessions";
import { formatClockTime, formatDateDotTime } from "@/lib/dates";
import { AUDIENCE_LABEL } from "@/lib/session-audience";
import { idSchema } from "@/lib/validation/member";

export const metadata: Metadata = { title: "Session" };

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[10rem_1fr] sm:gap-4">
      <dt className="text-sm font-semibold text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-ink">{children}</dd>
    </div>
  );
}

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireAdmin();
  const { id } = await params;

  // El id viene de la URL: se valida antes de tocar la base de datos.
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const result = await getSession(supabase, parsedId.data);
  if (!result.ok) notFound();
  const session = result.data;

  // ACTIVA: asistencia en vivo (check-ins). CERRADA: resumen y roster de la población esperada, calculados por la base de datos (Attendance).
  const [live, starters, closedAttendance] = await Promise.all([
    session.status === "draft" ? null : getSessionLive(supabase, session.id),
    getAdminFirstNames(),
    session.status === "closed" ? getSessionAttendanceDetail(supabase, session.id) : null,
  ]);
  const startedBy = session.opened_by ? (starters.get(session.opened_by) ?? null) : null;

  return (
    <>
      <Link href="/admin/sessions" className="inline-flex min-h-11 items-center gap-2 font-semibold text-blue underline-offset-4 hover:underline">
        <ArrowLeft aria-hidden="true" className="h-5 w-5" />
        Back to sessions
      </Link>

      <PageHeader
        title={session.title}
        description={
          session.opened_at
            ? `${startedBy ? `Started by ${startedBy} · ` : "Started "}${formatDateDotTime(session.opened_at)}`
            : `Created ${formatDateDotTime(session.scheduled_at)}`
        }
        actions={
          <div className="flex flex-wrap items-start gap-2">
            {session.status === "draft" ? <StartSessionButton sessionId={session.id} sessionTitle={session.title} action={startSessionAction} /> : null}
            {session.status === "active" ? (
              <>
                <ButtonLink href={`/admin/sessions/${session.id}/qr`}>
                  <QrCode aria-hidden="true" className="h-5 w-5" />
                  Open QR screen
                </ButtonLink>
                <CloseSessionControl sessionId={session.id} sessionTitle={session.title} action={closeSessionAction} />
              </>
            ) : null}
          </div>
        }
      />

      <Card className="max-w-3xl p-5 sm:p-8">
        <h2 className="mb-5 text-lg font-bold text-navy">Details</h2>
        <dl className="space-y-4">
          <Detail label="Status">
            <SessionStatusBadge status={session.status} />
          </Detail>
          <Detail label="Required">{AUDIENCE_LABEL[session.audience]}</Detail>
          <Detail label="Created">{formatDateDotTime(session.scheduled_at)}</Detail>
          {startedBy ? <Detail label="Started by">{startedBy}</Detail> : null}
          {session.opened_at ? <Detail label="Check-in opened">{formatDateDotTime(session.opened_at)}</Detail> : null}
          {session.closed_at ? <Detail label="Check-in closed">{formatDateDotTime(session.closed_at)}</Detail> : null}
          {/* Sesiones antiguas: la ubicación y la descripción se conservan y se muestran si existen (ya no se piden al crear). */}
          {session.location ? <Detail label="Location">{session.location}</Detail> : null}
          {session.description ? <Detail label="Description"><span className="whitespace-pre-line">{session.description}</span></Detail> : null}
        </dl>
      </Card>

      {closedAttendance ? (
        <Card className="max-w-3xl p-5 sm:p-8">
          {closedAttendance.ok ? (
            <SessionAttendance
              sessionId={session.id}
              sessionTitle={session.title}
              summary={closedAttendance.data.summary}
              roster={closedAttendance.data.roster}
              action={setAttendanceAction}
            />
          ) : (
            <>
              <h2 className="mb-4 text-lg font-bold text-navy">Attendance</h2>
              <Alert variant="danger">{closedAttendance.error.message}</Alert>
            </>
          )}
        </Card>
      ) : null}

      {live && session.status !== "closed" ? (
        <Card className="max-w-3xl p-5 sm:p-8">
          <div className="mb-4 flex items-baseline justify-between gap-4">
            <h2 className="text-lg font-bold text-navy">Check-ins</h2>
            {live.ok ? (
              <p className="tabular-nums text-muted">
                <span className="text-2xl font-bold text-navy">{live.data.count}</span> / {live.data.total} active members
              </p>
            ) : null}
          </div>
          {!live.ok ? (
            <Alert variant="danger">{live.error.message}</Alert>
          ) : live.data.attendees.length === 0 ? (
            <p className="text-muted">No one has checked in yet.</p>
          ) : (
            <ul className="divide-y divide-line">
              {live.data.attendees.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <p className="truncate font-semibold text-ink">{a.name}</p>
                    <p className="truncate text-sm text-muted">{a.position}</p>
                  </div>
                  <p className="shrink-0 text-sm tabular-nums text-muted">{formatClockTime(a.checkedInAt)}</p>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ) : null}

      <Card className="max-w-3xl p-5 sm:p-8">
        <h2 className="text-lg font-bold text-navy">Delete session</h2>
        <p className="mb-4 mt-1 text-muted">Permanently removes this session and its attendance records.</p>
        <DeleteSessionControl
          sessionId={session.id}
          active={session.status === "active"}
          checkinCount={live?.ok ? live.data.count : 0}
          action={deleteSessionAction}
        />
      </Card>
    </>
  );
}
