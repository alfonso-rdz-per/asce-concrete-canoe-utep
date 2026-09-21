import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { setAttendanceAction, setMemberActiveAction, updateMemberAction } from "@/app/admin/(shell)/members/actions";
import { AttendanceHistory } from "@/components/admin/AttendanceHistory";
import { MemberForm } from "@/components/admin/MemberForm";
import { MemberStatusControl } from "@/components/admin/MemberControls";
import { Alert, Badge, Card, PageHeader } from "@/components/ui/Display";
import { requireAdmin } from "@/lib/auth/session";
import { getMemberAttendanceHistory } from "@/lib/data/attendance";
import { getMember } from "@/lib/data/members";
import { formatDateOnly, formatMeetingDate } from "@/lib/dates";
import { idSchema } from "@/lib/validation/member";

export const metadata: Metadata = { title: "Edit member" };

export default async function EditMemberPage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireAdmin();
  const { id } = await params;

  // El id viene de la URL: se valida antes de tocar la base de datos.
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const result = await getMember(supabase, parsedId.data);
  if (!result.ok) notFound();
  const member = result.data;
  const history = await getMemberAttendanceHistory(supabase, member.id);

  return (
    <>
      <Link href="/admin/members" className="inline-flex min-h-11 items-center gap-2 font-semibold text-blue underline-offset-4 hover:underline">
        <ArrowLeft aria-hidden="true" className="h-5 w-5" />
        Back to members
      </Link>

      <PageHeader
        title={member.name}
        description={
          member.active
            ? `Joined ${formatDateOnly(member.joined_on)}`
            : `Joined ${formatDateOnly(member.joined_on)} · Deactivated ${member.deactivated_on ? formatDateOnly(member.deactivated_on) : ""}`
        }
        actions={<Badge tone={member.active ? "active" : "inactive"}>{member.active ? "Active" : "Inactive"}</Badge>}
      />

      <Card className="max-w-2xl p-5 sm:p-8">
        <h2 className="mb-5 text-lg font-bold text-navy">Member details</h2>
        <MemberForm
          mode="edit"
          action={updateMemberAction}
          submitLabel="Save changes"
          defaults={{
            id: member.id,
            asceId: member.asce_id,
            name: member.name,
            email: member.email ?? "",
            joinedOn: member.joined_on,
            position: member.position,
            isDesignTeam: member.is_design_team,
          }}
        />
      </Card>

      <Card className="max-w-3xl p-5 sm:p-8">
        <section aria-labelledby="attendance-heading" className="space-y-4">
          <div className="space-y-1">
            <h2 id="attendance-heading" className="text-lg font-bold text-navy">
              Attendance History
            </h2>
            <p className="text-muted">
              Correct a closed meeting if someone was marked wrongly. Nothing is deleted: every change is recorded in the audit log.
            </p>
          </div>
          {history.ok ? (
            <AttendanceHistory
              memberId={member.id}
              memberName={member.name}
              action={setAttendanceAction}
              rows={history.data.map((row) => ({
                sessionId: row.sessionId,
                title: row.title,
                dateLabel: formatMeetingDate(row.heldAt),
                sessionStatus: row.sessionStatus,
                audience: row.audience,
                forMember: row.forMember,
                status: row.status,
                source: row.source,
              }))}
            />
          ) : (
            <Alert variant="danger">{history.error.message}</Alert>
          )}
        </section>
      </Card>

      <Card className="max-w-2xl space-y-8 p-5 sm:p-8">
        <section aria-labelledby="status-heading" className="space-y-3">
          <h2 id="status-heading" className="text-lg font-bold text-navy">
            Status
          </h2>
          <MemberStatusControl memberId={member.id} memberName={member.name} active={member.active} action={setMemberActiveAction} />
        </section>
      </Card>
    </>
  );
}
