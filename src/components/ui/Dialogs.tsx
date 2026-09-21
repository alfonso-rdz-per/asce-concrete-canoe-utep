"use client";

import { useEffect, useId, useRef } from "react";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";
import { SubmitButton } from "@/components/ui/SubmitButton";
import type { ActionState } from "@/lib/action-state";

/**
 * Diálogos con el elemento nativo <dialog> (showModal): el navegador atrapa el foco, marca el resto
 * como inerte y Escape lo cierra. Sin librerías.
 */
const DIALOG_CLASSES =
  "m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl border border-line bg-white p-0 text-ink shadow-card backdrop:bg-ink/60";

export function ConfirmDialog({
  triggerLabel,
  triggerAriaLabel,
  triggerVariant = "secondary",
  triggerSize = "md",
  title,
  description,
  confirmLabel,
  pendingLabel,
  danger = false,
  action,
  hidden = {},
  state,
}: {
  triggerLabel: string;
  /** Nombre accesible completo del disparador cuando hay varios iguales en la página (p. ej. uno por fila). */
  triggerAriaLabel?: string;
  triggerVariant?: ButtonVariant;
  triggerSize?: ButtonSize;
  title: string;
  description: string;
  confirmLabel: string;
  pendingLabel: string;
  danger?: boolean;
  action: (formData: FormData) => void;
  hidden?: Record<string, string>;
  /** Cuando la acción responde (estado != idle) el diálogo se cierra solo. */
  state?: ActionState;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    if (state && state.status !== "idle") ref.current?.close();
  }, [state]);

  return (
    <>
      <Button variant={triggerVariant} size={triggerSize} aria-label={triggerAriaLabel} onClick={() => ref.current?.showModal()}>
        {triggerLabel}
      </Button>
      <dialog ref={ref} aria-labelledby={titleId} aria-describedby={descId} className={DIALOG_CLASSES}>
        <form action={action} className="space-y-4 p-6">
          {Object.entries(hidden).map(([name, value]) => (
            <input key={name} type="hidden" name={name} value={value} />
          ))}
          <h2 id={titleId} className="text-lg font-bold text-navy">
            {title}
          </h2>
          <p id={descId} className="text-muted">
            {description}
          </p>
          <div className="flex flex-col-reverse gap-2 pt-2 sm:flex-row sm:justify-end">
            <Button variant="secondary" onClick={() => ref.current?.close()}>
              Cancel
            </Button>
            <SubmitButton variant={danger ? "danger" : "primary"} pendingLabel={pendingLabel}>
              {confirmLabel}
            </SubmitButton>
          </div>
        </form>
      </dialog>
    </>
  );
}
