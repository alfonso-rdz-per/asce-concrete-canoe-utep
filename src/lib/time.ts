/**
 * Reloj inyectable. Toda decisión de validez (tokens, tickets) recibe la hora
 * como parámetro `now` o a través de un `Clock`, y en producción esa hora es
 * SIEMPRE la del servidor. Nunca se lee un reloj del navegador para decidir nada.
 */
export interface Clock {
  /** Milisegundos desde la época Unix (UTC). */
  now(): number;
}

export const systemClock: Clock = {
  now: () => Date.now(),
};

/**
 * Falla CERRADO ante una hora inválida. Sin esta guarda, un `now` NaN/undefined
 * haría falsas las dos comparaciones de vigencia y aceptaría tokens caducados.
 */
export function assertNowMs(now: unknown): asserts now is number {
  if (typeof now !== "number" || !Number.isFinite(now) || now < 0) {
    throw new RangeError("La hora del servidor debe ser un número finito no negativo (ms).");
  }
}
