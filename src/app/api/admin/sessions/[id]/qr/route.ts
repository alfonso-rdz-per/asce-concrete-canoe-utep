import { NextResponse } from "next/server";
import { getAdmin } from "@/lib/auth/session";
import { appKeys } from "@/lib/crypto/server-keys";
import { getSession } from "@/lib/data/sessions";
import { NOT_FOUND_SESSION } from "@/lib/errors";
import { systemClock } from "@/lib/time";
import { issueQrTokens } from "@/lib/tokens";
import { idSchema } from "@/lib/validation/member";

/**
 * Estado del QR de una sesión para la pantalla del administrador.
 *  - Solo administradores (el proxy NO protege /api: se comprueba aquí; sin sesión válida -> 401 JSON).
 *  - Solo entrega tokens si la sesión está `active` según la BASE DE DATOS; si no, solo el estado (el QR deja de dibujarse).
 *  - La hora es la del SERVIDOR (`serverNow`): la pantalla ancla a ella su cuenta regresiva.
 *  - Devuelve el token actual y el siguiente para cambiar de QR sin esperar a la red en el límite.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdmin();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const result = await getSession(admin.supabase, id.data);
  if (!result.ok) {
    const notFound = result.error.message === NOT_FOUND_SESSION;
    return NextResponse.json({ error: notFound ? "not_found" : "unavailable" }, { status: notFound ? 404 : 503, headers: NO_STORE });
  }

  const now = systemClock.now();
  const session = result.data;
  if (session.status !== "active") {
    return NextResponse.json({ status: session.status, serverNow: now }, { headers: NO_STORE });
  }

  const { serverNow, current, next } = issueQrTokens({ key: appKeys().qr, sessionId: session.id, now });
  const pick = (w: { token: string; startsAtMs: number; endsAtMs: number }) => ({ token: w.token, startsAtMs: w.startsAtMs, endsAtMs: w.endsAtMs });
  return NextResponse.json({ status: "active", serverNow, current: pick(current), next: pick(next) }, { headers: NO_STORE });
}
