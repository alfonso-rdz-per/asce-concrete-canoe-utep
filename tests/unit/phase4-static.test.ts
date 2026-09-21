/**
 * Pruebas ESTÁTICAS de la Fase 4 (sesiones, QR, canje del ticket): protegen las reglas de arquitectura para que una edición
 * futura no las rompa sin que salte una alarma. Recorren el código con el compilador de TypeScript.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
/** El código sin comentarios (los comentarios explican qué NO se hace y mencionan esos nombres a propósito). */
const code = (rel: string) => read(rel).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/.*$/gm, "");

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name).split(path.sep).join("/");
    return e.isDirectory() ? walk(rel) : /\.(ts|tsx)$/.test(e.name) ? [rel] : [];
  });
}

const parse = (rel: string) => ts.createSourceFile(rel, read(rel), ts.ScriptTarget.Latest, true, rel.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const importsOf = (rel: string) =>
  parse(rel)
    .statements.filter(ts.isImportDeclaration)
    .map((i) => (i.moduleSpecifier as ts.StringLiteral).text);

const SRC = walk("src");
const API_ROUTES = SRC.filter((f) => /^src\/app\/api\/.*\/route\.ts$/.test(f));

describe("rutas de API del administrador", () => {
  it("hay exactamente las dos rutas de la pantalla del QR", () => {
    expect(API_ROUTES.sort()).toEqual(["src/app/api/admin/sessions/[id]/attendance/route.ts", "src/app/api/admin/sessions/[id]/qr/route.ts"]);
  });

  it("TODAS comprueban al administrador ANTES que cualquier otra cosa (el proxy no protege /api) y responden 401 JSON", () => {
    for (const file of API_ROUTES) {
      const get = parse(file).statements.find((s): s is ts.FunctionDeclaration => ts.isFunctionDeclaration(s) && s.name?.text === "GET");
      expect(get, `${file}: falta GET`).toBeDefined();
      expect(get?.body?.statements[0]?.getText(), `${file}: la PRIMERA sentencia debe ser getAdmin()`).toMatch(/await getAdmin\(\)/);
      expect(get?.body?.statements[1]?.getText(), file).toMatch(/if \(!admin\) return NextResponse\.json\(\{ error: "unauthorized" \}, \{ status: 401/);
    }
  });

  it("solo exportan GET (sin escritura por API) y nunca usan el cliente service_role", () => {
    for (const file of API_ROUTES) {
      const text = read(file);
      expect(text, file).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)/);
      expect(importsOf(file).join("|"), file).not.toMatch(/supabase\/admin/);
      expect(text, file).toContain('export const dynamic = "force-dynamic"');
    }
  });

  it("no seleccionan pin_hash ni el ASCE ID en ninguna consulta de sesiones o asistencia", () => {
    const sessionsData = code("src/lib/data/sessions.ts");
    expect(sessionsData).not.toMatch(/pin_hash|asce_id/);
    expect(sessionsData).not.toMatch(/select\(\s*["'`]\*["'`]/);
    for (const file of API_ROUTES) expect(code(file), file).not.toMatch(/pin_hash|asce_id/);
  });

  it("el módulo de datos de sesiones es 'server-only' y consulta con el cliente de la SESIÓN del administrador", () => {
    const text = read("src/lib/data/sessions.ts");
    expect(text).toMatch(/^import "server-only";/m);
    expect(importsOf("src/lib/data/sessions.ts").join("|")).not.toMatch(/supabase\/admin/);
  });
});

describe("ruta del estudiante /c/[token]", () => {
  const PAGE = "src/app/(public)/c/[token]/page.tsx";

  it("no usa sesión de administrador ni el cliente de Supabase; solo LEE la cookie del dispositivo recordado (nunca la escribe)", () => {
    const imports = importsOf(PAGE).join("|");
    expect(imports).not.toMatch(/auth\/session|supabase\/server|supabase\/admin/);
    const text = code(PAGE);
    expect(text).not.toMatch(/Set-Cookie|localStorage|sessionStorage|\.set\(|\.delete\(/);
    expect((text.match(/cookies\(\)/g) ?? []).length).toBe(1);
    expect(text).toMatch(/cookies\(\)\)\.get\(DEVICE_COOKIE\)/);
  });

  it("canjea el QR SOLO en el servidor y nunca lo hace desde un componente de cliente", () => {
    expect(read(PAGE)).toContain("redeemQrOnServer");
    expect(read(PAGE)).not.toMatch(/^\s*["']use client["']/m);
  });

  it("no tiene escáner interno ni entrada manual de tickets/códigos, ni geolocalización", () => {
    const files = [PAGE, "src/components/checkin/CheckInPanel.tsx", "src/app/(public)/c/[token]/actions.ts"];
    for (const f of files) {
      const text = read(f);
      expect(text, f).not.toMatch(/getUserMedia|BarcodeDetector|jsqr|html5-qrcode|navigator\.geolocation|Bluetooth|NDEFReader/i);
      expect(text, f).not.toMatch(/name="ticket"[^>]*type="text"|type="text"[^>]*name="ticket"/);
    }
  });

  it("el ticket va en un campo OCULTO (nunca visible ni editable) dentro del panel", () => {
    expect(read("src/components/checkin/CheckInPanel.tsx")).toMatch(/<input type="hidden" name="ticket" value=\{ticket\} \/>/);
  });

  it("el flujo del ESTUDIANTE no usa PIN en ninguna parte: ni formulario, ni validación, ni envío, ni contraseñas", () => {
    const studentFiles = [
      PAGE,
      "src/app/(public)/c/[token]/actions.ts",
      "src/components/checkin/CheckInPanel.tsx",
      "src/lib/checkin/submit.ts",
      "src/lib/checkin/state.ts",
      "src/lib/validation/checkin.ts",
      "src/lib/member-name.ts",
    ];
    for (const f of studentFiles) {
      const text = code(f);
      expect(text, f).not.toMatch(/\bpin\b|pin_hash|PIN_PEPPER|verifyPin|hashPin|generatePin|@\/lib\/pin|password/i);
    }
    // El envío nunca lee el hash del PIN de la BD (ni siquiera lo selecciona).
    expect(code("src/lib/checkin/server.ts")).not.toMatch(/pin_hash|\.select\("[^"]*pin/);
  });

  it("el formulario del estudiante pide solo 'ASCE ID' y 'Name' (no 'Full Name')", () => {
    const panel = code("src/components/checkin/CheckInPanel.tsx");
    expect(panel).toMatch(/label="ASCE ID"/);
    expect(panel).toMatch(/label="Name"/);
    expect(panel).not.toMatch(/Full Name|full name|Last Name|Surname/i);
  });

  it("límites de intentos: por ticket, por ASCE ID y por IP (HMAC, nunca la IP en claro)", () => {
    const submit = code("src/lib/checkin/submit.ts");
    for (const scope of ['"ticket"', '"asce_id"', '"ip"']) expect(submit, scope).toContain(scope);
    expect(submit).toContain("rate_limited");
    const server = code("src/lib/checkin/server.ts");
    expect(server).toMatch(/hmacSha256\(appKeys\(\)\.ip/);
    expect(server).not.toMatch(/ip_hash: (a|args)\.ip\b/); // se guarda el HMAC, no la IP
  });

  it("las cabeceras impiden cachear el destino del QR y no filtran el token por Referer", () => {
    const config = read("next.config.ts");
    expect(config).toMatch(/source: "\/c\/:path\*", headers: noStore/);
    expect(config).toMatch(/Referrer-Policy", value: "no-referrer"/);
    expect(read("src/app/(public)/c/[token]/page.tsx")).toMatch(/robots: \{ index: false/);
  });
});

describe("secretos y módulos de servidor", () => {
  it("el canje del QR y la validación del ticket están en módulos de servidor; la puerta pura no lee variables de entorno", () => {
    expect(read("src/lib/checkin/server.ts")).toMatch(/^import "server-only";/m);
    const gate = read("src/lib/checkin/gate.ts");
    expect(gate).not.toMatch(/process\.env|serverEnv|Date\.now|new Date\(|createClient/); // hora, claves y BD siempre inyectadas
  });

  it("ningún componente de cliente importa tokens, tickets, claves ni la puerta de check-in", () => {
    const clientFiles = SRC.filter((f) => /^\s*["']use client["']/.test(read(f)));
    expect(clientFiles.length).toBeGreaterThan(8);
    for (const f of clientFiles) {
      for (const spec of importsOf(f)) {
        expect(spec, `${f} importa ${spec}`).not.toMatch(/lib\/tokens|lib\/tickets|checkin\/(gate|server)|crypto\/|data\/sessions|data\/attendance|lib\/env|server-only/);
      }
    }
  });

  it("no hay variables NEXT_PUBLIC_ con secretos ni claves de firma en el código de la Fase 4", () => {
    for (const f of SRC.filter((p) => /checkin|sessions|QrScreen|qr-display|api\/admin/.test(p))) {
      expect(read(f), f).not.toMatch(/NEXT_PUBLIC_(SERVER_SECRET|PIN_PEPPER|SERVICE|SECRET|KEY)/);
    }
  });

  it("qrcode.react se usa en su variante SVG (sin canvas gigante) y con corrección de errores M", () => {
    const screen = read("src/components/admin/QrScreen.tsx");
    expect(screen).toMatch(/import \{ QRCodeSVG \} from "qrcode\.react"/);
    expect(screen).not.toMatch(/QRCodeCanvas/);
    expect(screen).toMatch(/level="M"/);
  });

  it("la pantalla del QR no genera ni valida tokens: solo pide a la API y dibuja", () => {
    const screen = read("src/components/admin/QrScreen.tsx");
    expect(screen).toMatch(/\/api\/admin\/sessions\/\$\{sessionId\}\/qr/);
    expect(screen).not.toMatch(/issueQrToken|verifyQrToken|hmac|createHmac/i);
    // Ninguna decisión de validez usa el reloj del dispositivo: solo performance.now (monótono) para medir el tiempo transcurrido.
    expect(screen).not.toMatch(/Date\.now|new Date\(/);
  });
});

describe("una sola sesión activa y ciclo de vida: los impone la base de datos, no la interfaz", () => {
  it("las acciones no fijan opened_at/closed_at/opened_by ni saltan estados: solo piden draft->active y active->closed", () => {
    const data = code("src/lib/data/sessions.ts");
    // Ningún insert/update escribe quién/cuándo (los fija el trigger de la base de datos).
    const writes = [...data.matchAll(/\.(insert|update)\(\s*(\{[^}]*\})/g)].map((m) => m[2]);
    expect(writes.length).toBeGreaterThanOrEqual(2);
    for (const w of writes) expect(w, w).not.toMatch(/opened_at|closed_at|opened_by|created_by/);
    expect(data).toMatch(/transition\(sb, id, "draft", "active"\)/);
    expect(data).toMatch(/transition\(sb, id, "active", "closed"\)/);
  });

  it("existe el índice único de sesión activa en el esquema (defensa en profundidad)", () => {
    expect(read("supabase/migrations/20260919000000_schema.sql")).toMatch(/create unique index sessions_single_active on public\.sessions \(\(true\)\) where status = 'active'/);
  });
});
