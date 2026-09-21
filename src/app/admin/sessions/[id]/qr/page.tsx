import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { closeSessionAction } from "@/app/admin/(shell)/sessions/actions";
import { QrScreen } from "@/components/admin/QrScreen";
import { BrandMark } from "@/components/brand/BrandMark";
import { requireAdmin } from "@/lib/auth/session";
import { getAdminFirstNames } from "@/lib/data/admin-names";
import { getSessionLive } from "@/lib/data/sessions";
import { idSchema } from "@/lib/validation/member";

export const metadata: Metadata = { title: "Check-in QR", robots: { index: false, follow: false } };

/**
 * Pantalla del QR de check-in (iPhone del administrador o proyector). Vive FUERA del shell del panel (sin barra
 * lateral) para ocupar toda la pantalla, así que exige administrador por sí misma. El QR lo dibuja el componente de
 * cliente pidiendo tokens a /api/admin/sessions/[id]/qr; esta página solo carga el estado inicial.
 */
export default async function SessionQrPage({ params }: { params: Promise<{ id: string }> }) {
  const { supabase } = await requireAdmin();
  const { id } = await params;

  // El id viene de la URL: se valida antes de tocar la base de datos.
  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) notFound();

  const [result, starters] = await Promise.all([getSessionLive(supabase, parsedId.data), getAdminFirstNames()]);
  if (!result.ok) notFound();
  const { session, count, total, attendees } = result.data;
  const startedBy = session.opened_by ? (starters.get(session.opened_by) ?? null) : null;

  // Un borrador aún no tiene QR: se abre desde su página (botón "Start check-in").
  if (session.status === "draft") redirect(`/admin/sessions/${session.id}`);

  return (
    <QrScreen
      sessionId={session.id}
      title={session.title}
      startedBy={startedBy}
      initialStatus={session.status}
      initialLive={{ count, total, attendees: attendees.map((a) => ({ id: a.id, name: a.name, position: a.position, checkedInAt: a.checkedInAt })) }}
      brand={<BrandMark tone="onDark" size="md" />}
      closeAction={closeSessionAction}
    />
  );
}
