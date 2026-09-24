import type { Brand, Tone } from "@/lib/brand/assets";

/**
 * Presentación pura de `ASCE | UTEP`. No sabe si los archivos de logo existen: recibe la ruta
 * (o null). Sin logo oficial se muestra un MARCADOR rotulado (`[ASCE logo]`); nunca se dibuja ni se
 * inventa un logo.
 */
export type BrandSize = "sm" | "md" | "lg";

const IMG_HEIGHT: Record<BrandSize, string> = { sm: "h-6", md: "h-8", lg: "h-11" };
const PLACEHOLDER_SIZE: Record<BrandSize, string> = {
  sm: "px-2 py-0.5 text-[0.7rem]",
  md: "px-2.5 py-1 text-xs",
  lg: "px-3 py-1.5 text-sm",
};
const BRAND_LABEL: Record<Brand, string> = { asce: "ASCE", utep: "UTEP" };

export function LogoSlot({ brand, tone, src, size }: { brand: Brand; tone: Tone; src: string | null; size: BrandSize }) {
  const label = BRAND_LABEL[brand];

  if (src) {
    // eslint-disable-next-line @next/next/no-img-element -- logos SVG oficiales de tamaño intrínseco desconocido
    return <img src={src} alt={label} className={`${IMG_HEIGHT[size]} w-auto`} />;
  }

  const colors = tone === "onDark" ? "border-white/60 text-white" : "border-navy/50 text-navy";
  return (
    <span
      role="img"
      aria-label={`${label} logo placeholder`}
      className={`inline-flex items-center whitespace-nowrap rounded border border-dashed font-semibold tracking-wide ${colors} ${PLACEHOLDER_SIZE[size]}`}
    >
      [{label} logo]
    </span>
  );
}

export function BrandMarkView({
  asceSrc,
  utepSrc,
  tone,
  size = "md",
  className = "",
}: {
  asceSrc: string | null;
  utepSrc: string | null;
  tone: Tone;
  size?: BrandSize;
  className?: string;
}) {
  const divider = tone === "onDark" ? "bg-white/50" : "bg-navy/30";
  const dividerHeight = size === "lg" ? "h-9" : size === "md" ? "h-7" : "h-5";
  return (
    <div className={`inline-flex items-center gap-3 ${className}`} data-testid="brand-mark">
      <LogoSlot brand="asce" tone={tone} src={asceSrc} size={size} />
      <span aria-hidden="true" className={`w-px ${dividerHeight} ${divider}`} />
      <LogoSlot brand="utep" tone={tone} src={utepSrc} size={size} />
    </div>
  );
}
