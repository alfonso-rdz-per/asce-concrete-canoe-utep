/**
 * Attendance contra Supabase REAL con un navegador de verdad, en los TRES perfiles (escritorio, iPhone/WebKit y Android):
 *   /admin/attendance (historial de reuniones cerradas + filtro por grupo) -> detalle de la sesión con el roster -> corrección Present <-> Absent
 *   con confirmación -> el resumen, el roster y el historial se actualizan. Más: sin desbordamiento horizontal, botones táctiles, diálogo dentro de
 *   la pantalla y axe (accesibilidad).
 *
 * NO forma parte de la suite habitual. Se ejecuta acotado:
 *   npm run test:e2e -- tests/e2e/attendance.spec.ts
 * Los datos se siembran por API con el JWT del administrador temporal (miembros con ASCE ID numérico de prueba, reuniones "[VALIDACIÓN]") y los
 * check-ins con `service_role` (como la ruta del estudiante). Las SESIONES se eliminan al terminar; los miembros de prueba y `audit_log` se limpian con
 * tests/supabase/cleanup.sql. Si hay un check-in REAL en curso, ABORTA sin tocar nada.
 */
import { randomBytes } from "node:crypto";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { ADMIN, expectNoAxeViolations, expectNoHorizontalScroll, login, trackCspViolations } from "./helpers";

test.skip(!ADMIN, "requiere usuarios temporales (npm run test:e2e)");
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const STAMP = `${Date.now().toString(36).toUpperCase().slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
const NSTAMP = `${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`; // 7 dígitos
const asceId = (n: number) => `0000000${String(Number(NSTAMP) + n).padStart(7, "0").slice(-7)}`; // 14 dígitos, «0000000…»: cleanup.sql los identifica
const TITLE_REMAR = `[VALIDACIÓN] E2E Attendance Remar ${STAMP}`;
const TITLE_DESIGN = `[VALIDACIÓN] E2E Attendance Design ${STAMP}`;
const NAME = { ana: `E2E Ana ${STAMP}`, beto: `E2E Beto ${STAMP}`, carla: `E2E Carla ${STAMP}`, dani: `E2E Dani ${STAMP}` };

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;
const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

let admin: SupabaseClient;
let svc: SupabaseClient;
const sessionIds: string[] = [];
let remarId = "";
let designId = "";

async function seedSession(title: string, audience: "design_team" | "remar_construction", who: string[]): Promise<string> {
  const s = await admin.from("sessions").insert({ title, scheduled_at: new Date().toISOString(), audience, status: "active" }).select("id").single();
  if (s.error) throw new Error(`no se pudo abrir la reunión de prueba (¿hay un check-in real en curso?): ${s.error.message}`);
  const id = s.data.id as string;
  sessionIds.push(id);
  for (const m of who) {
    const ins = await svc.from("checkins").insert({ session_id: id, member_id: m, token_slot: 1, ticket_nonce: randomBytes(16).toString("base64url") });
    if (ins.error) throw new Error(`check-in de prueba: ${ins.error.message}`);
  }
  const closed = await admin.from("sessions").update({ status: "closed" }).eq("id", id);
  if (closed.error) throw new Error(`cerrar la reunión de prueba: ${closed.error.message}`);
  return id;
}

test.beforeAll(async () => {
  admin = createClient(URL_, ANON_KEY, CLIENT_OPTS);
  svc = createClient(URL_, process.env.SUPABASE_SERVICE_ROLE_KEY as string, CLIENT_OPTS);
  const signed = await admin.auth.signInWithPassword({ email: ADMIN!.email, password: ADMIN!.password });
  if (signed.error) throw new Error(`login del administrador temporal: ${signed.error.message}`);

  // PROTECCIÓN: si hay una sesión ACTIVA (un check-in real en curso), no se toca nada.
  const active = await svc.from("sessions").select("title").eq("status", "active");
  if ((active.data ?? []).length > 0) throw new Error(`ABORTADO sin modificar nada: hay un check-in en curso («${active.data?.[0].title}»). Ciérralo y repite.`);

  const mk = async (n: number, name: string, design = false) => {
    const r = await admin.from("members").insert({ asce_id: asceId(n), name, is_design_team: design }).select("id").single();
    if (r.error) throw new Error(`miembro de prueba: ${r.error.message}`);
    return r.data.id as string;
  };
  const ana = await mk(1, NAME.ana);
  await mk(2, NAME.beto);
  await mk(3, NAME.carla);
  const dani = await mk(4, NAME.dani, true);
  // Reunión general: asisten Ana (general) y Dani (Design Team, OTRO grupo). Reunión de Design Team: asiste Dani.
  remarId = await seedSession(TITLE_REMAR, "remar_construction", [ana, dani]);
  designId = await seedSession(TITLE_DESIGN, "design_team", [dani]);
});

test.afterAll(async () => {
  // Se eliminan las sesiones creadas (cascada a check-ins y correcciones); los miembros ZZ y audit_log los limpia cleanup.sql.
  for (const id of sessionIds) await admin?.from("sessions").delete().eq("id", id);
});

test.beforeEach(async ({ page }) => {
  await login(page, ADMIN!);
});

// --- utilidades ------------------------------------------------------------------------------------------------------------------
const meetingLink = (page: Page, title: string) => page.getByRole("link", { name: title });
const summaryNumbers = async (page: Page) => {
  const text = (await page.getByTestId("attendance-summary").innerText()).replace(/\s+/g, " ");
  const m = /(\d+) \/ (\d+) present/.exec(text);
  if (!m) throw new Error(`resumen inesperado: ${text}`);
  return { present: Number(m[1]), expected: Number(m[2]), text };
};
const rosterItems = (page: Page) => page.getByRole("main").getByRole("listitem");
const rosterRow = (page: Page, name: string) => rosterItems(page).filter({ hasText: name });
async function expectTouchSize(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  expect(box, `${label}: sin caja`).not.toBeNull();
  expect(box!.height, `${label}: alto táctil (px)`).toBeGreaterThanOrEqual(43.5);
}

// ==================================================================================================================================
test("1. Attendance aparece en el menú y lista las reuniones cerradas con grupo, fecha, presentes / esperados y porcentaje", async ({ page, isMobile }) => {
  const csp = await trackCspViolations(page);
  await page.goto("/admin");
  // Navegación: escritorio (barra lateral) o menú del móvil.
  if (isMobile) await page.getByRole("button", { name: /menu/i }).click();
  await page.getByRole("link", { name: "Attendance" }).first().click();
  await expect(page).toHaveURL(/\/admin\/attendance$/);
  await expect(page.getByRole("heading", { level: 1, name: "Attendance" })).toBeVisible();

  const remar = meetingLink(page, TITLE_REMAR);
  await expect(remar).toBeVisible();
  await expect(remar).toContainText("Rowing & Construction");
  await expect(remar).toContainText(/[A-Z][a-z]{2} \d{1,2}, \d{4}/); // fecha
  await expect(remar).toContainText(/\d+ \/ \d+/); // presentes / esperados
  await expect(remar).toContainText(/\d+%|—/); // porcentaje
  await expect(meetingLink(page, TITLE_DESIGN)).toContainText("Design Team");

  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page, "Attendance (lista)");
  expect(await csp(), "violaciones de CSP").toEqual([]);
});

test("2. el filtro por grupo (All / Design Team / Rowing & Construction) es un enlace, marca el activo y filtra", async ({ page }) => {
  await page.goto("/admin/attendance");
  const nav = page.getByRole("navigation", { name: "Filter by group" });
  await expect(nav.getByRole("link")).toHaveText(["All", "Design Team", "Rowing & Construction"]);
  await expect(nav.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
  await expect(meetingLink(page, TITLE_REMAR)).toBeVisible();
  await expect(meetingLink(page, TITLE_DESIGN)).toBeVisible();

  await nav.getByRole("link", { name: "Design Team" }).click();
  await expect(page).toHaveURL(/\/admin\/attendance\?group=design_team$/);
  await expect(nav.getByRole("link", { name: "Design Team" })).toHaveAttribute("aria-current", "page");
  await expect(meetingLink(page, TITLE_DESIGN)).toBeVisible();
  await expect(meetingLink(page, TITLE_REMAR)).toHaveCount(0);

  await nav.getByRole("link", { name: "Rowing & Construction" }).click();
  await expect(page).toHaveURL(/\/admin\/attendance\?group=remar_construction$/);
  await expect(meetingLink(page, TITLE_REMAR)).toBeVisible();
  await expect(meetingLink(page, TITLE_DESIGN)).toHaveCount(0);

  await nav.getByRole("link", { name: "All" }).click();
  await expect(page).toHaveURL(/\/admin\/attendance$/);
  await expect(meetingLink(page, TITLE_DESIGN)).toBeVisible();

  // Un valor manipulado no rompe la pantalla: se trata como «All».
  await page.goto("/admin/attendance?group=%27%3B%20drop%20table%20sessions%3B--");
  await expect(nav.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
  await expect(meetingLink(page, TITLE_REMAR)).toBeVisible();
});

test("3. el detalle de la reunión muestra presentes / esperados, porcentaje y el roster SOLO de los esperados (otro grupo, no)", async ({ page }) => {
  await page.goto("/admin/attendance");
  await meetingLink(page, TITLE_REMAR).click();
  await expect(page).toHaveURL(new RegExp(`/admin/sessions/${remarId}$`));
  await expect(page.getByRole("heading", { level: 1, name: TITLE_REMAR })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Attendance" })).toBeVisible();

  const s = await summaryNumbers(page);
  expect(s.present).toBeLessThanOrEqual(s.expected);
  expect(s.text).toMatch(/\d+%|—/);
  // Roster: Ana (presente, con ASCE ID y cargo), Beto y Carla (ausentes). Dani es del Design Team: aparece en la reunión general como raw present pero NO en el roster.
  await expect(rosterRow(page, NAME.ana)).toContainText("Present");
  await expect(rosterRow(page, NAME.ana)).toContainText(`${asceId(1)} · Member`);
  await expect(rosterRow(page, NAME.beto)).toContainText("Absent");
  await expect(rosterRow(page, NAME.carla)).toContainText("Absent");
  await expect(page.getByText(NAME.dani)).toHaveCount(0);
  // Un control por miembro ESPERADO (el resumen dice cuántos son) y ninguno para nadie más.
  expect(await rosterItems(page).filter({ has: page.getByRole("button") }).count()).toBe(s.expected);

  // La reunión de Design Team: solo Dani.
  await page.goto(`/admin/sessions/${designId}`);
  await expect(rosterRow(page, NAME.dani)).toContainText("Present");
  for (const n of [NAME.ana, NAME.beto, NAME.carla]) await expect(page.getByText(n)).toHaveCount(0);

  await expectNoHorizontalScroll(page);
  await expectNoAxeViolations(page, "Attendance (detalle de la reunión)");
});

test("4. Present <-> Absent pide confirmación, actualiza roster, presentes / esperados y porcentaje, y el historial; después se revierte", async ({ page }) => {
  await page.goto(`/admin/sessions/${remarId}`);
  const before = await summaryNumbers(page);
  const beto = rosterRow(page, NAME.beto);
  await expect(beto).toContainText("Absent");

  // Absent -> Present: primero la confirmación (nada cambia aún); Cancel no cambia nada.
  await page.getByRole("button", { name: `Mark ${NAME.beto} present for ${TITLE_REMAR}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Mark ${NAME.beto} as Present?`);
  await expect(dialog).toContainText("recorded in the audit log");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(beto).toContainText("Absent");
  expect((await summaryNumbers(page)).present).toBe(before.present);

  await page.getByRole("button", { name: `Mark ${NAME.beto} present for ${TITLE_REMAR}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark Present" }).click();
  await expect(beto).toContainText("Present");
  await expect(beto).toContainText("Set manually");
  await expect.poll(async () => (await summaryNumbers(page)).present).toBe(before.present + 1);
  const after = await summaryNumbers(page);
  expect(after.expected).toBe(before.expected); // corregir no cambia a quién se esperaba
  expect(after.text).not.toBe(before.text); // el porcentaje también cambió

  // El historial refleja lo mismo.
  await page.goto("/admin/attendance");
  await expect(meetingLink(page, TITLE_REMAR)).toContainText(`${after.present} / ${after.expected}`);

  // Present -> Absent (revertir): la fila de la corrección se conserva; el check-in de Ana no se toca.
  await page.goto(`/admin/sessions/${remarId}`);
  await page.getByRole("button", { name: `Mark ${NAME.beto} absent for ${TITLE_REMAR}` }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Mark Absent" }).click();
  await expect(rosterRow(page, NAME.beto)).toContainText("Absent");
  await expect.poll(async () => (await summaryNumbers(page)).present).toBe(before.present);
  await expect(rosterRow(page, NAME.ana)).toContainText("Present");
});

test("5. móvil / escritorio: sin desbordamiento, controles táctiles cómodos y el diálogo cabe en la pantalla", async ({ page }) => {
  const viewport = page.viewportSize()!;
  await page.goto("/admin/attendance");
  await expectNoHorizontalScroll(page);
  for (const link of await page.getByRole("navigation", { name: "Filter by group" }).getByRole("link").all()) await expectTouchSize(link, "filtro por grupo");
  await expectTouchSize(meetingLink(page, TITLE_REMAR), "fila de reunión");

  await meetingLink(page, TITLE_REMAR).click();
  await expect(page.getByRole("heading", { level: 2, name: "Attendance" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  const buttons = await rosterItems(page).getByRole("button").all();
  expect(buttons.length).toBeGreaterThanOrEqual(3);
  for (const b of buttons) await expectTouchSize(b, "Mark present/absent");

  await page.getByRole("button", { name: `Mark ${NAME.carla} present for ${TITLE_REMAR}` }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const box = (await dialog.boundingBox())!;
  expect(box.x, "diálogo: borde izquierdo").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "diálogo: borde derecho").toBeLessThanOrEqual(viewport.width + 0.5);
  expect(box.y, "diálogo: borde superior").toBeGreaterThanOrEqual(0);
  expect(box.y + box.height, "diálogo: borde inferior").toBeLessThanOrEqual(viewport.height + 0.5);
  await expectTouchSize(dialog.getByRole("button", { name: "Cancel" }), "Cancel");
  await expectTouchSize(dialog.getByRole("button", { name: "Mark Present" }), "Mark Present");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(rosterRow(page, NAME.carla)).toContainText("Absent"); // cancelar no cambia nada
  await expectNoHorizontalScroll(page);
});

test("6. estados de error razonables: una reunión que no existe o un id inválido muestran «Page not found» (sin error crudo ni datos)", async ({ page }) => {
  // Un id con formato válido pero inexistente y uno que no es UUID. El código HTTP puede ser 200 porque Next ya empezó a enviar la respuesta:
  // lo que importa es la página (igual que en checkin-flow.spec.ts).
  for (const bad of ["00000000-0000-4000-8000-000000000000", "no-es-un-uuid"]) {
    await page.goto(`/admin/sessions/${bad}`);
    await expect(page.getByRole("heading", { level: 1, name: "Page not found" }), bad).toBeVisible();
    await expect(page.getByText("Attendance", { exact: true }), bad).toHaveCount(0);
  }
  // La lista sigue viva y sin desbordamiento después.
  await page.goto("/admin/attendance");
  await expect(page.getByRole("heading", { level: 1, name: "Attendance" })).toBeVisible();
  await expectNoHorizontalScroll(page);
});

test("7. sin sesión de administrador no hay acceso: /admin/attendance redirige al login", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await page.goto("/admin/attendance");
    await expect(page).toHaveURL(/\/admin\/login/);
    await expect(page.getByText(TITLE_REMAR)).toHaveCount(0);
    await page.goto(`/admin/sessions/${remarId}`);
    await expect(page).toHaveURL(/\/admin\/login/);
  } finally {
    await context.close();
  }
});
