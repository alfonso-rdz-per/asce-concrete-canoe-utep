/**
 * GUARDA DE IDIOMA: toda la interfaz visible debe estar en inglés. Recorre el código con el compilador
 * de TypeScript y revisa SOLO textos (literales de cadena, plantillas y texto JSX), no comentarios:
 * los comentarios internos siguen en español a propósito.
 *
 * Además comprueba la marca: `ASCE` nunca aparece suelto en textos de interfaz (solo BrandMark).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");

const SCOPE = [
  "src/app",
  "src/components",
  "src/lib/errors.ts",
  "src/lib/dates.ts",
  "src/lib/action-state.ts",
  "src/lib/validation",
  "src/lib/auth/auth-settings.ts",
];

function files(entry: string): string[] {
  const abs = path.join(ROOT, entry);
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(entry, e.name);
    return e.isDirectory() ? files(p) : /\.(ts|tsx)$/.test(e.name) ? [path.join(ROOT, p)] : [];
  });
}

/** Extrae los textos visibles (o potencialmente visibles) de un archivo. */
function textsOf(file: string): string[] {
  const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return; // rutas de módulos
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) out.push(node.text);
    else if (ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    else if (ts.isJsxText(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
}

const SPANISH_CHARS = /[áéíóúñüÁÉÍÓÚÑ¿¡]/;
const SPANISH_WORDS = [
  "inicio", "asistencia", "asistencias", "miembro", "miembros", "sesión", "sesion", "sesiones", "guardar", "cancelar", "cerrar",
  "iniciar", "contraseña", "correo", "nombre", "fecha", "bienvenido", "bienvenida", "editar", "eliminar", "desactivar", "reactivar",
  "agregar", "añadir", "buscar", "activo", "inactivo", "cargando", "ubicación", "escanea", "escanear", "registra", "gracias",
  "volver", "siguiente", "anterior", "cuenta", "usuario", "clave", "pin incorrecto", "no se pudo", "ocurrió", "intenta",
];
const WORD_RE = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${SPANISH_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|")})(?![\\p{L}\\p{N}_])`, "iu");

const all = SCOPE.flatMap(files);

describe("interfaz 100 % en inglés", () => {
  it("el alcance de la guarda incluye páginas, componentes y módulos con texto de usuario", () => {
    expect(all.length).toBeGreaterThan(25);
    expect(all.some((f) => f.endsWith("MemberForm.tsx"))).toBe(true);
    expect(all.some((f) => f.endsWith("errors.ts"))).toBe(true);
  });

  it("ningún texto contiene caracteres del español (á é í ó ú ñ ¿ ¡)", () => {
    const offenders = all.flatMap((f) => textsOf(f).filter((t) => SPANISH_CHARS.test(t)).map((t) => `${path.relative(ROOT, f)}: «${t}»`));
    expect(offenders).toEqual([]);
  });

  it("ningún texto contiene palabras típicas de interfaz en español", () => {
    const offenders = all.flatMap((f) => textsOf(f).filter((t) => WORD_RE.test(t)).map((t) => `${path.relative(ROOT, f)}: «${t}»`));
    expect(offenders).toEqual([]);
  });

  it("la guarda detecta español (no es una prueba vacía)", () => {
    expect(SPANISH_CHARS.test("Iniciar sesión")).toBe(true);
    expect(WORD_RE.test("Guardar cambios")).toBe(true);
    expect(WORD_RE.test("Save changes")).toBe(false);
    expect(WORD_RE.test("Member")).toBe(false);
  });

  it("la marca `ASCE` no aparece suelta en la interfaz: solo `ASCE ID`, `ASCE | UTEP` y BrandMarkView", () => {
    const offenders = all
      .filter((f) => !f.endsWith("BrandMarkView.tsx"))
      .flatMap((f) =>
        textsOf(f)
          .filter((t) => /\bASCE\b/.test(t) && !/ASCE ID/.test(t) && !/ASCE \| UTEP/.test(t))
          .map((t) => `${path.relative(ROOT, f)}: «${t}»`),
      );
    expect(offenders).toEqual([]);
  });

  it("el HTML raíz declara lang=\"en\"", () => {
    expect(readFileSync(path.join(ROOT, "src/app/layout.tsx"), "utf8")).toContain('<html lang="en"');
  });
});
