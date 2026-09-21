"use client";

import { useFormStatus } from "react-dom";
import { Button, type ButtonSize, type ButtonVariant } from "@/components/ui/Button";

/** Botón de envío que se desactiva y cambia de texto mientras el formulario se procesa. */
export function SubmitButton({
  children,
  pendingLabel = "Saving…",
  variant,
  size,
  fullWidth,
  name,
  value,
}: {
  children: React.ReactNode;
  pendingLabel?: string;
  variant?: ButtonVariant;
  size?: ButtonSize;
  fullWidth?: boolean;
  /** Con `name`/`value` el botón dice QUÉ se pidió (p. ej. intent=start) cuando un formulario tiene varios envíos. */
  name?: string;
  value?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" name={name} value={value} variant={variant} size={size} fullWidth={fullWidth} aria-disabled={pending} onClick={(e) => pending && e.preventDefault()}>
      {pending ? pendingLabel : children}
    </Button>
  );
}
