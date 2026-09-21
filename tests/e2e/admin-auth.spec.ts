import { expect, test, type Page } from "@playwright/test";
import { ADMIN, NONAME, expectNoAxeViolations, expectNoHorizontalScroll, formAlert, login, trackCspViolations, trackRequestHosts } from "./helpers";

async function signOut(page: Page) {
  const menu = page.getByRole("button", { name: "Open menu" });
  if (await menu.isVisible()) await menu.click();
  await page.getByRole("button", { name: "Sign out" }).click();
  await page.waitForURL("**/admin/login");
}

test.describe("acceso de administradores", () => {
  test("sin sesión, /admin/* redirige al login conservando el destino", async ({ page }) => {
    for (const path of ["/admin", "/admin/members", "/admin/members/new"]) {
      await page.goto(path);
      await expect(page).toHaveURL(new RegExp(`/admin/login\\?next=${encodeURIComponent(path).replace(/%/g, "%")}`));
      await expect(page.getByRole("heading", { name: "Admin sign in" })).toBeVisible();
    }
  });

  test("el login no ofrece registro ni recuperación de contraseña; textos en inglés y sin CSP violada", async ({ page }) => {
    const violations = await trackCspViolations(page);
    await page.goto("/admin/login");
    await expect(page.getByLabel("Email")).toBeVisible();
    await expect(page.getByLabel("Password")).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/forgot|sign up|register|create (an )?account|reset password/i);
    await page.waitForLoadState("networkidle");
    expect(await violations()).toEqual([]);
    await expectNoHorizontalScroll(page);
  });

  test("campos >= 16 px y objetivos táctiles >= 44 px (sin zoom automático en iOS)", async ({ page }) => {
    await page.goto("/admin/login");
    for (const el of [page.getByLabel("Email"), page.getByLabel("Password")]) {
      const m = await el.evaluate((n) => ({ font: parseFloat(getComputedStyle(n).fontSize), height: n.getBoundingClientRect().height }));
      expect(m.font).toBeGreaterThanOrEqual(16);
      expect(m.height).toBeGreaterThanOrEqual(44);
    }
    const btn = await page.getByRole("button", { name: "Sign in" }).boundingBox();
    expect(btn!.height).toBeGreaterThanOrEqual(44);
  });

  test("accesibilidad (axe): login, con y sin error", async ({ page }) => {
    await page.goto("/admin/login");
    await expectNoAxeViolations(page, "login");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formAlert(page)).toHaveText("Enter your email and password.");
    await expectNoAxeViolations(page, "login con error");
  });

  test("credenciales incorrectas o correo inexistente: el MISMO mensaje genérico", async ({ page }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    await page.goto("/admin/login");
    await page.getByLabel("Email").fill(ADMIN!.email);
    await page.getByLabel("Password").fill("contraseña-incorrecta-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formAlert(page)).toHaveText("Invalid email or password.");
    const first = await formAlert(page).innerText();
    expect(first).toBe("Invalid email or password.");

    await page.getByLabel("Email").fill("nadie-existe-zz@example.com");
    await page.getByLabel("Password").fill("otra-contraseña-123");
    await page.getByRole("button", { name: "Sign in" }).click();
    await expect(formAlert(page)).toHaveText(first);
    await expect(page).toHaveURL(/\/admin\/login/);
  });

  test("open redirect: un ?next= externo se ignora y se aterriza en /admin", async ({ page, baseURL }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    await login(page, ADMIN!, "https://evil.example/steal");
    expect(new URL(page.url()).host).toBe(new URL(baseURL!).host);
    expect(new URL(page.url()).pathname).toBe("/admin");
    await signOut(page);
  });

  test("un ?next= interno válido se respeta", async ({ page }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    await login(page, ADMIN!, "/admin/members");
    await expect(page).toHaveURL(/\/admin\/members$/);
    await expect(page.getByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    await signOut(page);
  });

  test("saludo con display_name: 'Welcome, Validation' (primera palabra)", async ({ page }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    await login(page, ADMIN!);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Welcome, Validation");
    await signOut(page);
  });

  test("saludo SIN display_name: usa la parte anterior al @ del correo", async ({ page }) => {
    test.skip(!NONAME, "requiere usuarios temporales");
    await login(page, NONAME!);
    const local = NONAME!.email.split("@")[0];
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Welcome, ${local}`);
    await signOut(page);
  });

  test("cookies de sesión: HttpOnly + SameSite=Lax, invisibles para JavaScript", async ({ page, context }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    // Lo que el servidor ENVÍA (independiente del motor: WebKit informa mal SameSite en context.cookies()).
    const setCookies: string[] = [];
    page.on("response", async (r) => {
      for (const h of await r.headersArray().catch(() => [])) if (h.name.toLowerCase() === "set-cookie" && h.value.startsWith("sb-")) setCookies.push(h.value);
    });
    await login(page, ADMIN!);
    expect(setCookies.length).toBeGreaterThan(0);
    for (const c of setCookies) {
      expect(c, c.split("=")[0]).toMatch(/;\s*HttpOnly/i);
      expect(c, c.split("=")[0]).toMatch(/;\s*SameSite=Lax/i);
      expect(c, c.split("=")[0]).toMatch(/;\s*Path=\//i);
    }

    const auth = (await context.cookies()).filter((c) => c.name.startsWith("sb-"));
    expect(auth.length).toBeGreaterThan(0);
    for (const c of auth) {
      expect(c.httpOnly, c.name).toBe(true);
      expect(c.path).toBe("/");
    }
    expect(await page.evaluate(() => document.cookie)).not.toContain("sb-");
    await signOut(page);
  });

  test("el navegador NUNCA habla con Supabase ni carga recursos externos durante todo el flujo", async ({ page, baseURL }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    const hosts = trackRequestHosts(page);
    await login(page, ADMIN!);
    await page.goto("/admin/members");
    await page.getByRole("heading", { level: 1, name: "Members" }).waitFor();
    await signOut(page);
    expect(hosts()).toEqual([new URL(baseURL!).host]);
  });

  test("ningún secreto ni clave de Supabase llega al JavaScript ni al HTML del navegador", async ({ page, request, baseURL }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    const secrets = [
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      process.env.SERVER_SECRET,
      process.env.PIN_PEPPER,
    ].filter((v): v is string => Boolean(v && v.length > 20));
    expect(secrets.length).toBe(4);

    const bodies: string[] = [];
    page.on("response", async (r) => {
      const type = r.headers()["content-type"] ?? "";
      if (/javascript|html|json/.test(type)) bodies.push(await r.text().catch(() => ""));
    });
    await login(page, ADMIN!);
    await page.goto("/admin/members/new");
    await page.waitForLoadState("networkidle");
    await page.goto("/");
    await page.waitForLoadState("networkidle");
    expect(bodies.length).toBeGreaterThan(5);
    for (const secret of secrets) for (const body of bodies) expect(body.includes(secret)).toBe(false);
    void request;
    void baseURL;
    await page.goto("/admin");
    await signOut(page);
  });

  test("cerrar sesión: vuelve al login, borra la sesión y /admin ya no es accesible", async ({ page, context }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    await login(page, ADMIN!);
    await signOut(page);
    expect((await context.cookies()).filter((c) => c.name.startsWith("sb-") && c.value.length > 0 && !/^base64-?$/.test(c.value))).toEqual([]);
    await page.goto("/admin");
    await expect(page).toHaveURL(/\/admin\/login\?next=/);
  });

  test("REVOCACIÓN: un administrador baneado pierde el acceso en la siguiente petición, aunque su sesión siga viva", async ({ page }) => {
    test.skip(!ADMIN, "requiere usuarios temporales");
    const base = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const headers = {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY!,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    };
    // Usuario propio de esta ejecución (los tres perfiles corren en serie y uno bloquearía al siguiente).
    const email = `zz-validation-revoke-${Date.now().toString(16)}@example.com`;
    const password = `Rv-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    const created = await fetch(`${base}/auth/v1/admin/users`, { method: "POST", headers, body: JSON.stringify({ email, password, email_confirm: true }) });
    expect(created.ok).toBe(true);
    const { id } = (await created.json()) as { id: string };

    try {
      await login(page, { email, password });
      await expect(page.getByRole("heading", { level: 1 })).toContainText("Welcome");

      const ban = await fetch(`${base}/auth/v1/admin/users/${id}`, { method: "PUT", headers, body: JSON.stringify({ ban_duration: "1h" }) });
      expect(ban.ok).toBe(true);

      await page.goto("/admin/members");
      await expect(page).toHaveURL(/\/admin\/login/);
      await expect(page.getByRole("heading", { name: "Admin sign in" })).toBeVisible();

      // y tampoco puede volver a entrar
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill(password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(formAlert(page)).toHaveText("Invalid email or password.");
    } finally {
      await fetch(`${base}/auth/v1/admin/users/${id}`, { method: "DELETE", headers });
    }
  });
});
