// Crea usuarios TEMPORALES en Supabase Auth para la validación real y las pruebas E2E:
//   - admin    : confirmado, con display_name ("Validation Admin")  -> es administrador (regla de la migración 3)
//   - noname   : confirmado, SIN display_name                       -> prueba el respaldo del saludo (parte del correo)
//   - outsider : confirmado; las pruebas lo banean tras iniciar sesión para simular a un admin revocado
// Se guardan en tests/supabase/.state.json (ignorado por git). Nunca imprime contraseñas ni claves.
//
// Uso: node --env-file=.env.local scripts/supabase-validation/prepare.mjs
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";

const STATE = "tests/supabase/.state.json";
const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.replace(/\/$/, "");
const svc = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !svc) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (cargue .env.local con --env-file).");
if (existsSync(STATE)) throw new Error(`Ya existe ${STATE}: ejecute primero cleanup.mjs.`);

const runId = randomBytes(4).toString("hex");

async function createUser(kind, displayName) {
  const email = `zz-validation-${kind}-${runId}@example.com`;
  const password = randomBytes(24).toString("base64url");
  const res = await fetch(`${url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: svc, Authorization: `Bearer ${svc}`, "Content-Type": "application/json" },
    // email_confirm: true => usuario confirmado y no se envía ningún correo.
    body: JSON.stringify({ email, password, email_confirm: true, ...(displayName ? { user_metadata: { display_name: displayName } } : {}) }),
  });
  const body = await res.json();
  if (!res.ok) throw new Error(`No se pudo crear el usuario ${kind}: HTTP ${res.status} ${body.msg ?? body.message ?? ""}`);
  return { id: body.id, email, password };
}

const admin = await createUser("admin", "Validation Admin");
const noname = await createUser("noname", null);
const outsider = await createUser("outsider", "Validation Outsider");
writeFileSync(STATE, JSON.stringify({ runId, createdAt: new Date().toISOString(), admin, noname, outsider }, null, 2));

console.log(`Usuarios temporales creados (runId ${runId}).`);
console.log(`  admin     ${admin.id}`);
console.log(`  noname    ${noname.id}`);
console.log(`  outsider  ${outsider.id}`);
