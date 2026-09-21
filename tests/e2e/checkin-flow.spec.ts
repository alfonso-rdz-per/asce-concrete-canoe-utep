/**
 * Flujo CRÍTICO contra Supabase REAL, con un navegador de verdad (Chromium de escritorio):
 *   New Session (solo Session Name + Required) -> pantalla del QR limpia -> el QR rota -> APIs del administrador -> un ESTUDIANTE
 *   sin cookies escanea y hace check-in con ASCE ID + Name (sin PIN) -> duplicado/nombre incorrecto -> QR viejo caducado ->
 *   una segunda sesión activa es imposible -> cerrar detiene QR y tickets.
 *
 * NO forma parte de la suite habitual. Se ejecuta acotado:
 *   npm run test:e2e -- tests/e2e/checkin-flow.spec.ts --project=desktop
 * Los datos llevan el prefijo "[VALIDACIÓN]" / "ZZVAL-" y se limpian con tests/supabase/cleanup.sql.
 * Nunca cierra ni toca sesiones que no haya creado él mismo: si ya hay un check-in real en curso, ABORTA.
 */
import { devices, expect, test, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { ADMIN, expectNoAxeViolations, expectNoHorizontalScroll, login, trackCspViolations } from "./helpers";

test.skip(!ADMIN, "requiere usuarios temporales (npm run test:e2e)");
test.skip(({ browserName, isMobile }) => browserName !== "chromium" || isMobile, "flujo crítico: solo Chromium de escritorio (--project=desktop)");
test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

const STAMP = `${Date.now().toString(36).toUpperCase().slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
const TITLE = `[VALIDACIÓN] E2E check-in ${STAMP}`;
// ASCE ID SOLO numéricos (la app ya no acepta letras). El prefijo de siete ceros identifica los datos de prueba para limpiarlos.
const NSTAMP = `${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
const ASCE_ID = `0000000${NSTAMP}`;
const MEMBER_NAME = "Max Verstappen";
const GENERIC_ERROR = "ASCE ID or name is incorrect. Check them and try again.";

let sessionId = "";
/** Sesiones extra abiertas por los tests de Remember me y borrado: el afterAll cierra las que sigan activas. */
const extraSessions: string[] = [];
const ASCE_ID_2 = `0000001${NSTAMP}`; // Lily: la que usa "Remember me"
const ASCE_ID_3 = `0000002${NSTAMP}`; // Zed: se desactiva mientras su dispositivo está recordado
const DEVICE_COOKIE = "asce_device";
let phone: { context: BrowserContext; page: Page } | null = null;
let lilyCookie = "";
let remSessionA = "";
let remSessionB = "";

interface QrPayload {
  status: string;
  serverNow: number;
  current?: { token: string; startsAtMs: number; endsAtMs: number };
  next?: { token: string; startsAtMs: number; endsAtMs: number };
}

const qrSvg = (page: Page) => page.locator("svg", { has: page.locator("title", { hasText: "Check-in QR code" }) });
const qrApi = async (page: Page): Promise<QrPayload> => (await page.request.get(`/api/admin/sessions/${sessionId}/qr`)).json();

/** Un ESTUDIANTE: contexto nuevo, sin ninguna cookie ni sesión del administrador. */
async function studentPage(browser: Browser, baseURL: string | undefined) {
  const context = await browser.newContext({ baseURL });
  return { context, page: await context.newPage() };
}

/**
 * Envía el formulario del estudiante y ESPERA la respuesta de la Server Action y a que el botón vuelva a estar libre.
 * Sin esto, el mensaje de error del intento anterior (que sigue en pantalla) hace creer que ya hubo respuesta y el siguiente
 * intento se escribiría mientras el formulario aún está procesando (React reinicia los campos al llegar la respuesta).
 */
async function submitStudentForm(student: Page, asceId: string, name: string) {
  await student.getByLabel("ASCE ID").fill(asceId);
  await student.getByLabel("Name", { exact: true }).fill(name);
  const answered = student.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/c/"));
  await student.getByRole("button", { name: "Check in" }).click();
  expect((await answered).status()).toBe(200);
  await expect(student.getByRole("button", { name: "Checking in…" })).toHaveCount(0);
}

test.beforeEach(async ({ page }) => {
  await login(page, ADMIN!);
});

// AUTOLIMPIEZA: aunque un test falle a mitad, la sesión que creó ESTE spec no debe quedar activa (bloquearía a los demás).
// Solo cierra la suya (por su id); nunca una sesión que no haya creado él.
test.afterAll(async ({ browser }, testInfo) => {
  if (!sessionId || !ADMIN) return;
  const baseURL = testInfo.project.use.baseURL;
  const context = await browser.newContext({ baseURL });
  try {
    const page = await context.newPage();
    await login(page, ADMIN);
    for (const id of [sessionId, ...extraSessions]) {
      const res = await page.request.get(`/api/admin/sessions/${id}/qr`);
      if (res.status() !== 200) continue; // ya eliminada
      if (((await res.json()) as QrPayload).status !== "active") continue;
      await page.goto(`/admin/sessions/${id}/qr`);
      await page.getByRole("button", { name: "Close check-in" }).click();
      await page.getByRole("dialog").getByRole("button", { name: "Close check-in" }).click();
      await expect(page.getByText("Check-in closed").first()).toBeVisible();
    }
  } finally {
    await phone?.context.close().catch(() => undefined);
    await context.close();
  }
});

test("1. New Session pide SOLO Session Name + Required (activado); 'Start check-in' abre la pantalla del QR", async ({ page }) => {
  // PROTECCIÓN: si ya hay un check-in real en curso, no se toca. (Se espera a que el panel esté pintado antes de mirar.)
  await page.goto("/admin");
  await expect(page.getByRole("heading", { level: 1, name: /^Welcome,/ })).toBeVisible();
  await expect(page.getByRole("region", { name: "Team overview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resume Check-In" }), "hay un check-in REAL en curso: ciérralo y repite").toHaveCount(0);
  await page.getByRole("link", { name: "Start Check-In" }).click();
  await expect(page).toHaveURL(/\/admin\/sessions\/new$/);
  await expect(page.getByRole("heading", { level: 1, name: "New session" })).toBeVisible();

  // Solo dos controles: el nombre y "Required" con DOS casillas que se pueden marcar a la vez (por defecto solo Rowing & Construction).
  await expect(page.getByLabel("Session Name")).toBeVisible();
  const group = page.getByRole("group", { name: "Required" });
  await expect(group.getByRole("checkbox")).toHaveCount(2);
  await expect(group.getByRole("radio")).toHaveCount(0);
  await expect(group.getByRole("checkbox", { name: "Design Team" })).not.toBeChecked();
  await expect(group.getByRole("checkbox", { name: "Rowing & Construction" })).toBeChecked();
  await expect(page.getByRole("switch")).toHaveCount(0);
  for (const label of [/description/i, /location/i, /schedul/i, /date/i, /time/i]) await expect(page.getByLabel(label)).toHaveCount(0);
  // Sin borradores: un solo botón; y "Required" es un grupo limpio (sin tarjeta alrededor del grupo).
  await expect(page.getByRole("button", { name: /draft/i })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Start check-in" })).toHaveCount(1);
  const fieldsetStyle = await group.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { width: cs.borderTopWidth, bg: cs.backgroundColor };
  });
  expect(fieldsetStyle).toEqual({ width: "0px", bg: "rgba(0, 0, 0, 0)" });
  await group.getByRole("checkbox", { name: "Design Team" }).check(); // se pueden marcar LAS DOS a la vez…
  await expect(group.getByRole("checkbox", { name: "Rowing & Construction" })).toBeChecked();
  await expect(group.getByRole("checkbox", { name: "Design Team" })).toBeChecked();
  await group.getByRole("checkbox", { name: "Design Team" }).uncheck(); // …y volver a una sola
  await expect(group.getByRole("checkbox", { name: "Design Team" })).not.toBeChecked();
  await expect(group.getByRole("checkbox", { name: "Rowing & Construction" })).toBeChecked();
  expect(await page.locator("main input:not([type=hidden]), main textarea, main select").count()).toBe(3); // nombre + 2 casillas
  expect(await page.locator("main").innerText()).not.toMatch(/location|description|GPS/i);
  await expectNoAxeViolations(page, "new session");

  await page.getByLabel("Session Name").fill(TITLE);
  await page.getByRole("button", { name: "Start check-in" }).click();
  await page.waitForURL(/\/admin\/sessions\/[0-9a-f-]{36}\/qr$/);
  sessionId = /sessions\/([0-9a-f-]{36})\/qr/.exec(page.url())![1];
});

test("2. Se crea un miembro de prueba (el estudiante existirá previamente en members)", async ({ page }) => {
  await page.goto("/admin/members/new");
  await page.getByLabel("ASCE ID").fill(ASCE_ID);
  await page.getByLabel("Full name").fill(MEMBER_NAME);
  await page.getByRole("button", { name: "Add member" }).click();
  await page.waitForURL(/\/admin\/members$/); // sin PIN: vuelve directamente a la lista
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("3. Pantalla del QR limpia: marca, nombre, QR grande, barra fina, 'Active' y 'Started by'; sin cuenta numérica, sin IP y sin párrafos", async ({ page }) => {
  const csp = await trackCspViolations(page);
  await page.goto(`/admin/sessions/${sessionId}/qr`);

  await expect(page.getByRole("heading", { level: 1, name: TITLE })).toBeVisible();
  await expect(page.getByRole("img", { name: "ASCE" }).first()).toBeVisible();
  await expect(page.getByRole("img", { name: "UTEP" }).first()).toBeVisible();
  await expect(page.getByText("Scan to check in")).toBeVisible();
  await expect(page.getByText("Active", { exact: true })).toBeVisible();
  await expect(page.getByText("Started by Validation", { exact: true })).toBeVisible(); // display_name "Validation Admin" -> primer nombre

  await expect(qrSvg(page)).toBeVisible();
  const box = await qrSvg(page).boundingBox();
  expect(box!.width, "el QR debe ser grande").toBeGreaterThanOrEqual(240);
  expect(Math.abs(box!.width - box!.height), "el QR es cuadrado").toBeLessThanOrEqual(2);
  expect(await page.locator("canvas").count(), "sin canvas: el QR es SVG").toBe(0);

  // Barra de progreso: existe, es muy delgada y mucho más baja que el QR.
  const bar = page.getByTestId("qr-progress");
  await expect(bar).toBeVisible();
  const barBox = await bar.boundingBox();
  expect(barBox!.height, "barra delgada").toBeLessThanOrEqual(4);
  expect(barBox!.height).toBeLessThan(box!.height / 50);
  expect(((await bar.textContent()) ?? "").trim()).toBe(""); // sin números ni texto (es un SVG: se lee textContent)

  // Nada de countdown numérico, IP local, host ni el párrafo explicativo anterior.
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/\b\d{1,2}\s?s\b/);
  expect(text).not.toMatch(/new code in|expires? in|seconds/i);
  expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}/);
  expect(text).not.toMatch(/localhost|:\d{4}\b/);
  expect(text).not.toMatch(/students scan this code|phone camera|screenshot|students will open/i);
  expect(text).not.toMatch(/location/i);

  await expect(page.getByRole("heading", { name: "Attendance" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close check-in" })).toBeVisible();
  await expectNoHorizontalScroll(page);
  expect(await csp(), "la CSP de producción no debe bloquear el QR ni la pantalla").toEqual([]);
  await expectNoAxeViolations(page, "QR screen");
});

test("4. La asistencia en vivo consulta la API cada ~3 s", async ({ page }) => {
  await page.goto(`/admin/sessions/${sessionId}/qr`);
  await expect(qrSvg(page)).toBeVisible();
  const url = new RegExp(`/api/admin/sessions/${sessionId}/attendance`);
  const first = await page.waitForResponse(url);
  const t1 = Date.now();
  await page.waitForResponse(url);
  const gap = Date.now() - t1;
  expect(first.status()).toBe(200);
  expect(gap, "cadencia del sondeo").toBeGreaterThanOrEqual(2_000);
  expect(gap, "cadencia del sondeo").toBeLessThanOrEqual(4_500);
});

test("5. El QR CAMBIA cada 10 s", async ({ page }) => {
  await page.goto(`/admin/sessions/${sessionId}/qr`);
  await expect(qrSvg(page)).toBeVisible();
  const before = await qrSvg(page).innerHTML();
  // Pasa SOLO cuando hay un QR dibujado y es DISTINTO del anterior (si el QR desapareciera, el resultado sería igual a `before` y no pasa).
  await expect
    .poll(async () => ((await qrSvg(page).count()) > 0 ? await qrSvg(page).innerHTML() : before), { timeout: 13_000, intervals: [400] })
    .not.toBe(before);
});

test("6. API del administrador: tokens del servidor con sesión válida; 401 sin sesión (un estudiante no accede a APIs administrativas)", async ({ page, playwright, baseURL }) => {
  const res = await page.request.get(`/api/admin/sessions/${sessionId}/qr`);
  expect(res.status()).toBe(200);
  expect(res.headers()["cache-control"]).toMatch(/no-store/);
  const body = (await res.json()) as QrPayload;
  expect(body.status).toBe("active");
  expect(body.current!.token).toMatch(/^v1\.[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
  expect(body.current!.endsAtMs - body.current!.startsAtMs).toBe(10_000);
  expect(body.next!.startsAtMs).toBe(body.current!.endsAtMs);
  expect(Math.abs(body.serverNow - Date.now()), "la hora del servidor es coherente").toBeLessThan(5_000);
  expect(JSON.stringify(body)).not.toMatch(/service_role|SERVER_SECRET|pin_hash/);

  const live = await page.request.get(`/api/admin/sessions/${sessionId}/attendance`);
  expect(live.status()).toBe(200);
  const liveBody = await live.json();
  expect(liveBody).toMatchObject({ status: "active", title: TITLE, count: 0, attendees: [] });
  expect(JSON.stringify(liveBody)).not.toMatch(/pin_hash|scrypt|asce_id/);

  const anon = await playwright.request.newContext({ baseURL });
  for (const path of [`/api/admin/sessions/${sessionId}/qr`, `/api/admin/sessions/${sessionId}/attendance`]) {
    const denied = await anon.get(path);
    expect(denied.status(), path).toBe(401);
    expect(await denied.json()).toEqual({ error: "unauthorized" });
  }
  await anon.dispose();
});

test("7. Estudiante sin cookies: QR -> 'QR code accepted' -> ASCE ID + Name (sin PIN) -> nombre incorrecto (genérico) -> éxito -> aparece en la asistencia", async ({ page, browser, baseURL }) => {
  const { current } = await qrApi(page);
  const { context, page: student } = await studentPage(browser, baseURL);
  try {
    const res = await student.goto(`/c/${current!.token}`);
    expect(res?.headers()["cache-control"]).toMatch(/no-store/);
    expect(res?.headers()["referrer-policy"]).toBe("no-referrer");
    await expect(student.getByRole("heading", { level: 1, name: "QR code accepted" })).toBeVisible();
    await expect(student.getByText(TITLE)).toBeVisible();
    await expect(student.getByText(/You have 3 minutes to finish checking in/)).toBeVisible();

    // Formulario: SOLO ASCE ID y Name (no "Full Name", no PIN); el ticket va oculto.
    await expect(student.getByLabel("ASCE ID")).toBeEnabled();
    await expect(student.getByLabel("Name", { exact: true })).toBeEnabled();
    expect(await student.getByLabel(/pin|full name|last name/i).count()).toBe(0);
    expect(await student.locator('input[type="password"], input[name="pin"]').count()).toBe(0);
    expect(await student.locator("main").innerText()).not.toMatch(/\bPIN\b/);
    const ticket = await student.locator('input[name="ticket"]').getAttribute("value");
    expect(ticket).toMatch(/^t1\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{22}\.[0-9a-z]+\.[0-9a-z]+\.[A-Za-z0-9_-]{22}$/);
    expect(await student.locator('input[name="ticket"]').getAttribute("type")).toBe("hidden");
    expect(await student.locator("body").innerText()).not.toContain(ticket!);
    expect(await student.locator("video, canvas").count(), "sin escáner de cámara").toBe(0);
    expect(await context.cookies(), "el estudiante NO recibe ninguna cookie").toEqual([]);
    await expectNoAxeViolations(student, "student form");

    // Nombre incorrecto y ASCE ID inexistente: el MISMO mensaje genérico.
    await submitStudentForm(student, ASCE_ID, "Lewis");
    await expect(student.getByText(GENERIC_ERROR)).toBeVisible();
    await expect(student.getByLabel("ASCE ID")).toHaveValue(ASCE_ID); // conserva lo escrito
    await expect(student.getByLabel("Name", { exact: true })).toHaveValue("Lewis");

    await submitStudentForm(student, "9999999999", "Max");
    await expect(student.getByText(GENERIC_ERROR)).toBeVisible();
    await expect(student.getByLabel("ASCE ID")).toHaveValue("9999999999");
    await expect(student.getByLabel("Name", { exact: true })).toHaveValue("Max");

    // ASCE ID + nombre de pila correcto: éxito.
    await student.getByLabel("ASCE ID").fill(ASCE_ID.toLowerCase()); // se normaliza a mayúsculas
    await student.getByLabel("Name", { exact: true }).fill("max");
    await student.getByRole("button", { name: "Check in" }).click();
    await expect(student.getByRole("heading", { name: "Check-in successful!" })).toBeVisible();
    expect(await context.cookies(), "sin 'Remember me' el estudiante NO recibe ninguna cookie, ni siquiera tras un check-in correcto").toEqual([]);
    await expect(student.getByText(/remember you/)).toHaveCount(0);
    await expect(student.getByText("Thanks, max")).toBeVisible();
    await expect(student.getByText(TITLE)).toBeVisible();
    await expect(student.getByLabel("ASCE ID")).toHaveCount(0);
    await expectNoAxeViolations(student, "student success");
  } finally {
    await context.close();
  }

  // La asistencia en vivo lo muestra (nombre y cargo; nunca hash ni ASCE ID).
  const live = await (await page.request.get(`/api/admin/sessions/${sessionId}/attendance`)).json();
  expect(live).toMatchObject({ count: 1, attendees: [{ name: MEMBER_NAME, position: "Member" }] });
  expect(JSON.stringify(live)).not.toMatch(/pin_hash|scrypt|asce_id|0000000/);
  await page.goto(`/admin/sessions/${sessionId}/qr`);
  await expect(page.getByText(MEMBER_NAME)).toBeVisible({ timeout: 8_000 });
});

test("8. Duplicado: el mismo miembro no puede volver a registrarse en la sesión", async ({ page, browser, baseURL }) => {
  const { current } = await qrApi(page);
  const { context, page: student } = await studentPage(browser, baseURL);
  try {
    await student.goto(`/c/${current!.token}`);
    await student.getByLabel("ASCE ID").fill(ASCE_ID);
    await student.getByLabel("Name", { exact: true }).fill("Max");
    await student.getByRole("button", { name: "Check in" }).click();
    await expect(student.getByRole("heading", { name: "You're already checked in for this session." })).toBeVisible();
    await expect(student.getByLabel("ASCE ID")).toHaveCount(0);
  } finally {
    await context.close();
  }
  expect((await (await page.request.get(`/api/admin/sessions/${sessionId}/attendance`)).json()).count).toBe(1);
});

test("9. Un QR VIEJO deja de valer pasada su ventana (10 s + ~5 s de gracia): 'This QR code has expired'", async ({ page, browser, baseURL }) => {
  const payload = await qrApi(page);
  const { context, page: student } = await studentPage(browser, baseURL);
  try {
    await student.goto(`/c/${payload.current!.token}`);
    await expect(student.getByRole("heading", { level: 1, name: "QR code accepted" })).toBeVisible();

    const waitMs = payload.current!.endsAtMs + 5_600 - Date.now();
    if (waitMs > 0) await page.waitForTimeout(waitMs);
    await student.goto(`/c/${payload.current!.token}`);
    await expect(student.getByRole("heading", { level: 1, name: "This QR code has expired" })).toBeVisible();
    await expect(student.getByText("Scan the code currently shown by your team admin.")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("10. Token modificado, basura o de una sesión inexistente: 'This QR code isn't valid' (sin detalles)", async ({ page, browser, baseURL }) => {
  const { current } = await qrApi(page);
  const tampered = current!.token.slice(0, -1) + (current!.token.endsWith("A") ? "B" : "A");
  const { context, page: student } = await studentPage(browser, baseURL);
  try {
    for (const bad of [tampered, "not-a-token", "v1.AAAAAAAAAAAAAAAAAAAAAA.1.AAAAAAAAAAAAAAAAAAAAAA"]) {
      await student.goto(`/c/${bad}`);
      await expect(student.getByRole("heading", { level: 1, name: "This QR code isn't valid" }), bad).toBeVisible();
      expect(await student.locator('input[name="ticket"]').count()).toBe(0);
    }
  } finally {
    await context.close();
  }
});

test("11. Sessions: 'Started by Validation' + fecha/hora; una sola activa: 'Resume Check-In', sin borradores ni segunda sesión activa", async ({ page }) => {
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: "Resume Check-In" })).toHaveAttribute("href", `/admin/sessions/${sessionId}/qr`);
  await expect(page.getByRole("link", { name: "Start Check-In" })).toHaveCount(0);
  const cards = page.getByRole("region", { name: "Team overview" });
  await expect(cards.getByText("In Progress", { exact: true })).toBeVisible();

  await page.goto("/admin/sessions");
  const row = page.getByRole("row").filter({ hasText: TITLE });
  await expect(row.getByText("Started by Validation")).toBeVisible();
  await expect(row.getByText(/^[A-Z][a-z]{2} \d{1,2}, \d{4} · \d{1,2}:\d{2} (AM|PM)$/)).toBeVisible(); // "Sep 19, 2026 · 7:42 PM"
  await expect(row.getByRole("cell", { name: "Rowing & Construction" })).toBeVisible(); // (la copia de la primera columna solo se ve en móvil)
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  await expect(row.getByText("1", { exact: true })).toBeVisible(); // asistencia
  await expectNoAxeViolations(page, "sessions list");

  // Con una sesión activa NO se ofrece abrir otra ni guardar borradores: solo el aviso y el enlace a su QR.
  await page.goto("/admin/sessions/new");
  await expect(page.getByText("A check-in is already in progress")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start check-in" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /draft/i })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Open the QR screen" })).toHaveAttribute("href", `/admin/sessions/${sessionId}/qr`);

  // Detalle de la sesión activa: quién y cuándo la empezó.
  await page.goto(`/admin/sessions/${sessionId}`);
  await expect(page.getByText("Started by Validation").first()).toBeVisible();
  await expect(page.locator("dt", { hasText: "Check-in opened" })).toBeVisible();
});

test("12. Cerrar la sesión: el QR desaparece y el QR/ticket dejan de aceptarse al instante (incluido un ticket ya emitido)", async ({ page, browser, baseURL }) => {
  const { current } = await qrApi(page); // un QR VÁLIDO justo antes de cerrar
  const { context, page: holder } = await studentPage(browser, baseURL);
  try {
    // Un estudiante ya tiene su ticket en pantalla (QR aceptado) cuando se cierra la sesión.
    await holder.goto(`/c/${current!.token}`);
    await expect(holder.getByRole("heading", { level: 1, name: "QR code accepted" })).toBeVisible();

    await page.goto(`/admin/sessions/${sessionId}/qr`);
    await expect(qrSvg(page)).toBeVisible();
    await page.getByRole("button", { name: "Close check-in" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("Closing is final");
    await dialog.getByRole("button", { name: "Close check-in" }).click();

    await expect(page.getByText("Check-in closed").first()).toBeVisible();
    await expect(page.getByText("This QR code is no longer accepted.")).toBeVisible();
    await expect(qrSvg(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Close check-in" })).toHaveCount(0);

    const after = await qrApi(page);
    expect(after.status).toBe("closed");
    expect(after.current).toBeUndefined();

    // El ticket ya emitido deja de valer: el envío se rechaza aunque el formulario siga abierto.
    await holder.getByLabel("ASCE ID").fill(ASCE_ID);
    await holder.getByLabel("Name", { exact: true }).fill("Max");
    await holder.getByRole("button", { name: "Check in" }).click();
    await expect(holder.getByRole("heading", { name: "Check-in is closed for this session." })).toBeVisible();

    // Un QR que era válido hace un instante: rechazado.
    await holder.goto(`/c/${current!.token}`);
    await expect(holder.getByRole("heading", { level: 1, name: "Check-in is closed" })).toBeVisible();
    expect(await holder.locator('input[name="ticket"]').count()).toBe(0);
  } finally {
    await context.close();
  }

  await page.reload();
  await expect(qrSvg(page)).toHaveCount(0);
  await page.goto("/admin/sessions");
  const row = page.getByRole("row").filter({ hasText: TITLE });
  await expect(row.getByText("Closed", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Resume Check-In" })).toHaveCount(0);
});

// ================================================================================================================
// Remember me on this device · Switch member · miembro inactivo · eliminar sesiones · diseño móvil
// ================================================================================================================
async function addMember(page: Page, asceId: string, fullName: string) {
  await page.goto("/admin/members/new");
  await page.getByLabel("ASCE ID").fill(asceId);
  await page.getByLabel("Full name").fill(fullName);
  await page.getByRole("button", { name: "Add member" }).click();
  await page.waitForURL(/\/admin\/members$/);
}

/** "Start Check-In" con SOLO el nombre: crea la sesión ya activa y abre la pantalla del QR (sin borrador). */
async function startSessionViaUi(page: Page, title: string, audience?: "Design Team" | "Rowing & Construction"): Promise<string> {
  await page.goto("/admin/sessions/new");
  await page.getByLabel("Session Name").fill(title);
  if (audience) {
    // Por defecto solo está marcada Rowing & Construction: se deja marcada únicamente la casilla pedida.
    const other = audience === "Design Team" ? "Rowing & Construction" : "Design Team";
    await page.getByRole("checkbox", { name: audience }).check();
    await page.getByRole("checkbox", { name: other }).uncheck();
  }
  await page.getByRole("button", { name: "Start check-in" }).click();
  await page.waitForURL(/\/admin\/sessions\/[0-9a-f-]{36}\/qr$/);
  const id = /sessions\/([0-9a-f-]{36})\/qr/.exec(page.url())![1];
  extraSessions.push(id);
  return id;
}

async function closeViaUi(page: Page, id: string) {
  await page.goto(`/admin/sessions/${id}/qr`);
  await page.getByRole("button", { name: "Close check-in" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Close check-in" }).click();
  await expect(page.getByText("Check-in closed").first()).toBeVisible();
}

const qrToken = async (page: Page, id: string) => ((await (await page.request.get(`/api/admin/sessions/${id}/qr`)).json()) as QrPayload).current!.token;
const attendance = async (page: Page, id: string) => (await page.request.get(`/api/admin/sessions/${id}/attendance`)).json();
const deviceCookie = async (context: BrowserContext) => (await context.cookies()).find((c) => c.name === DEVICE_COOKIE);

test("13. Remember me (primera vez): QR -> ASCE ID + Name -> 'Remember me on this device' -> Check in; cookie HttpOnly y NADA en localStorage", async ({ page, browser, baseURL }) => {
  await addMember(page, ASCE_ID_2, "Lily Nguyen");
  remSessionA = await startSessionViaUi(page, `[VALIDACIÓN] E2E remember A ${STAMP}`);
  const tokenA = await qrToken(page, remSessionA);

  phone = await studentPage(browser, baseURL);
  const student = phone.page;
  await student.goto(`/c/${tokenA}`);
  await expect(student.getByRole("heading", { level: 1, name: "QR code accepted" })).toBeVisible();
  const remember = student.getByRole("checkbox", { name: "Remember me on this device" });
  await expect(remember).toBeVisible();
  await expect(remember).not.toBeChecked();
  await expect(student.getByText("Checking in as")).toHaveCount(0);
  expect(await phone.context.cookies()).toEqual([]);
  await expectNoAxeViolations(student, "student form with Remember me");

  await remember.check();
  await submitStudentForm(student, ASCE_ID_2, "Lily");
  await expect(student.getByRole("heading", { name: "Check-in successful!" })).toBeVisible();
  await expect(student.getByText("This device will remember you next time.")).toBeVisible();

  // La cookie: aleatoria, HttpOnly, SameSite=Lax, solo en /c y con ~180 días de vida.
  const cookie = await deviceCookie(phone.context);
  expect(cookie, "debe existir la cookie del dispositivo").toBeDefined();
  expect(cookie).toMatchObject({ httpOnly: true, sameSite: "Lax", path: "/c" });
  expect(cookie!.value).toMatch(/^d1\.[A-Za-z0-9_-]{43}$/);
  const days = (cookie!.expires - Date.now() / 1000) / 86_400;
  expect(days).toBeGreaterThan(179);
  expect(days).toBeLessThanOrEqual(180.1);
  lilyCookie = cookie!.value;
  // JavaScript NO la ve, y no hay nada sensible en el almacenamiento del navegador.
  expect(await student.evaluate(() => document.cookie)).not.toContain(DEVICE_COOKIE);
  const storage = await student.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).toBe("{}");
  expect(await student.content()).not.toContain(lilyCookie);

  expect(await attendance(page, remSessionA)).toMatchObject({ count: 1, attendees: [{ name: "Lily Nguyen" }] });
  await closeViaUi(page, remSessionA);
});

test("14. Remember me (siguiente reunión): QR -> el dispositivo reconoce al miembro -> Check in, SIN escribir ASCE ID ni Name; el QR sigue siendo obligatorio", async ({ page, browser, baseURL }) => {
  test.skip(!phone, "depende del test 13");
  remSessionB = await startSessionViaUi(page, `[VALIDACIÓN] E2E remember B ${STAMP}`, "Design Team");
  const tokenB = await qrToken(page, remSessionB);
  const student = phone!.page;

  // La sesión se creó como "Design Team": el detalle y la lista lo muestran.
  await page.goto(`/admin/sessions/${remSessionB}`);
  await expect(page.getByText("Design Team", { exact: true }).first()).toBeVisible();
  await page.goto("/admin/sessions");
  await expect(page.getByRole("row").filter({ hasText: `remember B ${STAMP}` }).getByRole("cell", { name: "Design Team" })).toBeVisible();

  await student.goto(`/c/${tokenB}`);
  await expect(student.getByRole("heading", { level: 1, name: "QR code accepted" })).toBeVisible();
  await expect(student.getByText("Checking in as")).toBeVisible();
  await expect(student.getByText("Lily Nguyen")).toBeVisible();
  await expect(student.getByLabel("ASCE ID")).toHaveCount(0);
  await expect(student.getByLabel("Name", { exact: true })).toHaveCount(0);
  await expect(student.getByRole("button", { name: "Not you? Switch member" })).toBeVisible();
  expect(await student.content(), "la página no lleva el ASCE ID ni el token").not.toMatch(/000000\d|d1\.[A-Za-z0-9_-]{43}/);
  await expectNoAxeViolations(student, "student remembered");

  const answered = student.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/c/"));
  await student.getByRole("button", { name: "Check in" }).click();
  expect((await answered).status()).toBe(200);
  await expect(student.getByRole("heading", { name: "Check-in successful!" })).toBeVisible();
  await expect(student.getByText("Thanks, Lily Nguyen")).toBeVisible();
  expect(await attendance(page, remSessionB)).toMatchObject({ count: 1, attendees: [{ name: "Lily Nguyen" }] });

  // Otro teléfono (sin cookie) escanea el MISMO QR: NO se le reconoce, se le pide ASCE ID + Name.
  const stranger = await studentPage(browser, baseURL);
  try {
    await stranger.page.goto(`/c/${await qrToken(page, remSessionB)}`);
    await expect(stranger.page.getByLabel("ASCE ID")).toBeVisible();
    await expect(stranger.page.getByText("Checking in as")).toHaveCount(0);
  } finally {
    await stranger.context.close();
  }

  // El token NO sustituye al QR: con la cookie puesta, un QR inválido o ya caducado no reconoce a nadie ni muestra nombres.
  const withCookie = phone!.page;
  for (const bad of ["garbage", "v1.00000000-0000-0000-0000-000000000000.1.AAAAAAAAAAAAAAAAAAAAAA"]) {
    await withCookie.goto(`/c/${bad}`);
    await expect(withCookie.getByRole("heading", { level: 1, name: "This QR code isn't valid" })).toBeVisible();
    await expect(withCookie.getByText("Checking in as")).toHaveCount(0);
    await expect(withCookie.getByText("Lily")).toHaveCount(0);
    expect(await withCookie.locator('input[name="ticket"]').count()).toBe(0);
  }
});

test("15. 'Not you? Switch member': olvida el dispositivo, vuelve al formulario y permite entrar como OTRO miembro; el token anterior queda revocado", async ({ page, browser, baseURL }) => {
  test.skip(!phone, "depende del test 13");
  const student = phone!.page;
  await student.goto(`/c/${await qrToken(page, remSessionB)}`);
  await expect(student.getByText("Lily Nguyen")).toBeVisible();

  await student.getByRole("button", { name: "Not you? Switch member" }).click();
  await expect(student.getByLabel("ASCE ID")).toBeVisible();
  await expect(student.getByLabel("ASCE ID")).toHaveValue("");
  await expect(student.getByLabel("ASCE ID")).toBeFocused();
  await expect(student.getByLabel("Name", { exact: true })).toHaveValue("");
  await expect(student.getByRole("checkbox", { name: "Remember me on this device" })).not.toBeChecked();
  await expect(student.getByText("Checking in as")).toHaveCount(0);
  expect(await deviceCookie(phone!.context), "la cookie se borra").toBeUndefined();

  // Recargando el mismo QR sigue sin reconocerlo (revocado en el servidor, no solo oculto).
  await student.reload();
  await expect(student.getByLabel("ASCE ID")).toBeVisible();
  await expect(student.getByText("Checking in as")).toHaveCount(0);

  // El token viejo, aunque alguien lo hubiera copiado, ya no sirve: NO salta ninguna validación.
  const thief = await studentPage(browser, baseURL);
  try {
    await thief.context.addCookies([{ name: DEVICE_COOKIE, value: lilyCookie, url: `${baseURL}/c/x`, httpOnly: true, sameSite: "Lax" }]);
    await thief.page.goto(`/c/${await qrToken(page, remSessionB)}`);
    await expect(thief.page.getByLabel("ASCE ID")).toBeVisible();
    await expect(thief.page.getByText("Checking in as")).toHaveCount(0);
  } finally {
    await thief.context.close();
  }

  // Otro miembro en el mismo teléfono: Max (ya registrado en la primera sesión) entra y recuerda el dispositivo.
  await student.getByLabel("ASCE ID").fill(ASCE_ID);
  await student.getByLabel("Name", { exact: true }).fill("Max");
  await student.getByRole("checkbox", { name: "Remember me on this device" }).check();
  const answered = student.waitForResponse((r) => r.request().method() === "POST" && r.url().includes("/c/"));
  await student.getByRole("button", { name: "Check in" }).click();
  expect((await answered).status()).toBe(200);
  await expect(student.getByText("Thanks, Max")).toBeVisible();
  const maxCookie = await deviceCookie(phone!.context);
  expect(maxCookie?.value).toMatch(/^d1\./);
  expect(maxCookie!.value).not.toBe(lilyCookie);
  expect(await attendance(page, remSessionB)).toMatchObject({ count: 2 });
});

test("16. Miembro INACTIVO: al desactivarlo su dispositivo deja de reconocerlo y no puede hacer check-in", async ({ page, browser, baseURL }) => {
  test.skip(!remSessionB, "depende del test 14");
  await addMember(page, ASCE_ID_3, "Zed Inactive");

  const zed = await studentPage(browser, baseURL);
  try {
    await zed.page.goto(`/c/${await qrToken(page, remSessionB)}`);
    await zed.page.getByRole("checkbox", { name: "Remember me on this device" }).check();
    await submitStudentForm(zed.page, ASCE_ID_3, "Zed");
    await expect(zed.page.getByRole("heading", { name: "Check-in successful!" })).toBeVisible();
    expect((await deviceCookie(zed.context))?.value).toMatch(/^d1\./);

    // El administrador desactiva a Zed.
    await page.goto("/admin/members");
    await page.getByLabel("Search").fill(ASCE_ID_3);
    await page.getByRole("button", { name: "Apply" }).click();
    await page.getByRole("link", { name: "Edit Zed Inactive" }).click();
    await page.getByRole("button", { name: "Deactivate member" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Deactivate", exact: true }).click();
    await expect(page.getByText(/Deactivated/).first()).toBeVisible();

    // Con la cookie aún puesta, ya no lo reconoce; y ASCE ID + Name tampoco entra (mensaje genérico).
    await zed.page.goto(`/c/${await qrToken(page, remSessionB)}`);
    await expect(zed.page.getByLabel("ASCE ID")).toBeVisible();
    await expect(zed.page.getByText("Checking in as")).toHaveCount(0);
    await submitStudentForm(zed.page, ASCE_ID_3, "Zed");
    await expect(zed.page.getByText(GENERIC_ERROR)).toBeVisible();
  } finally {
    await zed.context.close();
  }
});

test("17. Diseño del estudiante en móvil: canoe-draw.png y el fondo azul se ven bien, sin desbordes y con el texto legible", async ({ page, browser, baseURL }) => {
  test.skip(!remSessionB, "depende del test 14");
  const context = await browser.newContext({ ...devices["iPhone 14"], baseURL });
  try {
    const mobile = await context.newPage();
    const csp = await trackCspViolations(mobile);
    await mobile.goto(`/c/${await qrToken(page, remSessionB)}`);
    await expect(mobile.getByRole("heading", { level: 1, name: "QR code accepted" })).toBeVisible();
    await expect(mobile.getByLabel("ASCE ID")).toBeVisible();
    await expect(mobile.getByRole("checkbox", { name: "Remember me on this device" })).toBeVisible();
    await mobile.waitForLoadState("networkidle");

    // Ilustración: el PNG exacto, cargado, con su proporción original.
    const canoe = mobile.getByTestId("canoe-illustration");
    await canoe.scrollIntoViewIfNeeded();
    await expect(canoe).toBeVisible();
    const info = await canoe.evaluate((img: HTMLImageElement) => ({ ok: img.complete && img.naturalWidth > 0, nw: img.naturalWidth, nh: img.naturalHeight, w: img.clientWidth, h: img.clientHeight, src: img.currentSrc }));
    expect(info.ok).toBe(true);
    expect([info.nw, info.nh]).toEqual([1023, 700]);
    expect(Math.abs(info.w / info.h - info.nw / info.nh)).toBeLessThan(0.02); // no se deforma
    expect(info.w).toBeGreaterThan(120);
    expect(new URL(info.src).pathname).toBe("/brand/canoe-draw.png");

    // Fondo: imagen-fondo.jpg como fondo CSS teñido de azul (no una <img> pegada), cargado de verdad.
    const bg = await mobile.locator(".hero-photo").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { image: cs.backgroundImage, blend: cs.backgroundBlendMode, color: cs.backgroundColor, size: cs.backgroundSize };
    });
    expect(bg.image).toContain("/brand/imagen-fondo.jpg");
    expect(bg.blend).toBe("luminosity");
    expect(bg.color).toBe("rgb(0, 48, 112)"); // navy
    expect(bg.size).toBe("cover");
    expect((await mobile.request.get("/brand/imagen-fondo.jpg")).status()).toBe(200);

    await expectNoHorizontalScroll(mobile);
    await expectNoAxeViolations(mobile, "student form (mobile)");
    expect(await csp(), "la CSP de producción no debe bloquear las imágenes").toEqual([]);
    // Todo el texto visible es inglés y no se ve ninguna IP ni el host.
    const text = await mobile.locator("body").innerText();
    expect(text).not.toMatch(/\d{1,3}(\.\d{1,3}){3}|localhost/);
  } finally {
    await context.close();
  }
});

test("18. Eliminar una sesión ACTIVA (con confirmación): el QR y el check-in dejan de funcionar al instante y desaparece de la lista", async ({ page, browser, baseURL }) => {
  test.skip(!remSessionB, "depende del test 14");
  const qrPage = await page.context().newPage(); // la pantalla del QR abierta en otra pestaña del administrador
  const student = await studentPage(browser, baseURL);
  try {
    await qrPage.goto(`/admin/sessions/${remSessionB}/qr`);
    await expect(qrSvg(qrPage)).toBeVisible();
    const liveToken = await qrToken(page, remSessionB);

    await page.goto(`/admin/sessions/${remSessionB}`);
    await expect(page.getByRole("heading", { level: 2, name: "Delete session" })).toBeVisible();
    await expect(page.getByText(/check-ins? will be deleted with it/)).toBeVisible();
    await page.getByRole("button", { name: "Delete Session" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("heading", { name: "Delete this session?" })).toBeVisible();
    await expect(dialog).toContainText("Check-in is still open");
    await expect(dialog).toContainText("This will permanently delete the session and its associated attendance records.");

    // Cancelar no borra nada.
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    expect((await page.request.get(`/api/admin/sessions/${remSessionB}/attendance`)).status()).toBe(200);

    // Confirmar: se elimina y vuelve a la lista.
    await page.getByRole("button", { name: "Delete Session" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Delete Session" }).click();
    await page.waitForURL(/\/admin\/sessions$/);
    await expect(page.getByRole("row").filter({ hasText: `remember B ${STAMP}` })).toHaveCount(0);

    // Las APIs del administrador ya no la conocen…
    expect((await page.request.get(`/api/admin/sessions/${remSessionB}/qr`)).status()).toBe(404);
    expect((await page.request.get(`/api/admin/sessions/${remSessionB}/attendance`)).status()).toBe(404);
    // …la pantalla del QR abierta deja de dibujarlo (≤ 3 s)…
    await expect(qrPage.getByText("This QR code is no longer accepted.")).toBeVisible({ timeout: 8_000 });
    await expect(qrSvg(qrPage)).toHaveCount(0);
    // …y el QR que hace un instante valía ya no lo acepta el servidor, sin datos del miembro.
    await student.page.goto(`/c/${liveToken}`);
    await expect(student.page.getByRole("heading", { level: 1 })).toHaveText(/isn't valid|is closed/);
    expect(await student.page.locator('input[name="ticket"]').count()).toBe(0);
    await expect(student.page.getByText("Checking in as")).toHaveCount(0);
  } finally {
    await student.context.close();
    await qrPage.close();
  }
});

test("19. Eliminar una sesión CERRADA con asistencia: pide confirmación, se van sus check-ins y no queda rastro visible", async ({ page }) => {
  test.skip(!remSessionA, "depende del test 13");
  await page.goto(`/admin/sessions/${remSessionA}`);
  await expect(page.getByText("1 check-in will be deleted with it.")).toBeVisible();
  // Una sesión CERRADA muestra el roster de los miembros esperados (Attendance): la asistente figura como Present. (Puede haber más miembros llamados igual,
  // p. ej. datos de pruebas anteriores, y los diálogos ocultos repiten el nombre: por eso se busca la fila con la insignia «Present».)
  await expect(page.getByRole("main").getByRole("listitem").filter({ hasText: "Lily Nguyen" }).filter({ has: page.getByText("Present", { exact: true }) })).toHaveCount(1);
  await expectNoAxeViolations(page, "session detail with Delete");
  await page.getByRole("button", { name: "Delete Session" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).not.toContainText("Check-in is still open"); // ya está cerrada: sin el aviso de sesión activa
  await dialog.getByRole("button", { name: "Delete Session" }).click();
  await page.waitForURL(/\/admin\/sessions$/);
  await expect(page.getByRole("row").filter({ hasText: `remember A ${STAMP}` })).toHaveCount(0);
  expect((await page.request.get(`/api/admin/sessions/${remSessionA}/attendance`)).status()).toBe(404);
  // La página de una sesión eliminada muestra "Page not found" (el código HTTP puede ser 200 porque Next ya empezó a enviar la respuesta).
  await page.goto(`/admin/sessions/${remSessionA}`);
  await expect(page.getByRole("heading", { level: 1, name: "Page not found" })).toBeVisible();
  await expect(page.getByText(`remember A ${STAMP}`)).toHaveCount(0);
});
