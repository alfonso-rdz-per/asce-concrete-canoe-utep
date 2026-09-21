"use client";

import { CheckCircle2, MapPin, TriangleAlert } from "lucide-react";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import { Alert, Card } from "@/components/ui/Display";
import { CheckboxField, TextField } from "@/components/ui/Fields";
import { SubmitButton } from "@/components/ui/SubmitButton";
import { CHECKIN_IDLE, type CheckInState } from "@/lib/checkin/state";
import { formatClockTime } from "@/lib/dates";

/**
 * Lo que ve el estudiante tras escanear un QR VÁLIDO: confirma el QR y pide ASCE ID + Name (solo el nombre, sin apellido).
 *
 * Con "Remember me on this device" el dispositivo recuerda AL MIEMBRO (una cookie HttpOnly con un token aleatorio: aquí nunca se ve
 * ni se guarda nada en el navegador). La próxima vez la página llega con `remembered` y basta pulsar "Check in"; "Not you? Switch
 * member" olvida el dispositivo y vuelve al formulario ASCE ID + Name. Recordar NO sustituye al QR: el ticket sigue siendo obligatorio.
 *
 * El ticket temporal viaja en un campo OCULTO y se envía en el CUERPO del formulario (sin cookie de estudiante ni cliente de
 * Supabase); no se muestra nunca y no existe entrada manual de tickets. Todo el texto visible está en inglés.
 */
export function CheckInPanel({
  ticket,
  title,
  location,
  expiresAtMs,
  ticketMinutes,
  remembered,
  action,
  switchAction,
}: {
  ticket: string;
  title: string;
  /** Solo las sesiones antiguas tienen ubicación (texto informativo). */
  location: string | null;
  expiresAtMs: number;
  ticketMinutes: number;
  /** Nombre REGISTRADO del miembro que este dispositivo recuerda (o null: se pide ASCE ID + Name). */
  remembered: { name: string } | null;
  action: (prev: CheckInState, formData: FormData) => Promise<CheckInState>;
  switchAction: () => Promise<void>;
}) {
  const [state, formAction] = useActionState(action, CHECKIN_IDLE);
  const [device, setDevice] = useState(remembered);
  const [switching, startSwitch] = useTransition();
  const formRef = useRef<HTMLFormElement>(null);
  const focusFirstField = useRef(false);

  // Al fallar la validación, el foco va al primer campo con error (lectores de pantalla y teclado).
  useEffect(() => {
    if (state.status === "error") formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  // Tras "Switch member" el foco pasa al ASCE ID del formulario que aparece.
  const usingDevice = device !== null && !(state.status === "error" && state.forgetDevice);
  useEffect(() => {
    if (!usingDevice && focusFirstField.current) {
      focusFirstField.current = false;
      formRef.current?.querySelector<HTMLElement>('input[name="asceId"]')?.focus();
    }
  }, [usingDevice]);

  function switchMember() {
    startSwitch(async () => {
      try {
        await switchAction();
      } catch {
        // Sin red o servidor caído: el formulario ASCE ID + Name se muestra igual (el token, sin cookie válida, caduca solo).
      }
      focusFirstField.current = true;
      setDevice(null);
    });
  }

  if (state.status === "success") {
    return (
      <Card className="w-full max-w-md p-6 text-center text-ink sm:p-8">
        <div aria-hidden="true" className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-mist text-blue">
          <CheckCircle2 className="h-9 w-9" />
        </div>
        <div role="status">
          <h1 className="mt-4 text-2xl font-bold text-navy">Check-in successful!</h1>
          <p className="mt-2 text-lg font-semibold text-ink">Thanks, {state.name}</p>
          <p className="mt-1 text-muted">{state.sessionTitle}</p>
          <p className="mt-1 text-sm text-muted">Checked in at {formatClockTime(state.checkedInAt)}</p>
          {state.remembered ? <p className="mt-3 text-sm text-muted">This device will remember you next time.</p> : null}
        </div>
      </Card>
    );
  }

  // Este ticket ya no sirve (caducó, sesión cerrada, ya usado, demasiados intentos): hay que volver a escanear.
  if (state.status === "error" && !state.canRetry) {
    return (
      <Card className="w-full max-w-md p-6 text-center text-ink sm:p-8">
        <div aria-hidden="true" className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-mist text-blue">
          <TriangleAlert className="h-9 w-9" />
        </div>
        <div role="alert">
          <h1 className="mt-4 text-2xl font-bold text-navy">{state.message}</h1>
        </div>
      </Card>
    );
  }

  const errors = state.status === "error" ? (state.fieldErrors ?? {}) : {};
  const values = state.status === "error" ? (state.values ?? {}) : {};

  return (
    <Card className="w-full max-w-md p-6 text-ink sm:p-8">
      <div aria-hidden="true" className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-mist text-blue">
        <CheckCircle2 className="h-9 w-9" />
      </div>
      <h1 className="mt-4 text-center text-2xl font-bold text-navy">QR code accepted</h1>
      <p className="mt-1 text-center text-lg font-semibold text-ink">{title}</p>
      {location ? (
        <p className="mt-1 flex items-center justify-center gap-1.5 text-center text-muted">
          <MapPin aria-hidden="true" className="h-4 w-4 shrink-0" />
          <span>Location: {location}</span>
        </p>
      ) : null}

      <p className="mt-5 rounded-lg bg-mist px-4 py-3 text-center text-sm text-navy">
        You have {ticketMinutes} minutes to finish checking in (until {formatClockTime(new Date(expiresAtMs).toISOString())}). If the time runs out,
        scan the QR code again.
      </p>

      {usingDevice && device ? (
        <form ref={formRef} action={formAction} noValidate className="mt-5 space-y-4" aria-label="Check in">
          <input type="hidden" name="ticket" value={ticket} />
          <input type="hidden" name="mode" value="remembered" />
          <div className="rounded-lg border border-line bg-surface px-4 py-3 text-center">
            <p className="text-sm text-muted">Checking in as</p>
            <p className="text-lg font-bold text-navy">{device.name}</p>
          </div>
          {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}
          <SubmitButton fullWidth pendingLabel="Checking in…">
            Check in
          </SubmitButton>
          <button
            type="button"
            onClick={switchMember}
            disabled={switching}
            className="mx-auto flex min-h-11 items-center justify-center rounded-md px-3 text-sm font-semibold text-blue underline-offset-4 hover:underline disabled:opacity-60"
          >
            Not you? Switch member
          </button>
        </form>
      ) : (
        <form ref={formRef} action={formAction} noValidate className="mt-5 space-y-4" aria-label="Check in">
          <input type="hidden" name="ticket" value={ticket} />
          <TextField
            label="ASCE ID"
            name="asceId"
            defaultValue={values.asceId ?? ""}
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
          <TextField label="Name" name="name" defaultValue={values.name ?? ""} error={errors.name} required maxLength={120} autoComplete="off" autoCapitalize="words" />
          <CheckboxField
            label="Remember me on this device"
            name="remember"
            defaultChecked={values.remember ?? false}
            hint="Skip typing your ASCE ID and name next time on this phone."
          />
          {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}
          <SubmitButton fullWidth pendingLabel="Checking in…">
            Check in
          </SubmitButton>
        </form>
      )}
    </Card>
  );
}
