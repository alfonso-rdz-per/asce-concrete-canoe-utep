"use client";

import Link from "next/link";
import { useActionState, useEffect, useRef } from "react";
import { Alert } from "@/components/ui/Display";
import { CheckboxGroupField, TextField } from "@/components/ui/Fields";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IDLE, type ActionState } from "@/lib/action-state";
import { AUDIENCE_LABEL, DEFAULT_AUDIENCE, groupsFromAudience, isTeamGroup, TEAM_GROUPS } from "@/lib/session-audience";
import { TITLE_MAX } from "@/lib/validation/session";

/**
 * Formulario de nueva sesión: SOLO el nombre y "Required": a qué equipo(s) va dirigida. Son dos casillas (Design Team y Rowing & Construction)
 * que se pueden marcar las dos a la vez; por defecto llega marcada Rowing & Construction. No pide descripción,
 * ubicación ni fecha/hora: la fecha la pone el servidor y quién/cuándo empezó lo fija la base de datos. Un solo botón,
 * "Start check-in": crea la sesión ya activa y lleva a la pantalla del QR (no hay borradores). Si ya hay un check-in en curso no
 * se ofrece abrir otro (la base de datos lo impide de todos modos): se explica y se enlaza a su pantalla del QR.
 */
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
  // Tras un error se repintan las casillas tal como se enviaron (aunque no hubiera ninguna); al abrir el formulario, la de por defecto.
  const checkedGroups = typeof values.audience === "string" ? values.audience.split(",").filter(isTeamGroup) : groupsFromAudience(DEFAULT_AUDIENCE);

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
      <CheckboxGroupField
        legend="Required"
        name="audience"
        options={TEAM_GROUPS.map((value) => ({ value, label: AUDIENCE_LABEL[value] }))}
        defaultValues={checkedGroups}
        error={errors.audience}
      />

      {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}

      {activeSession ? null : <SubmitButton pendingLabel="Starting…">Start check-in</SubmitButton>}
    </form>
  );
}
