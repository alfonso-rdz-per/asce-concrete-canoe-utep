"use client";

import { QRCodeSVG } from "qrcode.react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { CloseSessionControl } from "@/components/admin/SessionControls";
import type { ActionState } from "@/lib/action-state";
import { INSTAGRAM_HANDLE, INSTAGRAM_URL } from "@/lib/brand/social";
import { formatClockTime } from "@/lib/dates";
import {
  RETRY_MS,
  chooseDisplayed,
  estimateServerNow,
  makeServerClock,
  needsRefresh,
  qrUrl,
  type QrSnapshot,
  type QrWindow,
  type ServerClock,
} from "@/lib/qr-display";

export interface QrAttendee {
  id: string;
  name: string;
  position: string;
  checkedInAt: string;
}

export interface QrLive {
  count: number;
  total: number;
  attendees: QrAttendee[];
}

type ScreenStatus = "active" | "draft" | "closed";

/** Sondeo de la asistencia en vivo (y del estado de la sesión). */
const LIVE_POLL_MS = 3_000;
/** Si ninguna petición al servidor tiene éxito durante este tiempo, el QR se oculta ("sin conexión"). */
const OFFLINE_AFTER_MS = 8_000;
/** Cadencia del reloj de dibujado (solo estética: la validez la decide el servidor). */
const TICK_MS = 250;

const noSubscribe = () => () => {};
const readOrigin = () => window.location.origin;
const serverOrigin = () => "";

function isWindow(v: unknown): v is QrWindow {
  const w = v as Partial<QrWindow> | null;
  return !!w && typeof w.token === "string" && Number.isFinite(w.startsAtMs) && Number.isFinite(w.endsAtMs);
}

/** Mantiene la pantalla encendida donde exista Screen Wake Lock. Si no existe o se deniega, todo sigue funcionando. */
function useWakeLock(enabled: boolean) {
  useEffect(() => {
    if (!enabled || typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
    let sentinel: WakeLockSentinel | null = null;
    let cancelled = false;

    const acquire = async () => {
      try {
        const lock = await navigator.wakeLock.request("screen");
        if (cancelled) void lock.release().catch(() => {});
        else sentinel = lock;
      } catch {
        // Sin permiso o sin soporte: la pantalla puede apagarse, pero la aplicación sigue funcionando normalmente.
      }
    };
    // El sistema libera el bloqueo al ocultar la pestaña: se vuelve a pedir al volver.
    const onVisible = () => {
      if (document.visibilityState === "visible" && (sentinel === null || sentinel.released)) void acquire();
    };

    void acquire();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
      void sentinel?.release().catch(() => {});
    };
  }, [enabled]);
}

/**
 * Pantalla del QR de check-in (iPhone del administrador o proyector).
 *
 * SOLO DIBUJA. Qué tokens existen y cuáles valen lo decide el servidor: aquí se pide el par (actual, siguiente), se ancla
 * la cuenta regresiva a la HORA DEL SERVIDOR y se cambia de QR en cada límite de 10 s. Nunca se dibuja un QR que la hora
 * estimada del servidor no cubra, ni se sigue dibujando uno sin conexión con el servidor o con la sesión cerrada.
 */
export function QrScreen({
  sessionId,
  title,
  startedBy,
  initialStatus,
  initialLive,
  brand,
  closeAction,
}: {
  sessionId: string;
  title: string;
  /** Nombre (primer nombre) del administrador que abrió el check-in; null si no se conoce. */
  startedBy: string | null;
  initialStatus: "active" | "closed";
  initialLive: QrLive;
  /** <BrandMark /> (componente de servidor: lee los logos del disco). */
  brand: ReactNode;
  closeAction: (prev: ActionState, formData: FormData) => Promise<ActionState>;
}) {
  const [status, setStatus] = useState<ScreenStatus>(initialStatus);
  const [live, setLive] = useState<QrLive>(initialLive);
  const [snapshot, setSnapshot] = useState<{ qr: QrSnapshot; clock: ServerClock } | null>(null);
  const [estNow, setEstNow] = useState<number | null>(null);
  const [offline, setOffline] = useState(false);
  const [signedOut, setSignedOut] = useState(false);
  // El origen solo existe en el navegador: en el servidor es "" (así no hay diferencias de hidratación).
  const origin = useSyncExternalStore(noSubscribe, readOrigin, serverOrigin);

  const statusRef = useRef<ScreenStatus>(status);
  const snapshotRef = useRef(snapshot);
  const qrInFlight = useRef(false);
  const nextQrAttemptAt = useRef(0);
  /** Instante (performance.now) de la última respuesta correcta del servidor; se inicia al montar. */
  const lastOkAt = useRef(0);

  useEffect(() => {
    statusRef.current = status;
  }, [status]);
  useEffect(() => {
    snapshotRef.current = snapshot;
  }, [snapshot]);
  useEffect(() => {
    lastOkAt.current = performance.now();
  }, []);

  useWakeLock(status === "active");

  /** Cierra la pantalla del QR a todos los efectos (sin QR, sin tokens guardados). */
  const markClosed = useCallback((next: ScreenStatus) => {
    statusRef.current = next;
    snapshotRef.current = null;
    setStatus(next);
    setSnapshot(null);
    setEstNow(null);
  }, []);

  const fetchQr = useCallback(async () => {
    if (qrInFlight.current || statusRef.current !== "active") return;
    qrInFlight.current = true;
    const requestPerf = performance.now();
    try {
      const res = await fetch(`/api/admin/sessions/${sessionId}/qr`, { cache: "no-store", credentials: "same-origin" });
      const responsePerf = performance.now();
      if (res.status === 401) {
        setSignedOut(true);
        return;
      }
      if (res.status === 404) {
        // La sesión se eliminó (aquí o en otra pestaña): el servidor ya rechaza su QR; la pantalla deja de dibujarlo al instante.
        markClosed("closed");
        return;
      }
      if (!res.ok) throw new Error("qr");
      const body = (await res.json()) as { status?: string; serverNow?: number; current?: unknown; next?: unknown };
      if (body.status !== "active") {
        markClosed(body.status === "draft" ? "draft" : "closed");
        return;
      }
      if (!isWindow(body.current) || !isWindow(body.next) || !Number.isFinite(body.serverNow)) throw new Error("shape");
      const clock = makeServerClock({ serverNowMs: body.serverNow as number, requestPerfMs: requestPerf, responsePerfMs: responsePerf });
      snapshotRef.current = { qr: { current: body.current, next: body.next }, clock };
      setSnapshot(snapshotRef.current);
      setEstNow(estimateServerNow(clock, performance.now())); // el QR se dibuja YA, sin esperar al siguiente tic
      lastOkAt.current = responsePerf;
      nextQrAttemptAt.current = 0;
    } catch {
      nextQrAttemptAt.current = performance.now() + RETRY_MS;
    } finally {
      qrInFlight.current = false;
    }
  }, [sessionId, markClosed]);

  const fetchLive = useCallback(async () => {
    try {
      const res = await fetch(`/api/admin/sessions/${sessionId}/attendance`, { cache: "no-store", credentials: "same-origin" });
      if (res.status === 401) {
        setSignedOut(true);
        return;
      }
      if (res.status === 404 && statusRef.current === "active") {
        markClosed("closed"); // sesión eliminada
        return;
      }
      if (!res.ok) throw new Error("live");
      const body = (await res.json()) as { status?: string; count?: number; total?: number; attendees?: QrAttendee[] };
      lastOkAt.current = performance.now();
      if (Array.isArray(body.attendees)) {
        setLive({ count: Number(body.count) || 0, total: Number(body.total) || 0, attendees: body.attendees });
      }
      // El estado de la sesión viaja en cada sondeo: si se cerró (aquí o en otra pestaña), el QR deja de mostrarse.
      if (body.status && body.status !== "active" && statusRef.current === "active") {
        markClosed(body.status === "draft" ? "draft" : "closed");
      }
    } catch {
      // El indicador de conexión lo decide el reloj de dibujado (OFFLINE_AFTER_MS).
    }
  }, [sessionId, markClosed]);

  // Reloj de dibujado: recalcula la hora estimada del servidor, decide si hay que pedir tokens y si seguimos "en línea".
  useEffect(() => {
    if (status !== "active") return;
    const tick = () => {
      const now = performance.now();
      const snap = snapshotRef.current;
      const est = snap ? estimateServerNow(snap.clock, now) : null;
      setEstNow(est);
      setOffline(now - lastOkAt.current > OFFLINE_AFTER_MS);
      if (needsRefresh(snap?.qr ?? null, est ?? 0) && now >= nextQrAttemptAt.current) void fetchQr();
    };
    tick();
    const timer = setInterval(tick, TICK_MS);
    return () => clearInterval(timer);
  }, [status, fetchQr]);

  // Asistencia en vivo: cada ~3 s mientras la sesión esté activa (y una última lectura al cerrarse).
  useEffect(() => {
    const first = setTimeout(() => void fetchLive(), 0);
    if (status !== "active") return () => clearTimeout(first);
    const timer = setInterval(() => void fetchLive(), LIVE_POLL_MS);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [status, fetchLive]);

  // Al volver a la pestaña / recuperar la red / volver de la caché de páginas: NUNCA se reutiliza un QR guardado. Se descarta
  // y se pide estado fresco al servidor (el reloj monótono puede haberse detenido con la pantalla apagada).
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === "hidden" || statusRef.current !== "active") return;
      snapshotRef.current = null;
      setSnapshot(null);
      setEstNow(null);
      nextQrAttemptAt.current = 0;
      void fetchQr();
      void fetchLive();
    };
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("online", refresh);
    window.addEventListener("pageshow", refresh);
    return () => {
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("pageshow", refresh);
    };
  }, [fetchQr, fetchLive]);

  const displayed = status === "active" && !offline && !signedOut && snapshot && estNow !== null ? chooseDisplayed(snapshot.qr, estNow) : null;
  // Solo una indicación visual discreta (sin números): cuánto falta para que cambie el código.
  const progress = displayed ? Math.max(0, Math.min(100, (displayed.msLeft / displayed.windowMs) * 100)) : 0;

  return (
    <div className="on-dark relative isolate flex min-h-dvh flex-col overflow-hidden bg-navy pb-[env(safe-area-inset-bottom)] pt-[env(safe-area-inset-top)] text-white">
      <QrBackdrop />

      <header className="relative mx-auto flex w-full items-center justify-between gap-4 px-4 py-4 sm:px-6 lg:px-10">
        {brand}
        <Link
          href={`/admin/sessions/${sessionId}`}
          className="inline-flex min-h-11 items-center rounded-lg border border-white/40 bg-navy/40 px-4 text-sm font-semibold text-white backdrop-blur-sm hover:bg-white/10"
        >
          Back to session
        </Link>
      </header>

      {/*
        COMPOSICIÓN (jerarquía: logos > Attendance > título > QR). La foto (imagen-fondo.jpg) tiene a la persona a la IZQUIERDA (~36 % del
        ancho) y espacio libre a la derecha, así que el QR va lo más a la DERECHA posible y la columna izquierda apila, de arriba abajo:
        logos (cabecera), la persona (la foto), Attendance, el título y "Active". Attendance es una columna ESTRECHA a la izquierda de la
        persona (nunca encima). En móvil la foto es un banner arriba (persona visible) y todo se apila debajo con el mismo orden.
      */}
      <main
        id="main"
        tabIndex={-1}
        className="relative flex flex-1 flex-col gap-4 px-4 pb-6 sm:px-6 lg:grid lg:grid-cols-[minmax(0,1fr)_var(--qr-w)] lg:grid-rows-[1fr_auto_auto_auto] lg:gap-x-10 lg:gap-y-3 lg:px-10 lg:pb-6 [--qr-w:clamp(19rem,34vw,32rem)]"
      >
        <section
          aria-labelledby="attendance-heading"
          className="mt-[25dvh] w-full min-w-0 self-center rounded-xl bg-white p-4 text-ink shadow-card sm:max-w-md lg:col-start-1 lg:row-start-2 lg:mt-0 lg:w-[clamp(14rem,17vw,22rem)] lg:self-start lg:p-4"
        >
          <div className="flex items-baseline justify-between gap-4">
            <h2 id="attendance-heading" className="text-lg font-bold text-navy">
              Attendance
            </h2>
            <p aria-live="polite" aria-atomic="true" className="tabular-nums text-muted">
              <span className="text-3xl font-extrabold text-navy">{live.count}</span> / {live.total}
            </p>
          </div>

          {status === "active" && offline ? (
            <p role="status" className="mt-2 text-sm font-medium text-danger">
              Connection lost — retrying…
            </p>
          ) : null}

          {live.attendees.length === 0 ? (
            <p className="mt-3 text-muted">No one has checked in yet.</p>
          ) : (
            <ul className="mt-2 max-h-[16dvh] divide-y divide-line overflow-y-auto lg:max-h-[22dvh]">
              {live.attendees.map((a) => (
                <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate font-semibold">{a.name}</p>
                    <p className="truncate text-sm text-muted">{a.position}</p>
                  </div>
                  <p className="shrink-0 text-sm tabular-nums text-muted">{formatClockTime(a.checkedInAt)}</p>
                </li>
              ))}
            </ul>
          )}

          {status === "active" ? (
            <div className="mt-3 border-t border-line pt-3">
              <CloseSessionControl sessionId={sessionId} sessionTitle={title} action={closeAction} onClosed={() => markClosed("closed")} />
            </div>
          ) : null}
        </section>

        <div className="text-center lg:col-start-1 lg:row-start-3 lg:self-end lg:text-left">
          {status === "active" ? <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky">Scan to check in</p> : null}
          <h1 id="qr-heading" className="mt-1 break-words text-3xl font-extrabold tracking-tight [text-shadow:0_1px_12px_rgb(0_32_74/0.6)] sm:text-4xl lg:text-5xl">
            {title}
          </h1>
        </div>

        <section
          aria-labelledby="qr-heading"
          className="flex min-w-0 flex-col items-center gap-4 [--qr-size:min(84vw,38dvh)] lg:col-start-2 lg:row-span-4 lg:row-start-1 lg:items-end lg:self-center lg:[--qr-size:min(var(--qr-w),66dvh)]"
        >
          <div className="flex aspect-square w-[var(--qr-size)] items-center justify-center rounded-2xl bg-white p-3 text-ink shadow-card">
            {displayed ? (
              <QRCodeSVG
                value={qrUrl(origin, displayed.token)}
                level="M"
                marginSize={4}
                bgColor="#ffffff"
                fgColor="#000000"
                title="Check-in QR code"
                className="h-full w-full"
                size={256}
              />
            ) : (
              <div role="status" className="space-y-2 px-4 text-center">
                {signedOut ? (
                  <>
                    <p className="text-lg font-bold text-navy">Your sign-in expired</p>
                    <Link href={`/admin/login?next=/admin/sessions/${sessionId}/qr`} className="inline-flex min-h-11 items-center font-semibold text-blue underline underline-offset-4">
                      Sign in again
                    </Link>
                  </>
                ) : status === "closed" ? (
                  <>
                    <p className="text-lg font-bold text-navy">Check-in closed</p>
                    <p className="text-muted">This QR code is no longer accepted.</p>
                  </>
                ) : status === "draft" ? (
                  <p className="text-lg font-bold text-navy">This session has not started</p>
                ) : offline ? (
                  <>
                    <p className="text-lg font-bold text-navy">Connection lost</p>
                    <p className="text-muted">Reconnecting…</p>
                  </>
                ) : (
                  <p className="text-lg font-bold text-navy">Getting a fresh code…</p>
                )}
              </div>
            )}
          </div>

          {status === "active" ? (
            // Barra fina y discreta, del ancho del QR y sin números: solo indica que el código va cambiando.
            <svg
              data-testid="qr-progress"
              aria-hidden="true"
              focusable="false"
              viewBox="0 0 100 2"
              preserveAspectRatio="none"
              className="block h-0.5 w-[var(--qr-size)]"
            >
              <rect width="100" height="2" rx="1" className="fill-white/25" />
              {progress > 0 ? <rect width={progress} height="2" rx="1" className="fill-sky/80" /> : null}
            </svg>
          ) : null}
        </section>

        <div className="flex flex-col items-center gap-1 text-sm lg:col-start-1 lg:row-start-4 lg:items-start">
          <span className="inline-flex items-center gap-2 rounded-full bg-navy/70 px-3 py-1 font-semibold ring-1 ring-white/20 backdrop-blur-sm">
            {status === "active" ? <span aria-hidden="true" className="h-2 w-2 rounded-full bg-sky" /> : null}
            {status === "active" ? "Active" : "Closed"}
          </span>
          {startedBy ? <span className="text-white/90 [text-shadow:0_1px_8px_rgb(0_32_74/0.7)]">Started by {startedBy}</span> : null}
        </div>
      </main>

      {/* Instagram del equipo: esquina inferior derecha, discreto pero visible; fuera del área del QR, la persona, Attendance y el título. */}
      <footer className="relative flex justify-end px-4 pb-[max(0.75rem,env(safe-area-inset-bottom))] pr-[max(1rem,env(safe-area-inset-right))] sm:px-6 lg:px-10">
        <a
          href={INSTAGRAM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center rounded-md px-2 text-sm font-semibold text-white/90 underline-offset-4 [text-shadow:0_1px_8px_rgb(0_32_74/0.8)] hover:text-white hover:underline"
        >
          {INSTAGRAM_HANDLE}
          <span className="sr-only"> (Instagram, opens in a new tab)</span>
        </a>
      </footer>
    </div>
  );
}

/**
 * Fondo de la pantalla del QR: imagen-fondo.jpg (SIN modificar el archivo) teñida de azul por CSS (mezcla `luminosity` sobre navy +
 * degradados). En móvil es un banner arriba (la persona queda visible sobre el título y el QR); en escritorio ocupa toda la pantalla
 * con la persona a la izquierda, y el degradado se oscurece a la derecha, donde van el QR y la asistencia. Capas decorativas
 * (`aria-hidden`) DETRÁS del contenido; el QR mantiene su placa blanca, así que el contraste del código no depende de la foto.
 */
function QrBackdrop() {
  return (
    <>
      <div aria-hidden="true" className="qr-photo pointer-events-none absolute inset-x-0 top-0 -z-10 h-[46dvh] opacity-90 lg:inset-0 lg:h-auto" />
      {/* Móvil: la foto se funde con el navy por abajo (ahí empiezan el título y el QR). */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 top-0 -z-10 h-[46dvh] bg-gradient-to-b from-navy/50 via-navy/20 to-navy lg:hidden" />
      {/* Escritorio: filtro azul más suave sobre la persona (izquierda) y más denso hacia el QR y la asistencia (derecha). */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 hidden bg-gradient-to-r from-navy/25 via-navy/35 to-navy/85 lg:block" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 hidden h-2/5 bg-gradient-to-t from-navy/90 via-navy/50 to-transparent lg:block" />
    </>
  );
}
