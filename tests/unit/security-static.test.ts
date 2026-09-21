/**
 * Pruebas ESTÁTICAS de seguridad sobre el código fuente (con el compilador de TypeScript). Protegen las
 * reglas de arquitectura para que una edición futura no las rompa sin que salte una alarma.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
}

function parse(rel: string) {
  return ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
}

/** Funciones exportadas y su primera sentencia (texto). */
function exportedFunctions(rel: string): Array<{ name: string; isAsync: boolean; first: string }> {
  const out: Array<{ name: string; isAsync: boolean; first: string }> = [];
  for (const st of parse(rel).statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      out.push({
        name: st.name.text,
        isAsync: Boolean(st.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)),
        first: st.body?.statements[0]?.getText() ?? "",
      });
    }
  }
  return out;
}

const SRC = walk("src");
const importsOf = (rel: string) =>
  parse(rel)
    .statements.filter(ts.isImportDeclaration)
    .map((i) => (i.moduleSpecifier as ts.StringLiteral).text);

describe("Server Actions del panel: cada una re-verifica al administrador", () => {
  const ACTIONS = "src/app/admin/(shell)/members/actions.ts";

  it("todas las acciones de miembros empiezan por `await requireAdmin()` (alcanzables por POST directo)", () => {
    const fns = exportedFunctions(ACTIONS);
    expect(fns.map((f) => f.name).sort()).toEqual(["createMemberAction", "setAttendanceAction", "setMemberActiveAction", "updateMemberAction"]);
    for (const fn of fns) {
      expect(fn.isAsync, fn.name).toBe(true);
      expect(fn.first, `${fn.name}: la PRIMERA sentencia debe ser requireAdmin()`).toMatch(/await requireAdmin\(\)/);
    }
  });

  it("todas las acciones de SESIONES empiezan por `await requireAdmin()` (alcanzables por POST directo)", () => {
    const fns = exportedFunctions("src/app/admin/(shell)/sessions/actions.ts");
    expect(fns.map((f) => f.name).sort()).toEqual(["closeSessionAction", "createSessionAction", "deleteSessionAction", "startSessionAction"]);
    for (const fn of fns) {
      expect(fn.isAsync, fn.name).toBe(true);
      expect(fn.first, `${fn.name}: la PRIMERA sentencia debe ser requireAdmin()`).toMatch(/await requireAdmin\(\)/);
    }
  });

  it("los archivos 'use server' solo exportan funciones asíncronas y están en la lista revisada", () => {
    const useServer = SRC.filter((f) => /^\s*["']use server["']/.test(read(f)));
    expect(useServer.sort()).toEqual([
      path.join("src", "app", "admin", "(shell)", "actions.ts"),
      path.join("src", "app", "admin", "(shell)", "members", "actions.ts"),
      path.join("src", "app", "admin", "(shell)", "sessions", "actions.ts"),
      path.join("src", "app", "admin", "login", "actions.ts"),
      path.join("src", "app", "(public)", "c", "[token]", "actions.ts"),
    ].sort());
    for (const f of useServer) {
      for (const st of parse(f).statements) {
        if (ts.isVariableStatement(st) && st.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) throw new Error(`${f}: exporta una constante`);
      }
      for (const fn of exportedFunctions(f)) expect(fn.isAsync, `${f}: ${fn.name}`).toBe(true);
    }
  });

  it("solo signIn (público por diseño) y signOut (siempre debe poder salir) prescinden de requireAdmin", () => {
    // signIn (público por diseño), signOut (siempre debe poder salir) y el check-in del ESTUDIANTE (sin cuenta: su defensa es el
    // ticket firmado + límites de intentos; ver sus pruebas específicas más abajo).
    const exempt = ["src/app/admin/login/actions.ts", "src/app/admin/(shell)/actions.ts", "src/app/(public)/c/[token]/actions.ts"];
    const useServer = SRC.filter((f) => /^\s*["']use server["']/.test(read(f))).map((f) => f.split(path.sep).join("/"));
    const requiring = useServer.filter((f) => !exempt.includes(f));
    expect(requiring.sort()).toEqual([ACTIONS, "src/app/admin/(shell)/sessions/actions.ts"].sort());
  });

  it("las acciones PÚBLICAS del estudiante son las únicas sin administrador: dos funciones asíncronas, sin cuenta ni cliente de Supabase", () => {
    const file = "src/app/(public)/c/[token]/actions.ts";
    const fns = exportedFunctions(file);
    expect(fns.map((f) => f.name)).toEqual(["checkInAction", "switchMemberAction"]);
    for (const fn of fns) expect(fn.isAsync, fn.name).toBe(true);
    // Solo el CÓDIGO (los comentarios explican por qué no se usa `requireAdmin` y lo mencionan a propósito).
    const text = read(file).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(text).not.toMatch(/requireAdmin|getAdmin|createSupabaseServerClient|supabase\/admin|localStorage|sessionStorage/);
    expect(text).toMatch(/formData\.get\("ticket"\)/); // el ticket llega en el CUERPO, no en cookie ni URL
  });

  it("la única cookie del estudiante es la del dispositivo recordado: HttpOnly, SameSite=Lax, solo en /c, y solo se crea tras un check-in correcto", () => {
    const text = code("src/app/(public)/c/[token]/actions.ts");
    const names = [...text.matchAll(/store\.set\(([A-Za-z_.]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(0);
    for (const n of names) expect(n, "solo se escribe la cookie del dispositivo").toBe("DEVICE_COOKIE");
    for (const opt of [/httpOnly: true/, /sameSite: "lax"/, /path: DEVICE_COOKIE_PATH/]) expect(text).toMatch(opt);
    // Solo se crea si el estudiante marcó "Remember me" Y el check-in salió bien (dentro de `if (result.ok)`).
    const created = text.indexOf("rememberDeviceOnServer(");
    expect(created).toBeGreaterThan(text.indexOf("if (result.ok)"));
    expect(text.slice(text.indexOf("if (result.ok)"), created)).toMatch(/parsed\.data\.remember/);
    // El token nunca se devuelve al navegador en el estado de la acción.
    expect(text).not.toMatch(/return \{[^}]*\b(token|tokenHash)\b[^}]*\}/);
  });

  it("las páginas del panel también exigen administrador", () => {
    for (const f of SRC.filter((p) => /src[\\/]app[\\/]admin[\\/]\(shell\)[\\/].*page\.tsx$/.test(p))) {
      expect(read(f), f).toMatch(/requireAdmin\(\)/);
    }
    expect(read("src/app/admin/(shell)/layout.tsx")).toMatch(/requireAdmin\(\)/);
  });
});

describe("el navegador nunca recibe poder de servidor", () => {
  const clientFiles = SRC.filter((f) => /^\s*["']use client["']/.test(read(f)));

  it("hay componentes de cliente y ninguno importa módulos de servidor", () => {
    expect(clientFiles.length).toBeGreaterThan(5);
    for (const f of clientFiles) {
      for (const spec of importsOf(f)) {
        expect(spec, `${f} importa ${spec}`).not.toMatch(/supabase\/(admin|server)|auth\/session|data\/members|crypto\/server-keys|lib\/env$|server-only/);
      }
    }
  });

  it("el cliente service_role solo se importa desde src/lib (nunca desde páginas ni componentes)", () => {
    const offenders = SRC.filter((f) => /^src[\\/](app|components)/.test(f)).filter((f) => importsOf(f).some((s) => /supabase\/admin/.test(s)));
    expect(offenders).toEqual([]);
    expect(read("src/lib/supabase/admin.ts")).toMatch(/import "server-only"/);
  });

  it("no hay cliente de Supabase en el navegador: nadie usa createBrowserClient ni referencia NEXT_PUBLIC_", () => {
    for (const f of SRC) {
      const text = read(f);
      expect(text, f).not.toMatch(/createBrowserClient/);
      if (/^src[\\/](components|app)/.test(f)) expect(text, f).not.toMatch(/NEXT_PUBLIC_SUPABASE/);
    }
  });

  it("los módulos con secretos o acceso a datos son 'server-only'", () => {
    for (const f of [
      "src/lib/env.ts",
      "src/lib/supabase/server.ts",
      "src/lib/supabase/admin.ts",
      "src/lib/crypto/server-keys.ts",
      "src/lib/auth/session.ts",
      "src/lib/data/members.ts",
      "src/lib/auth/auth-settings.server.ts",
    ]) {
      expect(read(f), f).toMatch(/^import "server-only";/m);
    }
  });

  it("dangerouslySetInnerHTML no se usa en ningún sitio (XSS)", () => {
    for (const f of SRC) expect(read(f), f).not.toContain("dangerouslySetInnerHTML");
  });

  it("los datos de miembros se leen con lista explícita de columnas (nunca select('*'))", () => {
    for (const f of SRC.filter((p) => /data[\\/]/.test(p))) expect(read(f), f).not.toMatch(/select\(\s*["'`]\*["'`]/);
    expect(read("src/lib/data/members.ts")).not.toContain("pin_hash,");
    expect(read("src/lib/data/members.ts")).toMatch(/MEMBER_COLUMNS = "[^"]*"/);
    expect(/pin_hash/.test(/MEMBER_COLUMNS = "([^"]*)"/.exec(read("src/lib/data/members.ts"))?.[1] ?? "")).toBe(false);
  });

  it("las cookies de sesión se fuerzan HttpOnly en TODOS los puntos que las escriben", () => {
    expect(read("src/lib/supabase/server.ts")).toContain("hardenCookieOptions(");
    expect(read("src/proxy.ts")).toContain("hardenCookieOptions(");
  });
});
