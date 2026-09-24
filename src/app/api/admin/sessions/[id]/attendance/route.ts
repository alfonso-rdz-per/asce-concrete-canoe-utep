import { NextResponse } from "next/server";
import { getAdmin } from "@/lib/auth/session";
import { getSessionLive } from "@/lib/data/sessions";
import { NOT_FOUND_SESSION } from "@/lib/errors";
import { systemClock } from "@/lib/time";
import { idSchema } from "@/lib/validation/member";

/**
 * Asistencia en vivo de UNA sesión (la del id de la URL) para la pantalla del administrador (sondeo cada ~3 s).
 *  - Solo administradores (401 JSON si no; el proxy no protege /api). RLS aplica además en la base de datos.
 *  - Devuelve solo lo que la pantalla necesita: estado de la sesión, conteo y, por asistente, nombre, cargo y hora.
 *    Nunca el ASCE ID ni secretos.
 *  - El estado de la sesión viaja en cada respuesta: si el administrador la cierra (aquí o en otra pestaña), la pantalla
 *    del QR deja de mostrar el código en el siguiente sondeo.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const admin = await getAdmin();
  if (!admin) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

  const id = idSchema.safeParse((await params).id);
  if (!id.success) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

  const result = await getSessionLive(admin.supabase, id.data);
  if (!result.ok) {
    const notFound = result.error.message === NOT_FOUND_SESSION;
    return NextResponse.json({ error: notFound ? "not_found" : "unavailable" }, { status: notFound ? 404 : 503, headers: NO_STORE });
  }

  const { session, count, total, attendees } = result.data;
  return NextResponse.json(
    {
      status: session.status,
      title: session.title,
      location: session.location,
      serverNow: systemClock.now(),
      count,
      total,
      attendees: attendees.map((a) => ({ id: a.id, name: a.name, position: a.position, checkedInAt: a.checkedInAt })),
    },
    { headers: NO_STORE },
  );
}
