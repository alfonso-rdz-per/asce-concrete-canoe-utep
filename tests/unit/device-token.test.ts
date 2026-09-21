import { describe, expect, it } from "vitest";
import { deriveKey } from "@/lib/crypto/keys";
import {
  DEVICE_COOKIE,
  DEVICE_COOKIE_PATH,
  DEVICE_MAX_LIFETIME_MS,
  DEVICE_TTL_MS,
  deviceExpiryMs,
  generateDeviceToken,
  hashDeviceToken,
  isDeviceTokenFormat,
  isDeviceUsable,
  MAX_DEVICES_PER_MEMBER,
} from "@/lib/device-token";

const DAY = 24 * 60 * 60 * 1000;
const KEY = deriveKey("secreto-de-servidor-para-pruebas-0123456789", "device");

describe("token de 'Remember me on this device'", () => {
  it("es aleatorio de 256 bits: formato d1.<43 caracteres base64url> y nunca se repite", () => {
    const tokens = Array.from({ length: 200 }, generateDeviceToken);
    for (const t of tokens) expect(t).toMatch(/^d1\.[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(200);
  });

  it("no contiene datos del miembro ni de la sesión: es un identificador opaco (sin ASCE ID, nombre, fechas)", () => {
    const t = generateDeviceToken();
    expect(t).not.toMatch(/ASCE|A\d{8}|\d{10,}/i);
    expect(Buffer.from(t.slice(3), "base64url")).toHaveLength(32);
  });

  it("solo se guarda su HMAC (hex de 64): determinista, dependiente de la clave y no reversible a simple vista", () => {
    const t = generateDeviceToken();
    const h = hashDeviceToken(t, KEY);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(hashDeviceToken(t, KEY)).toBe(h);
    expect(hashDeviceToken(t, deriveKey("otro-secreto-de-servidor-0123456789-xyz", "device"))).not.toBe(h);
    expect(hashDeviceToken(generateDeviceToken(), KEY)).not.toBe(h);
    expect(h).not.toContain(t.slice(3, 15));
  });

  it("la clave 'device' es distinta de la de QR, ticket e IP (separación de dominio)", () => {
    const secret = "secreto-de-servidor-para-pruebas-0123456789";
    const t = generateDeviceToken();
    const a = hashDeviceToken(t, deriveKey(secret, "device"));
    for (const other of ["qr", "ticket", "ip"] as const) expect(hashDeviceToken(t, deriveKey(secret, other))).not.toBe(a);
  });

  it("valida el formato antes de usarlo: cualquier otra cosa se rechaza (y hash lanza)", () => {
    for (const bad of [undefined, null, 42, "", "d1.", "d2." + "A".repeat(43), "d1." + "A".repeat(42), "d1." + "A".repeat(44), "d1." + "!".repeat(43), "t1.x.y", " d1." + "A".repeat(43)]) {
      expect(isDeviceTokenFormat(bad), String(bad)).toBe(false);
    }
    expect(() => hashDeviceToken("no-es-un-token", KEY)).toThrow(TypeError);
    expect(isDeviceTokenFormat(generateDeviceToken())).toBe(true);
  });

  it("la cookie es de las páginas del estudiante (/c), no del panel de administración ni de la API", () => {
    expect(DEVICE_COOKIE).toBe("asce_device");
    expect(DEVICE_COOKIE_PATH).toBe("/c");
  });
});

describe("caducidad y revocación", () => {
  it("vida de 180 días desde el último uso, con tope absoluto de 365 días desde la creación", () => {
    expect(DEVICE_TTL_MS).toBe(180 * DAY);
    expect(DEVICE_MAX_LIFETIME_MS).toBe(365 * DAY);
    const created = Date.UTC(2026, 8, 19);
    expect(deviceExpiryMs(created, created)).toBe(created + 180 * DAY);
    expect(deviceExpiryMs(created + 100 * DAY, created)).toBe(created + 280 * DAY);
    // Usándolo a diario no se pasa del tope.
    expect(deviceExpiryMs(created + 300 * DAY, created)).toBe(created + 365 * DAY);
    expect(deviceExpiryMs(created + 400 * DAY, created)).toBe(created + 365 * DAY);
  });

  it("un dispositivo vale solo si no está revocado, no ha caducado y no pasó del tope absoluto (hora del servidor)", () => {
    const now = Date.UTC(2026, 8, 19);
    const ok = { createdAtMs: now - 10 * DAY, expiresAtMs: now + 10 * DAY, revoked: false };
    expect(isDeviceUsable(ok, now)).toBe(true);
    expect(isDeviceUsable({ ...ok, revoked: true }, now)).toBe(false);
    expect(isDeviceUsable({ ...ok, expiresAtMs: now }, now)).toBe(false); // caduca exactamente ahora
    expect(isDeviceUsable({ ...ok, expiresAtMs: now - 1 }, now)).toBe(false);
    expect(isDeviceUsable({ ...ok, createdAtMs: now - 365 * DAY }, now)).toBe(false); // tope absoluto
    expect(isDeviceUsable({ ...ok, createdAtMs: now - 365 * DAY + 1 }, now)).toBe(true);
  });

  it("cada miembro conserva a lo sumo unos pocos dispositivos vigentes", () => {
    expect(MAX_DEVICES_PER_MEMBER).toBe(5);
  });
});
