import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { createSessionAction } from "@/app/admin/(shell)/sessions/actions";
import { SessionForm } from "@/components/admin/SessionForm";
import { Card, PageHeader } from "@/components/ui/Display";
import { requireAdmin } from "@/lib/auth/session";
import { getActiveSession } from "@/lib/data/sessions";

export const metadata: Metadata = { title: "New session" };

export default async function NewSessionPage() {
  const { supabase } = await requireAdmin();
  const active = await getActiveSession(supabase);

  return (
    <>
      <Link href="/admin/sessions" className="inline-flex min-h-11 items-center gap-2 font-semibold text-blue underline-offset-4 hover:underline">
        <ArrowLeft aria-hidden="true" className="h-5 w-5" />
        Back to sessions
      </Link>

      <PageHeader title="New session" />

      <Card className="max-w-2xl p-5 sm:p-8">
        <SessionForm action={createSessionAction} activeSession={active.ok && active.data ? { id: active.data.id, title: active.data.title } : null} />
      </Card>
    </>
  );
}
