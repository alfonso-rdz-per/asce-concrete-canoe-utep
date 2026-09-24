"use client";

import { useActionState, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Display";
import { CheckboxField, SelectField, TextField } from "@/components/ui/Fields";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { IDLE, type ActionState } from "@/lib/action-state";
import { OTHER_POSITION, POSITION_MAX, POSITION_OPTIONS, splitPosition } from "@/lib/positions";

export interface MemberFormDefaults {
  id?: string;
  asceId: string;
  name: string;
  email: string;
  joinedOn: string;
  /** Cargo guardado (predefinido o personalizado). Por defecto, "Member". */
  position?: string;
  /** Casilla "Design Team". Por defecto, apagada. */
  isDesignTeam?: boolean;
}

/**
 * Cargo: desplegable con los cargos predefinidos y, solo con "Other", un campo de texto adicional
 * ("Custom Position"). Los campos son no controlados (los valores tras un error llegan como `defaultValue`);
 * solo se recuerda qué opción está elegida para mostrar u ocultar el campo de texto.
 */
function PositionFields({
  defaultPreset,
  defaultCustom,
  positionError,
  customError,
}: {
  defaultPreset: string;
  defaultCustom: string;
  positionError?: string;
  customError?: string;
}) {
  const [preset, setPreset] = useState(defaultPreset);
  return (
    <>
      <SelectField
        label="Position"
        name="position"
        defaultValue={defaultPreset}
        error={positionError}
        onChange={(event) => setPreset(event.target.value)}
      >
        {POSITION_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </SelectField>
      {preset === OTHER_POSITION ? (
        <TextField
          label="Custom Position"
          name="customPosition"
          defaultValue={defaultCustom}
          error={customError}
          required
          maxLength={POSITION_MAX}
          autoComplete="off"
        />
      ) : null}
    </>
  );
}

/**
 * Formulario de miembro (alta y edición). Recibe la Server Action como prop (así se puede probar sin Next).
 * Al dar de alta con éxito avisa con `onCreated` (la página vuelve a la lista).
 */
export function MemberForm({
  mode,
  action,
  defaults,
  submitLabel,
  onCreated,
}: {
  mode: "create" | "edit";
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  defaults: MemberFormDefaults;
  submitLabel: string;
  onCreated?: () => void;
}) {
  const [state, formAction] = useActionState(action, IDLE);
  const formRef = useRef<HTMLFormElement>(null);

  // Al fallar la validación, el foco va al primer campo con error (lectores de pantalla y teclado).
  useEffect(() => {
    if (state.status === "error") formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  // Alta correcta: avisa una sola vez por cada resultado (la página navega a la lista).
  const onCreatedRef = useRef(onCreated);
  useEffect(() => {
    onCreatedRef.current = onCreated;
  });
  useEffect(() => {
    if (mode === "create" && state.status === "success") onCreatedRef.current?.();
  }, [mode, state]);

  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const values = state.status === "error" ? (state.values ?? {}) : {};

  // Tras un error, el servidor devuelve lo tecleado: se usa como valor inicial (React 19 reinicia el formulario).
  const saved = splitPosition(defaults.position);
  const positionPreset = values.position ?? saved.preset;
  const positionCustom = values.customPosition ?? saved.custom;

  return (
    <>
      <form ref={formRef} action={formAction} noValidate className="space-y-5">
        {defaults.id ? <input type="hidden" name="id" value={defaults.id} /> : null}

        <TextField
          label="ASCE ID"
          name="asceId"
          defaultValue={values.asceId ?? defaults.asceId}
          error={errors.asceId}
          required
          maxLength={32}
          inputMode="numeric"
          pattern="[0-9]*"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          // Solo números: se descarta al momento cualquier otro carácter (el servidor lo vuelve a validar).
          onInput={(event) => {
            event.currentTarget.value = event.currentTarget.value.replace(/[^0-9]/g, "");
          }}
        />
        <TextField
          label="Full name"
          name="name"
          defaultValue={values.name ?? defaults.name}
          error={errors.name}
          required
          maxLength={120}
          autoComplete="off"
        />
        <TextField
          label="Email"
          name="email"
          type="email"
          optional
          defaultValue={values.email ?? defaults.email}
          error={errors.email}
          inputMode="email"
          maxLength={254}
          autoComplete="off"
        />
        {/* La `key` reinicia el desplegable cuando cambian los valores iniciales (p. ej. al devolver un error). */}
        <PositionFields
          key={`${positionPreset}|${positionCustom}`}
          defaultPreset={positionPreset}
          defaultCustom={positionCustom}
          positionError={errors.position}
          customError={errors.customPosition}
        />
        <TextField
          label="Joined on"
          name="joinedOn"
          type="date"
          defaultValue={values.joinedOn ?? defaults.joinedOn}
          error={errors.joinedOn}
          required={mode === "edit"}
        />

        <CheckboxField label="Design Team" name="designTeam" defaultChecked={values.designTeam === undefined ? Boolean(defaults.isDesignTeam) : values.designTeam === "on"} />

        {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}
        {state.status === "success" && mode === "edit" && state.message ? <Alert variant="success">{state.message}</Alert> : null}

        <SubmitButton pendingLabel={mode === "create" ? "Adding member…" : "Saving changes…"}>{submitLabel}</SubmitButton>
      </form>
    </>
  );
}
