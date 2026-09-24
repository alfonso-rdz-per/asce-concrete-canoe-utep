import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BrandMarkView } from "@/components/brand/BrandMarkView";
import { INSTAGRAM_URL, SiteFooter } from "@/components/brand/SiteFooter";
import { AuthSettingsWarning } from "@/components/admin/AuthSettingsWarning";
import { BRAND_ASSET_FILES, brandLogoSrc } from "@/lib/brand/assets";

describe("BrandMark: ASCE | UTEP", () => {
  it("sin logos oficiales muestra marcadores claramente rotulados, en orden ASCE | UTEP", () => {
    render(<BrandMarkView asceSrc={null} utepSrc={null} tone="onDark" />);
    const marks = screen.getAllByRole("img");
    expect(marks.map((m) => m.textContent)).toEqual(["[ASCE logo]", "[UTEP logo]"]);
    expect(marks[0]).toHaveAccessibleName("ASCE logo placeholder");
    expect(marks[1]).toHaveAccessibleName("UTEP logo placeholder");
  });

  it("con los archivos oficiales usa las imágenes (sin rediseñar nada) y ya no hay marcadores", () => {
    render(<BrandMarkView asceSrc="/brand/asce-logo-white.svg" utepSrc="/brand/utep-logo-white.svg" tone="onDark" />);
    const [asce, utep] = screen.getAllByRole("img");
    expect(asce).toHaveAttribute("src", "/brand/asce-logo-white.svg");
    expect(asce).toHaveAttribute("alt", "ASCE");
    expect(utep).toHaveAttribute("src", "/brand/utep-logo-white.svg");
    expect(utep).toHaveAttribute("alt", "UTEP");
    expect(screen.queryByText(/logo\]/)).toBeNull();
  });

  it("acepta un logo y un marcador a la vez (p. ej. solo llegó el de ASCE)", () => {
    render(<BrandMarkView asceSrc="/brand/asce-logo.svg" utepSrc={null} tone="onLight" />);
    expect(screen.getByAltText("ASCE")).toBeInTheDocument();
    expect(screen.getByText("[UTEP logo]")).toBeInTheDocument();
  });

  it("el separador es decorativo (no lo leen los lectores de pantalla)", () => {
    const { container } = render(<BrandMarkView asceSrc={null} utepSrc={null} tone="onLight" />);
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });

  it("los nombres de archivo son los que el equipo colocó en public/brand/ (PNG de ASCE, SVG de UTEP sobre claro, PNG de UTEP sobre oscuro)", () => {
    expect(BRAND_ASSET_FILES).toEqual({
      asce: { onLight: "asce-logo.png", onDark: "asce-logo-white.png" },
      utep: { onLight: "utep-logo.svg", onDark: "utep-logo-white.png" },
    });
  });

  it("los cuatro archivos existen en public/brand/: brandLogoSrc devuelve su ruta pública", () => {
    for (const brand of ["asce", "utep"] as const) {
      for (const tone of ["onLight", "onDark"] as const) expect(brandLogoSrc(brand, tone)).toBe(`/brand/${BRAND_ASSET_FILES[brand][tone]}`);
    }
  });
});

describe("SiteFooter", () => {
  it("muestra ASCE | UTEP e Instagram · @asceconcretecanoe con el enlace EXACTO", () => {
    render(<SiteFooter />);
    const footer = screen.getByRole("contentinfo");
    expect(within(footer).getByAltText("ASCE")).toHaveAttribute("src", "/brand/asce-logo.png");
    expect(within(footer).getByAltText("UTEP")).toHaveAttribute("src", "/brand/utep-logo.svg");

    const link = within(footer).getByRole("link", { name: /Instagram · @asceconcretecanoe/ });
    expect(INSTAGRAM_URL).toBe("https://www.instagram.com/asceconcretecanoe/");
    expect(link).toHaveAttribute("href", "https://www.instagram.com/asceconcretecanoe/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link.getAttribute("rel")).toMatch(/noopener/);
    expect(link.getAttribute("rel")).toMatch(/noreferrer/);
    expect(link).toHaveAccessibleName(/opens in a new tab/i);
  });

  it("queda al final de la página (mt-auto) y respeta el área segura de iPhone", () => {
    render(<SiteFooter />);
    const footer = screen.getByRole("contentinfo");
    expect(footer.className).toContain("mt-auto");
    expect(footer.innerHTML).toContain("safe-area-inset-bottom");
  });

  it("es discreto: un solo enlace, sin botones", () => {
    render(<SiteFooter />);
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

describe("Aviso de configuración de Supabase Auth", () => {
  it("no muestra nada si todo está bien o si no se pudo comprobar", () => {
    const { container, rerender } = render(<AuthSettingsWarning problems={[]} />);
    expect(container).toBeEmptyDOMElement();
    rerender(<AuthSettingsWarning problems={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("si el registro público está abierto, avisa (en inglés) como alerta", () => {
    render(
      <AuthSettingsWarning
        problems={[
          { code: "signup_enabled", message: "Public sign-ups are enabled in Supabase. Every new account would become an administrator." },
          { code: "oauth_provider_enabled", provider: "github", message: 'The "github" sign-in provider is enabled in Supabase and is not authorized.' },
        ]}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Security warning");
    expect(alert).toHaveTextContent("Public sign-ups are enabled");
    expect(alert).toHaveTextContent("github");
    expect(alert).toHaveTextContent("Every Supabase Auth user is an administrator");
  });
});
