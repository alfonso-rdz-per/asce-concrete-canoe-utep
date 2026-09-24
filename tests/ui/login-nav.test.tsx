import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

// La Server Action real usa cookies/Supabase: aquí se sustituye por una acción falsa.
const signIn = vi.fn();
vi.mock("@/app/admin/login/actions", () => ({ signInAction: (...args: unknown[]) => signIn(...args) }));

const pathname = vi.fn(() => "/admin");
vi.mock("next/navigation", () => ({ usePathname: () => pathname(), useRouter: () => ({ push: vi.fn() }) }));

import { LoginForm } from "@/app/admin/login/LoginForm";
import { NavLinks } from "@/components/admin/NavLinks";

beforeEach(() => {
  signIn.mockReset();
});

describe("LoginForm", () => {
  it("muestra los campos en inglés y no ofrece registro ni recuperación de contraseña", () => {
    render(<LoginForm next="/admin" />);
    expect(screen.getByLabelText("Email")).toHaveAttribute("autocomplete", "username");
    expect(screen.getByLabelText("Password")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Password")).toHaveAttribute("autocomplete", "current-password");
    expect(screen.getByRole("button", { name: "Sign in" })).toBeInTheDocument();
    expect(screen.queryByText(/forgot|sign up|register|create account/i)).toBeNull();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("los campos tienen texto >= 16 px y objetivo táctil >= 48 px", () => {
    render(<LoginForm next="/admin" />);
    for (const label of ["Email", "Password"]) {
      const el = screen.getByLabelText(label);
      expect(el.className).toContain("text-base");
      expect(el.className).toContain("min-h-12");
    }
    expect(screen.getByRole("button", { name: "Sign in" }).className).toContain("min-h-12");
  });

  it("envía el destino sanitizado por el servidor en un campo oculto", () => {
    render(<LoginForm next="/admin/members" />);
    expect(document.querySelector('input[name="next"]')).toHaveValue("/admin/members");
  });

  it("un fallo muestra UN mensaje genérico como alerta y conserva el correo (nunca la contraseña)", async () => {
    const user = userEvent.setup();
    signIn.mockResolvedValue({ status: "error", message: "Invalid email or password.", email: "ana@example.test" });
    render(<LoginForm next="/admin" />);

    await user.type(screen.getByLabelText("Email"), "ana@example.test");
    await user.type(screen.getByLabelText("Password"), "secreto-que-no-debe-volver");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email or password.");
    await waitFor(() => expect(screen.getByLabelText("Email")).toHaveValue("ana@example.test"));
    expect(screen.getByLabelText("Password")).toHaveValue("");
    expect(document.body.innerHTML).not.toContain("secreto-que-no-debe-volver");
  });

  it("muestra el aviso informativo cuando se redirigió al login", () => {
    render(<LoginForm next="/admin" notice="Please sign in to continue." />);
    expect(screen.getByRole("status")).toHaveTextContent("Please sign in to continue.");
  });
});

describe("NavLinks", () => {
  it("enlaza las cuatro secciones del panel (Fase 4): Dashboard, Sessions, Members y Attendance", () => {
    render(<NavLinks />);
    expect(screen.getByRole("navigation", { name: "Main" })).toBeInTheDocument();
    expect(screen.getAllByRole("link").map((l) => l.textContent)).toEqual(["Dashboard", "Sessions", "Members", "Attendance"]);
  });

  it("marca la página actual con aria-current (Dashboard solo en /admin exacto)", () => {
    pathname.mockReturnValue("/admin");
    const { unmount } = render(<NavLinks />);
    expect(screen.getByRole("link", { name: "Dashboard" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Members" })).not.toHaveAttribute("aria-current");
    unmount();

    pathname.mockReturnValue("/admin/members/abc/edit");
    render(<NavLinks />);
    expect(screen.getByRole("link", { name: "Members" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
  });

  it("cada enlace mide al menos 48 px de alto", () => {
    render(<NavLinks />);
    for (const link of screen.getAllByRole("link")) expect(link.className).toContain("min-h-12");
  });
});
