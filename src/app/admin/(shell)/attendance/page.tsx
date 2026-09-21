import { ClipboardCheck } from "lucide-react";
import type { Metadata } from "next";
import { AttendanceGroupFilter, AttendanceMeetingList } from "@/components/admin/AttendanceOverview";
import { ButtonLink } from "@/components/ui/Button";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui/Display";
import { parseAttendanceGroup } from "@/lib/attendance";
import { requireAdmin } from "@/lib/auth/session";
import { listClosedMeetings, MEETING_LIST_LIMIT } from "@/lib/data/attendance";

export const metadata: Metadata = { title: "Attendance" };

/**
 * Historial de asistencia: reuniones CERRADAS (las más recientes primero) con presentes / esperados / porcentaje y filtro por grupo.
 * Los números salen de `session_attendance_summary` (la base de datos decide quién se esperaba); una reunión activa no aparece aquí: su
 * asistencia en vivo está en su página y en la pantalla del QR. Cada fila lleva al detalle de la sesión, donde está el roster.
 */
export default async function AttendancePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase } = await requireAdmin();
  // El filtro viene de la URL: solo se admiten los tres valores conocidos; cualquier otra cosa es "All".
  const group = parseAttendanceGroup((await searchParams).group);
  const result = await listClosedMeetings(supabase, group);

  return (
    <>
      <PageHeader title="Attendance" />
      <AttendanceGroupFilter group={group} />

      {!result.ok ? <Alert variant="danger">{result.error.message}</Alert> : null}

      {result.ok ? (
        <Card>
          {result.data.meetings.length === 0 ? (
            <EmptyState
              icon={<ClipboardCheck className="h-7 w-7" />}
              title={group === "all" ? "No closed meetings yet" : "No closed meetings for this group"}
              description={
                group === "all"
                  ? "Attendance appears here once a check-in is closed. Start one from Sessions."
                  : "Try another group, or show all meetings."
              }
              action={
                group === "all" ? (
                  <ButtonLink href="/admin/sessions">Go to sessions</ButtonLink>
                ) : (
                  <ButtonLink href="/admin/attendance" variant="secondary">
                    Show all meetings
                  </ButtonLink>
                )
              }
            />
          ) : (
            <AttendanceMeetingList meetings={result.data.meetings} />
          )}
        </Card>
      ) : null}

      {result.ok && result.data.truncated ? <p className="text-sm text-muted">Showing the {MEETING_LIST_LIMIT} most recent meetings.</p> : null}
    </>
  );
}
