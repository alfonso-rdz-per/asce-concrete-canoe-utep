"use client";

import { useRouter } from "next/navigation";
import { MemberForm } from "@/components/admin/MemberForm";
import type { ActionState } from "@/lib/action-state";

/** Alta de miembro: al guardarlo, vuelve a la lista. */
export function NewMemberForm({
  action,
  today,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  today: string;
}) {
  const router = useRouter();
  return (
    <MemberForm
      mode="create"
      action={action}
      defaults={{ asceId: "", name: "", email: "", joinedOn: today, position: "Member", isDesignTeam: false }}
      submitLabel="Add member"
      onCreated={() => router.push("/admin/members")}
    />
  );
}
