import type { NextConfig } from "next";

// Cabeceras de seguridad estáticas. La Content-Security-Policy (con nonce por petición) la fija
// src/proxy.ts. Aquí solo van las que no dependen de la petición.
const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Strict-Transport-Security", value: "max-age=31536000" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), bluetooth=(), usb=(), serial=(), payment=()",
  },
];

// Nada que dependa de sesión, token o ticket debe quedar en caché.
const noStore = [{ key: "Cache-Control", value: "no-store, max-age=0" }];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  // BrandMark comprueba en tiempo de ejecución si existen los logos de public/brand/:
  // se incluyen en el empaquetado del servidor (p. ej. en Vercel) para que esa comprobación funcione.
  outputFileTracingIncludes: {
    "/*": ["public/brand/**/*"],
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/api/:path*", headers: noStore },
      { source: "/c/:path*", headers: noStore },
      { source: "/admin/:path*", headers: noStore },
    ];
  },
};

export default nextConfig;
