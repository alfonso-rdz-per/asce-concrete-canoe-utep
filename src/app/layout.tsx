import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import "@fontsource-variable/inter";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Check-In · ASCE | UTEP Concrete Canoe Team",
    template: "%s · ASCE | UTEP Concrete Canoe Team",
  },
  description: "Attendance check-in for the ASCE | UTEP Concrete Canoe Team.",
  // App privada de un equipo estudiantil: no debe indexarse.
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Permite usar env(safe-area-inset-*) en iPhone (notch y barra de inicio).
  viewportFit: "cover",
  themeColor: "#003070",
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  // La CSP usa un nonce distinto por petición (src/proxy.ts): todas las páginas se renderizan dinámicamente.
  await connection();

  return (
    <html lang="en" className="h-full">
      <body className="min-h-dvh bg-surface font-sans text-ink antialiased">
        <a
          href="#main"
          className="sr-only focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-50 focus:rounded-lg focus:bg-white focus:px-4 focus:py-3 focus:font-semibold focus:text-navy focus:shadow-card"
        >
          Skip to main content
        </a>
        {children}
      </body>
    </html>
  );
}
