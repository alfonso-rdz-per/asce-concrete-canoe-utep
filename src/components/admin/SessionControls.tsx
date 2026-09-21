"use client";

import { useActionState } from "react";
import { Alert } from "@/components/ui/Display";
import { ConfirmDialog } from "@/components/ui/Dialogs";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IDLE, type ActionState } from "@/lib/action-state";
import type { ButtonSize } from "@/components/ui/Button";

type SessionAction = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/** Abre el check-in de un borrador y lleva a la pantalla del QR. Si ya hay otro activo, la BD lo rechaza y se explica. */
export function StartSessionButton({
  sessionId,
  sessionTitle,
  action,
  size = "md",
}: {
  sessionId: string;
  sessionTitle: string;
  action: SessionAction;
  size?: ButtonSize;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <form action={formAction} className="space-y-2">
      <input type="hidden" name="id" value={sessionId} />
      <SubmitButton size={size} pendingLabel="Starting…">
        <span aria-hidden="true">Start check-in</span>
        <span className="sr-only">Start check-in for {sessionTitle}</span>
      </SubmitButton>
      {state.status === "error" ? (
        <p role="alert" className="text-sm font-medium text-danger">
          {state.message}
        </p>
      ) : null}
    </form>
  );
}

/**
 * Cierra el check-in (definitivo). Tras cerrar, el servidor rechaza al instante nuevos QR, tickets y check-ins de
 * la sesión: no depende de que esta pantalla se actualice.
 */
export function CloseSessionControl({
  sessionId,
  sessionTitle,
  action,
  onClosed,
  triggerSize = "md",
}: {
  sessionId: string;
  sessionTitle: string;
  action: SessionAction;
  /** La pantalla del QR se entera al momento (sin esperar al siguiente sondeo). */
  onClosed?: () => void;
  triggerSize?: ButtonSize;
}) {
  const [state, formAction] = useActionState(async (prev: ActionState, formData: FormData) => {
    const next = await action(prev, formData);
    if (next.status === "success") onClosed?.();
    return next;
  }, IDLE);

  return (
    <div className="space-y-2">
      <ConfirmDialog
        triggerLabel="Close check-in"
        triggerVariant="danger"
        triggerSize={triggerSize}
        title={`Close check-in for “${sessionTitle}”?`}
        description="Students will no longer be able to scan the QR code or check in. Closing is final: a closed session can't be reopened."
        confirmLabel="Close check-in"
        pendingLabel="Closing…"
        danger
        action={formAction}
        hidden={{ id: sessionId }}
        state={state}
      />
      {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}
    </div>
  );
}

/**
 * Elimina la sesión. Siempre pide confirmación explícita en un diálogo; si la sesión sigue ACTIVA el texto lo advierte (el QR y los
 * check-ins dejan de funcionar al instante). Al confirmar, la acción de servidor redirige a la lista de sesiones.
 */
export function DeleteSessionControl({
  sessionId,
  active,
  checkinCount,
  action,
}: {
  sessionId: string;
  active: boolean;
  checkinCount: number;
  action: SessionAction;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  return (
    <div className="space-y-2">
      <ConfirmDialog
        triggerLabel="Delete Session"
        triggerVariant="danger"
        title="Delete this session?"
        description={
          active
            ? "Check-in is still open for this session. Deleting it stops the QR code and rejects any check-in immediately. This will permanently delete the session and its associated attendance records."
            : "This will permanently delete the session and its associated attendance records."
        }
        confirmLabel="Delete Session"
        pendingLabel="Deleting…"
        danger
        action={formAction}
        hidden={{ id: sessionId }}
        state={state}
      />
      {checkinCount > 0 ? (
        <p className="text-sm text-muted">
          {checkinCount} check-in{checkinCount === 1 ? "" : "s"} will be deleted with it.
        </p>
      ) : null}
      {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}
    </div>
  );
}
