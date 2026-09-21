// Borra los usuarios temporales de validación (y con ellos su fila en public.admins,
// por ON DELETE CASCADE) y elimina tests/supabase/.state.json.
// Los datos de negocio de prueba (miembros, sesiones, check-ins, auditoría) NO se pueden
// borrar por API (a propósito): se limpian con tests/supabase/cleanup.sql en el SQL Editor.
//
// Uso: node --env-file=.env.local scripts/supabase-validation/cleanup.mjs
import { existsSync, readFileSync, rmSync } from "node:fs";

const STATE = "tests/supabase/.state.json";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !svc) throw new Error("Faltan variables de entorno (cargue .env.local con --env-file).");
if (!existsSync(STATE)) {
  console.log("No hay .state.json: nada que borrar.");
  process.exit(0);
}

const state = JSON.parse(readFileSync(STATE, "utf8"));
const headers = { apikey: svc, Authorization: `Bearer ${svc}` };
let failed = false;
for (const kind of ["admin", "noname", "outsider"]) {
  const u = state[kind];
  if (!u?.id) continue;
  // Salvaguarda: solo se borran usuarios cuyo correo sea de validación.
  if (!/^zz-validation-(admin|noname|outsider)-[0-9a-f]{8}@example\.com$/.test(u.email)) {
    throw new Error(`Correo inesperado para ${kind}: no se borra.`);
  }
  const res = await fetch(`${url}/auth/v1/admin/users/${u.id}`, { method: "DELETE", headers });
  console.log(`  ${kind.padEnd(9)} ${u.id} -> HTTP ${res.status}`);
  if (!res.ok && res.status !== 404) failed = true;
}
if (failed) {
  // No se borra el archivo de estado: así se puede reintentar y no quedan usuarios huérfanos.
  console.error("Algún usuario NO se pudo borrar: se conserva .state.json para reintentar.");
  process.exit(1);
}
rmSync(STATE);
console.log("Usuarios temporales borrados y .state.json eliminado.");
