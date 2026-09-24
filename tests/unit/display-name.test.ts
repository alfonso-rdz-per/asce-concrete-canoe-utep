import { describe, expect, it } from "vitest";
import { DISPLAY_NAME_MAX, getDisplayName, getFirstName, getInitials } from "@/lib/auth/display-name";

const withName = (display_name: unknown, email: string | null = "lesley.girlet@example.test") => ({ email, user_metadata: { display_name } });

describe("display_name (solo lectura desde user_metadata)", () => {
  it("usa display_name y saluda con la primera palabra", () => {
    const u = withName("Lesley Girlet");
    expect(getDisplayName(u)).toBe("Lesley Girlet");
    expect(getFirstName(u)).toBe("Lesley");
    expect(getInitials(u)).toBe("LG");
  });

  it("un solo nombre", () => {
    const u = withName("Cesar");
    expect(getFirstName(u)).toBe("Cesar");
    expect(getInitials(u)).toBe("C");
  });

  it("sin display_name: usa la parte anterior al @ del correo", () => {
    for (const meta of [undefined, null, {}, { display_name: undefined }]) {
      const u = { email: "lesley.girlet@example.test", user_metadata: meta as Record<string, unknown> | null | undefined };
      expect(getDisplayName(u)).toBe("lesley.girlet");
      expect(getFirstName(u)).toBe("lesley.girlet");
    }
    expect(getInitials({ email: "lesley.girlet@example.test" })).toBe("LG");
  });

  it("display_name vacío, en blanco o de tipo incorrecto cae al correo", () => {
    for (const bad of ["", "   ", "\n\t", 42, true, {}, [], null]) {
      expect(getFirstName(withName(bad)), String(bad)).toBe("lesley.girlet");
    }
  });

  it("sin nada útil devuelve un respaldo neutro", () => {
    expect(getDisplayName(null)).toBe("Admin");
    expect(getFirstName(undefined)).toBe("Admin");
    expect(getInitials(null)).toBe("A");
    expect(getFirstName({ email: null, user_metadata: {} })).toBe("Admin");
    expect(getFirstName({ email: "@example.test", user_metadata: {} })).not.toBe("");
  });

  it("colapsa espacios y elimina caracteres de control y de reordenación bidireccional", () => {
    const evil = "Ann\u202E  \u0000Lee\u200B\u2066 X";
    const cleaned = getDisplayName(withName(evil));
    expect(cleaned).toBe("Ann Lee X");
    expect(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(cleaned)).toBe(false);
  });

  it("limita la longitud sin partir caracteres astrales (emoji)", () => {
    const long = getDisplayName(withName("A".repeat(300)));
    expect(Array.from(long)).toHaveLength(DISPLAY_NAME_MAX);
    const emoji = getDisplayName(withName("😀".repeat(100)));
    expect(Array.from(emoji)).toHaveLength(DISPLAY_NAME_MAX);
    expect(emoji).not.toContain("�");
  });

  it("es texto NO confiable: el HTML no se interpreta ni se 'sanea' aquí (React lo escapa al pintarlo)", () => {
    const html = '<img src=x onerror="alert(1)">';
    expect(getDisplayName(withName(html))).toBe(html);
  });
});
