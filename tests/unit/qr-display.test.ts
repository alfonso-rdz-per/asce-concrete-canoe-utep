/**
 * Lógica de presentación de la pantalla del QR: qué se dibuja, cuándo se refresca y cuándo NO se dibuja nada.
 * Todo recibe las horas por parámetro: ni el reloj del dispositivo ni la red intervienen.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REFRESH_AFTER_CURRENT_ENDS_MS,
  chooseDisplayed,
  countdownSeconds,
  estimateServerNow,
  makeServerClock,
  needsRefresh,
  qrUrl,
  type QrSnapshot,
} from "@/lib/qr-display";
import { deriveKey } from "@/lib/crypto/keys";
import { issueQrTokens, verifyQrToken } from "@/lib/tokens";
import { SESSION_A, T0 } from "../helpers/clock";

const KEY = deriveKey("secreto-de-servidor-para-pruebas-0123456789", "qr");

/** Lo que devuelve /api/admin/sessions/[id]/qr, tal como lo recibe el navegador. */
function snapshotAt(serverNow: number): QrSnapshot {
  const { current, next } = issueQrTokens({ key: KEY, sessionId: SESSION_A, now: serverNow });
  return {
    current: { token: current.token, startsAtMs: current.startsAtMs, endsAtMs: current.endsAtMs },
    next: { token: next.token, startsAtMs: next.startsAtMs, endsAtMs: next.endsAtMs },
  };
}

afterEach(() => vi.useRealTimers());

describe("reloj anclado al servidor", () => {
  it("compensa la mitad del viaje (RTT/2) y avanza con el reloj monótono", () => {
    // La petición salió en perf=1000 y la respuesta llegó en perf=1400 (RTT 400 ms): el servidor respondió ~200 ms antes.
    const clock = makeServerClock({ serverNowMs: T0 + 5_000, requestPerfMs: 1_000, responsePerfMs: 1_400 });
    expect(estimateServerNow(clock, 1_400)).toBe(T0 + 5_200);
    expect(estimateServerNow(clock, 3_400)).toBe(T0 + 7_200);
  });

  it("un RTT negativo o absurdo no adelanta el reloj", () => {
    const clock = makeServerClock({ serverNowMs: T0, requestPerfMs: 2_000, responsePerfMs: 1_000 });
    expect(estimateServerNow(clock, 1_000)).toBe(T0);
  });

  it("NO USA el reloj del dispositivo: la estimación no cambia aunque `Date` diga cualquier cosa", () => {
    vi.useFakeTimers();
    const clock = makeServerClock({ serverNowMs: T0 + 2_000, requestPerfMs: 0, responsePerfMs: 0 });
    for (const deviceClock of ["1999-01-01T00:00:00Z", "2100-06-15T12:00:00Z"]) {
      vi.setSystemTime(new Date(deviceClock));
      expect(estimateServerNow(clock, 3_000)).toBe(T0 + 5_000);
    }
  });
});

describe("qué QR se dibuja", () => {
  it("dentro del intervalo actual: el token ACTUAL, con su cuenta regresiva", () => {
    const snap = snapshotAt(T0 + 3_000);
    const shown = chooseDisplayed(snap, T0 + 3_000);
    expect(shown).toMatchObject({ token: snap.current.token, msLeft: 7_000, windowMs: 10_000 });
    expect(countdownSeconds(shown!.msLeft)).toBe(7);
  });

  it("al cruzar el límite de 10 s cambia al SIGUIENTE token, sin pedir nada a la red", () => {
    const snap = snapshotAt(T0 + 3_000);
    expect(chooseDisplayed(snap, T0 + 9_999)!.token).toBe(snap.current.token);
    expect(chooseDisplayed(snap, T0 + 10_000)!.token).toBe(snap.next.token);
    expect(chooseDisplayed(snap, T0 + 15_000)!.token).toBe(snap.next.token);
  });

  it("los tokens dibujados son los que el SERVIDOR aceptaría en ese instante (nunca uno vencido)", () => {
    const snap = snapshotAt(T0 + 3_000);
    for (let est = T0 + 3_000; est < T0 + 20_000; est += 250) {
      const shown = chooseDisplayed(snap, est);
      if (!shown) continue;
      expect(verifyQrToken({ key: KEY, token: shown.token, now: est, graceMs: 5_000 }).ok, `est=${est - T0}`).toBe(true);
    }
  });

  it("STALE: cuando la hora estimada sale de AMBAS ventanas no se dibuja NINGÚN QR", () => {
    const snap = snapshotAt(T0 + 3_000);
    expect(chooseDisplayed(snap, T0 + 20_000)).toBeNull();
    expect(chooseDisplayed(snap, T0 + 600_000)).toBeNull();
    expect(chooseDisplayed(snap, T0 - 1)).toBeNull(); // antes del intervalo actual
  });

  it("sin snapshot o con una hora no numérica: nada", () => {
    expect(chooseDisplayed(null, T0)).toBeNull();
    expect(chooseDisplayed(snapshotAt(T0), Number.NaN)).toBeNull();
    expect(chooseDisplayed(snapshotAt(T0), Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("countdownSeconds redondea hacia arriba y nunca es negativo", () => {
    expect(countdownSeconds(9_001)).toBe(10);
    expect(countdownSeconds(1)).toBe(1);
    expect(countdownSeconds(0)).toBe(0);
    expect(countdownSeconds(-500)).toBe(0);
  });
});

describe("cuándo pedir tokens nuevos", () => {
  it("sin snapshot: sí", () => {
    expect(needsRefresh(null, T0)).toBe(true);
  });

  it("mientras el actual siga en curso y poco después de que termine: no", () => {
    const snap = snapshotAt(T0 + 3_000);
    expect(needsRefresh(snap, T0 + 3_000)).toBe(false);
    expect(needsRefresh(snap, T0 + 10_000)).toBe(false); // ya se muestra el siguiente
    expect(needsRefresh(snap, T0 + 10_000 + REFRESH_AFTER_CURRENT_ENDS_MS - 1)).toBe(false);
  });

  it("tras el actual + 2 s (aún quedan ~8 s del siguiente): sí, con margen para la red", () => {
    const snap = snapshotAt(T0 + 3_000);
    expect(needsRefresh(snap, T0 + 10_000 + REFRESH_AFTER_CURRENT_ENDS_MS)).toBe(true);
    // En ese momento todavía hay un QR válido que dibujar: no se parpadea mientras llega el par nuevo.
    expect(chooseDisplayed(snap, T0 + 10_000 + REFRESH_AFTER_CURRENT_ENDS_MS)).not.toBeNull();
  });

  it("si ningún token cubre la hora estimada: sí (y mientras tanto no se dibuja nada)", () => {
    const snap = snapshotAt(T0 + 3_000);
    expect(needsRefresh(snap, T0 + 25_000)).toBe(true);
  });

  it("un ciclo completo de 60 s nunca deja la pantalla sin QR si el servidor responde (simulación)", () => {
    let snap = snapshotAt(T0);
    let clock = makeServerClock({ serverNowMs: T0, requestPerfMs: 0, responsePerfMs: 0 });
    let blank = 0;
    for (let perf = 0; perf <= 60_000; perf += 250) {
      const est = estimateServerNow(clock, perf);
      if (needsRefresh(snap, est)) {
        // El servidor responde al instante con el par de tokens de su hora actual.
        snap = snapshotAt(est);
        clock = makeServerClock({ serverNowMs: est, requestPerfMs: perf, responsePerfMs: perf });
      }
      if (chooseDisplayed(snap, estimateServerNow(clock, perf)) === null) blank++;
    }
    expect(blank).toBe(0);
  });
});

describe("contenido del QR", () => {
  it("origen + /c/<token>, sin barras duplicadas y sin datos personales", () => {
    expect(qrUrl("https://asce.example.org", "v1.abc.def.ghi")).toBe("https://asce.example.org/c/v1.abc.def.ghi");
    expect(qrUrl("https://asce.example.org/", "v1.abc.def.ghi")).toBe("https://asce.example.org/c/v1.abc.def.ghi");
    expect(qrUrl("http://192.168.1.20:3000", "t")).toBe("http://192.168.1.20:3000/c/t");
  });
});
