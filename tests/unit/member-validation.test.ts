import { describe, expect, it } from "vitest";
import { addDaysToDateOnly } from "@/lib/dates";
import { idSchema, parseAsceId, parseEmail, parseJoinedOn, parseMemberForm, parseName } from "@/lib/validation/member";

const TODAY = "2026-09-19";

function form(values: Record<string, string | File>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
}

describe("ASCE ID: SOLO números (validación real en el servidor)", () => {
  it("acepta únicamente dígitos, con los ceros iniciales, y recorta espacios", () => {
    for (const ok of ["12345", "001234", "20261234", "0000000", "123"]) expect(parseAsceId(ok).value, ok).toBe(ok);
    expect(parseAsceId("  12345  ").value).toBe("12345");
    expect(parseAsceId("1".repeat(32)).value).toBe("1".repeat(32));
  });

  it("rechaza cualquier carácter que no sea un dígito ASCII (letras, guiones, espacios, símbolos, dígitos de otros alfabetos)", () => {
    for (const bad of ["ABC123", "ASCE-123", "123-456", "12A34", "abc", "12 34", "12_34", "12.34", "12,34", "1e5", "+12345", "-12345", "12345\n6", "<b>1</b>", "é123", "١٢٣٤٥", "１２３４５"]) {
      expect(parseAsceId(bad).error, bad).toBe("ASCE ID must contain numbers only.");
    }
  });

  it("vacío o demasiado corto/largo: mensajes en inglés (y ya no existe el mensaje de letras y guiones)", () => {
    expect(parseAsceId("").error).toBe("Enter the ASCE ID.");
    expect(parseAsceId("   ").error).toBe("Enter the ASCE ID.");
    expect(parseAsceId("12").error).toBe("ASCE ID must have 3 to 32 digits.");
    expect(parseAsceId("1".repeat(33)).error).toBe("ASCE ID must have 3 to 32 digits.");
    for (const v of ["", "ab", "ABC123", "1".repeat(40)]) expect(parseAsceId(v).error ?? "").not.toMatch(/letters|hyphens/);
  });

  it("el formulario de miembros lo valida en el servidor aunque el navegador no lo haga (POST manipulado)", () => {
    for (const bad of ["ABC123", "ASCE-123", "123-456", "12A34"]) {
      const r = parseMemberForm(form({ asceId: bad, name: "Ana", email: "", joinedOn: "" }), { mode: "create", today: TODAY });
      expect(r, bad).toEqual({ ok: false, fieldErrors: { asceId: "ASCE ID must contain numbers only." } });
    }
    for (const ok of ["12345", "001234", "20261234"]) {
      expect(parseMemberForm(form({ asceId: ok, name: "Ana", email: "", joinedOn: "" }), { mode: "create", today: TODAY }).ok, ok).toBe(true);
    }
  });
});

describe("casilla Design Team", () => {
  const base = { asceId: "12345", name: "Ana", email: "", joinedOn: "" };
  it("por defecto está APAGADA (sin enviar la casilla)", () => {
    expect(parseMemberForm(form(base), { mode: "create", today: TODAY })).toMatchObject({ ok: true, data: { isDesignTeam: false } });
  });
  it("solo la casilla marcada ('on') la enciende; cualquier otro valor no", () => {
    for (const [raw, expected] of [["on", true], ["", false], ["true", false], ["1", false], ["ON", false], ["off", false]] as const) {
      expect(parseMemberForm(form({ ...base, designTeam: raw }), { mode: "create", today: TODAY }), raw).toMatchObject({ ok: true, data: { isDesignTeam: expected } });
    }
  });
  it("también se puede cambiar al editar", () => {
    expect(parseMemberForm(form({ ...base, joinedOn: "2026-01-01", designTeam: "on" }), { mode: "edit", today: TODAY })).toMatchObject({ ok: true, data: { isDesignTeam: true } });
    expect(parseMemberForm(form({ ...base, joinedOn: "2026-01-01" }), { mode: "edit", today: TODAY })).toMatchObject({ ok: true, data: { isDesignTeam: false } });
  });
});

describe("nombre", () => {
  it("recorta y colapsa espacios", () => {
    expect(parseName("  Daniel    Pérez  ").value).toBe("Daniel Pérez");
  });
  it("rechaza vacío, demasiado largo y caracteres de control", () => {
    expect(parseName("   ").error).toBe("Enter the full name.");
    expect(parseName("x".repeat(121)).error).toBe("Name must be 120 characters or fewer.");
    expect(parseName("x".repeat(120)).value).toHaveLength(120);
    expect(parseName("Ana\u0000Lee").error).toBe("Name contains invalid characters.");
  });
});

describe("email (opcional)", () => {
  it("vacío -> null; se pasa a minúsculas", () => {
    expect(parseEmail("").value).toBeNull();
    expect(parseEmail("   ").value).toBeNull();
    expect(parseEmail(" Ana@Example.TEST ").value).toBe("ana@example.test");
  });
  it("rechaza formatos inválidos", () => {
    for (const bad of ["ana", "ana@", "@example.test", "a b@example.test", "ana@@example.test", `${"a".repeat(250)}@x.co`]) {
      expect(parseEmail(bad).error, bad).toBe("Enter a valid email address.");
    }
  });
});

describe("fecha de ingreso (joined_on)", () => {
  it("alta: vacío = usar el valor por defecto de la base de datos", () => {
    expect(parseJoinedOn("", "create", TODAY).value).toBeNull();
  });
  it("edición: es obligatoria", () => {
    expect(parseJoinedOn("", "edit", TODAY).error).toBe("Enter the join date.");
  });
  it("solo fechas de calendario reales", () => {
    for (const bad of ["2026-02-30", "2026-13-01", "2026-9-1", "19/09/2026", "hoy", "2026-09-19T00:00:00Z"]) {
      expect(parseJoinedOn(bad, "create", TODAY).error, bad).toBe("Enter a valid date.");
    }
    expect(parseJoinedOn("2024-02-29", "create", TODAY).value).toBe("2024-02-29");
    expect(parseJoinedOn("2025-02-29", "create", TODAY).error).toBe("Enter a valid date.");
  });
  it("límites: no antes de 2000 ni más de un año en el futuro", () => {
    expect(parseJoinedOn("1999-12-31", "create", TODAY).error).toBe("The join date can't be before 2000.");
    expect(parseJoinedOn("2000-01-01", "create", TODAY).value).toBe("2000-01-01");
    expect(parseJoinedOn(addDaysToDateOnly(TODAY, 366), "create", TODAY).value).toBeDefined();
    expect(parseJoinedOn(addDaysToDateOnly(TODAY, 367), "create", TODAY).error).toBe("The join date can't be more than a year in the future.");
    expect(parseJoinedOn(TODAY, "edit", TODAY).value).toBe(TODAY);
  });
});

describe("parseMemberForm", () => {
  it("formulario válido", () => {
    const r = parseMemberForm(form({ asceId: " 001234 ", name: " Ana  López ", email: "", joinedOn: "" }), { mode: "create", today: TODAY });
    expect(r).toEqual({ ok: true, data: { asceId: "001234", name: "Ana López", email: null, joinedOn: null, position: "Member", isDesignTeam: false } });
  });

  it("junta TODOS los errores por campo", () => {
    const r = parseMemberForm(form({ asceId: "x", name: "", email: "no", joinedOn: "2026-02-31" }), { mode: "edit", today: TODAY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(["asceId", "email", "joinedOn", "name"]);
  });

  it("campos ausentes o de tipo archivo cuentan como vacíos (no lanzan)", () => {
    const r = parseMemberForm(form({ asceId: new File(["x"], "x.txt"), name: "Ana" }), { mode: "create", today: TODAY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.fieldErrors.asceId).toBe("Enter the ASCE ID.");
    expect(parseMemberForm(new FormData(), { mode: "create", today: TODAY }).ok).toBe(false);
  });
});

describe("id de miembro (viene de la URL)", () => {
  it("acepta UUID v4 y rechaza todo lo demás", () => {
    expect(idSchema.safeParse(crypto.randomUUID()).success).toBe(true);
    for (const bad of ["", "1", "abc", "../../etc/passwd", "1 OR 1=1", "00000000-0000-0000-0000-00000000000", null, undefined, 5]) {
      expect(idSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
  });
});
