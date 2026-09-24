/**
 * Estado que devuelve la Server Action del check-in al formulario del estudiante (todo texto visible, en inglés). Sin
 * dependencias: lo importan el cliente y el servidor. Nunca lleva el ticket ni datos del miembro más allá de lo que él escribió.
 */
import type { CheckinFailure } from "@/lib/checkin/submit";

export interface CheckInFieldValues {
  asceId?: string;
  name?: string;
  /** Casilla "Remember me on this device" tal como la dejó el estudiante. */
  remember?: boolean;
}

export type CheckInState =
  | { status: "idle" }
  | {
      status: "error";
      message: string;
      fieldErrors?: CheckInFieldValues;
      values?: CheckInFieldValues;
      /** false = este ticket ya no sirve (caducó, sesión cerrada, ya usado…): hay que volver a escanear el QR. */
      canRetry: boolean;
      /** true = el dispositivo recordado ya no vale (revocado, caducado, miembro inactivo): se vuelve a pedir ASCE ID + Name. */
      forgetDevice?: boolean;
    }
  | { status: "success"; name: string; sessionTitle: string; checkedInAt: string; /** Este dispositivo quedó recordado. */ remembered: boolean };

export const CHECKIN_IDLE: CheckInState = { status: "idle" };

/** Mensajes hacia el estudiante: genéricos, nunca revelan si un ASCE ID existe ni por qué falló la identificación. */
export const CHECKIN_MESSAGES: Record<CheckinFailure | "unavailable", { message: string; canRetry: boolean }> = {
  bad_credentials: { message: "ASCE ID or name is incorrect. Check them and try again.", canRetry: true },
  device_unrecognized: { message: "We couldn't recognize this device. Enter your ASCE ID and name.", canRetry: true },
  already_checked_in: { message: "You're already checked in for this session.", canRetry: false },
  ticket_expired: { message: "Your time to check in ran out. Scan the QR code again.", canRetry: false },
  ticket_invalid: { message: "This check-in link isn't valid anymore. Scan the QR code again.", canRetry: false },
  session_closed: { message: "Check-in is closed for this session.", canRetry: false },
  rate_limited: { message: "Too many attempts. Wait a few minutes, then scan the QR code again.", canRetry: false },
  unavailable: { message: "Something went wrong. Please try again.", canRetry: true },
};
