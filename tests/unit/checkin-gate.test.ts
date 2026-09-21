/**
 * Puerta de check-in (Fase 4): canje del QR por un ticket y validación del ticket contra el estado REAL de la sesión.
 * Todo con hora, claves y sesión inyectadas: ningún reloj del dispositivo ni acceso a red interviene.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkTicket, redeemQr, type GateSession, type LoadSession } from "@/lib/checkin/gate";
import { deriveKey } from "@/lib/crypto/keys";
import { TICKET_DEFAULT_TTL_MS, verifyTicket } from "@/lib/tickets";
import { QR_SLOT_MS, issueQrToken, slotAt } from "@/lib/tokens";
import { SESSION_A, SESSION_B, T0 } from "../helpers/clock";

const SECRET = "secreto-de-servidor-para-pruebas-0123456789";
const QR_KEY = deriveKey(SECRET, "qr");
const TICKET_KEY = deriveKey(SECRET, "ticket");
const GRACE = 5_000;
const TTL = TICKET_DEFAULT_TTL_MS;
const SLOT = slotAt(T0);

const session = (over: Partial<GateSession> = {}): GateSession => ({
  id: SESSION_A,
  title: "Concrete Canoe Team Meeting",
  location: "Construction Workshop",
  status: "active",
  ...over,
});

/** Base de datos falsa: solo conoce las sesiones que se le dan, y cuenta cuántas veces se le pregunta. */
function db(...sessions: GateSession[]) {
  const load = vi.fn<LoadSession>(async (id) => sessions.find((s) => s.id === id) ?? null);
  return load;
}

const qr = (sessionId = SESSION_A, slot = SLOT, key = QR_KEY) => issueQrToken({ key, sessionId, slot });
const redeem = (token: unknown, now: number, loadSession: LoadSession, key = QR_KEY) =>
  redeemQr({ token, now, qrKey: key, ticketKey: TICKET_KEY, graceMs: GRACE, ticketTtlMs: TTL, loadSession });
const check = (ticket: unknown, now: number, loadSession: LoadSession) => checkTicket({ ticket, now, ticketKey: TICKET_KEY, ticketTtlMs: TTL, loadSession });

afterEach(() => vi.useRealTimers());

describe("canje del QR: token vigente", () => {
  it("un token del intervalo actual emite un ticket ligado a SU sesión, con título y ubicación", async () => {
    const result = await redeem(qr(), T0 + 3_000, db(session()));
    expect(result).toMatchObject({ ok: true, session: { id: SESSION_A, title: "Concrete Canoe Team Meeting", location: "Construction Workshop" } });
    if (!result.ok) return;
    expect(result.ticket).toMatch(/^t1\./);
    expect(result.expiresAtMs).toBe(T0 + 3_000 + TTL);
    const verified = verifyTicket({ key: TICKET_KEY, ticket: result.ticket, now: T0 + 3_000, ttlMs: TTL });
    expect(verified).toMatchObject({ ok: true, sessionId: SESSION_A, tokenSlot: SLOT });
  });

  it("MULTIUSO: cada estudiante que escanea recibe su PROPIO ticket (nonce distinto)", async () => {
    const load = db(session());
    const tickets = await Promise.all(Array.from({ length: 20 }, () => redeem(qr(), T0 + 1_000, load)));
    const nonces = new Set(tickets.map((t) => (t.ok ? verifyTicket({ key: TICKET_KEY, ticket: t.ticket, now: T0 + 1_000, ttlMs: TTL }) : null)).map((v) => (v && v.ok ? v.nonce : "x")));
    expect(nonces.size).toBe(20);
  });

  it("escanear NO completa la asistencia: el resultado es solo un ticket (sin miembro, sin check-in)", async () => {
    const result = await redeem(qr(), T0, db(session()));
    expect(Object.keys(result).sort()).toEqual(["expiresAtMs", "ok", "session", "ticket"]);
  });
});

describe("canje del QR: vigencia (hora del SERVIDOR) y período de gracia", () => {
  it("dentro del intervalo de 10 s: válido", async () => {
    for (const offset of [0, 1_000, 9_999]) expect((await redeem(qr(), T0 + offset, db(session()))).ok, `+${offset}`).toBe(true);
  });

  it("GRACIA: hasta 5 s después de terminar el intervalo (16 s en total) sigue valiendo", async () => {
    expect((await redeem(qr(), T0 + QR_SLOT_MS + 4_999, db(session()))).ok).toBe(true);
    expect((await redeem(qr(), T0 + QR_SLOT_MS + GRACE - 1, db(session()))).ok).toBe(true);
  });

  it("EXPIRADO: pasada la gracia se rechaza como 'expired' (mensaje específico)", async () => {
    expect(await redeem(qr(), T0 + QR_SLOT_MS + GRACE, db(session()))).toEqual({ ok: false, reason: "expired" });
    expect(await redeem(qr(), T0 + 30_000, db(session()))).toEqual({ ok: false, reason: "expired" });
  });

  it("un token del FUTURO (slot siguiente) aún no vale: se trata como inválido", async () => {
    expect(await redeem(qr(SESSION_A, SLOT + 1), T0 + 2_000, db(session()))).toEqual({ ok: false, reason: "invalid" });
  });

  it("HORA DEL SERVIDOR: el resultado depende solo de `now`; el reloj del dispositivo no interviene", async () => {
    vi.useFakeTimers();
    for (const deviceClock of ["2001-01-01T00:00:00Z", "2099-12-31T23:59:59Z", new Date(T0).toISOString()]) {
      vi.setSystemTime(new Date(deviceClock));
      expect((await redeem(qr(), T0 + 3_000, db(session()))).ok, deviceClock).toBe(true);
      expect((await redeem(qr(), T0 + 60_000, db(session()))).ok, deviceClock).toBe(false);
    }
  });
});

describe("canje del QR: autenticidad", () => {
  it("MAC inválido: se rechaza como 'invalid' y NO se consulta la base de datos", async () => {
    const load = db(session());
    const good = qr();
    const forged = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    expect(await redeem(forged, T0, load)).toEqual({ ok: false, reason: "invalid" });
    expect(load).not.toHaveBeenCalled();
  });

  it("token MODIFICADO (cualquier carácter): ninguna alteración lo hace válido", async () => {
    const load = db(session());
    const good = qr();
    for (let i = 0; i < good.length; i++) {
      const swapped = good[i] === "a" ? "b" : "a";
      const tampered = good.slice(0, i) + swapped + good.slice(i + 1);
      if (tampered === good) continue;
      const result = await redeem(tampered, T0, load);
      expect(result.ok, `posición ${i}`).toBe(false);
    }
  });

  it("SESIÓN EQUIVOCADA: no se puede reutilizar el MAC con otro sessionId", async () => {
    const load = db(session(), session({ id: SESSION_B, title: "Otro" }));
    const [v, sidA, slot, mac] = qr(SESSION_A).split(".");
    const sidB = qr(SESSION_B).split(".")[1];
    expect(v).toBe("v1");
    expect(await redeem([v, sidB, slot, mac].join("."), T0, load)).toEqual({ ok: false, reason: "invalid" });
    // Y el token legítimo de B es válido solo para B.
    expect(await redeem(qr(SESSION_B), T0, load)).toMatchObject({ ok: true, session: { id: SESSION_B } });
    expect(sidA).not.toBe(sidB);
  });

  it("no se puede adelantar el slot reutilizando el MAC", async () => {
    const [v, sid, , mac] = qr().split(".");
    expect(await redeem([v, sid, (SLOT + 1).toString(36), mac].join("."), T0 + 12_000, db(session()))).toEqual({ ok: false, reason: "invalid" });
  });

  it("firmado con otra clave, basura y tipos raros: 'invalid' sin lanzar", async () => {
    const load = db(session());
    expect(await redeem(qr(SESSION_A, SLOT, deriveKey("otro-secreto-distinto-para-pruebas-987654321", "qr")), T0, load)).toEqual({ ok: false, reason: "invalid" });
    for (const bad of ["", "v1", "x.y.z.w", "v1.a.b.c", undefined, null, 42, {}, "v1." + "a".repeat(500)]) {
      expect(await redeem(bad, T0, load), String(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });

  it("un TICKET no sirve como token QR (separación de dominio)", async () => {
    const ticket = (await redeem(qr(), T0, db(session())));
    expect(ticket.ok).toBe(true);
    if (ticket.ok) expect(await redeem(ticket.ticket, T0, db(session()))).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("estado de la sesión (la base de datos manda)", () => {
  it("SESIÓN CERRADA: un QR con MAC válido y vigente se rechaza como 'closed'", async () => {
    expect(await redeem(qr(), T0 + 1_000, db(session({ status: "closed" })))).toEqual({ ok: false, reason: "closed" });
  });

  it("un BORRADOR tampoco admite check-ins", async () => {
    expect(await redeem(qr(), T0 + 1_000, db(session({ status: "draft" })))).toEqual({ ok: false, reason: "closed" });
  });

  it("sesión inexistente (MAC válido pero sin fila): 'invalid', sin revelar nada", async () => {
    expect(await redeem(qr(), T0 + 1_000, db())).toEqual({ ok: false, reason: "invalid" });
  });

  it("la comprobación es EN CADA canje: si se cierra entre dos escaneos, el segundo falla", async () => {
    const state = { current: session() };
    const load: LoadSession = async () => state.current;
    expect((await redeem(qr(), T0 + 1_000, load)).ok).toBe(true);
    state.current = session({ status: "closed" });
    expect(await redeem(qr(), T0 + 2_000, load)).toEqual({ ok: false, reason: "closed" });
  });

  it("un token expirado de una sesión cerrada responde 'expired' (la vigencia se mira antes que la BD)", async () => {
    const load = db(session({ status: "closed" }));
    expect(await redeem(qr(), T0 + 60_000, load)).toEqual({ ok: false, reason: "expired" });
    expect(load).not.toHaveBeenCalled();
  });

  it("si la base de datos falla, el error se propaga (la ruta lo muestra como error genérico, no como aceptado)", async () => {
    const boom: LoadSession = async () => {
      throw new Error("db down");
    };
    await expect(redeem(qr(), T0, boom)).rejects.toThrow("db down");
  });
});

describe("ticket: vida de 3 minutos INDEPENDIENTE de las rotaciones del QR", () => {
  async function ticketAt(scanAt: number) {
    const r = await redeem(qr(SESSION_A, slotAt(scanAt)), scanAt, db(session()));
    if (!r.ok) throw new Error("se esperaba un ticket");
    return r.ticket;
  }

  it("escanear en el segundo 8 y tardar 60–90 s: el ticket SIGUE valiendo aunque el QR haya rotado varias veces", async () => {
    const scanAt = T0 + 8_000;
    const ticket = await ticketAt(scanAt);
    const load = db(session());
    for (const later of [12_000, 20_000, 60_000, 75_000, 90_000, 179_000]) {
      const now = scanAt + later;
      // El QR original ya no sirve (rotó muchas veces)…
      if (later > QR_SLOT_MS + GRACE) expect((await redeem(qr(SESSION_A, SLOT), now, load)).ok, `QR +${later}`).toBe(false);
      // …pero el ticket ya emitido sí.
      expect(await check(ticket, now, load), `ticket +${later}`).toMatchObject({ ok: true, sessionId: SESSION_A, tokenSlot: SLOT });
    }
  });

  it("caduca a los 180 s exactos: entonces hay que escanear un QR nuevo", async () => {
    const scanAt = T0 + 8_000;
    const ticket = await ticketAt(scanAt);
    expect((await check(ticket, scanAt + TTL - 1, db(session()))).ok).toBe(true);
    expect(await check(ticket, scanAt + TTL, db(session()))).toEqual({ ok: false, reason: "expired" });
    expect(await check(ticket, scanAt + TTL + 60_000, db(session()))).toEqual({ ok: false, reason: "expired" });
  });

  it("la validación del ticket no depende del slot del QR vigente: se comprueba en cualquier instante de su vida", async () => {
    const scanAt = T0 + 1_000;
    const ticket = await ticketAt(scanAt);
    for (let t = 0; t < TTL; t += 7_300) expect((await check(ticket, scanAt + t, db(session()))).ok, `+${t}`).toBe(true);
  });

  it("ticket válido: conserva sesión, nonce, slot y emisión (para asociarlos al check-in)", async () => {
    const scanAt = T0 + 2_000;
    const result = await check(await ticketAt(scanAt), scanAt + 30_000, db(session()));
    expect(result).toMatchObject({ ok: true, sessionId: SESSION_A, tokenSlot: SLOT, issuedAtMs: scanAt, expiresAtMs: scanAt + TTL });
    if (result.ok) expect(result.nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    if (result.ok) expect(result.session).toEqual({ id: SESSION_A, title: "Concrete Canoe Team Meeting", location: "Construction Workshop" });
  });

  it("TICKET MODIFICADO (cualquier carácter): inválido y sin consultar la base de datos", async () => {
    const ticket = await ticketAt(T0);
    const load = db(session());
    for (let i = 0; i < ticket.length; i++) {
      const swapped = ticket[i] === "a" ? "b" : "a";
      const tampered = ticket.slice(0, i) + swapped + ticket.slice(i + 1);
      if (tampered === ticket) continue;
      expect((await check(tampered, T0 + 1_000, load)).ok, `posición ${i}`).toBe(false);
    }
    expect(load).not.toHaveBeenCalled();
  });

  it("TICKET DE OTRA SESIÓN: cambiar el sessionId invalida el MAC; el de B solo sirve para B", async () => {
    const ticketA = await ticketAt(T0);
    const parts = ticketA.split(".");
    const sidB = qr(SESSION_B).split(".")[1]; // el id de B en base64url, tal como viaja en el ticket
    const forged = [parts[0], sidB, ...parts.slice(2)].join(".");
    expect(await check(forged, T0 + 1_000, db(session(), session({ id: SESSION_B })))).toEqual({ ok: false, reason: "invalid" });

    const load = db(session(), session({ id: SESSION_B, title: "Otro" }));
    const rB = await redeem(qr(SESSION_B), T0, load);
    if (rB.ok) expect(await check(rB.ticket, T0 + 1_000, load)).toMatchObject({ ok: true, sessionId: SESSION_B, session: { title: "Otro" } });
  });

  it("SESIÓN CERRADA: un ticket vigente y auténtico se rechaza como 'closed' (al enviar el check-in)", async () => {
    const scanAt = T0 + 5_000;
    const ticket = await ticketAt(scanAt);
    expect((await check(ticket, scanAt + 30_000, db(session()))).ok).toBe(true);
    expect(await check(ticket, scanAt + 31_000, db(session({ status: "closed" })))).toEqual({ ok: false, reason: "closed" });
  });

  it("un token QR no sirve como ticket; un ticket firmado con la clave del QR tampoco", async () => {
    expect(await check(qr(), T0, db(session()))).toEqual({ ok: false, reason: "invalid" });
    const wrongDomain = (await import("@/lib/tickets")).issueTicket({ key: QR_KEY, sessionId: SESSION_A, tokenSlot: SLOT, now: T0 }).ticket;
    expect(await check(wrongDomain, T0, db(session()))).toEqual({ ok: false, reason: "invalid" });
  });

  it("HORA DEL SERVIDOR: el dispositivo no influye en la vigencia del ticket", async () => {
    vi.useFakeTimers();
    const ticket = await ticketAt(T0);
    for (const deviceClock of ["2001-01-01T00:00:00Z", "2099-12-31T23:59:59Z"]) {
      vi.setSystemTime(new Date(deviceClock));
      expect((await check(ticket, T0 + 90_000, db(session()))).ok, deviceClock).toBe(true);
      expect((await check(ticket, T0 + 200_000, db(session()))).ok, deviceClock).toBe(false);
    }
  });

  it("basura y tipos raros: 'invalid' sin lanzar", async () => {
    for (const bad of ["", "t1", "a.b.c", undefined, null, 7, {}, "t1." + "a".repeat(400)]) {
      expect(await check(bad, T0, db(session())), String(bad)).toEqual({ ok: false, reason: "invalid" });
    }
  });
});
