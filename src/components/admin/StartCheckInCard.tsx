import { ButtonLink } from "@/components/ui/Button";

/**
 * Llamada principal del dashboard: "Start Check-In".
 *  - Sin check-in en curso: lleva al formulario de nueva sesión, cuyo botón principal crea la reunión, abre el check-in
 *    y muestra la pantalla del QR.
 *  - Con un check-in ya en curso NO se crea otro (además lo impide la base de datos): el botón pasa a "Resume Check-In",
 *    lleva a su pantalla del QR y se indica cuál está abierto.
 *
 * COMPOSICIÓN: el texto y el botón van a la IZQUIERDA (el botón debajo del texto, alineado a la izquierda) y la ilustración del
 * equipo (canoe-draw.png) queda libre en la esquina inferior derecha, sin que ningún texto ni botón la cubra.
 */
export function StartCheckInCard({ active }: { active?: { id: string; title: string } | null }) {
  return (
    <section
      aria-labelledby="start-check-in-heading"
      className="on-dark relative overflow-hidden rounded-xl bg-gradient-to-br from-navy to-ocean p-6 text-white shadow-card sm:p-8"
    >
      {/* La ilustración del equipo (canoe-draw.png) como marca de agua blanca: el filtro CSS la tiñe sin modificar el archivo. */}
      {/* eslint-disable-next-line @next/next/no-img-element -- PNG del equipo servido tal cual; next/image inyecta un estilo en línea que la CSP bloquea */}
      <img
        src="/brand/canoe-draw.png"
        alt=""
        width={1023}
        height={700}
        loading="eager"
        decoding="async"
        aria-hidden="true"
        data-testid="start-card-illustration"
        className="pointer-events-none absolute bottom-1 -right-1 h-auto w-36 opacity-25 brightness-0 invert sm:bottom-0 sm:right-4 sm:w-60"
      />
      <div className="relative flex flex-col items-start gap-5 pr-24 sm:pr-0">
        <div className="max-w-xl space-y-1.5 sm:max-w-[58%]">
          {active ? <p className="text-sm font-semibold uppercase tracking-[0.18em] text-sky">Check-in in progress</p> : null}
          <h2 id="start-check-in-heading" className="text-2xl font-bold tracking-tight sm:text-3xl">
            {active ? active.title : "Ready to take attendance?"}
          </h2>
          {active ? <p className="text-sky">Show the QR code again to keep checking people in.</p> : null}
        </div>
        <ButtonLink href={active ? `/admin/sessions/${active.id}/qr` : "/admin/sessions/new"} variant="onDark">
          {active ? "Resume Check-In" : "Start Check-In"}
        </ButtonLink>
      </div>
    </section>
  );
}
