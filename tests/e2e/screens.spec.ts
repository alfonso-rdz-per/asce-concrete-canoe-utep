import { test } from "@playwright/test";
import { ADMIN, login } from "./helpers";

/** Capturas para revisión visual (no son aserciones). Solo con E2E_SCREENSHOTS=1. */
test.skip(!process.env.E2E_SCREENSHOTS, "solo con E2E_SCREENSHOTS=1");

test("capturas", async ({ page }, info) => {
  const dir = `test-results/screens/${info.project.name}`;
  await page.goto("/");
  await page.screenshot({ path: `${dir}-01-home.png`, fullPage: true });
  await page.goto("/admin/login");
  await page.screenshot({ path: `${dir}-02-login.png`, fullPage: true });

  if (!ADMIN) return;
  await login(page, ADMIN);
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.screenshot({ path: `${dir}-03-dashboard-empty.png`, fullPage: true });
  await page.goto("/admin/members/new");
  await page.screenshot({ path: `${dir}-04-new-member.png`, fullPage: true });
  await page.getByRole("button", { name: "Add member" }).click();
  await page.getByText("Enter the ASCE ID.").waitFor();
  await page.screenshot({ path: `${dir}-05-new-member-errors.png`, fullPage: true });
  await page.getByLabel("ASCE ID").fill(`0000000${Date.now().toString().slice(-6)}`);
  await page.getByLabel("Full name").fill("Screenshot Member");
  await page.getByRole("button", { name: "Add member" }).click();
  await page.waitForURL("**/admin/members"); // sin PIN: vuelve directamente a la lista
  await page.screenshot({ path: `${dir}-07-members.png`, fullPage: true });
  await page.goto("/admin");
  await page.getByRole("heading", { level: 1 }).waitFor();
  await page.screenshot({ path: `${dir}-08-dashboard.png`, fullPage: true });
});
