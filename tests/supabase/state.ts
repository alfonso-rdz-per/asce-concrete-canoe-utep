import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export interface TempUser {
  id: string;
  email: string;
  password: string;
}

export interface ValidationState {
  runId: string;
  /** Confirmado y con display_name: administrador. */
  admin: TempUser;
  /** Confirmado y SIN display_name: administrador (prueba el respaldo del saludo). */
  noname: TempUser;
  /** Confirmado; las pruebas lo banean tras iniciar sesión para simular un administrador revocado. */
  outsider: TempUser;
}

/** Estado creado por scripts/supabase-validation/prepare.mjs. Falla con un mensaje claro si falta. */
export function loadState(): ValidationState {
  const file = path.resolve(import.meta.dirname, ".state.json");
  if (!existsSync(file)) {
    throw new Error(
      "Falta tests/supabase/.state.json. Ejecute: node --env-file=.env.local scripts/supabase-validation/prepare.mjs " +
        "y después tests/supabase/promote-admin.sql en el SQL Editor.",
    );
  }
  return JSON.parse(readFileSync(file, "utf8")) as ValidationState;
}
