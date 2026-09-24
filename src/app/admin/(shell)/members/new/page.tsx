import { ArrowLeft } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";
import { createMemberAction } from "@/app/admin/(shell)/members/actions";
import { NewMemberForm } from "@/components/admin/NewMemberForm";
import { Card, PageHeader } from "@/components/ui/Display";
import { requireAdmin } from "@/lib/auth/session";
import { todayInElPaso } from "@/lib/dates";

export const metadata: Metadata = { title: "Add member" };

export default async function NewMemberPage() {
  await requireAdmin();

  return (
    <>
      <Link href="/admin/members" className="inline-flex min-h-11 items-center gap-2 font-semibold text-blue underline-offset-4 hover:underline">
        <ArrowLeft aria-hidden="true" className="h-5 w-5" />
        Back to members
      </Link>
      <PageHeader title="Add member" description="Members check in with their ASCE ID and name." />
      <Card className="max-w-2xl p-5 sm:p-8">
        <NewMemberForm action={createMemberAction} today={todayInElPaso()} />
      </Card>
    </>
  );
}
