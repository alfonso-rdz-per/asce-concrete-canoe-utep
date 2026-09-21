import { BrandMark } from "@/components/brand/BrandMark";

import { INSTAGRAM_HANDLE, INSTAGRAM_URL } from "@/lib/brand/social";

export { INSTAGRAM_HANDLE, INSTAGRAM_URL };

/** Pie de página discreto: marca `ASCE | UTEP` + Instagram del equipo. Va al final de la página. */
export function SiteFooter() {
  return (
    <footer className="mt-auto border-t border-line bg-white">
      <div className="mx-auto flex w-full max-w-6xl flex-col items-center gap-2 px-4 py-4 pb-[max(1rem,env(safe-area-inset-bottom))] text-sm text-muted sm:flex-row sm:justify-between sm:px-6">
        <BrandMark tone="onLight" size="md" />
        <a
          href={INSTAGRAM_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center rounded-md px-2 font-medium text-blue underline-offset-4 hover:underline"
        >
          Instagram · {INSTAGRAM_HANDLE}
          <span className="sr-only"> (opens in a new tab)</span>
        </a>
      </div>
    </footer>
  );
}
