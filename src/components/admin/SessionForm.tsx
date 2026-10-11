"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { Alert } from "@/components/ui/Display";
import { RadioGroupField, TextField } from "@/components/ui/Fields";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IDLE, type ActionState } from "@/lib/action-state";
import { AUDIENCE_LABEL, DEFAULT_AUDIENCE, isSelectableAudience, SELECTABLE_AUDIENCES } from "@/lib/session-audience";
import { TITLE_MAX } from "@/lib/validation/session";

/** Start a session with a name and one type; an active session blocks another start. */
export function SessionForm({
  action,
  activeSession,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  activeSession?: { id: string; title: string } | null;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);

  // Al fallar la validación, el foco va al primer campo con error (lectores de pantalla y teclado).
  useEffect(() => {
    if (state.status === "error") formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const values = state.status === "error" ? (state.values ?? {}) : {};
  // Restore the single selected audience after a validation error.
  const selectedAudience = isSelectableAudience(values.audience) ? values.audience : DEFAULT_AUDIENCE;

  return (
    <form ref={formRef} action={formAction} noValidate className="space-y-5">
      {activeSession ? (
        <Alert variant="info" title="A check-in is already in progress">
          <p>
            “{activeSession.title}” is open. Close it before starting another one.{" "}
            <Link href={`/admin/sessions/${activeSession.id}/qr`} className="font-semibold text-blue underline underline-offset-4">
              Open the QR screen
            </Link>
          </p>
        </Alert>
      ) : null}

      <TextField
        label="Session Name"
        name="title"
        defaultValue={values.title ?? ""}
        error={errors.title}
        required
        maxLength={TITLE_MAX}
        placeholder="Concrete Canoe Practice"
        autoComplete="off"
      />
      <RadioGroupField
        legend="Session type"
        name="audience"
        options={SELECTABLE_AUDIENCES.map((value) => ({ value, label: AUDIENCE_LABEL[value] }))}
        defaultValue={selectedAudience}
        error={errors.audience}
      />

      {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}

      {activeSession ? null : <SubmitButton pendingLabel="Starting…">Start check-in</SubmitButton>}
    </form>
  );
}
