/**
 * Imágenes de marca del hero: `canoe-draw.png` (ilustración de la canoa, el PNG aportado por el equipo) e `imagen-fondo.jpg` (foto
 * de fondo, teñida de azul por CSS sin tocar el archivo). Se comprueba que los archivos existen y son válidos, que la ilustración se
 * sirve TAL CUAL (sin recodificar ni deformar) y que la foto se integra con CSS (mezcla + degradados), no como un rectángulo pegado.
 */
import { render, screen } from "@testing-library/react";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CanoeBand, HeroBackdrop } from "@/components/brand/Hero";

const ROOT = process.cwd();
const brand = (file: string) => path.join(ROOT, "public", "brand", file);
const css = readFileSync(path.join(ROOT, "src", "app", "globals.css"), "utf8");

describe("archivos aportados por el equipo", () => {
  it("canoe-draw.png existe, es un PNG de 1023×700 con transparencia y no está vacío", () => {
    const b = readFileSync(brand("canoe-draw.png"));
    expect([...b.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect([b.readUInt32BE(16), b.readUInt32BE(20)]).toEqual([1023, 700]);
    expect(b[25]).toBe(6); // RGBA: fondo transparente
    expect(statSync(brand("canoe-draw.png")).size).toBeGreaterThan(10_000);
  });

  it("imagen-fondo.jpg existe y es una imagen válida (el archivo aportado es en realidad WebP con extensión .jpg: los navegadores lo detectan solos)", () => {
    const b = readFileSync(brand("imagen-fondo.jpg"));
    const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const isWebp = b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP";
    expect(isJpeg || isWebp).toBe(true);
    expect(statSync(brand("imagen-fondo.jpg")).size).toBeGreaterThan(10_000);
  });
});

describe("canoe-draw.png (reemplaza la ilustración dibujada)", () => {
  it("se muestra el PNG exacto: sin recodificar (no pasa por /_next/image), sin estilos en línea (CSP), decorativo y con su proporción 1023×700", () => {
    render(<CanoeBand />);
    const img = screen.getByTestId("canoe-illustration") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/brand/canoe-draw.png");
    expect(img.getAttribute("src")).not.toContain("_next/image");
    expect(img).toHaveAttribute("alt", "");
    expect(img).toHaveAttribute("width", "1023");
    expect(img).toHaveAttribute("height", "700");
    expect(img).toHaveAttribute("loading", "eager");
    expect(img.getAttribute("style")).toBeNull(); // next/image añadía style="color:transparent", que la CSP de producción bloquea
    expect(img).not.toHaveAttribute("data-nimg");
  });

  it("ninguna imagen del equipo usa next/image (inyecta estilos en línea que la CSP bloquea)", () => {
    for (const f of ["src/components/brand/Hero.tsx", "src/components/admin/StartCheckInCard.tsx"]) {
      expect(readFileSync(path.join(ROOT, f), "utf8"), f).not.toMatch(/from ["']next\/image["']/);
    }
  });

  it("no se deforma: el alto es automático y el ancho responsive (más pequeño en móvil, más grande en pantallas anchas)", () => {
    render(<CanoeBand />);
    const cls = (screen.getByTestId("canoe-illustration") as HTMLImageElement).className;
    expect(cls).toContain("h-auto");
    expect(cls).toMatch(/\bw-44\b/);
    expect(cls).toMatch(/sm:w-64/);
    expect(cls).not.toMatch(/object-cover|object-fill|\bh-\d/); // nada que estire o recorte la imagen
  });

  it("se apoya en una franja CLARA (sus trazos azules no se verían sobre el navy) y no queda ninguna ilustración SVG antigua", () => {
    const { container } = render(<CanoeBand />);
    expect(container.firstElementChild?.className).toContain("bg-surface");
    expect(container.querySelector("svg")).toBeNull();
  });
});

describe("imagen-fondo.jpg (fondo azul del hero)", () => {
  it("la foto se aplica por CSS como fondo (no como <img> pegada) y con capas decorativas aria-hidden", () => {
    const { container } = render(
      <div className="relative isolate overflow-hidden bg-navy">
        <HeroBackdrop />
      </div>,
    );
    expect(container.querySelector("img")).toBeNull();
    const layers = Array.from(container.querySelectorAll('[aria-hidden="true"]'));
    expect(layers).toHaveLength(3);
    expect(layers[0].className).toContain("hero-photo");
    for (const l of layers) {
      expect(l.className).toContain("-z-10"); // DETRÁS del contenido
      expect(l.className).toContain("pointer-events-none");
      expect(l.getAttribute("style")).toBeNull(); // sin estilos en línea (CSP)
    }
  });

  it("el CSS tiñe la foto de azul con mezcla de fondo 'luminosity' sobre navy y usa el archivo original tal cual", () => {
    const rule = /\.hero-photo\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(rule).toContain('url("/brand/imagen-fondo.jpg")');
    expect(rule).toContain("background-blend-mode: luminosity");
    expect(rule).toContain("var(--color-navy)");
    expect(rule).toContain("background-size: cover"); // responsive: cubre el contenedor sin deformar
  });

  it("legibilidad: degradado navy más opaco a la izquierda (texto) y fundido con el navy abajo (olas)", () => {
    const { container } = render(<HeroBackdrop />);
    const cls = Array.from(container.children).map((c) => c.className);
    expect(cls[1]).toMatch(/bg-gradient-to-r.*from-navy.*via-navy\/85/);
    expect(cls[2]).toMatch(/bg-gradient-to-t.*from-navy/);
  });
});

describe("las páginas del estudiante usan las imágenes (y no la ilustración antigua)", () => {
  const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
  it("portada y check-in usan HeroBackdrop + CanoeBand y ya no importan CanoeMark", () => {
    for (const f of ["src/app/(public)/page.tsx", "src/app/(public)/c/[token]/page.tsx"]) {
      const text = read(f);
      expect(text, f).toContain("<HeroBackdrop />");
      expect(text, f).toContain("<CanoeBand />");
      expect(text, f).not.toContain("CanoeMark");
    }
    expect(read("src/components/brand/Shapes.tsx")).not.toContain("CanoeMark");
  });

  it("la tarjeta 'Start Check-In' del panel usa el mismo PNG (como marca de agua) y no hay ningún otro dibujo de canoa", () => {
    const text = read("src/components/admin/StartCheckInCard.tsx");
    expect(text).toContain("/brand/canoe-draw.png");
    expect(text).not.toContain("CanoeMark");
  });
});
