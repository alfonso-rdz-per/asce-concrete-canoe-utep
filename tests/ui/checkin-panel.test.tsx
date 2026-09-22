/**
 * Lo que ve el estudiante tras un QR válido: formulario ASCE ID + Name (solo el nombre, sin apellido, sin PIN) con "Remember me",
 * el modo de dispositivo recordado ("Checking in as … / Not you? Switch member") y la confirmación.
 */
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { CheckInPanel } from "@/components/checkin/CheckInPanel";
import { CHECKIN_MESSAGES, type CheckInState } from "@/lib/checkin/state";

const TICKET = "t1.PyyaTnsdTGqeXwobLD1OXw.AAAAAAAAAAAAAAAAAAAAAA.abc.def.MACMACMACMACMACMACMACM";
const expiresAtMs = Date.parse("2026-09-20T00:03:00Z"); // 6:03 PM en El Paso
type Act = (prev: CheckInState, fd: FormData) => Promise<CheckInState>;
const idle: Act = async () => ({ status: "idle" });

function panel(action: Act = idle, over: Partial<React.ComponentProps<typeof CheckInPanel>> = {}) {
  return render(
    <CheckInPanel
      ticket={TICKET}
      title="Concrete Canoe Practice"
      location={null}
      expiresAtMs={expiresAtMs}
      ticketMinutes={3}
      remembered={null}
      action={action}
      switchAction={async () => {}}
      {...over}
    />,
  );
}

describe("formulario", () => {
  it("confirma el QR y muestra sesión y una cuenta atrás pequeña y azul (3:00)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(expiresAtMs - 3 * 60_000);
    try {
      panel();
      expect(screen.getByRole("heading", { level: 1, name: "QR code accepted" })).toBeInTheDocument();
      expect(screen.getByText("Concrete Canoe Practice")).toBeInTheDocument();
      const timer = screen.getByRole("timer");
      expect(timer).toHaveTextContent("3:00");
      expect(timer).toHaveAttribute("aria-label", "Time left to check in: 3:00");
      expect(timer.className).toMatch(/text-blue/);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pide SOLO ASCE ID y Name (el campo se llama 'Name', no 'Full Name'); no hay PIN ni apellido", () => {
    const { container } = panel();
    expect(screen.getByLabelText("ASCE ID")).toBeEnabled();
    expect(screen.getByLabelText("Name")).toBeEnabled();
    expect(screen.queryByLabelText(/full name/i)).toBeNull();
    expect(screen.queryByLabelText(/last name|surname|apellido/i)).toBeNull();
    expect(screen.queryByLabelText(/pin/i)).toBeNull();
    expect(container.querySelector('input[name="pin"], input[type="password"]')).toBeNull();
    expect(container.textContent).not.toMatch(/\bPIN\b/);
    expect(screen.getAllByRole("textbox")).toHaveLength(2); // ASCE ID + Name
    expect(screen.getByRole("button", { name: "Check in" })).toBeEnabled();
  });

  it("incluye 'Remember me' (casilla SIN marcar por defecto, sin tarjeta alrededor)", () => {
    panel();
    const box = screen.getByRole("checkbox", { name: "Remember me" });
    expect(box).not.toBeChecked();
    expect(box).toHaveAttribute("name", "remember");
    expect(box.closest("label")?.className).not.toMatch(/\bborder\b|\bbg-white\b|\brounded-lg\b/);
  });

  it("el ticket va en un campo OCULTO: no se muestra, no se puede escribir y no hay entrada manual", () => {
    const { container } = panel();
    const hidden = container.querySelector('input[name="ticket"]') as HTMLInputElement;
    expect(hidden.type).toBe("hidden");
    expect(hidden.value).toBe(TICKET);
    expect(container.textContent).not.toContain(TICKET);
    expect(screen.queryByLabelText(/ticket/i)).toBeNull();
  });

  it("campos >= 16 px y objetivos táctiles >= 48 px (sin zoom automático en iOS)", () => {
    panel();
    for (const label of ["ASCE ID", "Name"]) {
      const el = screen.getByLabelText(label);
      expect(el.className).toContain("text-base");
      expect(el.className).toContain("min-h-12");
    }
    expect(screen.getByRole("button", { name: "Check in" }).className).toContain("min-h-12");
  });

  it("solo las sesiones antiguas muestran 'Location:' (ya no se pide al crear)", () => {
    const { unmount } = panel(idle, { location: "Construction Workshop" });
    expect(screen.getByText("Location: Construction Workshop")).toBeInTheDocument();
    unmount();
    panel();
    expect(screen.queryByText(/Location:/)).toBeNull();
  });
});

describe("envío", () => {
  it("el campo ASCE ID solo admite números: teclado numérico y descarta al momento cualquier otro carácter", async () => {
    const user = userEvent.setup();
    panel();
    const input = screen.getByLabelText("ASCE ID");
    expect(input).toHaveAttribute("inputmode", "numeric");
    expect(input).toHaveAttribute("pattern", "[0-9]*");
    await user.type(input, "AB-12x3 45");
    expect(input).toHaveValue("12345");
  });

  it("envía ticket, ASCE ID y Name en el cuerpo del formulario (y nada más)", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    panel(action);
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Max");
    await user.click(screen.getByRole("button", { name: "Check in" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("ticket")).toBe(TICKET);
    expect(fd.get("asceId")).toBe("12345678");
    expect(fd.get("name")).toBe("Max");
    expect([...fd.keys()].sort()).toEqual(["asceId", "name", "ticket"]); // sin marcar 'Remember me' no se envía "remember"
  });

  it("con 'Remember me' marcada se envía remember=on (junto con ticket, ASCE ID y Name)", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    panel(action);
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Max");
    await user.click(screen.getByRole("checkbox", { name: "Remember me" }));
    await user.click(screen.getByRole("button", { name: "Check in" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("remember")).toBe("on");
    expect([...fd.keys()].sort()).toEqual(["asceId", "name", "remember", "ticket"]);
  });

  it("ASCE ID + Name correctos: 'Check-in successful!' con el nombre que escribió y la sesión; ya no muestra el formulario", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "success", name: "Max", sessionTitle: "Concrete Canoe Practice", checkedInAt: "2026-09-20T00:04:00Z", remembered: false });
    panel(action);
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Max");
    await user.click(screen.getByRole("button", { name: "Check in" }));

    expect(await screen.findByRole("heading", { name: "Check-in successful!" })).toBeInTheDocument();
    expect(screen.getByText("Thanks, Max")).toBeInTheDocument();
    expect(screen.getByText("Checked in at 6:04 PM")).toBeInTheDocument();
    expect(screen.queryByLabelText("ASCE ID")).toBeNull();
    expect(screen.queryByText(/remember you/)).toBeNull();
  });

  it("si quedó recordado, la confirmación lo dice", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "success", name: "Max", sessionTitle: "Concrete Canoe Practice", checkedInAt: "2026-09-20T00:04:00Z", remembered: true });
    panel(action);
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Max");
    await user.click(screen.getByRole("checkbox", { name: "Remember me" }));
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByText("This device will remember you next time.")).toBeInTheDocument();
  });

  it("credenciales incorrectas: mensaje genérico, conserva lo escrito y se puede reintentar", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", ...CHECKIN_MESSAGES.bad_credentials, values: { asceId: "12345678", name: "Lewis" } });
    panel(action);
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Lewis");
    await user.click(screen.getByRole("button", { name: "Check in" }));

    expect(await screen.findByText("ASCE ID or name is incorrect. Check them and try again.")).toBeInTheDocument();
    expect(screen.getByLabelText("ASCE ID")).toHaveValue("12345678");
    expect(screen.getByLabelText("Name")).toHaveValue("Lewis");
    expect(screen.getByRole("button", { name: "Check in" })).toBeInTheDocument();
  });

  it("conserva también la casilla 'Remember me' tras un error de credenciales", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", ...CHECKIN_MESSAGES.bad_credentials, values: { asceId: "12345678", name: "Lewis", remember: true } });
    panel(action);
    await user.click(screen.getByRole("button", { name: "Check in" }));
    await screen.findByText("ASCE ID or name is incorrect. Check them and try again.");
    expect(screen.getByRole("checkbox", { name: "Remember me" })).toBeChecked();
  });

  it("errores de formato por campo, con foco en el primero", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: { asceId: "Enter the ASCE ID.", name: "Enter your name." },
      values: {},
      canRetry: true,
    });
    panel(action);
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByText("Enter the ASCE ID.")).toBeInTheDocument();
    expect(screen.getByText("Enter your name.")).toBeInTheDocument();
    expect(screen.getByLabelText("ASCE ID")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("ASCE ID")).toHaveFocus();
  });

  it.each([
    ["ticket_expired", "Your time to check in ran out. Scan the QR code again."],
    ["session_closed", "Check-in is closed for this session."],
    ["already_checked_in", "You're already checked in for this session."],
    ["ticket_invalid", "This check-in link isn't valid anymore. Scan the QR code again."],
    ["rate_limited", "Too many attempts. Wait a few minutes, then scan the QR code again."],
  ] as const)("%s: muestra el mensaje y OCULTA el formulario (este ticket ya no sirve)", async (reason, message) => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", ...CHECKIN_MESSAGES[reason] });
    panel(action);
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Max");
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(message);
    expect(screen.queryByLabelText("ASCE ID")).toBeNull();
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
  });
});

describe("dispositivo recordado (Remember me)", () => {
  const remembered = { name: "Max Verstappen" };

  it("saluda al miembro recordado, NO pide ASCE ID ni Name y basta pulsar 'Check in'", () => {
    const { container } = panel(idle, { remembered });
    expect(screen.getByText("Checking in as")).toBeInTheDocument();
    expect(screen.getByText("Max Verstappen")).toBeInTheDocument();
    expect(screen.queryByLabelText("ASCE ID")).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getByRole("button", { name: "Check in" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Not you? Switch member" })).toBeEnabled();
    // El QR/ticket sigue viajando (oculto) y no se muestra jamás.
    expect((container.querySelector('input[name="ticket"]') as HTMLInputElement).value).toBe(TICKET);
    expect(container.textContent).not.toContain(TICKET);
    // La página nunca recibe el ASCE ID ni ningún token: solo el nombre registrado.
    expect(container.textContent).not.toMatch(/A\d{8}|d1\./);
  });

  it("envía ticket + mode=remembered y NADA de identidad (el servidor la saca de la cookie HttpOnly)", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    panel(action, { remembered });
    await user.click(screen.getByRole("button", { name: "Check in" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect([...fd.keys()].sort()).toEqual(["mode", "ticket"]);
    expect(fd.get("mode")).toBe("remembered");
    expect(fd.get("ticket")).toBe(TICKET);
  });

  it("éxito con el dispositivo recordado: 'Check-in successful!' con el nombre registrado", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "success", name: "Max Verstappen", sessionTitle: "Concrete Canoe Practice", checkedInAt: "2026-09-20T00:04:00Z", remembered: true });
    panel(action, { remembered });
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByRole("heading", { name: "Check-in successful!" })).toBeInTheDocument();
    expect(screen.getByText("Thanks, Max Verstappen")).toBeInTheDocument();
  });

  it("'Not you? Switch member': olvida el dispositivo (acción del servidor) y vuelve al formulario ASCE ID + Name con el foco en el ASCE ID", async () => {
    const user = userEvent.setup();
    const switchAction = vi.fn(async () => {});
    panel(idle, { remembered, switchAction });
    await user.click(screen.getByRole("button", { name: "Not you? Switch member" }));

    await waitFor(() => expect(switchAction).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("ASCE ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toHaveValue("");
    expect(screen.getByRole("checkbox", { name: "Remember me" })).not.toBeChecked();
    expect(screen.queryByText("Checking in as")).toBeNull();
    await waitFor(() => expect(screen.getByLabelText("ASCE ID")).toHaveFocus());
  });

  it("si 'Switch member' falla en el servidor, igualmente se muestra el formulario (nunca deja al estudiante atascado)", async () => {
    const user = userEvent.setup();
    const switchAction = vi.fn(async () => {
      throw new Error("db down");
    });
    panel(idle, { remembered, switchAction });
    await user.click(screen.getByRole("button", { name: "Not you? Switch member" }));
    expect(await screen.findByLabelText("ASCE ID")).toBeInTheDocument();
  });

  it("dispositivo revocado/caducado o miembro inactivo (el servidor responde device_unrecognized): vuelve a pedir ASCE ID + Name con un aviso genérico", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", ...CHECKIN_MESSAGES.device_unrecognized, forgetDevice: true });
    panel(action, { remembered });
    await user.click(screen.getByRole("button", { name: "Check in" }));

    expect(await screen.findByText("We couldn't recognize this device. Enter your ASCE ID and name.")).toBeInTheDocument();
    expect(screen.getByLabelText("ASCE ID")).toBeInTheDocument();
    expect(screen.getByLabelText("Name")).toBeInTheDocument();
    expect(screen.queryByText("Checking in as")).toBeNull();
  });

  it("los errores que invalidan el ticket también se muestran con el dispositivo recordado (ya no sirve: hay que volver a escanear)", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", ...CHECKIN_MESSAGES.ticket_expired });
    panel(action, { remembered });
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Your time to check in ran out. Scan the QR code again.");
    expect(screen.queryByRole("button", { name: "Check in" })).toBeNull();
  });

  it("recordar NO es una alternativa a escanear: el panel solo existe con un QR válido (recibe el ticket) y no guarda nada en el navegador", () => {
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const { container } = panel(idle, { remembered });
    expect(container.querySelector('input[name="ticket"]')).not.toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    setItem.mockRestore();
  });
});
