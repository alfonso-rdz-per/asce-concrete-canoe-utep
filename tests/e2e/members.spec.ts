import { expect, test, type Page } from "@playwright/test";
import { ADMIN, expectNoAxeViolations, expectNoHorizontalScroll, login } from "./helpers";

test.skip(!ADMIN, "requiere usuarios temporales (npm run test:e2e)");
test.describe.configure({ mode: "serial" });

// Un miembro por proyecto (escritorio / iPhone / Android): el ASCE ID debe ser único.
const suffix = () => `${Date.now().toString(36).toUpperCase().slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
let asceId = "";
let name = "";

const today = () => new Intl.DateTimeFormat("en-CA", { timeZone: "America/Denver" }).format(new Date());

async function openEdit(page: Page) {
  await page.goto("/admin/members");
  await page.getByLabel("Search").fill(asceId);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: `Edit ${name}` }).click();
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
}

test.beforeAll(() => {
  const s = suffix();
  // ASCE ID SOLO numérico; los siete ceros iniciales identifican los datos de prueba.
  asceId = `0000000${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
  name = `E2E Member ${s}`;
});

test.beforeEach(async ({ page }) => {
  await login(page, ADMIN!);
});

test("validación del formulario: mensajes en inglés, foco en el primer error y sin perder lo tecleado", async ({ page }) => {
  await page.goto("/admin/members/new");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByText("Enter the ASCE ID.")).toBeVisible();
  await expect(page.getByText("Enter the full name.")).toBeVisible();
  await expect(page.locator("form [role=alert]").filter({ hasText: "Please fix the highlighted fields." })).toBeVisible();
  await expect(page.getByLabel("ASCE ID")).toBeFocused();
  await expect(page.getByLabel("ASCE ID")).toHaveAttribute("aria-invalid", "true");

  await page.getByLabel("ASCE ID").pressSequentially("ab"); // solo números: las letras se descartan al escribir…
  await expect(page.getByLabel("ASCE ID")).toHaveValue("");
  await page.getByLabel("ASCE ID").fill("12"); // …y "12" es demasiado corto
  await page.getByLabel("Full name").fill("Ana");
  await page.getByLabel(/Email/).fill("no-es-email");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByText("ASCE ID must have 3 to 32 digits.")).toBeVisible();
  await expect(page.getByText("Enter a valid email address.")).toBeVisible();
  // lo escrito NO se pierde tras el error
  await expect(page.getByLabel("Full name")).toHaveValue("Ana");
  await expect(page.getByLabel(/Email/)).toHaveValue("no-es-email");
});

test("alta: guarda el ASCE ID numérico y vuelve a la lista; no hay PIN ni diálogo", async ({ page }) => {
  await page.goto("/admin/members/new");
  await expect(page.locator("main")).not.toContainText(/\bPIN\b/);
  await page.getByLabel("ASCE ID").fill(asceId);
  await page.getByLabel("Full name").fill(`  ${name}  `);
  await page.getByLabel(/Email/).fill("E2E.Member@Example.com");
  await page.getByRole("button", { name: "Add member" }).click();

  // Sin PIN de un solo uso: al guardar vuelve directamente a la lista.
  await page.waitForURL("**/admin/members");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.getByTestId("pin-value")).toHaveCount(0);
  await expect(page.getByText(asceId).filter({ visible: true }).first()).toBeVisible();
  await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible();
  expect(await page.content()).not.toMatch(/\bPIN\b/);
});

test("ASCE ID duplicado: error claro en inglés sobre el campo, conservando lo escrito", async ({ page }) => {
  await page.goto("/admin/members/new");
  await page.getByLabel("ASCE ID").fill(asceId);
  await page.getByLabel("Full name").fill("Someone Else");
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByText("That ASCE ID is already registered.")).toBeVisible();
  await expect(page.getByLabel("ASCE ID")).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByLabel("Full name")).toHaveValue("Someone Else");
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("búsqueda y filtro por estado", async ({ page }) => {
  await page.goto("/admin/members");
  await page.getByLabel("Search").fill(asceId.slice(0, 9));
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByText(name).filter({ visible: true }).first()).toBeVisible();

  await page.getByLabel("Search").fill("zzzz-no-existe-qqq");
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("heading", { name: "No members match" })).toBeVisible();
  await page.getByRole("link", { name: "Clear filters" }).click();
  await expect(page.getByLabel("Search")).toHaveValue("");

  await page.getByLabel("Status").selectOption("inactive");
  await page.getByLabel("Search").fill(asceId);
  await page.getByRole("button", { name: "Apply" }).click();
  await expect(page.getByRole("heading", { name: "No members match" })).toBeVisible();
});

test("editar: cambia nombre y fecha de ingreso; los cambios persisten", async ({ page }) => {
  await openEdit(page);
  await page.getByLabel("Full name").fill(`${name} Edited`);
  await page.getByLabel("Joined on").fill("2024-01-15");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();

  await page.reload();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`${name} Edited`);
  await expect(page.getByLabel("Joined on")).toHaveValue("2024-01-15");
  await expect(page.getByText("Joined Jan 15, 2024")).toBeVisible();
  name = `${name} Edited`;
});

test("editar: validación (nombre vacío, fecha inválida o en el futuro lejano)", async ({ page }) => {
  await openEdit(page);
  await page.getByLabel("Full name").fill("");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Enter the full name.")).toBeVisible();

  await page.getByLabel("Full name").fill("Valid Name");
  await page.getByLabel("Joined on").fill("2099-01-01");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("The join date can't be more than a year in the future.")).toBeVisible();
});

test("desactivar (con confirmación) CONSERVA joined_on; reactivar TAMBIÉN la conserva", async ({ page }) => {
  await openEdit(page);
  await expect(page.getByText("Joined Jan 15, 2024", { exact: false }).first()).toBeVisible();

  await page.getByRole("button", { name: "Deactivate member" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading")).toContainText("Deactivate");
  await expectNoAxeViolations(page, "diálogo de confirmación");
  await dialog.getByRole("button", { name: "Deactivate", exact: true }).click();

  await expect(page.getByText(/was deactivated\./)).toBeVisible();
  await expect(page.getByText("Inactive").first()).toBeVisible();
  await expect(page.getByText(/Joined Jan 15, 2024 · Deactivated/)).toBeVisible();
  await expect(page.getByLabel("Joined on")).toHaveValue("2024-01-15"); // NO se reinicia

  await page.getByRole("button", { name: "Reactivate member" }).click();
  await expect(page.getByText(/was reactivated\./)).toBeVisible();
  await expect(page.getByText("Active").first()).toBeVisible();
  await expect(page.getByText("Joined Jan 15, 2024")).toBeVisible();
  await expect(page.getByLabel("Joined on")).toHaveValue("2024-01-15"); // NO se reinicia al reactivar
  await expect(page.getByText(/Deactivated/)).toHaveCount(0);
  expect(today()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
});

test("no existe 'Reset PIN': la edición del miembro no ofrece nada relacionado con un PIN", async ({ page }) => {
  await openEdit(page);
  await expect(page.getByRole("button", { name: /PIN/ })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "PIN" })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/\bPIN\b/);
});

test("accesibilidad (axe): panel, lista, alta y edición", async ({ page }) => {
  await page.goto("/admin");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await expectNoAxeViolations(page, "dashboard");
  await page.goto("/admin/members");
  await page.getByRole("heading", { level: 1, name: "Members" }).waitFor();
  await expectNoAxeViolations(page, "members");
  await page.goto("/admin/members/new");
  await expectNoAxeViolations(page, "new member");
  await openEdit(page);
  await expectNoAxeViolations(page, "edit member");
});

test("responsivo: sin desbordamiento, campos >= 16 px, objetivos táctiles >= 44 px", async ({ page }) => {
  for (const path of ["/admin", "/admin/members", "/admin/members/new"]) {
    await page.goto(path);
    await page.getByRole("heading", { level: 1 }).waitFor();
    await expectNoHorizontalScroll(page);
  }
  await page.goto("/admin/members/new");
  for (const label of ["ASCE ID", "Full name", "Joined on"]) {
    const m = await page.getByLabel(label).evaluate((n) => ({ font: parseFloat(getComputedStyle(n).fontSize), h: n.getBoundingClientRect().height }));
    expect(m.font, label).toBeGreaterThanOrEqual(16);
    expect(m.h, label).toBeGreaterThanOrEqual(44);
  }
  for (const link of await page.getByRole("main").getByRole("link").all()) {
    if (!(await link.isVisible())) continue;
    const box = await link.boundingBox();
    expect(box!.height, await link.innerText()).toBeGreaterThanOrEqual(43.5);
  }
});

test("navegación: barra lateral en escritorio; menú desplegable accesible en móvil", async ({ page, isMobile }) => {
  await page.goto("/admin");
  await page.getByRole("heading", { level: 1 }).waitFor();
  if (isMobile) {
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    const open = page.getByRole("button", { name: "Open menu" });
    await expect(open).toHaveAttribute("aria-expanded", "false");
    await open.click();
    await expect(page.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    await expect(nav.getByRole("link", { name: "Members" })).toBeVisible();
    await expectNoAxeViolations(page, "menú móvil abierto");
    await page.keyboard.press("Escape");
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Open menu" })).toBeFocused();

    await page.getByRole("button", { name: "Open menu" }).click();
    await page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(/\/admin\/members$/);
    await expect(page.getByRole("navigation", { name: "Main" })).toHaveCount(0); // se cierra al navegar
  } else {
    await expect(page.getByRole("button", { name: "Open menu" })).toBeHidden();
    const nav = page.getByRole("navigation", { name: "Main" });
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "Members" }).click();
    await expect(page).toHaveURL(/\/admin\/members$/);
    await expect(nav.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
  }
});

test("teclado: el formulario de alta se completa y se envía solo con el teclado", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "WebKit no enfoca enlaces con Tab por defecto");
  await page.goto("/admin/members/new");
  const s = suffix();
  await page.getByLabel("ASCE ID").focus();
  await page.keyboard.type(`0000000${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`);
  await page.keyboard.press("Tab");
  await page.keyboard.type(`Keyboard Member ${s}`);
  await page.keyboard.press("Enter"); // Enter envía el formulario
  await page.waitForURL("**/admin/members"); // sin PIN: vuelve directamente a la lista
  await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("el panel: Start Check-In, las 4 tarjetas y el roster con Attendance (textos fijos en inglés)", async ({ page }) => {
  await page.goto("/admin");
  // Fase 4: "Start Check-In" ya es funcional (enlace al formulario de nueva sesión, o "Resume Check-In" si ya hay una activa).
  await expect(page.getByRole("link", { name: /^(Start|Resume) Check-In$/ })).toBeVisible();
  const cards = page.getByRole("region", { name: "Team overview" });
  for (const label of ["Total Members", "Total Meetings", "Average Attendance", "Active Check-In"]) {
    await expect(cards.getByText(label, { exact: true })).toBeVisible();
  }
  await expect(page.getByText("Inactive members", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Recently added")).toHaveCount(0);
  // Textos de ayuda eliminados a petición del equipo.
  await expect(page.getByText("Name the session, start a check-in")).toHaveCount(0);
  await expect(page.getByText("Active on the team")).toHaveCount(0);
  await expect(page.getByText("Closed meetings")).toHaveCount(0);

  const roster = page.getByRole("table", { name: "Member roster with attendance" });
  await expect(roster).toBeVisible();
  // Solo se revisa el texto FIJO de la interfaz (tarjetas y cabeceras): los nombres de miembros son datos de usuario.
  const chrome = [await cards.innerText(), ...(await roster.getByRole("columnheader").allInnerTexts())].join(" ");
  expect(chrome).not.toMatch(/[áéíóúñ¿¡]|miembros|asistencia/i);
});

test("Members y Attendance: sin el texto de ayuda bajo el título", async ({ page }) => {
  await page.goto("/admin/members");
  await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
  await expect(page.getByText("Everyone on the team")).toHaveCount(0);
  await expect(page.getByText("Add, edit or deactivate members here")).toHaveCount(0);

  await page.goto("/admin/attendance");
  await expect(page.getByRole("heading", { level: 1, name: "Attendance" })).toBeVisible();
  await expect(page.getByText("how many of the expected members came")).toHaveCount(0);
});

test("New Member: formulario limpio, sin los tres textos de ayuda anteriores", async ({ page }) => {
  await page.goto("/admin/members/new");
  const main = page.locator("main");
  for (const gone of ["3–32 letters, numbers or hyphens.", "Choose Other to enter a different position.", "The date this member joined the team. Correct it here if needed."]) {
    await expect(main).not.toContainText(gone);
  }
  await expect(main).not.toContainText(/letters, numbers or hyphens|Choose Other|joined the team/);
  expect(await main.locator("[id$='-hint']").count()).toBe(0);
  await expect(page.getByRole("checkbox", { name: "Design Team" })).not.toBeChecked(); // por defecto, apagada
});

test("ASCE ID solo números: el campo descarta letras al escribir Y el servidor rechaza un valor manipulado", async ({ page }) => {
  await page.goto("/admin/members/new");
  // Esperar a que la página termine de hidratar: en WebKit (iPhone) teclear antes hace que React reinicie el campo y se pierda lo escrito.
  await page.waitForLoadState("networkidle");
  const id = page.getByLabel("ASCE ID");
  await id.pressSequentially("ABC-12x3 4");
  await expect(id).toHaveValue("1234"); // frontend: solo dígitos
  await expect(id).toHaveAttribute("inputmode", "numeric");

  // Servidor: se salta el filtro del navegador (asignando el valor sin evento) y se envía.
  await page.getByLabel("Full name").fill("Servidor Valida");
  await id.evaluate((el: HTMLInputElement) => {
    el.value = "ABC123";
  });
  await page.getByRole("button", { name: "Add member" }).click();
  await expect(page.getByText("ASCE ID must contain numbers only.")).toBeVisible();
  await expect(page).toHaveURL(/\/admin\/members\/new$/);
  for (const bad of ["ASCE-123", "123-456", "12A34"]) {
    await id.evaluate((el: HTMLInputElement, v: string) => {
      el.value = v;
    }, bad);
    await page.getByRole("button", { name: "Add member" }).click();
    await expect(page.getByText("ASCE ID must contain numbers only.")).toBeVisible();
  }
});

test("Design Team: se guarda al crear, se ve al editar y se puede cambiar", async ({ page }) => {
  const id = `0000000${String(Date.now()).slice(-5)}${Math.floor(Math.random() * 90 + 10)}`;
  await page.goto("/admin/members/new");
  await page.getByLabel("ASCE ID").fill(id);
  await page.getByLabel("Full name").fill("Diseño Equipo");
  await page.getByRole("checkbox", { name: "Design Team" }).check();
  await page.getByRole("button", { name: "Add member" }).click();
  await page.waitForURL("**/admin/members");

  await page.getByLabel("Search").fill(id);
  await page.getByRole("button", { name: "Apply" }).click();
  await page.getByRole("link", { name: "Edit Diseño Equipo" }).click();
  await expect(page.getByRole("checkbox", { name: "Design Team" })).toBeChecked();
  await page.getByRole("checkbox", { name: "Design Team" }).uncheck();
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByText("Changes saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByRole("checkbox", { name: "Design Team" })).not.toBeChecked();
});
