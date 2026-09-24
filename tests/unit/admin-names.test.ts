/**
 * "Started by Lesley": el nombre sale de `user_metadata.display_name` (solo lectura, texto no confiable) y, si no existe, del
 * respaldo actual basado en el correo. Se obtiene de la API de administración de Auth desde el servidor, nunca de `auth.users`.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const listUsers = vi.fn();
vi.mock("@/lib/supabase/admin", () => ({ createServiceRoleClient: () => ({ auth: { admin: { listUsers } } }) }));

import { fetchAdminFirstNames } from "@/lib/data/admin-names";

const user = (id: string, email: string, display_name?: unknown) => ({ id, email, user_metadata: display_name === undefined ? {} : { display_name } });

beforeEach(() => {
  listUsers.mockReset();
});

describe("fetchAdminFirstNames", () => {
  it("usa la primera palabra de display_name ('Lesley Torres' -> 'Lesley')", async () => {
    listUsers.mockResolvedValue({ data: { users: [user("u1", "lesley@utep.edu", "Lesley Torres")] }, error: null });
    expect((await fetchAdminFirstNames()).get("u1")).toBe("Lesley");
  });

  it("sin display_name usa el respaldo actual: la parte del correo antes de la @", async () => {
    listUsers.mockResolvedValue({ data: { users: [user("u2", "daniel.perez@utep.edu"), user("u3", "sam@utep.edu", "   ")] }, error: null });
    const names = await fetchAdminFirstNames();
    expect(names.get("u2")).toBe("daniel.perez");
    expect(names.get("u3")).toBe("sam");
  });

  it("trata display_name como texto no confiable: caracteres de control y bidireccionales se limpian", async () => {
    listUsers.mockResolvedValue({ data: { users: [user("u4", "x@utep.edu", "Le\u202esley\u0000 Torres")] }, error: null });
    const name = (await fetchAdminFirstNames()).get("u4") as string;
    expect(name).not.toMatch(/[\u202e\u0000]/);
    expect(name.length).toBeGreaterThan(0);
  });

  it("solo devuelve nombres (nunca correos completos ni otros metadatos) y varios administradores conviven", async () => {
    listUsers.mockResolvedValue({ data: { users: [user("u1", "lesley@utep.edu", "Lesley"), user("u2", "max@utep.edu", "Max V")] }, error: null });
    const names = await fetchAdminFirstNames();
    expect([...names.entries()]).toEqual([["u1", "Lesley"], ["u2", "Max"]]);
  });

  it("si Auth falla (error o excepción) no rompe nada: devuelve vacío y la interfaz omite 'Started by'", async () => {
    listUsers.mockResolvedValue({ data: { users: [] }, error: { message: "boom" } });
    expect((await fetchAdminFirstNames()).size).toBe(0);
    listUsers.mockImplementation(async () => {
      throw new Error("network");
    });
    expect((await fetchAdminFirstNames()).size).toBe(0);
  });

  it("no hay edición del nombre: el módulo solo LEE (listUsers), jamás actualiza usuarios", async () => {
    const src = (await import("node:fs")).readFileSync("src/lib/data/admin-names.ts", "utf8");
    expect(src).not.toMatch(/updateUser|createUser|deleteUser|updateUserById/);
  });
});
