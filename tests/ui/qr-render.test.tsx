/**
 * La librería REAL `qrcode.react`: se dibuja como SVG (nunca un canvas enorme), escala con CSS, no usa estilos en línea
 * (la CSP de producción los bloquea) y siempre es negro sobre blanco con margen de silencio.
 */
import { render } from "@testing-library/react";
import { QRCodeSVG } from "qrcode.react";
import { describe, expect, it } from "vitest";
import { deriveKey } from "@/lib/crypto/keys";
import { qrUrl } from "@/lib/qr-display";
import { issueQrToken } from "@/lib/tokens";
import { SESSION_A, T0 } from "../helpers/clock";

const KEY = deriveKey("secreto-de-servidor-para-pruebas-0123456789", "qr");
const url = qrUrl("https://asce.example.org", issueQrToken({ key: KEY, sessionId: SESSION_A, slot: T0 / 10_000 }));

describe("qrcode.react (SVG)", () => {
  it("produce un <svg> con viewBox (escalable), sin <canvas> y sin estilos en línea", () => {
    const { container } = render(<QRCodeSVG value={url} level="M" marginSize={4} size={256} className="h-full w-full" title="Check-in QR code" />);
    const svg = container.querySelector("svg");
    expect(svg).not.toBeNull();
    expect(container.querySelector("canvas")).toBeNull();
    expect(svg?.getAttribute("viewBox")).toMatch(/^0 0 \d+ \d+$/);
    expect(svg?.getAttribute("class")).toBe("h-full w-full");
    expect(container.querySelector("[style]")).toBeNull();
    expect(svg?.querySelector("title")?.textContent).toBe("Check-in QR code");
  });

  it("negro sobre blanco con margen de silencio de 4 módulos: el viewBox incluye el margen", () => {
    const withMargin = render(<QRCodeSVG value={url} level="M" marginSize={4} bgColor="#ffffff" fgColor="#000000" />).container.querySelector("svg");
    const noMargin = render(<QRCodeSVG value={url} level="M" marginSize={0} />).container.querySelector("svg");
    const side = (svg: SVGElement | null) => Number(svg?.getAttribute("viewBox")?.split(" ")[2]);
    expect(side(withMargin) - side(noMargin)).toBe(8);
    expect(withMargin?.innerHTML).toContain("#000000");
    expect(withMargin?.innerHTML).toContain("#ffffff");
  });

  it("el contenido (~80 caracteres) cabe en un QR de baja densidad (fácil de escanear a distancia)", () => {
    expect(url.length).toBeLessThan(100);
    const { container } = render(<QRCodeSVG value={url} level="M" marginSize={0} />);
    const modules = Number(container.querySelector("svg")?.getAttribute("viewBox")?.split(" ")[2]);
    expect(modules).toBeLessThanOrEqual(45); // versión ≤ 6 con nivel M
  });
});
