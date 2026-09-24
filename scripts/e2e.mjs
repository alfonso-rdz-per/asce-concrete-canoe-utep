// Orquesta las pruebas E2E + accesibilidad contra Supabase REAL:
//   1. compila (a menos que E2E_SKIP_BUILD=1)
//   2. crea usuarios temporales de Auth (scripts/supabase-validation/prepare.mjs)
//   3. ejecuta Playwright (Chromium escritorio, WebKit iPhone, Chromium Android)
//   4. SIEMPRE borra los usuarios temporales
// Los miembros de prueba (ZZVAL- y IDs numéricos de prueba) quedan en la base de datos: se limpian con
// tests/supabase/cleanup.sql en el SQL Editor (audit_log/check-ins son inmutables a propósito).
//
// Uso: npm run test:e2e [-- argumentos de playwright]
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const run = (args, opts = {}) => spawnSync(process.execPath, args, { stdio: "inherit", env: process.env, ...opts });
const ENV = "--env-file=.env.local";

if (!existsSync(".env.local")) {
  console.error("Falta .env.local (credenciales de Supabase). Ver docs/SETUP.md.");
  process.exit(1);
}

if (process.env.E2E_SKIP_BUILD !== "1") {
  const build = run(["./node_modules/next/dist/bin/next", "build"]); // Next lee .env.local por sí mismo
  if (build.status !== 0) process.exit(build.status ?? 1);
}

if (existsSync("tests/supabase/.state.json")) run([ENV, "scripts/supabase-validation/cleanup.mjs"]);
const prep = run([ENV, "scripts/supabase-validation/prepare.mjs"]);
if (prep.status !== 0) process.exit(prep.status ?? 1);

let status = 1;
try {
  const state = JSON.parse(readFileSync("tests/supabase/.state.json", "utf8"));
  const env = {
    ...process.env,
    E2E_ADMIN_EMAIL: state.admin.email,
    E2E_ADMIN_PASSWORD: state.admin.password,
    E2E_NONAME_EMAIL: state.noname.email,
    E2E_NONAME_PASSWORD: state.noname.password,
    E2E_OUTSIDER_EMAIL: state.outsider.email,
    E2E_OUTSIDER_PASSWORD: state.outsider.password,
    E2E_OUTSIDER_ID: state.outsider.id,
    E2E_RUN_ID: state.runId,
  };
  const result = spawnSync(process.execPath, [ENV, "./node_modules/@playwright/test/cli.js", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env,
  });
  status = result.status ?? 1;
} finally {
  run([ENV, "scripts/supabase-validation/cleanup.mjs"]);
  console.log("\nRecuerda: los miembros de prueba (ZZVAL- e IDs numéricos de 13–14 dígitos) se limpian con tests/supabase/cleanup.sql (SQL Editor).");
}
process.exit(status);
