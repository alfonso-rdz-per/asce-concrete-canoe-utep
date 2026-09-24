import { expect, test } from "@playwright/test";
import { expectNoAxeViolations, expectNoHorizontalScroll, headerOf, trackCspViolations, trackRequestHosts } from "./helpers";

const SPANISH = /[áéíóúñ¿¡]|\b(inicio|asistencia|miembros?|sesi[oó]n|guardar|cancelar|bienvenid[oa]|contraseña|correo)\b/i;

test.describe("página de estudiantes (/)", () => {
  test("contenido, marca ASCE | UTEP y textos en inglés", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveTitle("ASCE | UTEP Concrete Canoe Team");
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    // Landing muy corta: quiénes somos + Instagram para seguirnos.
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("We build canoes out of concrete.");
    await expect(page.getByText(/University of Texas at El Paso/).first()).toBeVisible();
    await expect(page.getByText(/ASCE Concrete Canoe Competition/)).toBeVisible();
    await expect(page.getByRole("list", { name: "What we do" }).getByRole("listitem")).toHaveText(["Design", "Build", "Race"]);
    // Ya no es la pantalla de check-in.
    await expect(page.getByRole("heading", { name: "Ready to check in?" })).toHaveCount(0);

    // Marca: logos oficiales ASCE | UTEP (cabecera blanca + footer a color), cargados de verdad (no rotos)
    const logos = page.getByRole("img", { name: /^(ASCE|UTEP)$/ });
    await expect(logos).toHaveCount(4);
    for (const logo of await logos.all()) {
      expect(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)).toBe(true);
    }
    await expect(page.getByText(/logo\]/)).toHaveCount(0); // ya no hay marcadores

    expect(await page.locator("body").innerText()).not.toMatch(SPANISH);
  });

  test("imágenes del equipo: canoe-draw.png (sin deformar) y el fondo azul con imagen-fondo.jpg, en móvil y escritorio", async ({ page }) => {
    await page.goto("/");
    await page.waitForLoadState("networkidle");

    const canoe = page.getByTestId("canoe-illustration");
    await canoe.scrollIntoViewIfNeeded();
    await expect(canoe).toBeVisible();
    await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode().catch(() => undefined))));
    const info = await canoe.evaluate((img: HTMLImageElement) => ({ ok: img.complete && img.naturalWidth > 0, nw: img.naturalWidth, nh: img.naturalHeight, w: img.clientWidth, h: img.clientHeight, src: img.currentSrc }));
    expect(info.ok).toBe(true);
    expect([info.nw, info.nh]).toEqual([1023, 700]);
    expect(Math.abs(info.w / info.h - info.nw / info.nh), "la ilustración no se deforma").toBeLessThan(0.02);
    expect(new URL(info.src).pathname, "el PNG exacto, sin pasar por el optimizador").toBe("/brand/canoe-draw.png");
    expect(info.w).toBeGreaterThan(120);

    const bg = await page.locator(".hero-photo").evaluate((el) => {
      const cs = getComputedStyle(el);
      return { image: cs.backgroundImage, blend: cs.backgroundBlendMode, color: cs.backgroundColor, size: cs.backgroundSize };
    });
    expect(bg).toMatchObject({ blend: "luminosity", color: "rgb(0, 48, 112)", size: "cover" });
    expect(bg.image).toContain("/brand/imagen-fondo.jpg");
    expect((await page.request.get("/brand/imagen-fondo.jpg")).status()).toBe(200);
    expect((await page.request.get("/brand/canoe-draw.png")).headers()["content-type"]).toBe("image/png");

    // El texto blanco sigue siendo legible sobre el fondo y no hay desbordes.
    await expectNoHorizontalScroll(page);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expectNoAxeViolations(page, "landing con imágenes");
  });

  test("favicon: UN solo <link rel=icon> hacia /favicon.ico y el archivo servido es un .ico real con varios tamaños", async ({ page }) => {
    await page.goto("/");
    const links = page.locator('head link[rel~="icon"]');
    await expect(links).toHaveCount(1);
    const href = (await links.getAttribute("href")) ?? "";
    expect(new URL(href, page.url()).pathname).toBe("/favicon.ico");
    const res = await page.request.get(href);
    expect(res.status()).toBe(200);
    expect(res.headers()["content-type"]).toMatch(/image\/(x-icon|vnd\.microsoft\.icon)/);
    const body = await res.body();
    expect([body.readUInt16LE(0), body.readUInt16LE(2)]).toEqual([0, 1]); // ICONDIR: es un icono, no un WebP/PNG renombrado
    expect(body.readUInt16LE(4)).toBeGreaterThanOrEqual(3);
    // El navegador la decodifica de verdad.
    const ok = await page.evaluate(async (u: string) => {
      const img = new Image();
      img.src = u;
      await img.decode();
      return img.naturalWidth > 0;
    }, href);
    expect(ok).toBe(true);
  });

  test("NO hay escáner QR interno ni entrada manual de códigos, ni cámara", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("button")).toHaveCount(0);
    await expect(page.getByRole("textbox")).toHaveCount(0);
    await expect(page.locator("video, canvas, input[type=file]")).toHaveCount(0);
    const text = await page.locator("body").innerText();
    expect(text).not.toMatch(/enter (a )?(ticket )?code|ticket code|scan qr button|manual/i);
  });

  test("landing: botón 'Follow us on Instagram' con el enlace exacto y en una pestaña nueva", async ({ page }) => {
    await page.goto("/");
    const cta = page.getByRole("link", { name: /Follow us on Instagram/ });
    await expect(cta).toBeVisible();
    await expect(cta).toHaveAttribute("href", "https://www.instagram.com/asceconcretecanoe/");
    await expect(cta).toHaveAttribute("target", "_blank");
    expect(await cta.getAttribute("rel")).toMatch(/noopener/);
    expect(await cta.getAttribute("rel")).toMatch(/noreferrer/);
    await expect(page.getByRole("main").getByText("@asceconcretecanoe")).toBeVisible();
    // Es un enlace, no un botón (la portada no tiene controles interactivos aparte de los enlaces).
    expect(await cta.evaluate((el) => el.tagName)).toBe("A");
    await expectNoHorizontalScroll(page);
  });

  test("footer: Instagram con el enlace exacto, discreto y al final de la página", async ({ page }) => {
    await page.goto("/");
    const link = page.getByRole("link", { name: /Instagram · @asceconcretecanoe/ });
    await expect(link).toHaveAttribute("href", "https://www.instagram.com/asceconcretecanoe/");
    await expect(link).toHaveAttribute("target", "_blank");
    expect(await link.getAttribute("rel")).toMatch(/noopener/);
    expect(await link.getAttribute("rel")).toMatch(/noreferrer/);

    const gap = await page.evaluate(() => {
      const footer = document.querySelector("footer")!;
      return Math.abs(footer.getBoundingClientRect().bottom + window.scrollY - document.documentElement.scrollHeight);
    });
    expect(gap, "el footer debe quedar en el borde inferior del documento").toBeLessThanOrEqual(1);
  });

  test("en una página CORTA el footer queda pegado al borde inferior de la ventana", async ({ page }) => {
    await page.goto("/this-page-does-not-exist");
    const bottom = await page.evaluate(() => document.querySelector("footer")!.getBoundingClientRect().bottom);
    const innerHeight = await page.evaluate(() => window.innerHeight);
    expect(Math.abs(bottom - innerHeight)).toBeLessThanOrEqual(1);
  });

  test("cabeceras de seguridad y CSP con nonce (sin violaciones en el navegador)", async ({ page }) => {
    const violations = await trackCspViolations(page);
    const res = await page.goto("/");
    const csp = headerOf(res, "content-security-policy");
    expect(csp).toMatch(/script-src 'self' 'nonce-[A-Za-z0-9+/=]+' 'strict-dynamic'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(headerOf(res, "x-frame-options")).toBe("DENY");
    expect(headerOf(res, "x-content-type-options")).toBe("nosniff");
    expect(headerOf(res, "referrer-policy")).toBe("no-referrer");
    expect(headerOf(res, "permissions-policy")).toContain("camera=()");
    expect(headerOf(res, "permissions-policy")).toContain("geolocation=()");
    expect(headerOf(res, "x-powered-by")).toBe("");

    await page.waitForLoadState("networkidle");
    expect(await violations()).toEqual([]);
  });

  test("cada petición usa un nonce distinto", async ({ page }) => {
    const a = headerOf(await page.goto("/"), "content-security-policy");
    const b = headerOf(await page.goto("/"), "content-security-policy");
    expect(a.match(/nonce-([^']+)/)?.[1]).not.toBe(b.match(/nonce-([^']+)/)?.[1]);
  });

  test("el navegador solo habla con nuestro origen (sin Supabase, sin fuentes ni CDN externos)", async ({ page, baseURL }) => {
    const hosts = trackRequestHosts(page);
    await page.goto("/");
    await page.goto("/admin/login");
    await page.waitForLoadState("networkidle");
    expect(hosts()).toEqual([new URL(baseURL!).host]);
  });

  test("teclado: primer Tab = enlace 'Skip to main content'; Enter salta al contenido; el foco es visible", async ({ page, browserName }) => {
    test.skip(browserName === "webkit", "Safari no pasa el foco a enlaces con Tab por defecto (necesita Opción+Tab)");
    await page.goto("/");
    await page.keyboard.press("Tab");
    const skip = page.getByRole("link", { name: "Skip to main content" });
    await expect(skip).toBeFocused();
    await expect(skip).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page.locator("#main")).toBeFocused();

    // Foco visible en los enlaces de Instagram (el botón de la portada y el del footer; ancho de contorno >= 2 px)
    for (const insta of await page.getByRole("link", { name: /Instagram/ }).all()) {
      await insta.focus();
      const outline = await insta.evaluate((el) => {
        const s = getComputedStyle(el);
        return { style: s.outlineStyle, width: parseFloat(s.outlineWidth) };
      });
      expect(outline.style).not.toBe("none");
      expect(outline.width).toBeGreaterThanOrEqual(2);
    }
  });

  test("sin desbordamiento horizontal y con viewport-fit=cover (zonas seguras de iPhone)", async ({ page }) => {
    await page.goto("/");
    await expectNoHorizontalScroll(page);
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute("content", /viewport-fit=cover/);
  });

  test("página 404 en inglés, con marca y footer", async ({ page }) => {
    const res = await page.goto("/nope");
    expect(res?.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Back to home" })).toBeVisible();
    await expect(page.getByRole("link", { name: /Instagram/ })).toBeVisible();
    expect(await page.locator("body").innerText()).not.toMatch(SPANISH);
  });

  test("accesibilidad (axe): inicio y 404", async ({ page }) => {
    await page.goto("/");
    await expectNoAxeViolations(page, "/");
    await page.goto("/nope");
    await expectNoAxeViolations(page, "404");
  });
});
