import { CalendarDays, Plus, QrCode } from "lucide-react";
import type { Metadata } from "next";
import { SessionList } from "@/components/admin/SessionList";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui/Display";
import { ButtonLink } from "@/components/ui/Button";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminFirstNames } from "@/lib/data/admin-names";
import { listSessions } from "@/lib/data/sessions";

export const metadata: Metadata = { title: "Sessions" };

export default async function SessionsPage() {
  const { supabase } = await requireAdmin();
  const [result, starters] = await Promise.all([listSessions(supabase), getAdminFirstNames()]);
  const sessions = result.ok ? result.data : [];
  const active = sessions.find((s) => s.status === "active") ?? null;
  const activeStarter = active?.opened_by ? (starters.get(active.opened_by) ?? null) : null;

  return (
    <>
      <PageHeader
        title="Sessions"
        description="Start a check-in to show the QR code for students to scan."
        actions={
          <ButtonLink href="/admin/sessions/new">
            <Plus aria-hidden="true" className="h-5 w-5" />
            New session
          </ButtonLink>
        }
      />

      {!result.ok ? <Alert variant="danger">{result.error.message}</Alert> : null}

      {active ? (
        <div className="on-dark flex flex-col gap-4 rounded-xl bg-gradient-to-br from-navy to-ocean p-5 text-white shadow-card sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky">Check-in in progress</p>
            <p className="mt-1 truncate text-xl font-bold">{active.title}</p>
            {activeStarter ? <p className="text-sky">Started by {activeStarter}</p> : null}
          </div>
          <ButtonLink href={`/admin/sessions/${active.id}/qr`} variant="onDark">
            <QrCode aria-hidden="true" className="h-5 w-5" />
            Open QR screen
          </ButtonLink>
        </div>
      ) : null}

      <Card>
        {sessions.length === 0 ? (
          <EmptyState
            icon={<CalendarDays className="h-7 w-7" />}
            title="No sessions yet"
            description="Create your first meeting, then start a check-in when the team arrives."
            action={<ButtonLink href="/admin/sessions/new">New session</ButtonLink>}
          />
        ) : (
          <SessionList sessions={sessions} starters={starters} />
        )}
      </Card>
    </>
  );
}
