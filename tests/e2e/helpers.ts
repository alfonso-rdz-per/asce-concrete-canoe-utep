import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, type Response } from "@playwright/test";

export interface Creds {
  email: string;
  password: string;
}

export const ADMIN: Creds | null = process.env.E2E_ADMIN_EMAIL
  ? { email: process.env.E2E_ADMIN_EMAIL, password: process.env.E2E_ADMIN_PASSWORD ?? "" }
  : null;
export const NONAME: Creds | null = process.env.E2E_NONAME_EMAIL
  ? { email: process.env.E2E_NONAME_EMAIL, password: process.env.E2E_NONAME_PASSWORD ?? "" }
  : null;
export const OUTSIDER: (Creds & { id: string }) | null = process.env.E2E_OUTSIDER_EMAIL
  ? { email: process.env.E2E_OUTSIDER_EMAIL, password: process.env.E2E_OUTSIDER_PASSWORD ?? "", id: process.env.E2E_OUTSIDER_ID ?? "" }
  : null;

export async function login(page: Page, creds: Creds, next?: string) {
  await page.goto(next ? `/admin/login?next=${encodeURIComponent(next)}` : "/admin/login");
  await page.getByLabel("Email").fill(creds.email);
  await page.getByLabel("Password").fill(creds.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL((url) => url.pathname.startsWith("/admin") && !url.pathname.startsWith("/admin/login"));
}

/** Accesibilidad (axe): WCAG 2.0/2.1/2.2 A y AA + buenas prácticas. Falla con la lista legible de infracciones. */
export async function expectNoAxeViolations(page: Page, label: string) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"])
    .analyze();
  const summary = results.violations.map((v) => `${v.id} (${v.impact}): ${v.help} -> ${v.nodes.map((n) => n.target.join(" ")).join(" | ")}`);
  expect(summary, `axe en «${label}»`).toEqual([]);
}

/** Registra violaciones de CSP del navegador (evento securitypolicyviolation). Llamar ANTES de navegar. */
export async function trackCspViolations(page: Page) {
  await page.addInitScript(() => {
    (window as unknown as { __csp: string[] }).__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => {
      (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} <- ${e.blockedURI || "inline"}`);
    });
  });
  return async () => page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
}

/** Sin desbordamiento horizontal. */
export async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "desbordamiento horizontal (px)").toBeLessThanOrEqual(0);
}

export function headerOf(res: Response | null, name: string): string {
  return res?.headers()[name.toLowerCase()] ?? "";
}

/** Hosts a los que el navegador hizo peticiones (para probar que nunca habla con Supabase directamente). */
export function trackRequestHosts(page: Page): () => string[] {
  const hosts = new Set<string>();
  page.on("request", (r) => {
    try {
      hosts.add(new URL(r.url()).host);
    } catch {
      /* data: / blob: */
    }
  });
  return () => [...hosts];
}

/** Alerta de un formulario (excluye el anunciador de rutas de Next, que también usa role=alert). */
export const formAlert = (page: Page) => page.locator('form [role="alert"], main [role="alert"]').first();
