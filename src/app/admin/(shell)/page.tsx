import { UserPlus, Users } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { MemberRoster } from "@/components/admin/MemberRoster";
import { StartCheckInCard } from "@/components/admin/StartCheckInCard";
import { Alert, Card, EmptyState, PageHeader, StatCard } from "@/components/ui/Display";
import { ButtonLink } from "@/components/ui/Button";
import { attendancePercent, averageAttendance } from "@/lib/attendance";
import { getFirstName } from "@/lib/auth/display-name";
import { requireAdmin } from "@/lib/auth/session";
import { getDashboardData } from "@/lib/data/attendance";

export const metadata: Metadata = { title: "Dashboard" };

export default async function DashboardPage() {
  const { user, supabase } = await requireAdmin();
  const result = await getDashboardData(supabase);
  const data = result.ok ? result.data : null;

  const members = data?.members ?? [];
  const rows = members.map((m) => ({
    id: m.id,
    name: m.name,
    asceId: m.asce_id,
    position: m.position,
    percent: attendancePercent(data?.counts.get(m.id) ?? { counted: 0, attended: 0 }),
  }));
  const average = averageAttendance(members.map((m) => data?.counts.get(m.id) ?? { counted: 0, attended: 0 }));
  const active = data?.activeSession ?? null;

  return (
    <>
      <PageHeader
        title={`Welcome, ${getFirstName(user)}`}
        description="Here's an overview of your team."
        actions={
          <ButtonLink href="/admin/members/new" variant="secondary">
            <UserPlus aria-hidden="true" className="h-5 w-5" />
            Add member
          </ButtonLink>
        }
      />

      {!result.ok ? <Alert variant="danger">{result.error.message}</Alert> : null}

      <StartCheckInCard active={active} />

      <section aria-label="Team overview" className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total Members" value={members.length} />
        <StatCard label="Total Meetings" value={data?.totalMeetings ?? 0} />
        <StatCard label="Average Attendance" value={average === null ? "—" : `${average}%`} hint={average === null ? "No meetings to average yet" : "Meetings for each member's group"} />
        <StatCard
          label="Active Check-In"
          value={active ? "In Progress" : "No"}
          hint={active ? active.title : "No session is open"}
        />
      </section>

      <Card>
        <div className="flex items-center justify-between gap-4 border-b border-line px-4 py-4 sm:px-5">
          <h2 className="text-lg font-bold text-navy">Members</h2>
          <Link href="/admin/members" className="inline-flex min-h-11 items-center px-2 text-sm font-semibold text-blue underline-offset-4 hover:underline">
            Manage members
          </Link>
        </div>

        {rows.length === 0 ? (
          <EmptyState
            icon={<Users className="h-7 w-7" />}
            title="No members yet"
            description="Add your first member to get the team started."
            action={<ButtonLink href="/admin/members/new">Add member</ButtonLink>}
          />
        ) : (
          <MemberRoster rows={rows} />
        )}
      </Card>
    </>
  );
}
