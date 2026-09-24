import "server-only";
import { serverEnv } from "@/lib/env";
import { deriveKey } from "@/lib/crypto/keys";

interface AppKeys {
  qr: Buffer;
  ticket: Buffer;
  ip: Buffer;
  device: Buffer;
}

let cached: AppKeys | undefined;

/** Claves derivadas de los secretos de entorno. Solo servidor; se calculan una vez por instancia. */
export function appKeys(): AppKeys {
  if (cached === undefined) {
    const env = serverEnv();
    cached = {
      qr: deriveKey(env.SERVER_SECRET, "qr"),
      ticket: deriveKey(env.SERVER_SECRET, "ticket"),
      ip: deriveKey(env.SERVER_SECRET, "ip"),
      device: deriveKey(env.SERVER_SECRET, "device"),
    };
  }
  return cached;
}
