import { ArrowUpRight, Hammer, PenTool, Waves } from "lucide-react";
import type { Metadata } from "next";
import { BrandMark } from "@/components/brand/BrandMark";
import { CanoeBand, HeroBackdrop } from "@/components/brand/Hero";
import { WaveDivider } from "@/components/brand/Shapes";
import { buttonClasses } from "@/components/ui/Button";
import { INSTAGRAM_HANDLE, INSTAGRAM_URL } from "@/lib/brand/social";

export const metadata: Metadata = {
  title: { absolute: "ASCE | UTEP Concrete Canoe Team" },
  description: "Student team at the University of Texas at El Paso that designs, builds and races a canoe made of concrete. Follow us on Instagram.",
};

/**
 * Portada pública: una landing MUY corta. Solo dice quiénes somos y da el Instagram para seguirnos. No hay escáner QR interno ni entrada
 * manual de códigos: el check-in llega por /c/<token> con la cámara nativa del teléfono. Los datos (equipo estudiantil de UTEP, capítulo de ASCE,
 * diseñar / construir / competir con una canoa de concreto contra otras universidades) salen de las páginas públicas de ASCE y de ASCE El Paso;
 * no se afirma nada más (ni cifras, ni resultados, ni fechas).
 */
const WHAT_WE_DO = [
  { icon: PenTool, label: "Design" },
  { icon: Hammer, label: "Build" },
  { icon: Waves, label: "Race" },
] as const;

export default function HomePage() {
  return (
    <div className="flex flex-1 flex-col">
      <div className="on-dark relative isolate flex flex-1 flex-col overflow-hidden bg-navy text-white">
        <HeroBackdrop />
        <header className="mx-auto w-full max-w-6xl px-4 py-5 sm:px-6">
          <BrandMark tone="onDark" size="lg" />
        </header>

        <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-4 pb-10 pt-4 sm:px-6">
          <div className="max-w-2xl">
            <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky">Concrete Canoe Team</p>
            <h1 className="mt-3 text-4xl font-extrabold tracking-tight sm:text-6xl">We build canoes out of concrete.</h1>
            <p className="mt-5 max-w-xl text-lg text-white/90">
              We&apos;re the ASCE | UTEP student team at the University of Texas at El Paso. We design, build and race a concrete canoe against
              other universities in the ASCE Concrete Canoe Competition.
            </p>

            <ul aria-label="What we do" className="mt-6 flex flex-wrap gap-x-6 gap-y-2">
              {WHAT_WE_DO.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-2 font-semibold">
                  <Icon aria-hidden="true" className="h-5 w-5 text-sky" />
                  {label}
                </li>
              ))}
            </ul>

            <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
              <a href={INSTAGRAM_URL} target="_blank" rel="noopener noreferrer" className={buttonClasses({ variant: "onDark", size: "md" })}>
                Follow us on Instagram
                <ArrowUpRight aria-hidden="true" className="h-5 w-5" />
                <span className="sr-only"> (opens in a new tab)</span>
              </a>
              <span className="font-semibold text-white/90">{INSTAGRAM_HANDLE}</span>
            </div>
          </div>
        </main>

        <WaveDivider />
      </div>
      <CanoeBand />
    </div>
  );
}
