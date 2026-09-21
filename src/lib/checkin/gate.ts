/**
 * Puerta de entrada del check-in del estudiante (Fase 4): canje del QR por un ticket y validación de un ticket
 * contra el estado REAL de la sesión. Sin acceso a red ni a variables de entorno: la hora, las claves y la búsqueda
 * de la sesión se INYECTAN, así que se prueba a fondo y el navegador no interviene en nada.
 *
 *   QR vigente (10 s + gracia) ──▶ sesión `active` en la BD ──▶ ticket de 3 min (independiente del QR)
 *
 * IMPORTANTE: escanear un QR válido NO completa la asistencia. Solo emite el ticket; el check-in lo completa la
 * envío del estudiante al recibir ASCE ID + Name (o el dispositivo recordado) junto con ese ticket (en el CUERPO de la petición, sin cookie de estudiante).
 * Tras la emisión el ticket NO depende del slot del QR: la siguiente rotación no lo invalida.
 *
 * Errores hacia el estudiante deliberadamente pobres: `invalid` cubre formato, MAC alterado, sesión inexistente y
 * QR de un instante futuro; `expired` y `closed` solo se distinguen DESPUÉS de comprobar la autenticidad (MAC).
 */
import { issueTicket, verifyTicket } from "@/lib/tickets";
import { verifyQrToken } from "@/lib/tokens";

export type SessionStatus = "draft" | "active" | "closed";

export interface GateSession {
  id: string;
  title: string;
  location: string | null;
  status: SessionStatus;
}

/** Busca la sesión en la base de datos (autoridad del estado). null si no existe. */
export type LoadSession = (sessionId: string) => Promise<GateSession | null>;

export type GateFailure = "invalid" | "expired" | "closed";

export type RedeemResult =
  | {
      ok: true;
      ticket: string;
      expiresAtMs: number;
      session: Pick<GateSession, "id" | "title" | "location">;
    }
  | { ok: false; reason: GateFailure };

/** Canjea un token QR por un ticket. `now` es SIEMPRE la hora del servidor. */
export async function redeemQr(args: {
  token: unknown;
  now: number;
  qrKey: Buffer;
  ticketKey: Buffer;
  graceMs: number;
  ticketTtlMs: number;
  loadSession: LoadSession;
}): Promise<RedeemResult> {
  const { token, now, qrKey, ticketKey, graceMs, ticketTtlMs, loadSession } = args;

  const qr = verifyQrToken({ key: qrKey, token, now, graceMs });
  if (!qr.ok) return { ok: false, reason: qr.reason === "expired" ? "expired" : "invalid" };

  // La autenticidad ya está probada: ahora la BD decide si la sesión admite check-ins.
  const session = await loadSession(qr.sessionId);
  if (session === null) return { ok: false, reason: "invalid" };
  if (session.status !== "active") return { ok: false, reason: "closed" };

  const issued = issueTicket({ key: ticketKey, sessionId: session.id, tokenSlot: qr.slot, now, ttlMs: ticketTtlMs });
  return { ok: true, ticket: issued.ticket, expiresAtMs: issued.expiresAtMs, session: { id: session.id, title: session.title, location: session.location } };
}

export type TicketCheck =
  | {
      ok: true;
      sessionId: string;
      nonce: string;
      tokenSlot: number;
      issuedAtMs: number;
      expiresAtMs: number;
      session: Pick<GateSession, "id" | "title" | "location">;
    }
  | { ok: false; reason: GateFailure };

/**
 * Valida un ticket contra la sesión (autenticidad, vigencia de 3 min y sesión `active` en la BD). `submitCheckin`
 * (submit.ts) lo llama al recibir el check-in. No mira el slot del QR: el ticket ya emitido sobrevive a las rotaciones.
 */
export async function checkTicket(args: {
  ticket: unknown;
  now: number;
  ticketKey: Buffer;
  ticketTtlMs: number;
  loadSession: LoadSession;
}): Promise<TicketCheck> {
  const { ticket, now, ticketKey, ticketTtlMs, loadSession } = args;

  const verified = verifyTicket({ key: ticketKey, ticket, now, ttlMs: ticketTtlMs });
  if (!verified.ok) return { ok: false, reason: verified.reason === "expired" ? "expired" : "invalid" };

  const session = await loadSession(verified.sessionId);
  if (session === null) return { ok: false, reason: "invalid" };
  if (session.status !== "active") return { ok: false, reason: "closed" };

  return {
    ok: true,
    sessionId: verified.sessionId,
    nonce: verified.nonce,
    tokenSlot: verified.tokenSlot,
    issuedAtMs: verified.issuedAtMs,
    expiresAtMs: verified.expiresAtMs,
    session: { id: session.id, title: session.title, location: session.location },
  };
}
