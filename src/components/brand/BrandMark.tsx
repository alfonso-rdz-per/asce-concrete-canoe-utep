import { BrandMarkView, type BrandSize } from "@/components/brand/BrandMarkView";
import { brandLogoSrc, type Tone } from "@/lib/brand/assets";

/**
 * ÚNICO lugar de la aplicación donde aparece la marca: `ASCE | UTEP`.
 * Cuando existan los archivos oficiales en `public/brand/` (asce-logo.svg, asce-logo-white.svg,
 * utep-logo.svg, utep-logo-white.svg) se usan solos; hasta entonces se muestran marcadores.
 */
export function BrandMark({ tone, size, className }: { tone: Tone; size?: BrandSize; className?: string }) {
  return (
    <BrandMarkView
      asceSrc={brandLogoSrc("asce", tone)}
      utepSrc={brandLogoSrc("utep", tone)}
      tone={tone}
      size={size}
      className={className}
    />
  );
}
