import { describe, expect, it } from "vitest";
import { deriveKey } from "@/lib/crypto/keys";
import {
  QR_EARLY_MS,
  QR_MAX_GRACE_MS,
  QR_SLOT_MS,
  issueQrToken,
  issueQrTokens,
  slotAt,
  verifyQrToken,
} from "@/lib/tokens";
import { SESSION_A, SESSION_B, T0 } from "../helpers/clock";

const SECRET = "secreto-de-servidor-para-pruebas-0123456789";
const KEY = deriveKey(SECRET, "qr");
const GRACE = 5_000;
const SLOT = slotAt(T0);

const token = (sessionId = SESSION_A, slot = SLOT, key = KEY) => issueQrToken({ key, sessionId, slot });
const verify = (t: unknown, now: number, graceMs = GRACE, key = KEY) => verifyQrToken({ key, token: t, now, graceMs });

describe("constantes del diseño", () => {
  it("el QR rota cada 10 s y T0 es inicio de slot", () => {
    expect(QR_SLOT_MS).toBe(10_000);
    expect(T0 % QR_SLOT_MS).toBe(0);
    expect(slotAt(T0)).toBe(T0 / QR_SLOT_MS);
    expect(slotAt(T0 + 9_999)).toBe(SLOT);
    expect(slotAt(T0 + 10_000)).toBe(SLOT + 1);
  });
});

describe("emisión", () => {
  it("formato v1.<sid>.<slot>.<mac> y corto (QR de baja densidad)", () => {
    const t = token();
    expect(t).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[0-9a-z]{1,10}\.[A-Za-z0-9_-]{22}$/);
    expect(t.length).toBeLessThan(64);
  });

  it("es determinista: mismo (clave, sesión, slot) -> mismo token", () => {
    expect(token()).toBe(token());
  });

  it("cambia con el slot, la sesión y la clave", () => {
    const base = token();
    expect(token(SESSION_A, SLOT + 1)).not.toBe(base);
    expect(token(SESSION_B)).not.toBe(base);
    expect(token(SESSION_A, SLOT, deriveKey(SECRET + "x", "qr"))).not.toBe(base);
  });

  it("rechaza sesiones que no son UUID y slots inválidos", () => {
    expect(() => issueQrToken({ key: KEY, sessionId: "123", slot: SLOT })).toThrow(TypeError);
    expect(() => issueQrToken({ key: KEY, sessionId: SESSION_A, slot: -1 })).toThrow(RangeError);
    expect(() => issueQrToken({ key: KEY, sessionId: SESSION_A, slot: 1.5 })).toThrow(RangeError);
  });

  it("issueQrTokens entrega el token actual y el siguiente, con sus intervalos", () => {
    const r = issueQrTokens({ key: KEY, sessionId: SESSION_A, now: T0 + 3_210 });
    expect(r.serverNow).toBe(T0 + 3_210);
    expect(r.current).toEqual({ slot: SLOT, token: token(), startsAtMs: T0, endsAtMs: T0 + 10_000 });
    expect(r.next).toEqual({ slot: SLOT + 1, token: token(SESSION_A, SLOT + 1), startsAtMs: T0 + 10_000, endsAtMs: T0 + 20_000 });
  });
});

describe("ventana de validez: [inicio - 1 s, inicio + 10 s + gracia)", () => {
  it("con gracia por defecto de 5 s", () => {
    const t = token();
    expect(verify(t, T0 - QR_EARLY_MS - 1)).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(verify(t, T0 - QR_EARLY_MS)).toMatchObject({ ok: true });
    expect(verify(t, T0)).toMatchObject({ ok: true });
    expect(verify(t, T0 + 9_999)).toMatchObject({ ok: true });
    expect(verify(t, T0 + 10_000)).toMatchObject({ ok: true }); // ya no se muestra, pero la gracia lo cubre
    expect(verify(t, T0 + 14_999)).toMatchObject({ ok: true });
    expect(verify(t, T0 + 15_000)).toEqual({ ok: false, reason: "expired" });
    expect(verify(t, T0 + 60_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("sin gracia, expira exactamente al terminar su intervalo", () => {
    const t = token();
    expect(verify(t, T0 + 9_999, 0)).toMatchObject({ ok: true });
    expect(verify(t, T0 + 10_000, 0)).toEqual({ ok: false, reason: "expired" });
  });

  it("con la gracia máxima (15 s) sigue acotado", () => {
    const t = token();
    expect(verify(t, T0 + 24_999, QR_MAX_GRACE_MS)).toMatchObject({ ok: true });
    expect(verify(t, T0 + 25_000, QR_MAX_GRACE_MS)).toEqual({ ok: false, reason: "expired" });
  });

  it("devuelve la sesión y el slot verificados", () => {
    expect(verify(token(), T0 + 500)).toEqual({ ok: true, sessionId: SESSION_A, slot: SLOT });
  });

  it("propiedad: la decisión coincide con la regla en 3000 instantes aleatorios", () => {
    const t = token();
    for (let i = 0; i < 3_000; i++) {
      const now = T0 - 5_000 + Math.floor(Math.random() * 30_000);
      const expected = now >= T0 - QR_EARLY_MS && now < T0 + QR_SLOT_MS + GRACE;
      expect(verify(t, now).ok, `now=${now - T0}`).toBe(expected);
    }
  });
});

describe("escenarios de uso", () => {
  it("MULTIUSO: veinte estudiantes canjean el mismo token dentro de su ventana", () => {
    const t = token();
    for (let i = 0; i < 20; i++) {
      expect(verify(t, T0 + i * 400)).toMatchObject({ ok: true, sessionId: SESSION_A });
    }
  });

  it("el QR cambia mientras se escanea: escanear en el último instante y llegar tarde a la red sigue valiendo", () => {
    const shownDuringScan = token(SESSION_A, SLOT);
    // La pantalla ya muestra el QR siguiente, pero la petición del que escaneó el anterior llega 3,2 s después del cambio.
    expect(verify(shownDuringScan, T0 + 10_000 + 3_200)).toMatchObject({ ok: true });
    // Y el QR nuevo también es válido para el que lo escanea justo al cambiar.
    expect(verify(token(SESSION_A, SLOT + 1), T0 + 10_000)).toMatchObject({ ok: true });
  });

  it("CAPTURA de pantalla usada 30 s después: rechazada por expiración", () => {
    expect(verify(token(), T0 + 30_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("FOTO reenviada por mensajería y abierta a los 45 s: rechazada", () => {
    expect(verify(token(), T0 + 45_000)).toEqual({ ok: false, reason: "expired" });
  });

  it("el token siguiente (que la pantalla del admin ya tiene) aún no vale antes de tiempo", () => {
    const { next } = issueQrTokens({ key: KEY, sessionId: SESSION_A, now: T0 + 1_000 });
    expect(verify(next.token, T0 + 1_000)).toEqual({ ok: false, reason: "not_yet_valid" });
    expect(verify(next.token, T0 + 9_000)).toMatchObject({ ok: true }); // 1 s de tolerancia previa
  });

  it("usa SOLO la hora del servidor recibida: no hay ninguna otra fuente de tiempo", () => {
    const t = token();
    const before = verify(t, T0 + 1_000);
    const dateNow = Date.now;
    Date.now = () => 0; // aunque el reloj del proceso mienta, la decisión depende solo de `now`
    try {
      expect(verify(t, T0 + 1_000)).toEqual(before);
      expect(verify(t, T0 + 20_000)).toEqual({ ok: false, reason: "expired" });
    } finally {
      Date.now = dateNow;
    }
  });
});

describe("autenticidad", () => {
  it("cualquier alteración de un solo carácter invalida el token (todas las posiciones)", () => {
    const t = token();
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.";
    let checked = 0;
    for (let i = 0; i < t.length; i++) {
      for (const c of alphabet) {
        if (c === t[i]) continue;
        const forged = t.slice(0, i) + c + t.slice(i + 1);
        expect(verify(forged, T0 + 500).ok, `pos ${i} -> ${c}`).toBe(false);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(t.length * 60);
  });

  it("no se puede reetiquetar el slot (adelantar la ventana) reutilizando el MAC", () => {
    const [v, sid, , mac] = token().split(".");
    const later = `${v}.${sid}.${(SLOT + 5).toString(36)}.${mac}`;
    expect(verify(later, T0 + 51_000)).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("no se puede cambiar de sesión reutilizando el MAC", () => {
    const [v, , slot, mac] = token(SESSION_A).split(".");
    const sidB = token(SESSION_B).split(".")[1];
    expect(verify(`${v}.${sidB}.${slot}.${mac}`, T0 + 500)).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("un token de otra sesión es válido solo para SU sesión", () => {
    const r = verify(token(SESSION_B), T0 + 500);
    expect(r).toEqual({ ok: true, sessionId: SESSION_B, slot: SLOT });
  });

  it("otra clave (o la clave de otro propósito) no valida", () => {
    const t = token();
    expect(verify(t, T0 + 500, GRACE, deriveKey(SECRET + "x", "qr"))).toEqual({ ok: false, reason: "bad_mac" });
    expect(verify(t, T0 + 500, GRACE, deriveKey(SECRET, "ticket"))).toEqual({ ok: false, reason: "bad_mac" });
  });

  it("la MAC se comprueba antes que la vigencia (un token falso caducado no revela nada del tiempo)", () => {
    const [v, sid, slot] = token().split(".");
    const forged = `${v}.${sid}.${slot}.${"A".repeat(22)}`;
    expect(verify(forged, T0 + 999_999)).toEqual({ ok: false, reason: "bad_mac" });
  });
});

describe("entradas malformadas", () => {
  const valid = token();
  const [, sid, slot, mac] = valid.split(".");
  const cases: Array<[string, unknown]> = [
    ["undefined", undefined],
    ["null", null],
    ["número", 123],
    ["objeto", {}],
    ["arreglo", [valid]],
    ["cadena vacía", ""],
    ["solo prefijo", "v1"],
    ["prefijo de otra versión", `v2.${sid}.${slot}.${mac}`],
    ["ticket en lugar de token", `t1.${sid}.${slot}.${mac}`],
    ["segmento de menos", `v1.${sid}.${slot}`],
    ["segmento de más", `${valid}.extra`],
    ["slot en mayúsculas", `v1.${sid}.${slot.toUpperCase()}.${mac}`],
    ["slot con ceros a la izquierda", `v1.${sid}.0${slot}.${mac}`],
    ["slot vacío", `v1.${sid}..${mac}`],
    ["slot desbordado", `v1.${sid}.zzzzzzzzzzzz.${mac}`],
    ["sid corto", `v1.${sid.slice(1)}.${slot}.${mac}`],
    ["mac corto", `v1.${sid}.${slot}.${mac.slice(1)}`],
    ["espacio al inicio", ` ${valid}`],
    ["salto de línea al final", `${valid}\n`],
    ["url completa", `https://example.test/c/${valid}`],
    ["unicode", `v1.${sid}.${slot}.${"ñ".repeat(22)}`],
    ["muy largo", "v1." + "A".repeat(5_000)],
  ];
  for (const [name, input] of cases) {
    it(`${name} -> rechazado sin lanzar`, () => {
      const r = verify(input, T0 + 500);
      expect(r.ok).toBe(false);
    });
  }

  it("los casos estructurales se reportan como malformed", () => {
    expect(verify("", T0)).toEqual({ ok: false, reason: "malformed" });
    expect(verify(`${valid}.extra`, T0)).toEqual({ ok: false, reason: "malformed" });
    expect(verify("v1." + "A".repeat(5_000), T0)).toEqual({ ok: false, reason: "malformed" });
  });
});

describe("configuración de gracia", () => {
  it("valida el rango 0..15000 (entero)", () => {
    const t = token();
    for (const bad of [-1, 1.5, NaN, Infinity, QR_MAX_GRACE_MS + 1]) {
      expect(() => verify(t, T0, bad), String(bad)).toThrow(RangeError);
    }
    for (const good of [0, 1, 5_000, QR_MAX_GRACE_MS]) {
      expect(() => verify(t, T0, good), String(good)).not.toThrow();
    }
  });

  it("FALLA CERRADO ante una hora inválida: nunca acepta un token por no poder comparar tiempos", () => {
    const t = token();
    for (const bad of [NaN, undefined, null, "1800000000000", -1, Infinity, {}]) {
      expect(() => verifyQrToken({ key: KEY, token: t, now: bad as number, graceMs: GRACE }), String(bad)).toThrow(RangeError);
    }
  });

  it("slotAt rechaza horas inválidas", () => {
    for (const bad of [-1, NaN, Infinity]) expect(() => slotAt(bad)).toThrow(RangeError);
  });
});

describe("fechas lejanas", () => {
  it("un token del año 2100 sigue siendo corto y válido en su ventana", () => {
    const y2100 = Date.UTC(2100, 0, 1);
    const slot = slotAt(y2100);
    const t = issueQrToken({ key: KEY, sessionId: SESSION_A, slot });
    expect(t.length).toBeLessThan(64);
    expect(verify(t, y2100 + 2_000)).toMatchObject({ ok: true, slot });
  });
});
