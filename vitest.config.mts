import path from "node:path";
import { defineConfig, type TestProjectInlineConfiguration } from "vitest/config";

// Validación contra Supabase REAL: solo se activa con `npm run test:supabase` (RUN_SUPABASE_TESTS=1).
// Nunca forma parte de `npm test`: necesita credenciales, red y crea datos de prueba.
const supabaseProject: TestProjectInlineConfiguration = {
  extends: true,
  test: {
    name: "supabase",
    include: ["tests/supabase/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
};

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src"),
      // `server-only` lanza al importarse fuera de un Server Component; en pruebas es un no-op.
      "server-only": path.resolve(import.meta.dirname, "tests/helpers/server-only-stub.ts"),
    },
  },
  test: {
    environment: "node",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["src/**/*.test.ts", "tests/unit/**/*.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "ui",
          environment: "jsdom",
          include: ["tests/ui/**/*.test.tsx"],
          setupFiles: ["tests/ui/setup.ts"],
        },
      },
      ...(process.env.RUN_SUPABASE_TESTS === "1" ? [supabaseProject] : []),
      {
        extends: true,
        test: {
          name: "db",
          include: ["tests/db/**/*.test.ts"],
          // Postgres real embebido: se levanta una vez y cada prueba clona una plantilla.
          globalSetup: ["tests/db/global-setup.ts"],
          testTimeout: 60_000,
          hookTimeout: 180_000,
        },
      },
    ],
  },
});
