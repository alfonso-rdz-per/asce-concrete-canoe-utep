import type { Metadata } from "next";
import { BrandMark } from "@/components/brand/BrandMark";
import { SiteFooter } from "@/components/brand/SiteFooter";
import { ButtonLink } from "@/components/ui/Button";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFound() {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="on-dark bg-navy px-4 py-5 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <BrandMark tone="onDark" size="lg" />
        </div>
      </header>
      <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-xl flex-1 flex-col items-center justify-center gap-4 px-4 py-16 text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.18em] text-blue">Error 404</p>
        <h1 className="text-3xl font-bold text-navy sm:text-4xl">Page not found</h1>
        <p className="text-muted">The page you&apos;re looking for doesn&apos;t exist or has moved.</p>
        <ButtonLink href="/">Back to home</ButtonLink>
      </main>
      <SiteFooter />
    </div>
  );
}
