/**
 * El PIN dejó de existir en la aplicación (no solo en el flujo del estudiante): sin campo, sin validación, sin "Reset PIN", sin helper,
 * sin variables de entorno y sin la columna en la base de datos. Estas pruebas estáticas impiden que reaparezca por descuido.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");

function walk(dir: string, exts: string[]): string[] {
  const abs = path.join(ROOT, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).flatMap((name) => {
    const rel = path.join(dir, name);
    if (statSync(path.join(ROOT, rel)).isDirectory()) return name === "node_modules" || name === ".next" ? [] : walk(rel, exts);
    return exts.some((e) => name.endsWith(e)) ? [rel.replaceAll("\\", "/")] : [];
  });
}

// "pin" como palabra, la columna, el pepper, los helpers y la interfaz de reinicio.
const PIN = /\bpin\b|pin_hash|pinhash|PIN_PEPPER|hashPin|verifyPin|generatePin|isValidPinFormat|ResetPin|PinReveal|Reset PIN|@\/lib\/pin\b/i;

describe("el código de la aplicación no menciona el PIN", () => {
  it("src/ (código, comentarios y estilos) está libre de PIN", () => {
    const offenders = walk("src", [".ts", ".tsx", ".css"]).filter((f) => PIN.test(read(f)));
    expect(offenders).toEqual([]);
  });

  it("el helper y sus pruebas ya no existen", () => {
    for (const f of ["src/lib/pin.ts", "tests/unit/pin.test.ts", "tests/unit/reset-pin.test.ts"]) expect(existsSync(path.join(ROOT, f)), f).toBe(false);
  });

  it("no hay variables de entorno de PIN: ni el esquema, ni el ejemplo, ni CI, ni los scripts", () => {
    for (const f of ["src/lib/env.ts", ".env.example", ".github/workflows/ci.yml", ...walk("scripts", [".mjs", ".ts", ".js"])]) {
      expect(read(f), f).not.toMatch(/PIN_PEPPER|\bpin\b/i);
    }
  });

  it("las claves derivadas son solo qr, ticket, ip y device (ya no existe 'pin')", () => {
    const keys = read("src/lib/crypto/keys.ts");
    expect(keys).toMatch(/KeyPurpose = "qr" \| "ticket" \| "ip" \| "device"/);
    expect(read("src/lib/crypto/server-keys.ts")).not.toMatch(/\bpin\b/i);
  });
});

describe("la interfaz no ofrece PIN", () => {
  it("ni el alta de miembros, ni la edición, ni el formulario del estudiante tienen un campo de PIN", () => {
    for (const f of ["src/components/admin/MemberForm.tsx", "src/components/admin/NewMemberForm.tsx", "src/components/admin/MemberControls.tsx", "src/components/checkin/CheckInPanel.tsx", "src/components/ui/Dialogs.tsx"]) {
      const text = read(f);
      expect(text, f).not.toMatch(/\bpin\b/i);
      expect(text, f).not.toMatch(/type="password"/);
    }
  });

  it("las acciones de miembros no incluyen 'Reset PIN' ni devuelven ningún PIN", () => {
    const actions = read("src/app/admin/(shell)/members/actions.ts");
    expect(actions).not.toMatch(/resetPin|resetMemberPin/i);
    expect(read("src/lib/action-state.ts")).not.toMatch(/\bpin\b/i);
    expect(read("src/lib/data/members.ts")).not.toMatch(/\bpin\b|pin_hash|hash/i);
  });

  it("la validación del check-in solo conoce ASCE ID, Name y la casilla 'remember'", () => {
    const text = read("src/lib/validation/checkin.ts");
    expect(text).not.toMatch(/\bpin\b/i);
    expect(text).toMatch(/formData\.get\("remember"\)/);
  });
});

describe("la base de datos ya no tiene PIN", () => {
  const migrations = walk("supabase/migrations", [".sql"]).sort();
  const DROP = "supabase/migrations/20260919000900_drop_member_pin.sql";

  it("una migración elimina la columna (no la oculta) y ninguna posterior la vuelve a mencionar", () => {
    expect(migrations).toContain(DROP);
    expect(read(DROP)).toMatch(/alter table public\.members drop column pin_hash;/);
    // Las migraciones posteriores no vuelven a tocarla (solo comentarios históricos).
    for (const later of migrations.filter((m) => m > DROP)) {
      const statements = read(later).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n");
      expect(statements, later).not.toMatch(/pin_hash/);
    }
  });

  it("las migraciones posteriores a la creación no vuelven a añadir ni conceder pin_hash", () => {
    for (const m of migrations.filter((f) => f > "supabase/migrations/20260919000100_security.sql" && f !== DROP)) {
      const statements = read(m).split("\n").filter((l) => !l.trim().startsWith("--")).join("\n"); // (los comentarios históricos pueden citarla)
      expect(statements, m).not.toMatch(/pin_hash/);
    }
  });
});

describe("la documentación no dice que el estudiante use PIN", () => {
  // Solo se admiten frases que dicen que el PIN NO existe / se eliminó.
  const REMOVED = /sin PIN|eliminad|ya no (existe|existen|usa|hay)|dejó de existir|se ignora|\bno hay\b/i;
  const claims = (file: string) =>
    read(file)
      .split("## PIN: eliminado del sistema")[0] // (la sección que explica la eliminación puede nombrarlo)
      .split("\n")
      .filter((l) => /\bPIN\b|PIN_PEPPER/.test(l) && !REMOVED.test(l));

  it("README y SETUP no dicen que exista o se use un PIN", () => {
    for (const f of ["README.md", "docs/SETUP.md"]) expect(claims(f), f).toEqual([]);
  });

  it("TOKENS.md solo habla del PIN para decir que no existe / fue eliminado", () => {
    expect(claims("docs/TOKENS.md")).toEqual([]);
    expect(read("docs/TOKENS.md")).toContain("## PIN: eliminado del sistema");
  });
});
