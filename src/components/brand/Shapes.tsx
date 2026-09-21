/**
 * Olas decorativas (vector original, no copiado de la referencia). La ilustración de la canoa es el PNG aportado por el equipo:
 * ver `Hero.tsx` (CanoeBand). Se usan con moderación (hero y pantallas de acceso). Son decorativas: aria-hidden.
 */
export function WaveDivider({ className = "" }: { className?: string }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 1440 140"
      preserveAspectRatio="none"
      className={`block h-16 w-full sm:h-24 ${className}`}
    >
      <path className="fill-ocean" d="M0 60 C220 112 420 8 660 52 S1100 112 1440 40 V140 H0 Z" />
      <path className="fill-wave" opacity="0.9" d="M0 90 C260 40 520 132 780 90 S1200 40 1440 82 V140 H0 Z" />
      <path className="fill-surface" d="M0 114 C300 84 560 140 860 108 S1260 84 1440 106 V140 H0 Z" />
    </svg>
  );
}
