/**
 * Favicon (App Router: src/app/favicon.ico, un .ico REAL sin iconos en conflicto) y tarjeta "Start Check-In" del dashboard
 * (el botón va a la izquierda y no cubre la ilustración de la derecha).
 */
import { render, screen } from "@testing-library/react";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StartCheckInCard } from "@/components/admin/StartCheckInCard";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

describe("favicon", () => {
  const ico = readFileSync(path.join(ROOT, "src/app/favicon.ico"));

  it("está donde Next.js 16 lo espera (src/app/favicon.ico) y es un .ico REAL (no un WebP/PNG renombrado)", () => {
    expect([ico.readUInt16LE(0), ico.readUInt16LE(2)]).toEqual([0, 1]); // ICONDIR: reservado 0, tipo 1 = icono
    expect(ico.subarray(0, 4).toString("latin1")).not.toBe("RIFF");
    expect(ico.length).toBeGreaterThan(1_000);
  });

  it("trae varios tamaños (16, 32, 48 y mayores), cada uno una imagen PNG válida dentro del .ico", () => {
    const count = ico.readUInt16LE(4);
    expect(count).toBeGreaterThanOrEqual(3);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const entry = 6 + i * 16;
      const w = ico[entry] || 256;
      const h = ico[entry + 1] || 256;
      expect(w).toBe(h); // cuadrados: la ilustración se encajó sin deformarla
      sizes.push(w);
      const size = ico.readUInt32LE(entry + 8);
      const offset = ico.readUInt32LE(entry + 12);
      expect(offset + size).toBeLessThanOrEqual(ico.length);
      expect(ico.subarray(offset, offset + 8).toString("hex")).toBe("89504e470d0a1a0a");
    }
    for (const s of [16, 32, 48]) expect(sizes).toContain(s);
  });

  it("NO hay otro favicon que entre en conflicto: ni public/favicon.ico, ni icon.*/apple-icon.* en la app, ni metadata.icons", () => {
    expect(existsSync(path.join(ROOT, "public/favicon.ico"))).toBe(false);
    const appFiles = readdirSync(path.join(ROOT, "src/app"));
    expect(appFiles.filter((f) => /^(icon|apple-icon|favicon)\./.test(f))).toEqual(["favicon.ico"]);
    expect(read("src/app/layout.tsx")).not.toMatch(/\bicons\b|rel="icon"|favicon/);
  });

  it("el proxy no intercepta /favicon.ico (se sirve tal cual)", () => {
    expect(read("src/proxy.ts")).toMatch(/\(\?!_next\/static\|_next\/image\|favicon\.ico\|brand\/\)/);
  });
});

describe("tarjeta Start Check-In del dashboard", () => {
  it("el botón va debajo del texto y ALINEADO A LA IZQUIERDA (no a la derecha, sobre la ilustración)", () => {
    render(<StartCheckInCard active={null} />);
    const link = screen.getByRole("link", { name: "Start Check-In" });
    expect(link).toHaveAttribute("href", "/admin/sessions/new");
    const column = link.parentElement as HTMLElement;
    expect(column.className).toContain("flex-col");
    expect(column.className).toContain("items-start");
    expect(column.className).not.toMatch(/justify-between|sm:items-end|sm:flex-row/);
    expect(link.className).not.toMatch(/\bw-full\b|sm:w-auto/); // ancho propio: no ocupa la fila hasta la ilustración
    // Deja libre la esquina de la ilustración: en móvil reserva espacio a la derecha; en pantallas anchas el texto se limita al 58 %.
    expect(column.className).toContain("pr-24");
    expect((screen.getByRole("heading", { level: 2 }).parentElement as HTMLElement).className).toContain("sm:max-w-[58%]");
  });

  it("la ilustración (canoe-draw.png) queda en la esquina inferior DERECHA, decorativa y sin que nada la tape", () => {
    render(<StartCheckInCard active={null} />);
    const img = screen.getByTestId("start-card-illustration");
    expect(img.getAttribute("src")).toBe("/brand/canoe-draw.png");
    expect(img).toHaveAttribute("aria-hidden", "true");
    expect(img.className).toMatch(/\babsolute\b/);
    expect(img.className).toMatch(/\bbottom-\S+/);
    expect(img.className).toMatch(/-?right-\S+/);
    expect(img.className).toContain("pointer-events-none");
    expect(img.className).toContain("h-auto"); // sin deformar
    // El contenido está POR ENCIMA de la marca de agua (relative) y no comparte su esquina.
    expect((screen.getByRole("link", { name: "Start Check-In" }).parentElement as HTMLElement).className).toContain("relative");
  });

  it("con un check-in en curso: 'Resume Check-In' con el mismo diseño y enlace a su pantalla del QR", () => {
    render(<StartCheckInCard active={{ id: "abc", title: "Concrete Canoe Practice" }} />);
    const link = screen.getByRole("link", { name: "Resume Check-In" });
    expect(link).toHaveAttribute("href", "/admin/sessions/abc/qr");
    expect((link.parentElement as HTMLElement).className).toContain("items-start");
    expect(screen.getByText("Check-in in progress")).toBeInTheDocument();
  });
});
