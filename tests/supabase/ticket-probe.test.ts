/**
 * SONDA MANUAL (opcional) del ticket contra la app y Supabase REALES: dice si un ticket sigue siendo válido AHORA, cuánto le queda
 * y por qué se rechaza. Sirve para comprobar a mano que el ticket dura ~3 min y sobrevive a las rotaciones del QR (el teléfono
 * no puede observarlo hasta que el estudiante envíe ASCE ID + Name).
 *
 *   $env:TICKET = "t1...."          # el ticket, copiado de la página /c/[token] (ver instrucciones)
 *   npm run test:supabase -- ticket-probe --reporter=verbose      (sin --reporter=verbose el resultado no se imprime)
 *
 * Sin la variable TICKET no hace nada (se omite). Solo LEE: nunca modifica datos. No imprime claves; del ticket solo muestra
 * un fragmento del nonce.
 */
import { describe, it } from "vitest";
import { checkTicketOnServer } from "@/lib/checkin/server";
import { formatClockTime } from "@/lib/dates";

const TICKET = process.env.TICKET;
const REASONS = {
  invalid: "el ticket no es auténtico (formato, MAC alterado o sesión inexistente)",
  expired: "el ticket CADUCÓ (pasaron más de 3 minutos desde que se emitió)",
  closed: "la sesión ya NO está activa (cerrada o en borrador)",
} as const;

describe.skipIf(!TICKET)("Sonda manual de ticket (Supabase real)", () => {
  it("imprime el estado del ticket con la hora del servidor", async () => {
    const now = Date.now();
    const r = await checkTicketOnServer(TICKET);
    if (r.ok) {
      const left = Math.round((r.expiresAtMs - now) / 1000);
      const age = Math.round((now - r.issuedAtMs) / 1000);
      console.log(
        `\n  ✔ Ticket VÁLIDO — sesión «${r.session.title}» — emitido hace ${age} s — le quedan ${left} s (caduca a las ${formatClockTime(new Date(r.expiresAtMs).toISOString())}) — nonce ${r.nonce.slice(0, 4)}…\n`,
      );
    } else {
      console.log(`\n  ✘ Ticket RECHAZADO: ${REASONS[r.reason]}\n`);
    }
  });
});
