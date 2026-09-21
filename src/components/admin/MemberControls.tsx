"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/Display";
import { ConfirmDialog } from "@/components/ui/Dialogs";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IDLE, type ActionState } from "@/lib/action-state";

type MemberAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** Desactivar (con confirmación) o reactivar. Ninguna de las dos toca la fecha de ingreso. */
export function MemberStatusControl({
  memberId,
  memberName,
  active,
  action,
}: {
  memberId: string;
  memberName: string;
  active: boolean;
  action: MemberAction;
}) {
  const [state, formAction] = useActionState(action, IDLE);

  return (
    <div className="space-y-3">
      <p className="text-muted">
        {active
          ? `${memberName} can check in. Deactivating stops new check-ins; their history is kept.`
          : `${memberName} is inactive and can't check in. Reactivating keeps their original join date.`}
      </p>
      {active ? (
        <ConfirmDialog
          triggerLabel="Deactivate member"
          triggerVariant="danger"
          title={`Deactivate ${memberName}?`}
          description="They won't be able to check in. Their history and join date are kept, and you can reactivate them at any time."
          confirmLabel="Deactivate"
          pendingLabel="Deactivating…"
          danger
          action={formAction}
          hidden={{ id: memberId, active: "false" }}
          state={state}
        />
      ) : (
        <form action={formAction}>
          <input type="hidden" name="id" value={memberId} />
          <input type="hidden" name="active" value="true" />
          <SubmitButton variant="secondary" pendingLabel="Reactivating…">
            Reactivate member
          </SubmitButton>
        </form>
      )}
      {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}
      {state.status === "success" && state.message ? <Alert variant="success">{state.message}</Alert> : null}
    </div>
  );
}
