import { defineConfig, devices } from "@playwright/test";

/**
 * Pruebas de extremo a extremo + accesibilidad (axe) + responsivo.
 * Se ejecutan con `npm run test:e2e` (scripts/e2e.mjs): compila, crea usuarios temporales en Supabase
 * real, lanza `next start` y corre estos proyectos. Las pruebas que necesitan un administrador se
 * omiten solas si no hay credenciales de prueba (E2E_ADMIN_EMAIL / E2E_ADMIN_PASSWORD).
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: "tests/e2e",
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "off",
    screenshot: "off",
  },
  projects: [
    // Escritorio (administración) — Chrome
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    // iPhone (Safari/WebKit, safe areas, dvh)
    { name: "iphone", use: { ...devices["iPhone 14"] } },
    // Android (Chrome móvil)
    { name: "android", use: { ...devices["Pixel 7"] } },
  ],
  // El servidor lo levanta scripts/e2e.mjs (necesita las variables de .env.local); aquí solo se espera.
  webServer: process.env.E2E_NO_SERVER
    ? undefined
    : {
        command: `node ./node_modules/next/dist/bin/next start -p ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: true,
        timeout: 120_000,
      },
});
