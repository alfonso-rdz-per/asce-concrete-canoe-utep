import { describe, expect, it } from "vitest";
import { deriveKey } from "@/lib/crypto/keys";
import {
  TICKET_DEFAULT_TTL_MS,
  TICKET_FUTURE_SKEW_MS,
  TICKET_MAX_TTL_MS,
  issueTicket,
  verifyTicket,
} from "@/lib/tickets";
import { issueQrToken, slotAt, verifyQrToken } from "@/lib/tokens";
import { SESSION_A, SESSION_B, T0 } from "../helpers/clock";

const SECRET = "secreto-de-servidor-para-pruebas-0123456789";
const KEY = deriveKey(SECRET, "ticket");
const SLOT = slotAt(T0);

const issue = (over: Partial<Parameters<typeof issueTicket>[0]> = {}) =>
  issueTicket({ key: KEY, sessionId: SESSION_A, tokenSlot: SLOT, now: T0, ...over });
const verify = (ticket: unknown, now: number, ttlMs?: number, key = KEY) => verifyTicket({ key, ticket, now, ttlMs });

describe("emisión y formato", () => {
  it("t1.<sid>.<nonce>.<emitido>.<slot>.<mac>", () => {
    const { ticket, nonce, expiresAtMs } = issue();
    expect(ticket).toMatch(/^t1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.[0-9a-z]{1,10}\.[0-9a-z]{1,10}\.[A-Za-z0-9_-]{22}$/);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(expiresAtMs).toBe(T0 + TICKET_DEFAULT_TTL_MS);
  });

  it("cada ticket lleva un nonce distinto (2000 emisiones, ninguna repetida)", () => {
    const nonces = new Set(Array.from({ length: 2_000 }, () => issue().nonce));
    expect(nonces.size).toBe(2_000);
  });

  it("rechaza sesión no UUID, TTL inválido y slot inválido", () => {
    expect(() => issue({ sessionId: "1" })).toThrow(TypeError);
    for (const bad of [0, -1, 1.5, NaN, TICKET_MAX_TTL_MS + 1]) {
      expect(() => issue({ ttlMs: bad }), String(bad)).toThrow(RangeError);
    }
    expect(() => issue({ tokenSlot: -1 })).toThrow(RangeError);
  });
});

describe("verificación y contenido", () => {
  it("conserva sesión, nonce, emisión y slot (para auditoría y asociarlos al check-in)", () => {
    const { ticket, nonce } = issue({ now: T0 + 1_234 });
    expect(verify(ticket, T0 + 2_000)).toEqual({
      ok: true,
      sessionId: SESSION_A,
      nonce,
      issuedAtMs: T0 + 1_234,
      tokenSlot: SLOT,
      expiresAtMs: T0 + 1_234 + TICKET_DEFAULT_TTL_MS,
    });
  });

  it("está ligado a UNA sesión: no se puede cambiar el sessionId", () => {
    const parts = issue().ticket.split(".");
    parts[1] = issue({ sessionId: SESSION_B }).ticket.split(".")[1];
    expect(verify(parts.join("."), T0)).toEqual({ ok: false, reason: "bad_mac" });
  });
});

describe("expiración (hora del servidor)", () => {
  it("vale 3 minutos por defecto: válido a +179,999 s, expirado a +180 s", () => {
    const { ticket } = issue();
    expect(verify(ticket, T0)).toMatchObject({ ok: true });
    expect(verify(ticket, T0 + 179_999)).toMatchObject({ ok: true });
    expect(verify(ticket, T0 + 180_000)).toEqual({ ok: false, reason: "expired" });
    expect(verify(ticket, T0 + 3_600_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("respeta un TTL configurado", () => {
    const { ticket } = issue({ ttlMs: 60_000 });
    expect(verify(ticket, T0 + 59_999, 60_000)).toMatchObject({ ok: true });
    expect(verify(ticket, T0 + 60_000, 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("no se puede prolongar alterando la fecha de emisión", () => {
    const parts = issue().ticket.split(".");
    parts[3] = (T0 + 170_000).toString(36); // reloj del ticket 170 s más tarde
    expect(verify(parts.join("."), T0 + 300_000)).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("un ticket emitido en el futuro se rechaza, con tolerancia de reloj entre instancias", () => {
    const future = issue({ now: T0 + TICKET_FUTURE_SKEW_MS + 1 }).ticket;
    expect(verify(future, T0)).toEqual({ ok: false, reason: "not_yet_valid" });
    const nearFuture = issue({ now: T0 + TICKET_FUTURE_SKEW_MS }).ticket;
    expect(verify(nearFuture, T0)).toMatchObject({ ok: true });
  });

  it("FALLA CERRADO ante una hora inválida, al emitir y al verificar", () => {
    const { ticket } = issue();
    for (const bad of [NaN, undefined, null, "1800000000000", -1, Infinity]) {
      expect(() => verify(ticket, bad as number), `verify ${String(bad)}`).toThrow(RangeError);
      expect(() => issue({ now: bad as number }), `issue ${String(bad)}`).toThrow(RangeError);
    }
  });

  it("valida el rango del TTL al verificar", () => {
    const { ticket } = issue();
    for (const bad of [0, -5, 1.5, TICKET_MAX_TTL_MS + 1]) {
      expect(() => verify(ticket, T0, bad), String(bad)).toThrow(RangeError);
    }
  });
});

describe("relación con el token QR (por qué existe el ticket)", () => {
  const qrKey = deriveKey(SECRET, "qr");

  it("permite completar el formulario mucho después de que el QR expirara", () => {
    const qr = issueQrToken({ key: qrKey, sessionId: SESSION_A, slot: SLOT });
    const scanAt = T0 + 9_000;
    const redeemed = verifyQrToken({ key: qrKey, token: qr, now: scanAt, graceMs: 5_000 });
    expect(redeemed.ok).toBe(true);

    const { ticket } = issueTicket({ key: KEY, sessionId: SESSION_A, tokenSlot: SLOT, now: scanAt });
    const submitAt = scanAt + 75_000; // 75 s escribiendo ASCE ID y Name
    expect(verifyQrToken({ key: qrKey, token: qr, now: submitAt, graceMs: 5_000 })).toEqual({ ok: false, reason: "expired" });
    expect(verify(ticket, submitAt)).toMatchObject({ ok: true, tokenSlot: SLOT });
  });

  it("un token QR no sirve como ticket ni un ticket como token QR", () => {
    const qr = issueQrToken({ key: qrKey, sessionId: SESSION_A, slot: SLOT });
    expect(verify(qr, T0).ok).toBe(false);
    const { ticket } = issue();
    expect(verifyQrToken({ key: qrKey, token: ticket, now: T0, graceMs: 5_000 }).ok).toBe(false);
  });

  it("separación de dominio: la clave de QR no valida tickets", () => {
    const { ticket } = issueTicket({ key: qrKey, sessionId: SESSION_A, tokenSlot: SLOT, now: T0 });
    expect(verify(ticket, T0)).toEqual({ ok: false, reason: "bad_mac" });
  });
});

describe("autenticidad y entradas malformadas", () => {
  it("cualquier alteración de un solo carácter invalida el ticket", () => {
    const { ticket } = issue();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.";
    for (let i = 0; i < ticket.length; i++) {
      for (const c of alphabet) {
        if (c === ticket[i]) continue;
        const forged = ticket.slice(0, i) + c + ticket.slice(i + 1);
        expect(verify(forged, T0 + 1).ok, `pos ${i} -> ${c}`).toBe(false);
      }
    }
  });

  it("otra clave no valida", () => {
    const { ticket } = issue();
    expect(verify(ticket, T0, undefined, deriveKey(SECRET + "x", "ticket"))).toEqual({ ok: false, reason: "bad_mac" });
  });

  const good = issue().ticket;
  const cases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["número", 42],
    ["objeto", {}],
    ["vacío", ""],
    ["prefijo incorrecto", good.replace(/^t1/, "t2")],
    ["un segmento de menos", good.split(".").slice(0, 5).join(".")],
    ["un segmento de más", good + ".x"],
    ["espacios", ` ${good} `],
    ["muy largo", "t1." + "A".repeat(10_000)],
    ["unicode", good.replace(/[A-Z]/, "Ñ")],
  ];
  for (const [name, input] of cases) {
    it(`${name} -> rechazado sin lanzar`, () => {
      expect(verify(input, T0).ok).toBe(false);
    });
  }
});
