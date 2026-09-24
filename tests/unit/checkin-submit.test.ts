/**
 * Envío del check-in del estudiante: ticket + identidad (ASCE ID + Name, o el dispositivo recordado por "Remember me"). Núcleo puro con
 * hora, claves y almacén inyectados.
 * El almacén falso reproduce las restricciones de la base de datos (una asistencia por miembro y sesión, un ticket por check-in,
 * sesión y miembro activos) y registra los intentos como `checkin_attempts`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { GateSession } from "@/lib/checkin/gate";
import {
  DEFAULT_LIMITS,
  submitCheckin,
  type AttemptRecord,
  type CheckinStore,
  type Credential,
  type DeviceRecord,
  type InsertCheckinResult,
  type MemberRecord,
  type NewCheckin,
} from "@/lib/checkin/submit";
import { CHECKIN_MESSAGES } from "@/lib/checkin/state";
import { deriveKey } from "@/lib/crypto/keys";
import { TICKET_DEFAULT_TTL_MS, issueTicket } from "@/lib/tickets";
import { issueQrToken, slotAt } from "@/lib/tokens";
import { SESSION_A, SESSION_B, T0 } from "../helpers/clock";

const SECRET = "secreto-de-servidor-para-pruebas-0123456789";
const TICKET_KEY = deriveKey(SECRET, "ticket");
const QR_KEY = deriveKey(SECRET, "qr");
const TTL = TICKET_DEFAULT_TTL_MS;
const SLOT = slotAt(T0);
const IP_A = "a".repeat(64);
const IP_B = "b".repeat(64);
const FAILURES = ["bad_credentials", "member_inactive"];

interface World {
  now: number;
  sessions: GateSession[];
  members: Map<string, MemberRecord>;
  attempts: Array<AttemptRecord & { at: number }>;
  checkins: NewCheckin[];
  /** Dispositivos recordados por el HMAC de su token. */
  devices: Map<string, DeviceRecord>;
  touched: string[];
  store: CheckinStore;
  calls: { findMember: number; recordAttempt: number; loadSession: number; insertCheckin: number };
}

function makeWorld(): World {
  const w: World = {
    now: T0,
    sessions: [{ id: SESSION_A, title: "Concrete Canoe Practice", location: null, status: "active" }],
    members: new Map([
      ["A12345678", { id: "m-max", name: "Max Verstappen", active: true }],
      ["A22222222", { id: "m-lily", name: "Lily Nguyen", active: true }],
      ["A33333333", { id: "m-old", name: "Old Member", active: false }],
    ]),
    attempts: [],
    checkins: [],
    devices: new Map(),
    touched: [],
    calls: { findMember: 0, recordAttempt: 0, loadSession: 0, insertCheckin: 0 },
    store: undefined as unknown as CheckinStore,
  };
  w.store = {
    async loadSession(id) {
      w.calls.loadSession++;
      return w.sessions.find((s) => s.id === id) ?? null;
    },
    async findMember(asceId) {
      w.calls.findMember++;
      return w.members.get(asceId) ?? null;
    },
    async findDevice(tokenHash) {
      return w.devices.get(tokenHash) ?? null;
    },
    async touchDevice(deviceId) {
      w.touched.push(deviceId);
    },
    async countFailures(by, value, sinceMs) {
      const field = by === "ticket" ? "nonce" : by === "asce_id" ? "asceId" : "ipHash";
      return w.attempts.filter((a) => FAILURES.includes(a.outcome) && a[field] === value && a.at >= sinceMs).length;
    },
    async recordAttempt(a) {
      w.calls.recordAttempt++;
      w.attempts.push({ ...a, at: w.now });
    },
    async insertCheckin(row): Promise<InsertCheckinResult> {
      w.calls.insertCheckin++;
      const s = w.sessions.find((x) => x.id === row.sessionId);
      if (!s || s.status !== "active") return { ok: false, kind: "session_not_active" };
      const member = [...w.members.values()].find((m) => m.id === row.memberId);
      if (!member?.active) return { ok: false, kind: "member_not_active" };
      if (w.checkins.some((c) => c.sessionId === row.sessionId && c.nonce === row.nonce)) return { ok: false, kind: "ticket_reused" }; // checkins_ticket_single_use
      if (w.checkins.some((c) => c.sessionId === row.sessionId && c.memberId === row.memberId)) return { ok: false, kind: "already_checked_in" }; // checkins_one_per_member_per_session
      w.checkins.push(row);
      return { ok: true, checkedInAt: new Date(w.now).toISOString() };
    },
  };
  return w;
}

let w: World;
beforeEach(() => {
  w = makeWorld();
});

const ticketFor = (sessionId = SESSION_A, issuedAt = w.now) => issueTicket({ key: TICKET_KEY, sessionId, tokenSlot: SLOT, now: issuedAt, ttlMs: TTL }).ticket;
type SubmitOverrides = Partial<Omit<Parameters<typeof submitCheckin>[0], "credential">> & { asceId?: string; name?: string; credential?: Credential };
const submit = (over: SubmitOverrides = {}) => {
  const { asceId = "A12345678", name = "Max", credential, ...rest } = over;
  return submitCheckin({
    ticket: ticketFor(),
    credential: credential ?? { kind: "identity", asceId, name },
    ipHash: IP_A,
    now: w.now,
    ticketKey: TICKET_KEY,
    ticketTtlMs: TTL,
    store: w.store,
    ...rest,
  });
};

describe("ASCE ID + Name correctos", () => {
  it("registra la asistencia y devuelve la sesión; el intento queda como 'success'", async () => {
    const r = await submit();
    expect(r).toMatchObject({ ok: true, session: { id: SESSION_A, title: "Concrete Canoe Practice" }, member: { id: "m-max", name: "Max Verstappen" } });
    expect(w.checkins).toHaveLength(1);
    expect(w.checkins[0]).toMatchObject({ sessionId: SESSION_A, memberId: "m-max", tokenSlot: SLOT, ipHash: IP_A });
    expect(w.attempts.map((a) => a.outcome)).toEqual(["success"]);
  });

  it("no hace falta ningún PIN: el resultado no depende de él (no existe en la interfaz de envío)", async () => {
    const r = await submit({ ...({ pin: "000000" } as object) });
    expect(r.ok).toBe(true);
  });

  it("vale el nombre en cualquier capitalización/acentos y también el nombre completo", async () => {
    expect((await submit({ name: "mAx" })).ok).toBe(true);
    const w2 = makeWorld();
    w2.members.set("A44444444", { id: "m-maria", name: "María José Pérez", active: true });
    const r = await submitCheckin({ ticket: ticketFor(), credential: { kind: "identity", asceId: "A44444444", name: "maria jose perez" }, ipHash: null, now: w2.now, ticketKey: TICKET_KEY, ticketTtlMs: TTL, store: w2.store });
    expect(r.ok).toBe(true);
  });

  it("el ticket lleva su nonce y slot: quedan guardados con el check-in (auditoría)", async () => {
    await submit();
    expect(w.checkins[0].nonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(w.attempts[0]).toMatchObject({ sessionId: SESSION_A, asceId: "A12345678", nonce: w.checkins[0].nonce, ipHash: IP_A });
  });
});

describe("credenciales incorrectas: TODAS iguales hacia fuera (anti-enumeración)", () => {
  it("nombre equivocado, ASCE ID inexistente y miembro inactivo devuelven exactamente lo mismo", async () => {
    const wrongName = await submit({ name: "Lewis" });
    const nonexistent = await submit({ asceId: "A99999999", name: "Max", ticket: ticketFor() });
    const inactive = await submit({ asceId: "A33333333", name: "Old", ticket: ticketFor() });
    expect(wrongName).toEqual({ ok: false, reason: "bad_credentials" });
    expect(nonexistent).toEqual(wrongName);
    expect(inactive).toEqual(wrongName);
    expect(w.checkins).toHaveLength(0);
  });

  it("y hacen el MISMO trabajo (una consulta de miembro y un registro de intento), sin atajos que delaten si existe", async () => {
    for (const asceId of ["A12345678", "A99999999", "A33333333"]) {
      const before = { ...w.calls };
      await submit({ asceId, name: "Wrong", ticket: ticketFor() });
      expect(w.calls.findMember - before.findMember, asceId).toBe(1);
      expect(w.calls.recordAttempt - before.recordAttempt, asceId).toBe(1);
      expect(w.calls.insertCheckin - before.insertCheckin, asceId).toBe(0);
    }
  });

  it("el mensaje al estudiante es genérico y no menciona existencia, actividad ni cuál de los dos datos falló", () => {
    const { message } = CHECKIN_MESSAGES.bad_credentials;
    expect(message).toBe("ASCE ID or name is incorrect. Check them and try again.");
    expect(message).not.toMatch(/exist|not found|inactive|no such|unknown|registered/i);
  });

  it("internamente el registro sí distingue 'member_inactive' de 'bad_credentials' (auditoría), pero nunca se muestra", async () => {
    await submit({ asceId: "A33333333", name: "Old", ticket: ticketFor() });
    await submit({ asceId: "A99999999", name: "Max", ticket: ticketFor() });
    await submit({ name: "Lewis", ticket: ticketFor() });
    expect(w.attempts.map((a) => a.outcome)).toEqual(["member_inactive", "bad_credentials", "bad_credentials"]);
  });

  it("un miembro inactivo con el nombre CORRECTO tampoco entra", async () => {
    expect(await submit({ asceId: "A33333333", name: "Old Member" })).toEqual({ ok: false, reason: "bad_credentials" });
    expect(w.checkins).toHaveLength(0);
  });

  it("un fallo NO gasta el ticket: se puede corregir el nombre y volver a intentar con el mismo ticket", async () => {
    const ticket = ticketFor();
    expect((await submit({ ticket, name: "Lewis" })).ok).toBe(false);
    expect((await submit({ ticket, name: "Max" })).ok).toBe(true);
  });
});

describe("duplicados y reutilización", () => {
  it("un segundo check-in del mismo miembro en la sesión se rechaza ('already_checked_in') y solo hay UNA asistencia", async () => {
    expect((await submit()).ok).toBe(true);
    expect(await submit({ ticket: ticketFor() })).toEqual({ ok: false, reason: "already_checked_in" });
    expect(w.checkins).toHaveLength(1);
    expect(w.attempts.map((a) => a.outcome)).toEqual(["success", "already_checked_in"]);
  });

  it("un ticket produce como máximo UN check-in: otro miembro con el MISMO ticket se rechaza (anti-replay)", async () => {
    const ticket = ticketFor();
    expect((await submit({ ticket })).ok).toBe(true);
    expect(await submit({ ticket, asceId: "A22222222", name: "Lily" })).toEqual({ ok: false, reason: "ticket_invalid" });
    expect(w.checkins).toHaveLength(1);
  });
});

describe("ticket y QR", () => {
  it("TICKET EXPIRADO (más de 3 min): 'ticket_expired', queda registrado y no se mira a ningún miembro", async () => {
    const ticket = ticketFor(SESSION_A, T0);
    w.now = T0 + TTL;
    expect(await submit({ ticket })).toEqual({ ok: false, reason: "ticket_expired" });
    expect(w.calls.findMember).toBe(0);
    expect(w.checkins).toHaveLength(0);
    expect(w.attempts.map((a) => a.outcome)).toEqual(["ticket_expired"]);
  });

  it("el ticket sigue valiendo 60–90 s después (aunque el QR haya rotado) y hasta el último instante de sus 3 min", async () => {
    const ticket = ticketFor(SESSION_A, T0 + 8_000);
    for (const later of [12_000, 60_000, 90_000, TTL - 1]) {
      const w2 = makeWorld();
      const r = await submitCheckin({ ticket, credential: { kind: "identity", asceId: "A12345678", name: "Max" }, ipHash: null, now: T0 + 8_000 + later, ticketKey: TICKET_KEY, ticketTtlMs: TTL, store: w2.store });
      expect(r.ok, `+${later / 1000}s`).toBe(true);
    }
  });

  it("SESIÓN CERRADA: ticket auténtico y vigente -> 'session_closed', registrado, sin mirar miembros", async () => {
    w.sessions[0].status = "closed";
    expect(await submit()).toEqual({ ok: false, reason: "session_closed" });
    expect(w.calls.findMember).toBe(0);
    expect(w.attempts.map((a) => a.outcome)).toEqual(["session_not_active"]);
    expect(w.checkins).toHaveLength(0);
  });

  it("si la sesión se cierra JUSTO al insertar (trigger de la BD), también se rechaza", async () => {
    const store: CheckinStore = { ...w.store, insertCheckin: async () => ({ ok: false, kind: "session_not_active" }) };
    expect(await submit({ store })).toEqual({ ok: false, reason: "session_closed" });
  });

  it("QR/ticket INVÁLIDO (alterado, basura, de otra sesión, un token QR): 'ticket_invalid' y NO se escribe nada ni se toca la BD", async () => {
    const good = ticketFor();
    const tampered = good.slice(0, -1) + (good.endsWith("A") ? "B" : "A");
    const qr = issueQrToken({ key: QR_KEY, sessionId: SESSION_A, slot: SLOT });
    const foreignSid = [good.split(".")[0], issueQrToken({ key: QR_KEY, sessionId: SESSION_B, slot: SLOT }).split(".")[1], ...good.split(".").slice(2)].join(".");
    for (const bad of [tampered, "garbage", "", null, undefined, 7, qr, foreignSid]) {
      expect(await submit({ ticket: bad }), String(bad).slice(0, 12)).toEqual({ ok: false, reason: "ticket_invalid" });
    }
    expect(w.calls).toEqual({ findMember: 0, recordAttempt: 0, loadSession: 0, insertCheckin: 0 });
  });

  it("solo llega a la sesión que el ticket nombra: un ticket de la sesión B no registra asistencia en A", async () => {
    w.sessions.push({ id: SESSION_B, title: "Other", location: null, status: "active" });
    const r = await submit({ ticket: ticketFor(SESSION_B) });
    expect(r).toMatchObject({ ok: true, session: { id: SESSION_B } });
    expect(w.checkins.map((c) => c.sessionId)).toEqual([SESSION_B]);
  });
});

describe("rate limiting (por ticket, por ASCE ID y por IP)", () => {
  async function failMany(n: number, over: (i: number) => Partial<Parameters<typeof submitCheckin>[0]> = () => ({})) {
    for (let i = 0; i < n; i++) await submit({ name: "Wrong", ...over(i) });
  }

  it("POR TICKET: tras 5 fallos con el mismo ticket, incluso las credenciales CORRECTAS se bloquean", async () => {
    const ticket = ticketFor();
    await failMany(DEFAULT_LIMITS.perTicket.max, () => ({ ticket, ipHash: null }));
    expect(await submit({ ticket, name: "Max", ipHash: null })).toEqual({ ok: false, reason: "rate_limited" });
    expect(w.checkins).toHaveLength(0);
    // Un ticket NUEVO (otro escaneo) no queda bloqueado por el anterior.
    expect((await submit({ ticket: ticketFor(), ipHash: null })).ok).toBe(true);
  });

  it("los 4 primeros fallos no bloquean (el quinto intento correcto aún entra)", async () => {
    const ticket = ticketFor();
    await failMany(DEFAULT_LIMITS.perTicket.max - 1, () => ({ ticket, ipHash: null }));
    expect((await submit({ ticket, name: "Max", ipHash: null })).ok).toBe(true);
  });

  it("POR ASCE ID: 8 fallos (con tickets distintos) bloquean ese ID durante 15 min; otros IDs siguen", async () => {
    await failMany(DEFAULT_LIMITS.perAsceId.max, () => ({ ticket: ticketFor(), ipHash: null }));
    expect(await submit({ ticket: ticketFor(), name: "Max", ipHash: null })).toEqual({ ok: false, reason: "rate_limited" });
    expect((await submit({ ticket: ticketFor(), credential: { kind: "identity", asceId: "A22222222", name: "Lily" }, ipHash: null })).ok).toBe(true);

    // Pasada la ventana de 15 min vuelve a funcionar.
    w.now = T0 + DEFAULT_LIMITS.perAsceId.windowMs + 1_000;
    expect((await submit({ ticket: ticketFor(SESSION_A, w.now), name: "Max", ipHash: null })).ok).toBe(true);
  });

  it("POR IP: 20 fallos desde la misma IP (contra IDs distintos) la bloquean; otra IP sigue; sin IP no se aplica", async () => {
    await failMany(DEFAULT_LIMITS.perIp.max, (i) => ({ ticket: ticketFor(), asceId: `A9${String(i).padStart(7, "0")}`, ipHash: IP_A }));
    expect(await submit({ ticket: ticketFor(), name: "Max", ipHash: IP_A })).toEqual({ ok: false, reason: "rate_limited" });
    expect((await submit({ ticket: ticketFor(), credential: { kind: "identity", asceId: "A22222222", name: "Lily" }, ipHash: IP_B })).ok).toBe(true);
    const w2 = makeWorld();
    for (let i = 0; i < 25; i++) {
      await submitCheckin({ ticket: ticketFor(), credential: { kind: "identity", asceId: `A9${String(i).padStart(7, "0")}`, name: "x" }, ipHash: null, now: w2.now, ticketKey: TICKET_KEY, ticketTtlMs: TTL, store: w2.store });
    }
    expect((await submitCheckin({ ticket: ticketFor(), credential: { kind: "identity", asceId: "A12345678", name: "Max" }, ipHash: null, now: w2.now, ticketKey: TICKET_KEY, ticketTtlMs: TTL, store: w2.store })).ok).toBe(true);
  });

  it("el bloqueo es igual de opaco para un ID que existe y uno que no (no permite enumerar)", async () => {
    await failMany(DEFAULT_LIMITS.perAsceId.max, () => ({ ticket: ticketFor(), asceId: "A12345678", ipHash: null }));
    await failMany(DEFAULT_LIMITS.perAsceId.max, () => ({ ticket: ticketFor(), asceId: "A00000000", ipHash: null }));
    const existing = await submit({ ticket: ticketFor(), asceId: "A12345678", ipHash: null });
    const missing = await submit({ ticket: ticketFor(), asceId: "A00000000", ipHash: null });
    expect(existing).toEqual({ ok: false, reason: "rate_limited" });
    expect(missing).toEqual(existing);
  });

  it("solo cuentan los FALLOS de credenciales: los éxitos, duplicados y tickets caducados no bloquean a nadie", async () => {
    expect((await submit()).ok).toBe(true);
    for (let i = 0; i < 10; i++) await submit({ ticket: ticketFor() }); // ya registrado -> already_checked_in
    w.now = T0 + 2 * TTL;
    for (let i = 0; i < 10; i++) await submit({ ticket: ticketFor(SESSION_A, T0) }); // caducados
    w.now = T0;
    expect(w.attempts.filter((a) => FAILURES.includes(a.outcome))).toHaveLength(0);
    expect((await submit({ ticket: ticketFor(), asceId: "A22222222", name: "Lily" })).ok).toBe(true);
  });

  it("un bloqueo NO escribe filas nuevas (evita amplificar escrituras); el mensaje pide esperar y volver a escanear", async () => {
    const ticket = ticketFor();
    await failMany(DEFAULT_LIMITS.perTicket.max, () => ({ ticket, ipHash: null }));
    const rows = w.attempts.length;
    for (let i = 0; i < 5; i++) await submit({ ticket, ipHash: null });
    expect(w.attempts).toHaveLength(rows);
    expect(CHECKIN_MESSAGES.rate_limited.message).toBe("Too many attempts. Wait a few minutes, then scan the QR code again.");
  });
});

describe("dispositivo recordado (Remember me): identifica al miembro, NO sustituye a nada más", () => {
  const HASH = "d".repeat(64);
  const remember = (over: Partial<DeviceRecord> = {}) => {
    w.devices.set(HASH, { deviceId: "dev-1", createdAtMs: T0 - 1_000, expiresAtMs: T0 + 86_400_000, revoked: false, member: { id: "m-max", name: "Max Verstappen", active: true }, ...over });
  };
  const viaDevice = (over: SubmitOverrides = {}) => submit({ credential: { kind: "device", tokenHash: HASH }, ...over });

  it("un dispositivo vigente registra la asistencia del miembro recordado (con su nombre registrado) y renueva el dispositivo", async () => {
    remember();
    const r = await viaDevice();
    expect(r).toMatchObject({ ok: true, member: { id: "m-max", name: "Max Verstappen" }, deviceId: "dev-1" });
    expect(w.checkins).toEqual([expect.objectContaining({ sessionId: SESSION_A, memberId: "m-max", tokenSlot: SLOT })]);
    expect(w.touched).toEqual(["dev-1"]);
    // El intento queda registrado SIN ASCE ID (no se tecleó ninguno).
    expect(w.attempts.map((a) => [a.outcome, a.asceId])).toEqual([["success", null]]);
  });

  it("el QR/ticket SIGUE siendo obligatorio: sin ticket válido no se mira ni el dispositivo", async () => {
    remember();
    for (const ticket of [undefined, "", "basura", ticketFor().slice(0, -3) + "AAA", "v1." + "x".repeat(60)]) {
      expect(await viaDevice({ ticket }), String(ticket)).toEqual({ ok: false, reason: "ticket_invalid" });
    }
    expect(w.checkins).toHaveLength(0);
    expect(w.touched).toEqual([]);
  });

  it("un ticket CADUCADO o de una sesión CERRADA no entra aunque el dispositivo sea válido", async () => {
    remember();
    w.now = T0 + 2 * TTL;
    expect(await viaDevice({ ticket: ticketFor(SESSION_A, T0) })).toEqual({ ok: false, reason: "ticket_expired" });
    w.now = T0;
    w.sessions[0].status = "closed";
    expect(await viaDevice({ ticket: ticketFor() })).toEqual({ ok: false, reason: "session_closed" });
    expect(w.checkins).toHaveLength(0);
  });

  it("token DESCONOCIDO, REVOCADO, CADUCADO o pasado del tope absoluto: 'device_unrecognized' y no se registra asistencia", async () => {
    expect(await viaDevice()).toEqual({ ok: false, reason: "device_unrecognized" }); // no existe
    remember({ revoked: true });
    expect(await viaDevice({ ticket: ticketFor() })).toEqual({ ok: false, reason: "device_unrecognized" });
    remember({ expiresAtMs: T0 - 1 });
    expect(await viaDevice({ ticket: ticketFor() })).toEqual({ ok: false, reason: "device_unrecognized" });
    remember({ createdAtMs: T0 - 366 * 86_400_000, expiresAtMs: T0 + 86_400_000 }); // más de 365 días desde la creación
    expect(await viaDevice({ ticket: ticketFor() })).toEqual({ ok: false, reason: "device_unrecognized" });
    expect(w.checkins).toHaveLength(0);
    expect(w.touched).toEqual([]);
  });

  it("un miembro INACTIVO no entra con su dispositivo (mismo resultado que un token inexistente)", async () => {
    remember({ member: { id: "m-old", name: "Old Member", active: false } });
    const inactive = await viaDevice();
    w.devices.clear();
    const unknown = await viaDevice({ ticket: ticketFor() });
    expect(inactive).toEqual({ ok: false, reason: "device_unrecognized" });
    expect(unknown).toEqual(inactive);
    expect(w.attempts.map((a) => a.outcome)).toEqual(["member_inactive", "bad_credentials"]);
    expect(w.checkins).toHaveLength(0);
  });

  it("una sola asistencia por miembro y sesión: repetir con el dispositivo (ticket nuevo) -> already_checked_in", async () => {
    remember();
    expect((await viaDevice()).ok).toBe(true);
    expect(await viaDevice({ ticket: ticketFor() })).toEqual({ ok: false, reason: "already_checked_in" });
    expect(w.checkins).toHaveLength(1);
  });

  it("anti-replay: un ticket que ya produjo un check-in no vale para otro miembro identificado con el dispositivo", async () => {
    remember({ deviceId: "dev-lily", member: { id: "m-lily", name: "Lily Nguyen", active: true } });
    const ticket = ticketFor();
    expect((await submit({ ticket })).ok).toBe(true); // Max entra con ASCE ID + Name y gasta el ticket
    expect(await viaDevice({ ticket })).toEqual({ ok: false, reason: "ticket_invalid" });
    expect(w.checkins.map((c) => c.memberId)).toEqual(["m-max"]);
  });

  it("rate limiting: los tokens malos cuentan como fallos por ticket e IP; agotado el límite ni un dispositivo VÁLIDO entra con ese ticket", async () => {
    const ticket = ticketFor();
    for (let i = 0; i < DEFAULT_LIMITS.perTicket.max; i++) expect(await viaDevice({ ticket, ipHash: null })).toEqual({ ok: false, reason: "device_unrecognized" });
    remember();
    expect(await viaDevice({ ticket, ipHash: null })).toEqual({ ok: false, reason: "rate_limited" });
    expect(w.checkins).toHaveLength(0);

    // Por IP
    const w2 = makeWorld();
    for (let i = 0; i < DEFAULT_LIMITS.perIp.max; i++) {
      await submitCheckin({ ticket: ticketFor(), credential: { kind: "device", tokenHash: "e".repeat(64) }, ipHash: IP_B, now: w2.now, ticketKey: TICKET_KEY, ticketTtlMs: TTL, store: w2.store });
    }
    const blocked = await submitCheckin({ ticket: ticketFor(), credential: { kind: "device", tokenHash: "e".repeat(64) }, ipHash: IP_B, now: w2.now, ticketKey: TICKET_KEY, ticketTtlMs: TTL, store: w2.store });
    expect(blocked).toEqual({ ok: false, reason: "rate_limited" });
  });

  it("si renovar el dispositivo falla, la asistencia YA registrada no se pierde ni se reporta como error", async () => {
    remember();
    const store: CheckinStore = { ...w.store, touchDevice: vi.fn(async () => { throw new Error("db down"); }) };
    const r = await viaDevice({ store });
    expect(r.ok).toBe(true);
    expect(w.checkins).toHaveLength(1);
  });

  it("ASCE ID + Name sigue funcionando igual (y el dispositivo no interviene)", async () => {
    remember();
    const r = await submit();
    expect(r).toMatchObject({ ok: true, member: { id: "m-max" } });
    expect(r.ok && r.deviceId).toBeFalsy();
    expect(w.touched).toEqual([]);
  });
});

describe("errores del almacén y mensajes", () => {
  it("si la base de datos falla, el error se propaga (la acción lo muestra como error genérico, jamás como éxito)", async () => {
    const store: CheckinStore = { ...w.store, findMember: vi.fn(async () => { throw new Error("db down"); }) };
    await expect(submit({ store })).rejects.toThrow("db down");
    expect(w.checkins).toHaveLength(0);
  });

  it("todos los mensajes están en inglés y los que invalidan el ticket piden volver a escanear", () => {
    expect(CHECKIN_MESSAGES.ticket_expired).toEqual({ message: "Your time to check in ran out. Scan the QR code again.", canRetry: false });
    expect(CHECKIN_MESSAGES.session_closed).toEqual({ message: "Check-in is closed for this session.", canRetry: false });
    expect(CHECKIN_MESSAGES.already_checked_in.message).toBe("You're already checked in for this session.");
    expect(CHECKIN_MESSAGES.bad_credentials.canRetry).toBe(true);
    for (const { message } of Object.values(CHECKIN_MESSAGES)) expect(message).not.toMatch(/[áéíóúñ¿¡]|\bPIN\b/);
  });
});
