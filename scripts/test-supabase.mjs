// Ejecuta la suite de validación contra Supabase REAL (no forma parte de `npm test`).
// Crea y modifica datos en el proyecto de .env.local; los datos llevan prefijo ZZVAL- / [VALIDACIÓN]
// y se limpian con tests/supabase/cleanup.sql. Ver docs/SUPABASE-VALIDATION.md.
//
// Uso: npm run test:supabase [-- filtro-de-archivo]
import { spawnSync } from "node:child_process";

const extra = process.argv.slice(2);
const result = spawnSync(
  process.execPath,
  ["--env-file=.env.local", "./node_modules/vitest/vitest.mjs", "run", "--project", "supabase", ...extra],
  { stdio: "inherit", env: { ...process.env, RUN_SUPABASE_TESTS: "1" } },
);
process.exit(result.status ?? 1);
