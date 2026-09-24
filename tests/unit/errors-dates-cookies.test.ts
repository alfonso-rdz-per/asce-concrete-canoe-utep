import { describe, expect, it } from "vitest";
import { addDaysToDateOnly, formatDateOnly, isValidDateOnly, maxDateOnly, todayInElPaso } from "@/lib/dates";
import { describeDbError, GENERIC_ERROR, NO_PERMISSION, NOT_FOUND_MEMBER } from "@/lib/errors";
import { hardenCookieOptions, isSecureRequest } from "@/lib/supabase/cookies";

describe("describeDbError: nunca muestra errores crudos, siempre en inglés", () => {
  it("ASCE ID duplicado", () => {
    expect(describeDbError({ code: "23505", message: 'duplicate key value violates unique constraint "members_asce_id_key"' })).toEqual({
      field: "asceId",
      message: "That ASCE ID is already registered.",
    });
  });
  it("restricciones de formato", () => {
    const c = (name: string) => describeDbError({ code: "23514", message: `new row violates check constraint "${name}"` });
    expect(c("members_asce_id_format").field).toBe("asceId");
    expect(c("members_name_length").field).toBe("name");
    expect(c("members_email_format").field).toBe("email");
    expect(c("members_deactivated_after_joined").field).toBe("joinedOn");
    expect(c("otra_restriccion").message).toBe("Some of the values are not valid.");
  });
  it("permisos, no encontrado y desconocido", () => {
    expect(describeDbError({ code: "42501", message: "permission denied for table members" }).message).toBe(NO_PERMISSION);
    expect(describeDbError({ code: "PGRST116" }).message).toBe(NOT_FOUND_MEMBER);
    expect(describeDbError({ code: "XX000", message: "algo interno con datos sensibles" }).message).toBe(GENERIC_ERROR);
    expect(describeDbError(null).message).toBe(GENERIC_ERROR);
    expect(describeDbError(undefined).message).toBe(GENERIC_ERROR);
  });
  it("el texto crudo de la base de datos NUNCA aparece en el mensaje", () => {
    const raw = 'duplicate key value violates unique constraint "members_pkey" DETAIL: Key (id)=(secret)';
    const out = describeDbError({ code: "23505", message: raw });
    expect(out.message).not.toContain("duplicate key");
    expect(out.message).not.toContain("secret");
  });
});

describe("fechas de calendario (America/Denver)", () => {
  it("hoy en El Paso depende de la zona, no de UTC", () => {
    expect(todayInElPaso(Date.parse("2026-09-19T03:30:00Z"))).toBe("2026-09-18"); // 21:30 del día anterior en MDT
    expect(todayInElPaso(Date.parse("2026-09-19T06:00:00Z"))).toBe("2026-09-19"); // 00:00 MDT
    expect(todayInElPaso(Date.parse("2026-01-15T06:59:59Z"))).toBe("2026-01-14"); // invierno: UTC-7
    expect(todayInElPaso(Date.parse("2026-01-15T07:00:00Z"))).toBe("2026-01-15");
  });
  it("validación estricta", () => {
    expect(isValidDateOnly("2026-09-19")).toBe(true);
    expect(isValidDateOnly("2026-02-29")).toBe(false);
    expect(isValidDateOnly("2028-02-29")).toBe(true);
    for (const bad of [null, undefined, 5, "", "2026-9-19", "2026/09/19"]) expect(isValidDateOnly(bad)).toBe(false);
  });
  it("formato en inglés sin desplazar el día", () => {
    expect(formatDateOnly("2026-09-19")).toBe("Sep 19, 2026");
    expect(formatDateOnly("2026-01-01")).toBe("Jan 1, 2026");
    expect(formatDateOnly("basura")).toBe("—");
  });
  it("aritmética de fechas", () => {
    expect(addDaysToDateOnly("2026-12-31", 1)).toBe("2027-01-01");
    expect(addDaysToDateOnly("2026-03-01", -1)).toBe("2026-02-28");
    expect(maxDateOnly("2026-09-19", "2026-10-01")).toBe("2026-10-01");
    expect(maxDateOnly("2026-11-01", "2026-10-01")).toBe("2026-11-01");
  });
});

describe("cookies de sesión de administrador", () => {
  it("se fuerzan HttpOnly + SameSite=Lax + path=/ (y Secure en HTTPS), conservando la duración", () => {
    const out = hardenCookieOptions({ maxAge: 400, httpOnly: false, sameSite: "none", path: "/x", domain: "evil.test" }, true);
    expect(out).toMatchObject({ httpOnly: true, sameSite: "lax", secure: true, path: "/", maxAge: 400 });
    expect(hardenCookieOptions(undefined, false)).toEqual({ path: "/", httpOnly: true, sameSite: "lax", secure: false });
  });
  it("detecta HTTPS por x-forwarded-proto o por la URL", () => {
    const h = (v: string | null) => ({ get: () => v });
    expect(isSecureRequest(h("https"))).toBe(true);
    expect(isSecureRequest(h("https,http"))).toBe(true);
    expect(isSecureRequest(h("http"))).toBe(false);
    expect(isSecureRequest(h("http"), "https://example.test/")).toBe(false);
    expect(isSecureRequest(h(null), "https://example.test/")).toBe(true);
    expect(isSecureRequest(h(null), "http://localhost:3000/")).toBe(false);
    expect(isSecureRequest(h(null))).toBe(false);
  });
});
