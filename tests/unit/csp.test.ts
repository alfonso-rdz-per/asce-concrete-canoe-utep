import { describe, expect, it } from "vitest";
import { buildCsp } from "@/lib/csp";

const directive = (csp: string, name: string) =>
  csp
    .split(";")
    .map((d) => d.trim())
    .find((d) => d.startsWith(`${name} `) || d === name);

describe("Content-Security-Policy (producción)", () => {
  const csp = buildCsp({ nonce: "NONCE123", isDev: false });

  it("scripts: solo 'self' + nonce + strict-dynamic; nunca unsafe-inline ni unsafe-eval", () => {
    expect(directive(csp, "script-src")).toBe("script-src 'self' 'nonce-NONCE123' 'strict-dynamic'");
  });

  it("estilos: 'self' + nonce (sin unsafe-inline)", () => {
    expect(directive(csp, "style-src")).toBe("style-src 'self' 'nonce-NONCE123'");
  });

  it("el navegador solo habla con NUESTRO origen (no hay cliente de Supabase en el navegador)", () => {
    expect(directive(csp, "connect-src")).toBe("connect-src 'self'");
    expect(directive(csp, "default-src")).toBe("default-src 'self'");
    expect(directive(csp, "font-src")).toBe("font-src 'self'");
    expect(directive(csp, "img-src")).toBe("img-src 'self' data:");
  });

  it("bloquea objetos, frames y bases/acciones externas", () => {
    expect(directive(csp, "object-src")).toBe("object-src 'none'");
    expect(directive(csp, "frame-ancestors")).toBe("frame-ancestors 'none'");
    expect(directive(csp, "base-uri")).toBe("base-uri 'self'");
    expect(directive(csp, "form-action")).toBe("form-action 'self'");
  });

  it("no contiene comodines ni orígenes externos ni http:", () => {
    expect(csp).not.toMatch(/\*/);
    expect(csp).not.toMatch(/https?:/);
    expect(csp).not.toContain("unsafe-inline");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).not.toMatch(/ws:|wss:/);
  });

  it("cada nonce produce una política distinta", () => {
    expect(buildCsp({ nonce: "A", isDev: false })).not.toBe(buildCsp({ nonce: "B", isDev: false }));
  });
});

describe("Content-Security-Policy (desarrollo)", () => {
  it("permite lo que necesita el HMR y solo en desarrollo", () => {
    const dev = buildCsp({ nonce: "N", isDev: true });
    expect(directive(dev, "script-src")).toContain("'unsafe-eval'");
    expect(directive(dev, "connect-src")).toContain("ws:");
    expect(directive(dev, "style-src")).toContain("'unsafe-inline'");
    expect(directive(dev, "frame-ancestors")).toBe("frame-ancestors 'none'");
  });
});
