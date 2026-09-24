import { AlertCircle, Clock, Lock } from "lucide-react";
import type { Metadata } from "next";
import { BrandMark } from "@/components/brand/BrandMark";
import { CanoeBand, HeroBackdrop } from "@/components/brand/Hero";
import { WaveDivider } from "@/components/brand/Shapes";
import { CheckInPanel } from "@/components/checkin/CheckInPanel";
import { Card } from "@/components/ui/Display";
import { lookupRememberedMember, redeemQrOnServer } from "@/lib/checkin/server";
import { DEVICE_COOKIE } from "@/lib/device-token";
import type { GateFailure } from "@/lib/checkin/gate";
import { serverEnv } from "@/lib/env";
import { checkInAction, switchMemberAction } from "@/app/(public)/c/[token]/actions";
import { cookies } from "next/headers";

export const metadata: Metadata = { title: "Check-In", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

/**
 * Destino del QR (lo abre la cámara nativa del teléfono). Todo se decide en el SERVIDOR con su reloj:
 *   1. valida el token (HMAC, ventana de 10 s + gracia), 2. comprueba en la base de datos que la sesión esté `active`,
 *   3. emite el ticket temporal (3 min, independiente de las rotaciones del QR) y 4. muestra el formulario de check-in (ASCE ID + Name).
 * Escanear NO completa la asistencia. Sin escáner interno ni entrada manual de códigos. Los errores son genéricos y no
 * revelan nada más que el motivo general.
 */
const FAILURES: Record<GateFailure | "error", { icon: typeof AlertCircle; title: string; text: string }> = {
  expired: { icon: Clock, title: "This QR code has expired", text: "Scan the code currently shown by your team admin." },
  closed: { icon: Lock, title: "Check-in is closed", text: "This session is no longer accepting check-ins." },
  invalid: { icon: AlertCircle, title: "This QR code isn't valid", text: "Open your phone's camera and scan the code shown by your team admin." },
  error: { icon: AlertCircle, title: "Something went wrong", text: "Please try again. If it keeps happening, tell your team admin." },
};

export default async function CheckInLandingPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;

  let outcome: Awaited<ReturnType<typeof redeemQrOnServer>> | { ok: false; reason: "error" };
  try {
    outcome = await redeemQrOnServer(token);
  } catch {
    outcome = { ok: false, reason: "error" }; // base de datos o configuración caídas: sin detalles hacia el estudiante
  }

  // "Remember me": si este dispositivo recuerda a un miembro ACTIVO, el panel solo pide pulsar "Check in". La cookie es HttpOnly (solo
  // el servidor la lee) y solo sirve para saber QUIÉN es: el QR válido y el ticket siguen siendo obligatorios.
  let remembered: { name: string } | null = null;
  if (outcome.ok) {
    try {
      remembered = await lookupRememberedMember((await cookies()).get(DEVICE_COOKIE)?.value);
    } catch {
      remembered = null; // sin datos del dispositivo: se pide ASCE ID + Name
    }
  }

  const failure = outcome.ok ? null : FAILURES[outcome.reason];

  return (
    <div className="flex flex-1 flex-col">
      <div className="on-dark relative isolate flex flex-1 flex-col overflow-hidden bg-navy text-white">
        <HeroBackdrop />
        <header className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          <BrandMark tone="onDark" size="lg" />
        </header>

        <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-6xl flex-1 flex-col items-center justify-center px-4 pb-10 pt-4 sm:px-6">
          {outcome.ok ? (
            <CheckInPanel
              ticket={outcome.ticket}
              title={outcome.session.title}
              location={outcome.session.location}
              expiresAtMs={outcome.expiresAtMs}
              ticketMinutes={Math.round(serverEnv().TICKET_TTL_SECONDS / 60)}
              remembered={remembered}
              action={checkInAction}
              switchAction={switchMemberAction}
            />
          ) : failure ? (
            <Card className="w-full max-w-md p-6 text-ink sm:p-8">
              <div role="alert" className="text-center">
                <div aria-hidden="true" className="mx-auto flex h-16 w-16 items-center justify-center rounded-full bg-mist text-blue">
                  <failure.icon className="h-9 w-9" />
                </div>
                <h1 className="mt-4 text-2xl font-bold text-navy">{failure.title}</h1>
                <p className="mt-2 text-muted">{failure.text}</p>
              </div>
            </Card>
          ) : null}
        </main>

        <WaveDivider />
      </div>
      <CanoeBand />
    </div>
  );
}
