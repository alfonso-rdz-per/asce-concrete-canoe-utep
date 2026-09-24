import { describe, expect, it } from "vitest";
import { nameMatches, normalizeName } from "@/lib/member-name";
import { parseCheckinForm, parseStudentName } from "@/lib/validation/checkin";

describe("normalizeName", () => {
  it("quita acentos y mayúsculas y colapsa espacios", () => {
    expect(normalizeName("  MARÍA   José  ")).toBe("maria jose");
    expect(normalizeName("Núñez")).toBe("nunez");
    expect(normalizeName("Zoë")).toBe("zoe");
  });
});

describe("nameMatches: el estudiante solo escribe su nombre (sin apellido)", () => {
  it("el nombre de pila acepta al miembro registrado con nombre completo", () => {
    expect(nameMatches("Max", "Max Verstappen")).toBe(true);
    expect(nameMatches("max", "Max Verstappen")).toBe(true);
    expect(nameMatches("MAX", "Max Verstappen")).toBe(true);
    expect(nameMatches("  Max  ", "Max Verstappen")).toBe(true);
  });

  it("también vale el nombre registrado COMPLETO o un prefijo de palabras completas (nombres compuestos)", () => {
    expect(nameMatches("Max Verstappen", "Max Verstappen")).toBe(true);
    expect(nameMatches("Mary Ann", "Mary Ann Smith")).toBe(true);
    expect(nameMatches("Mary", "Mary Ann Smith")).toBe(true);
    expect(nameMatches("Max", "Max")).toBe(true); // registrado solo con el nombre
  });

  it("ignora acentos y mayúsculas en cualquiera de los dos lados", () => {
    expect(nameMatches("Maria", "María José Pérez")).toBe(true);
    expect(nameMatches("maría josé", "Maria Jose Perez")).toBe(true);
    expect(nameMatches("JOSE", "María José Pérez")).toBe(false); // no es el PRIMER nombre
  });

  it("NO acepta prefijos parciales de una palabra, apellidos ni otros nombres", () => {
    expect(nameMatches("Ma", "Max Verstappen")).toBe(false);
    expect(nameMatches("Ma", "Max")).toBe(false);
    expect(nameMatches("Verstappen", "Max Verstappen")).toBe(false);
    expect(nameMatches("Maxine", "Max Verstappen")).toBe(false);
    expect(nameMatches("Max Verstappen Jr", "Max Verstappen")).toBe(false);
    expect(nameMatches("Lewis", "Max Verstappen")).toBe(false);
  });

  it("vacío o solo espacios no coincide nunca (ni con un nombre registrado vacío)", () => {
    for (const [entered, registered] of [["", "Max"], ["   ", "Max"], ["Max", ""], ["", ""]] as const) {
      expect(nameMatches(entered, registered), `${entered}|${registered}`).toBe(false);
    }
  });
});

describe("formulario del estudiante: ASCE ID + Name (sin PIN, sin apellido)", () => {
  const form = (values: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(values)) fd.set(k, v);
    return fd;
  };

  it("normaliza el ASCE ID (recortado) y el nombre (espacios)", () => {
    expect(parseCheckinForm(form({ asceId: " 12345678 ", name: "  Max   " }))).toEqual({ ok: true, data: { asceId: "12345678", name: "Max", remember: false } });
  });

  it("'Remember me on this device': solo la casilla marcada ('on') cuenta; cualquier otro valor o su ausencia = no recordar", () => {
    for (const [raw, expected] of [["on", true], ["", false], ["true", false], ["1", false], ["ON", false]] as const) {
      expect(parseCheckinForm(form({ asceId: "12345678", name: "Max", remember: raw })), raw).toMatchObject({ ok: true, data: { remember: expected } });
    }
    expect(parseCheckinForm(form({ asceId: "12345678", name: "Max" }))).toMatchObject({ ok: true, data: { remember: false } });
  });

  it("errores de FORMATO por campo, en inglés (no dicen nada sobre si un miembro existe)", () => {
    expect(parseCheckinForm(form({ asceId: "", name: "" }))).toEqual({ ok: false, fieldErrors: { asceId: "Enter the ASCE ID.", name: "Enter your name." } });
    expect(parseCheckinForm(form({ asceId: "12", name: "Max" }))).toMatchObject({ ok: false, fieldErrors: { asceId: "ASCE ID must have 3 to 32 digits." } });
    // El ASCE ID del estudiante también es SOLO numérico (misma regla que New Member).
    for (const bad of ["ABC123", "ASCE-123", "123-456", "12A34"]) {
      expect(parseCheckinForm(form({ asceId: bad, name: "Max" })), bad).toEqual({ ok: false, fieldErrors: { asceId: "ASCE ID must contain numbers only." } });
    }
    expect(parseStudentName("x".repeat(121)).error).toBe("Name must be 120 characters or fewer.");
    for (const bad of ["Max\u0000", "Max\u202e", "Ma\u200bx"]) expect(parseStudentName(bad).error, JSON.stringify(bad)).toBe("Name contains invalid characters.");
  });

  it("IGNORA cualquier campo de PIN que llegue (un POST manipulado no cambia nada) y no lo devuelve", () => {
    const parsed = parseCheckinForm(form({ asceId: "12345678", name: "Max", pin: "987654" }));
    expect(parsed).toEqual({ ok: true, data: { asceId: "12345678", name: "Max", remember: false } });
    expect(JSON.stringify(parsed)).not.toContain("987654");
  });
});
