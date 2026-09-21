/**
 * Fondo de las pantallas de estudiante (portada y check-in): la foto del equipo (`public/brand/imagen-fondo.jpg`, SIN modificar el
 * archivo) se integra con el azul por CSS (mezcla de fondo `luminosity` sobre navy + degradados), en lugar de pegarse como un
 * rectángulo: más oscuro a la izquierda, donde va el texto, y fundida con el navy abajo, donde empiezan las olas.
 * Son capas decorativas (`aria-hidden`) DETRÁS del contenido: el contraste del texto blanco lo garantiza el navy del degradado.
 * El contenedor debe ser `relative isolate overflow-hidden bg-navy` para que las capas queden dentro de él.
 */
export function HeroBackdrop() {
  return (
    <>
      <div aria-hidden="true" className="hero-photo pointer-events-none absolute inset-0 -z-10 opacity-60" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-r from-navy via-navy/85 to-navy/45" />
      <div aria-hidden="true" className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-40 bg-gradient-to-t from-navy to-transparent" />
    </>
  );
}

/**
 * Franja clara bajo las olas con la ilustración de la canoa (`public/brand/canoe-draw.png`, el PNG aportado por el equipo, sin
 * recrear ni modificar). Sus trazos son azules, así que se apoya sobre la superficie clara (no sobre el navy, donde no se verían).
 * Se sirve tal cual (un <img> normal, sin recodificar) y conserva su proporción 1023×700 en cualquier ancho. NO usa next/image: este
 * añade `style="color:transparent"` en línea y la CSP de producción (sin 'unsafe-inline' en style-src-attr) lo bloquea.
 */
export function CanoeBand() {
  return (
    <div className="bg-surface">
      <div className="mx-auto flex w-full max-w-6xl justify-center px-4 py-1 sm:justify-end sm:px-6">
        {/* eslint-disable-next-line @next/next/no-img-element -- PNG del equipo servido tal cual; next/image inyecta un estilo en línea que la CSP bloquea */}
        <img
          src="/brand/canoe-draw.png"
          alt=""
          width={1023}
          height={700}
          loading="eager"
          decoding="async"
          data-testid="canoe-illustration"
          className="h-auto w-44 sm:w-64"
        />
      </div>
    </div>
  );
}
