import "server-only";
import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Logos oficiales en `public/brand/` (formatos tal como los aportó el equipo):
 *   asce-logo.png · asce-logo-white.png · utep-logo.svg · utep-logo-white.png
 * Si alguno falta, se muestra un marcador rotulado (`[ASCE logo]`); nunca se inventa un logo.
 */
export type Brand = "asce" | "utep";
/** `onLight` = logo normal sobre fondo claro; `onDark` = versión blanca sobre fondo oscuro. */
export type Tone = "onLight" | "onDark";

export const BRAND_ASSET_FILES: Record<Brand, Record<Tone, string>> = {
  asce: { onLight: "asce-logo.png", onDark: "asce-logo-white.png" },
  utep: { onLight: "utep-logo.svg", onDark: "utep-logo-white.png" },
};

/** Ruta pública del logo si el archivo existe; `null` si todavía no se ha aportado. */
export function brandLogoSrc(brand: Brand, tone: Tone): string | null {
  const file = BRAND_ASSET_FILES[brand][tone];
  return existsSync(path.join(process.cwd(), "public", "brand", file)) ? `/brand/${file}` : null;
}
