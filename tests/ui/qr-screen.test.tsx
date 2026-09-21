/**
 * Pantalla del QR del administrador (componente de cliente). Se prueba con temporizadores falsos y un "servidor" falso cuya
 * hora es CONTROLABLE e independiente del reloj del dispositivo: demuestra que la cuenta regresiva sigue al servidor, que el
 * QR rota cada 10 s, que NUNCA se dibuja un QR obsoleto o sin conexión y que cerrar la sesión lo quita de inmediato.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => ({ push: vi.fn() }) }));
// Se sustituye la librería por un marcador que expone el valor codificado (la prueba de la librería real está en qr-render.test.tsx).
vi.mock("qrcode.react", () => ({
  QRCodeSVG: (props: { value: string; className?: string }) => <svg data-testid="qr" data-value={props.value} className={props.className} />,
}));

import { QrScreen, type QrAttendee } from "@/components/admin/QrScreen";
import type { ActionState } from "@/lib/action-state";
import { deriveKey } from "@/lib/crypto/keys";
import { issueQrTokens, verifyQrToken } from "@/lib/tokens";
import { SESSION_A, T0 } from "../helpers/clock";

const css = readFileSync("src/app/globals.css", "utf8");
const KEY = deriveKey("secreto-de-servidor-para-pruebas-0123456789", "qr");

interface Server {
  status: "active" | "closed";
  /** Hora del servidor en el instante t=0 de la prueba. */
  startMs: number;
  down: boolean;
  unauthorized: boolean;
  /** La sesión se eliminó: las APIs responden 404. */
  deleted: boolean;
  hold: Promise<void> | null;
  qrCalls: number;
  liveCalls: number;
  attendees: QrAttendee[];
  total: number;
}

let srv: Server;
let perfStart = 0;
/** Hora del SERVIDOR: avanza con el reloj monótono falso, jamás con el reloj del dispositivo (`Date`). */
const serverNow = () => srv.startMs + (performance.now() - perfStart);

function install() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (srv.hold) await srv.hold;
      if (srv.down) throw new TypeError("network down");
      if (srv.unauthorized) return { ok: false, status: 401, json: async () => ({ error: "unauthorized" }) };
      if (srv.deleted) return { ok: false, status: 404, json: async () => ({ error: "not_found" }) };
      if (input.includes("/qr")) {
        srv.qrCalls++;
        if (srv.status !== "active") return { ok: true, status: 200, json: async () => ({ status: srv.status, serverNow: serverNow() }) };
        const { serverNow: now, current, next } = issueQrTokens({ key: KEY, sessionId: SESSION_A, now: serverNow() });
        const pick = (w: { token: string; startsAtMs: number; endsAtMs: number }) => ({ token: w.token, startsAtMs: w.startsAtMs, endsAtMs: w.endsAtMs });
        return { ok: true, status: 200, json: async () => ({ status: "active", serverNow: now, current: pick(current), next: pick(next) }) };
      }
      srv.liveCalls++;
      return { ok: true, status: 200, json: async () => ({ status: srv.status, count: srv.attendees.length, total: srv.total, attendees: srv.attendees }) };
    }),
  );
}

const PEOPLE: QrAttendee[] = [
  { id: "c1", name: "Maria Lopez", position: "Safety Officer", checkedInAt: "2026-09-20T00:10:00Z" },
  { id: "c2", name: "John Smith", position: "Member", checkedInAt: "2026-09-20T00:12:00Z" },
];

const closeAction = vi.fn(async (): Promise<ActionState> => ({ status: "success", message: "Check-in closed." }));

function renderScreen(over: Partial<React.ComponentProps<typeof QrScreen>> = {}) {
  return render(
    <QrScreen
      sessionId={SESSION_A}
      title="Concrete Canoe Practice"
      startedBy="Lesley"
      initialStatus="active"
      initialLive={{ count: 12, total: 25, attendees: PEOPLE }}
      brand={<span data-testid="brand">ASCE | UTEP</span>}
      closeAction={closeAction}
      {...over}
    />,
  );
}

/** Avanza el tiempo (reloj monótono, temporizadores y promesas pendientes). */
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
const shownToken = () => screen.queryByTestId("qr")?.getAttribute("data-value")?.split("/c/")[1] ?? null;
const valid = (token: string | null) => token !== null && verifyQrToken({ key: KEY, token, now: serverNow(), graceMs: 5_000 }).ok;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"] });
  vi.setSystemTime(new Date("2035-05-05T05:05:05Z")); // el reloj del DISPOSITIVO marca cualquier cosa
  perfStart = performance.now();
  srv = { status: "active", startMs: T0 + 3_000, down: false, unauthorized: false, deleted: false, hold: null, qrCalls: 0, liveCalls: 0, attendees: [...PEOPLE], total: 25 };
  install();
  closeAction.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(navigator, "wakeLock");
});

/** Ancho (0–100) del relleno de la barra fina: cuánto falta para que cambie el código. */
const progressWidth = () => {
  const rects = screen.getByTestId("qr-progress").querySelectorAll("rect");
  return rects.length > 1 ? Number(rects[1].getAttribute("width")) : 0;
};

describe("QR, barra fina y diseño limpio", () => {
  it("dibuja el QR del intervalo actual (enlace /c/<token>) con marca, nombre de la sesión, 'Active' y 'Started by Lesley'", async () => {
    renderScreen();
    expect(screen.getByText("Getting a fresh code…")).toBeInTheDocument(); // hasta que responde el servidor NO hay QR
    await advance(20);

    expect(screen.getByTestId("qr").getAttribute("data-value")).toMatch(/^http:\/\/localhost:3000\/c\/v1\./); // el QR sí codifica el origen: es lo que abre el teléfono
    expect(valid(shownToken())).toBe(true);
    expect(screen.getByRole("heading", { level: 1, name: "Concrete Canoe Practice" })).toBeInTheDocument();
    expect(screen.getByTestId("brand")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Started by Lesley")).toBeInTheDocument();
    expect(screen.getByText("Scan to check in")).toBeInTheDocument();
  });

  it("SIN countdown numérico: no hay segundos restantes, ni 'New code in', ni 'Expires in', en ningún momento", async () => {
    renderScreen();
    for (let s = 0; s < 25; s++) {
      await advance(1_000);
      const text = document.body.textContent ?? "";
      expect(text, `t=${s}s`).not.toMatch(/\b\d{1,2}\s?s\b/); // "7s", "7 s"
      expect(text, `t=${s}s`).not.toMatch(/new code in|expires? in|seconds?\b|refreshes every/i);
    }
  });

  it("NO muestra ninguna IP ni host local en ninguna parte (ni el origen, ni 'Students will open …')", async () => {
    renderScreen();
    await advance(20);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/); // 192.168.1.215
    expect(text).not.toMatch(/localhost|:3000|:3300|students will open/i);
    // (el QR sí contiene el origen, pero solo dentro del código, no como texto visible)
    expect(screen.getByTestId("qr").getAttribute("data-value")).toContain("localhost");
  });

  it("NO muestra el párrafo explicativo anterior ('Students scan this code…')", async () => {
    renderScreen();
    await advance(20);
    const text = document.body.textContent ?? "";
    expect(text).not.toMatch(/students scan this code|phone camera|screenshot stops working|changes every 10 seconds/i);
  });

  it("la barra es pequeña, delgada y discreta: sin números, aria-hidden, mucho más baja que el QR", async () => {
    renderScreen();
    await advance(20);
    const bar = screen.getByTestId("qr-progress");
    expect(bar).toHaveAttribute("aria-hidden", "true");
    expect(bar.textContent).toBe(""); // sin números ni texto
    expect(bar.getAttribute("class")).toContain("h-0.5"); // 2 px
    const qrCard = screen.getByTestId("qr").parentElement as HTMLElement;
    expect(qrCard.className).toContain("aspect-square"); // el QR sigue siendo el protagonista
    expect(qrCard.className).toContain("w-[var(--qr-size)]");
    expect(bar.getAttribute("class")).toContain("w-[var(--qr-size)]"); // del ancho EXACTO del QR (misma variable), no más grande
  });

  it("la barra SIGUE AL SERVIDOR (no al dispositivo): a +3 s del intervalo va al 70 % y baja con el tiempo", async () => {
    renderScreen();
    await advance(20);
    expect(progressWidth()).toBeCloseTo(70, 0);
    await advance(2_000);
    expect(progressWidth()).toBeCloseTo(50, 0);
  });

  it("aunque el reloj del dispositivo salte años, la barra y el QR siguen la hora del servidor", async () => {
    renderScreen();
    await advance(20);
    const before = shownToken();
    vi.setSystemTime(new Date("1999-01-01T00:00:00Z")); // el teléfono cambia de hora
    await advance(2_000);
    expect(progressWidth()).toBeCloseTo(50, 0);
    expect(shownToken()).toBe(before);
    vi.setSystemTime(new Date("2099-01-01T00:00:00Z"));
    await advance(3_000);
    expect(progressWidth()).toBeCloseTo(20, 0);
    expect(valid(shownToken())).toBe(true);
  });

  it("sin administrador conocido no imprime 'Started by'", async () => {
    renderScreen({ startedBy: null });
    await advance(20);
    expect(screen.queryByText(/Started by/)).toBeNull();
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  it("no muestra ubicación (New Session ya no la pide)", async () => {
    renderScreen();
    await advance(20);
    expect(document.body.textContent).not.toMatch(/location/i);
  });

  it("ROTA cada 10 s: en el límite pasa al token siguiente y después pide un par nuevo al servidor", async () => {
    renderScreen();
    await advance(20);
    const first = shownToken();
    const callsBefore = srv.qrCalls;

    await advance(7_000); // cruza el límite del intervalo (+10 s de servidor)
    const second = shownToken();
    expect(second).not.toBe(first);
    expect(valid(second)).toBe(true);
    expect(srv.qrCalls).toBe(callsBefore); // el cambio de QR es local: no esperó a la red

    await advance(2_500); // 2 s después del límite se pide el siguiente par
    expect(srv.qrCalls).toBeGreaterThan(callsBefore);
  });

  it("durante 90 s el QR dibujado SIEMPRE es uno que el servidor aceptaría en ese instante", async () => {
    renderScreen();
    await advance(20);
    const seen = new Set<string>();
    for (let s = 0; s < 90; s++) {
      await advance(1_000);
      const token = shownToken();
      expect(token, `t=${s}s`).not.toBeNull();
      expect(valid(token), `t=${s}s`).toBe(true);
      seen.add(token as string);
    }
    expect(seen.size).toBeGreaterThanOrEqual(9); // ~9–10 QR distintos en 90 s (uno cada 10 s)
  });
});

describe("fondo con imagen-fondo.jpg y composición (persona visible, QR a la derecha)", () => {
  it("el fondo es la foto teñida de azul por CSS: capas decorativas DETRÁS del contenido, sin <img>, sin estilos en línea", async () => {
    const { container } = renderScreen();
    await advance(20);
    const layers = Array.from(container.querySelectorAll('[aria-hidden="true"].pointer-events-none'));
    const photo = layers.find((l) => l.className.includes("qr-photo")) as HTMLElement;
    expect(photo).toBeDefined();
    expect(photo.className).toContain("-z-10");
    expect(layers.length).toBeGreaterThanOrEqual(4); // foto + degradados (móvil y escritorio) para el tinte azul
    expect(layers.filter((l) => /bg-gradient-to-/.test(l.className)).length).toBeGreaterThanOrEqual(3);
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[style]")).toBeNull();
    expect((container.firstElementChild as HTMLElement).className).toMatch(/\bisolate\b.*\boverflow-hidden\b|\boverflow-hidden\b.*\bisolate\b/);
  });

  it("el CSS usa imagen-fondo.jpg TAL CUAL (mezcla luminosity sobre navy), encuadrada según dónde está la persona", () => {
    const rule = /\.qr-photo\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain('url("/brand/imagen-fondo.jpg")');
    expect(rule).toContain("background-blend-mode: luminosity");
    expect(rule).toContain("var(--color-navy)");
    expect(rule).toContain("background-size: cover");
    // Móvil: encuadre que deja a la persona (a ~36 % del ancho) dentro del recorte. Escritorio: foto anclada a la DERECHA.
    expect(rule).toMatch(/background-position:\s*18% 42%/);
    expect(/@media \(min-width: 64rem\)\s*\{\s*\.qr-photo\s*\{[^}]*background-position:\s*100% 40%/.test(css)).toBe(true);
  });

  it("NO se voltea ni se refleja la foto (el rótulo de la lancha saldría al revés): la persona se queda a la izquierda", () => {
    const source = readFileSync("src/components/admin/QrScreen.tsx", "utf8") + css;
    expect(source).not.toMatch(/scale-x-\[?-|-scale-x|scaleX\(-1\)|scale\(-1|rotate-y|mirror/i);
  });

  it("escritorio: el QR va lo más a la DERECHA; Attendance y el título quedan en la columna IZQUIERDA (Attendance encima del título)", async () => {
    renderScreen();
    await advance(20);
    const qrSection = screen.getByTestId("qr").closest("section") as HTMLElement;
    expect(qrSection.className).toContain("lg:col-start-2");
    expect(qrSection.className).toContain("lg:items-end"); // pegado al borde derecho del área segura
    expect(qrSection.className).toContain("lg:self-center");
    const heading = screen.getByRole("heading", { level: 1 });
    expect((heading.parentElement as HTMLElement).className).toContain("lg:col-start-1");
    expect((heading.parentElement as HTMLElement).className).toContain("lg:self-end");
    const status = screen.getByText("Active").closest("div") as HTMLElement;
    expect(status.className).toContain("lg:col-start-1");
    const panel = screen.getByRole("heading", { name: "Attendance" }).closest("section") as HTMLElement;
    expect(panel.className).toContain("lg:col-start-1");
    expect(panel.className).toContain("lg:row-start-2"); // fila del título: row-start-3
    expect((heading.parentElement as HTMLElement).className).toContain("lg:row-start-3");
    // Solo dos columnas: la izquierda (persona, Attendance, título) recibe el resto y la del QR tiene ancho propio.
    const main = screen.getByRole("main");
    expect(main.className).toContain("lg:grid-cols-[minmax(0,1fr)_var(--qr-w)]");
  });

  it("jerarquía visual (también en móvil): logos → Attendance → título → QR, y @asceconcretecanoe al final a la derecha", async () => {
    const { container } = renderScreen();
    await advance(20);
    const before = (a: Node, b: Node) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
    const logos = container.querySelector("header") as HTMLElement;
    const panel = screen.getByRole("heading", { name: "Attendance" }).closest("section") as HTMLElement;
    const heading = screen.getByRole("heading", { level: 1 });
    const qrSection = screen.getByTestId("qr").closest("section") as HTMLElement;
    expect(before(logos, panel)).toBe(true);
    expect(before(panel, heading)).toBe(true);
    expect(before(heading, qrSection)).toBe(true);
    const insta = screen.getByRole("link", { name: /@asceconcretecanoe/ });
    expect(insta).toHaveAttribute("href", "https://www.instagram.com/asceconcretecanoe/");
    expect(insta).toHaveAttribute("rel", expect.stringContaining("noopener"));
    expect(before(qrSection, insta)).toBe(true);
    expect((insta.parentElement as HTMLElement).className).toContain("justify-end");
  });

  it("móvil: la foto es un banner arriba y Attendance, el título y el QR empiezan debajo de la cintura de la persona", async () => {
    const { container } = renderScreen();
    await advance(20);
    const photo = container.querySelector(".qr-photo") as HTMLElement;
    expect(photo.className).toContain("h-[46dvh]");
    expect(photo.className).toContain("lg:inset-0"); // en escritorio ocupa toda la pantalla
    // Attendance es el primer bloque bajo el banner: su margen superior deja libre a la persona; en escritorio no hay margen.
    const panel = screen.getByRole("heading", { name: "Attendance" }).closest("section") as HTMLElement;
    expect(panel.className).toContain("mt-[25dvh]");
    expect(panel.className).toContain("lg:mt-0");
  });

  it("legibilidad: el QR conserva su placa BLANCA, negro sobre blanco, zona de silencio y nivel de corrección M (no depende de la foto)", async () => {
    renderScreen();
    await advance(20);
    const plate = screen.getByTestId("qr").parentElement as HTMLElement;
    expect(plate.className).toContain("bg-white");
    expect(plate.className).toContain("p-3");
    const source = readFileSync("src/components/admin/QrScreen.tsx", "utf8");
    expect(source).toMatch(/level="M"/);
    expect(source).toMatch(/marginSize=\{4\}/);
    expect(source).toMatch(/bgColor="#ffffff"/);
    expect(source).toMatch(/fgColor="#000000"/);
  });

  it("sigue siendo el mismo QR dinámico: rota cada 10 s y el título, 'Active' y 'Started by' se ven", async () => {
    renderScreen();
    await advance(20);
    const first = shownToken();
    expect(valid(first)).toBe(true);
    expect(screen.getByRole("heading", { level: 1, name: "Concrete Canoe Practice" })).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Started by Lesley")).toBeInTheDocument();
    await advance(10_500);
    expect(valid(shownToken())).toBe(true);
    expect(shownToken()).not.toBe(first);
  });
});

describe("QR obsoleto, sin conexión y recuperación (NUNCA se muestra un QR viejo)", () => {
  it("si el servidor deja de responder, el QR se OCULTA y se explica; al volver la red reaparece uno NUEVO", async () => {
    renderScreen();
    await advance(20);
    const stale = shownToken();
    srv.down = true;

    await advance(9_500); // pasan más de 8 s sin ninguna respuesta correcta
    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getAllByText(/Connection lost/).length).toBeGreaterThan(0);
    expect(screen.getByText("Connection lost — retrying…")).toBeInTheDocument();

    srv.down = false;
    await advance(3_000);
    const fresh = shownToken();
    expect(fresh).not.toBeNull();
    expect(fresh).not.toBe(stale);
    expect(valid(fresh)).toBe(true);
  });

  it("sin conexión NUNCA se dibuja un token cuya ventana ya pasó, aunque el reloj monótono siga corriendo", async () => {
    renderScreen();
    await advance(20);
    srv.down = true;
    for (let s = 0; s < 40; s++) {
      await advance(1_000);
      const token = shownToken();
      if (token !== null) expect(valid(token), `t=${s}s`).toBe(true); // si hay QR, es uno vigente
    }
    expect(screen.queryByTestId("qr")).toBeNull();
  });

  it("al VOLVER a la pestaña se descarta el QR guardado y solo se muestra uno pedido de nuevo al servidor", async () => {
    renderScreen();
    await advance(20);
    expect(shownToken()).not.toBeNull();

    let release!: () => void;
    srv.hold = new Promise<void>((resolve) => (release = resolve)); // el servidor tarda en responder
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange")); // jsdom: visibilityState = "visible"
      await vi.advanceTimersByTimeAsync(10);
    });
    expect(screen.queryByTestId("qr")).toBeNull(); // mientras no llegue estado FRESCO, nada

    srv.hold = null;
    release();
    await advance(20);
    expect(valid(shownToken())).toBe(true);
  });

  it("al recuperar la red (evento online) pide estado fresco", async () => {
    renderScreen();
    await advance(20);
    const calls = srv.qrCalls;
    await act(async () => {
      window.dispatchEvent(new Event("online"));
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(srv.qrCalls).toBeGreaterThan(calls);
    expect(valid(shownToken())).toBe(true);
  });

  it("sesión de administrador caducada (401): no hay QR y se ofrece iniciar sesión de nuevo", async () => {
    renderScreen();
    await advance(20);
    srv.unauthorized = true;
    await advance(4_000);
    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByText("Your sign-in expired")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Sign in again" })).toHaveAttribute("href", `/admin/login?next=/admin/sessions/${SESSION_A}/qr`);
  });
});

describe("cerrar la sesión", () => {
  it("cerrada en OTRA pestaña: el siguiente sondeo (≤ 3 s) quita el QR y no se vuelve a pedir ninguno", async () => {
    renderScreen();
    await advance(20);
    expect(screen.getByTestId("qr")).toBeInTheDocument();

    srv.status = "closed";
    await advance(3_200);
    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByText("Check-in closed", { selector: "p.text-lg" })).toBeInTheDocument();
    expect(screen.getByText("This QR code is no longer accepted.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Close check-in" })).toBeNull();

    const calls = srv.qrCalls;
    await advance(30_000);
    expect(srv.qrCalls).toBe(calls);
  });

  it("ELIMINADA (otra pestaña o 'Delete Session'): las APIs responden 404 y el QR desaparece; no se sigue pidiendo ninguno", async () => {
    renderScreen();
    await advance(20);
    expect(screen.getByTestId("qr")).toBeInTheDocument();

    srv.deleted = true;
    await advance(3_200);
    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByText("Check-in closed", { selector: "p.text-lg" })).toBeInTheDocument();
    expect(screen.getByText("This QR code is no longer accepted.")).toBeInTheDocument();

    const calls = srv.qrCalls;
    await advance(30_000);
    expect(srv.qrCalls).toBe(calls);
  });

  it("'Close check-in' pide confirmación y, al confirmar, el QR desaparece AL INSTANTE (sin esperar al sondeo)", async () => {
    renderScreen();
    await advance(20);
    // (fireEvent y no userEvent: userEvent espera con temporizadores que aquí están falsos.)
    fireEvent.click(screen.getByRole("button", { name: "Close check-in" }));
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    expect(dialog).toHaveTextContent("Closing is final");
    expect(closeAction).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Close check-in" }));
    await advance(20);
    expect(closeAction).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByText("Check-in closed", { selector: "p.text-lg" })).toBeInTheDocument();
  });

  it("una sesión que ya llega cerrada no pide ningún QR", async () => {
    srv.status = "closed";
    renderScreen({ initialStatus: "closed" });
    await advance(10_000);
    expect(srv.qrCalls).toBe(0);
    expect(screen.queryByTestId("qr")).toBeNull();
    expect(screen.getByText("Check-in closed", { selector: "p.text-lg" })).toBeInTheDocument();
  });
});

describe("asistencia en vivo", () => {
  it("muestra 'Attendance', el conteo y los asistentes con nombre, cargo y hora — nunca PIN ni credenciales", () => {
    renderScreen();
    expect(screen.getByRole("heading", { name: "Attendance" })).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText(/\/ 25/)).toBeInTheDocument();
    expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
    expect(screen.getByText("Safety Officer")).toBeInTheDocument();
    expect(screen.getByText("6:10 PM")).toBeInTheDocument(); // 00:10Z = 18:10 MDT, hora de El Paso
    expect(document.body.textContent).not.toMatch(/pin|scrypt|ticket|asce id/i);
  });

  it("se actualiza cada ~3 s con lo que devuelve el servidor", async () => {
    renderScreen({ initialLive: { count: 0, total: 25, attendees: [] } });
    expect(screen.getByText("No one has checked in yet.")).toBeInTheDocument();
    const before = srv.liveCalls;

    await advance(3_100);
    expect(srv.liveCalls).toBeGreaterThan(before);
    expect(screen.getByText("Maria Lopez")).toBeInTheDocument();
    expect(screen.getByText("John Smith")).toBeInTheDocument();

    srv.attendees = [{ id: "c3", name: "Alex Johnson", position: "Project Manager", checkedInAt: "2026-09-20T00:20:00Z" }, ...PEOPLE];
    await advance(3_100);
    expect(screen.getByText("Alex Johnson")).toBeInTheDocument();
    expect(screen.getByText("Project Manager")).toBeInTheDocument();
  });

  it("la cadencia es de 3 s (ni más rápido ni mucho más lento)", async () => {
    renderScreen();
    await advance(20);
    const start = srv.liveCalls;
    await advance(9_000);
    expect(srv.liveCalls - start).toBeGreaterThanOrEqual(2);
    expect(srv.liveCalls - start).toBeLessThanOrEqual(4);
  });
});

describe("Wake Lock (mantener la pantalla encendida)", () => {
  function installWakeLock() {
    const sentinel = { released: false, release: vi.fn(async () => void (sentinel.released = true)), addEventListener: vi.fn() };
    const request = vi.fn(async () => sentinel);
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    return { sentinel, request };
  }

  it("lo pide al abrir, lo vuelve a pedir al volver a la pestaña y lo libera al salir", async () => {
    const { sentinel, request } = installWakeLock();
    const view = renderScreen();
    await advance(20);
    expect(request).toHaveBeenCalledWith("screen");
    expect(request).toHaveBeenCalledTimes(1);

    sentinel.released = true; // el sistema lo libera al ocultar la pestaña
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(20);
    });
    expect(request.mock.calls.length).toBeGreaterThanOrEqual(2);

    view.unmount();
    expect(sentinel.release).toHaveBeenCalled();
  });

  it("si Wake Lock no existe, todo funciona igual (sin errores)", async () => {
    renderScreen();
    await advance(20);
    expect(valid(shownToken())).toBe(true);
  });

  it("si el navegador DENIEGA el permiso, la pantalla sigue funcionando", async () => {
    const request = vi.fn(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    Object.defineProperty(navigator, "wakeLock", { value: { request }, configurable: true });
    renderScreen();
    await advance(20);
    expect(request).toHaveBeenCalled();
    expect(valid(shownToken())).toBe(true);
  });

  it("una sesión cerrada no pide mantener la pantalla encendida", async () => {
    const { request } = installWakeLock();
    renderScreen({ initialStatus: "closed" });
    await advance(20);
    expect(request).not.toHaveBeenCalled();
  });
});

describe("diseño para iPhone", () => {
  it("el QR es un cuadrado grande que escala con el ancho de pantalla, con zonas seguras y volver a la sesión", async () => {
    const { container } = renderScreen();
    await advance(20);
    const card = screen.getByTestId("qr").parentElement as HTMLElement;
    expect(card.className).toContain("aspect-square");
    expect(card.className).toContain("w-[var(--qr-size)]");
    // El tamaño lo fija UNA variable: móvil min(84vw, 38dvh) (grande y sin cortarse); escritorio hasta 32rem y como máximo el 66 % del alto.
    const section = card.parentElement as HTMLElement;
    expect(section.className).toContain("[--qr-size:min(84vw,38dvh)]");
    expect(section.className).toContain("lg:[--qr-size:min(var(--qr-w),66dvh)]");
    expect(screen.getByTestId("qr").getAttribute("class")).toContain("w-full");
    expect((container.firstElementChild as HTMLElement).className).toContain("env(safe-area-inset-bottom)");
    expect(screen.getByRole("link", { name: "Back to session" })).toHaveAttribute("href", `/admin/sessions/${SESSION_A}`);
    expect(container.querySelector("[style]")).toBeNull(); // la CSP de producción no admite estilos en línea
  });
});
