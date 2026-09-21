/**
 * Lógica de PRESENTACIÓN de la pantalla del QR del administrador. Sin dependencias ni acceso a relojes: todo recibe
 * las horas por parámetro, así que se prueba sin navegador.
 *
 * Quién manda: el SERVIDOR. La validez de un token la decide `verifyQrToken` con la hora del servidor; esto solo decide
 * QUÉ DIBUJAR. El reloj del teléfono del administrador NUNCA interviene: se usa únicamente `performance.now()`
 * (monótono) para medir cuánto ha pasado desde la última respuesta del servidor.
 *
 *   hora_servidor_estimada = serverNow(respuesta) + rtt/2 + (performance.now() - instante_de_la_respuesta)
 *
 * El servidor entrega el token del intervalo actual y el del siguiente; el cambio de uno a otro es local y atómico.
 * Si ninguno de los dos cubre la hora estimada, NO se dibuja ningún QR (nunca uno viejo "como si valiera").
 */
export interface QrWindow {
  token: string;
  /** Intervalo en que el token se muestra (ms, hora del servidor). */
  startsAtMs: number;
  endsAtMs: number;
}

export interface QrSnapshot {
  current: QrWindow;
  next: QrWindow;
}

export interface ServerClock {
  /** Hora estimada del servidor en el instante `perfBaseMs` (performance.now del navegador). */
  serverBaseMs: number;
  perfBaseMs: number;
}

/** Se pide un par nuevo de tokens un poco después de que termine el actual (aún quedan ~8 s del siguiente). */
export const REFRESH_AFTER_CURRENT_ENDS_MS = 2_000;
/** Si falla una petición, se reintenta pronto. */
export const RETRY_MS = 1_500;

/** Ancla el reloj a la respuesta del servidor, compensando la mitad del viaje (RTT/2). */
export function makeServerClock(args: { serverNowMs: number; requestPerfMs: number; responsePerfMs: number }): ServerClock {
  const rtt = Math.max(0, args.responsePerfMs - args.requestPerfMs);
  return { serverBaseMs: args.serverNowMs + rtt / 2, perfBaseMs: args.responsePerfMs };
}

export function estimateServerNow(clock: ServerClock, perfNowMs: number): number {
  return clock.serverBaseMs + (perfNowMs - clock.perfBaseMs);
}

export interface DisplayedQr {
  token: string;
  /** Milisegundos que le quedan visibles (para la cuenta regresiva). */
  msLeft: number;
  /** Duración total del intervalo (10 s). */
  windowMs: number;
}

/** El token cuyo intervalo contiene la hora estimada del servidor, o null (entonces NO se dibuja ningún QR). */
export function chooseDisplayed(snapshot: QrSnapshot | null, estServerNowMs: number): DisplayedQr | null {
  if (!snapshot || !Number.isFinite(estServerNowMs)) return null;
  for (const w of [snapshot.current, snapshot.next]) {
    if (estServerNowMs >= w.startsAtMs && estServerNowMs < w.endsAtMs) {
      return { token: w.token, msLeft: w.endsAtMs - estServerNowMs, windowMs: w.endsAtMs - w.startsAtMs };
    }
  }
  return null;
}

/** true si hay que pedir tokens nuevos: no hay ninguno, no cubren la hora actual o el actual ya terminó hace un rato. */
export function needsRefresh(snapshot: QrSnapshot | null, estServerNowMs: number): boolean {
  if (!snapshot) return true;
  if (chooseDisplayed(snapshot, estServerNowMs) === null) return true;
  return estServerNowMs >= snapshot.current.endsAtMs + REFRESH_AFTER_CURRENT_ENDS_MS;
}

export function countdownSeconds(msLeft: number): number {
  return Math.max(0, Math.ceil(msLeft / 1000));
}

/** Contenido del QR: el origen de esta página + /c/<token>. El token no contiene caracteres que requieran escape. */
export function qrUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, "")}/c/${token}`;
}
