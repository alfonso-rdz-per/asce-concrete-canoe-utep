import { describe, expect, it } from "vitest";
import { safeAdminRedirect } from "@/lib/auth/safe-redirect";

describe("safeAdminRedirect (anti open-redirect)", () => {
  it("acepta rutas internas bajo /admin (con query)", () => {
    expect(safeAdminRedirect("/admin")).toBe("/admin");
    expect(safeAdminRedirect("/admin/members")).toBe("/admin/members");
    expect(safeAdminRedirect("/admin/members?q=ana&status=active")).toBe("/admin/members?q=ana&status=active");
    expect(safeAdminRedirect("/admin/members/new")).toBe("/admin/members/new");
  });

  it("rechaza todo lo demás y cae al panel", () => {
    const bad: unknown[] = [
      undefined,
      null,
      42,
      {},
      "",
      "admin",
      "/",
      "/other",
      "/administrator",
      "/adminx",
      "//evil.example",
      "//evil.example/admin",
      "///evil.example",
      "https://evil.example",
      "https://evil.example/admin",
      "http://localhost/admin",
      "javascript:alert(1)",
      "/\\evil.example",
      "\\\\evil.example",
      "/admin\\..\\evil",
      "/admin\n/evil",
      "/admin\r\nSet-Cookie: x=1",
      "/admin\u0000",
      "/" + "a".repeat(300),
      "data:text/html,<script>1</script>",
    ];
    for (const b of bad) expect(safeAdminRedirect(b), JSON.stringify(b)).toBe("/admin");
  });

  it("nunca devuelve el propio login (evita bucles)", () => {
    expect(safeAdminRedirect("/admin/login")).toBe("/admin");
    expect(safeAdminRedirect("/admin/login?next=/admin")).toBe("/admin");
    expect(safeAdminRedirect("/admin/login/x")).toBe("/admin");
  });

  it("respeta un valor por defecto distinto", () => {
    expect(safeAdminRedirect("https://evil.example", "/admin/members")).toBe("/admin/members");
  });

  it("no permite escapar con codificación en la ruta (el resultado sigue bajo /admin)", () => {
    const r = safeAdminRedirect("/admin/%2e%2e/evil");
    expect(r.startsWith("/admin")).toBe(true);
    expect(r.startsWith("//")).toBe(false);
  });
});
