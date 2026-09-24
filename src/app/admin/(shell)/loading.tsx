/** Estado de carga del panel (visible para lectores de pantalla). */
export default function AdminLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-4">
      <span className="sr-only">Loading…</span>
      <div aria-hidden="true" className="h-8 w-56 animate-pulse rounded-lg bg-mist" />
      <div aria-hidden="true" className="grid gap-4 sm:grid-cols-3">
        <div className="h-28 animate-pulse rounded-xl bg-mist" />
        <div className="h-28 animate-pulse rounded-xl bg-mist" />
        <div className="h-28 animate-pulse rounded-xl bg-mist" />
      </div>
    </div>
  );
}
