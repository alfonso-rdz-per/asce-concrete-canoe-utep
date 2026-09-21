import "server-only";
import { z } from "zod";
import {
  QR_DEFAULT_GRACE_MS,
  QR_MAX_GRACE_MS,
} from "@/lib/tokens";
import { MIN_SECRET_LENGTH } from "@/lib/crypto/keys";
import { TICKET_DEFAULT_TTL_MS } from "@/lib/tickets";

/** Una variable vacía en .env cuenta como "no definida" (no como 0). */
const emptyAsUndefined = (v: unknown) => (v === "" ? undefined : v);

const secret = z
  .string()
  .min(MIN_SECRET_LENGTH, `debe tener al menos ${MIN_SECRET_LENGTH} caracteres`)
  .refine((v) => !v.startsWith("replace-me"), "sigue con el valor de ejemplo");

const schema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z
    .string()
    .min(1)
    .refine((v) => v !== "replace-me", "sigue con el valor de ejemplo"),
  SERVER_SECRET: secret,
  QR_GRACE_MS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(0).max(QR_MAX_GRACE_MS).default(QR_DEFAULT_GRACE_MS),
  ),
  TICKET_TTL_SECONDS: z.preprocess(
    emptyAsUndefined,
    z.coerce.number().int().min(60).max(600).default(TICKET_DEFAULT_TTL_MS / 1000),
  ),
});

export type ServerEnv = z.infer<typeof schema>;

/**
 * Valida un origen de variables. El mensaje de error lista nombre y motivo,
 * NUNCA el valor recibido (podría ser un secreto).
 */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(env)"}: ${i.message}`)
      .join("\n");
    throw new Error(`Variables de entorno inválidas:\n${detail}`);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

/** Perezoso: no valida al importar, así `next build` no exige secretos. */
export function serverEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
