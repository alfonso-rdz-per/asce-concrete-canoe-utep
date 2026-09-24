"use client";

import { Button } from "@/components/ui/Button";

/** Límite de errores de la aplicación: mensaje claro en inglés, sin detalles técnicos. */
export default function GlobalError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main id="main" tabIndex={-1} className="mx-auto flex min-h-dvh w-full max-w-xl flex-col items-center justify-center gap-4 px-4 text-center">
      <p className="text-sm font-semibold uppercase tracking-[0.18em] text-danger">Error</p>
      <h1 className="text-3xl font-bold text-navy">Something went wrong</h1>
      <p className="text-muted">We couldn&apos;t load this page. Please try again.</p>
      <Button onClick={() => reset()}>Try again</Button>
    </main>
  );
}
