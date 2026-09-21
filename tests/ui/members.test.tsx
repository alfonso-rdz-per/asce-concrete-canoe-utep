import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { MemberForm } from "@/components/admin/MemberForm";
import { MemberStatusControl } from "@/components/admin/MemberControls";
import * as MemberControls from "@/components/admin/MemberControls";
import * as Dialogs from "@/components/ui/Dialogs";
import { ConfirmDialog } from "@/components/ui/Dialogs";
import { TextField } from "@/components/ui/Fields";
import type { ActionState } from "@/lib/action-state";

const DEFAULTS = { asceId: "", name: "", email: "", joinedOn: "2026-09-19" };
const ok = (over: Partial<Extract<ActionState, { status: "success" }>> = {}): ActionState => ({ status: "success", ...over });

describe("TextField (accesibilidad)", () => {
  it("etiqueta asociada, ayuda y error enlazados con aria-describedby, aria-invalid y texto >= 16 px", () => {
    render(<TextField label="ASCE ID" name="asceId" hint="3–32 letters." error="Enter the ASCE ID." />);
    const input = screen.getByLabelText("ASCE ID");
    expect(input).toHaveAttribute("aria-invalid", "true");
    const described = input.getAttribute("aria-describedby")?.split(" ") ?? [];
    expect(described).toHaveLength(2);
    expect(document.getElementById(described[0])).toHaveTextContent("3–32 letters.");
    expect(screen.getByRole("alert")).toHaveTextContent("Enter the ASCE ID.");
    expect(input.className).toContain("text-base"); // 16 px: sin zoom automático en iOS
    expect(input.className).toContain("min-h-12"); // 48 px de alto táctil
  });

  it("sin error no marca aria-invalid", () => {
    render(<TextField label="Email" name="email" optional />);
    expect(screen.getByLabelText(/Email/)).not.toHaveAttribute("aria-invalid");
    expect(screen.getByText("(optional)")).toBeInTheDocument();
  });
});

describe("MemberForm: formulario limpio, ASCE ID numérico y casilla Design Team", () => {
  it("SIN textos de ayuda: se eliminaron por completo (no se reemplazan por otros)", () => {
    const { container } = render(<MemberForm mode="create" action={async () => ({ status: "idle" })} defaults={DEFAULTS} submitLabel="Add member" />);
    const text = container.textContent ?? "";
    for (const gone of ["3–32 letters, numbers or hyphens.", "Choose Other to enter a different position.", "The date this member joined the team. Correct it here if needed."]) {
      expect(text).not.toContain(gone);
    }
    expect(text).not.toMatch(/letters|hyphens|Choose Other|joined the team/i);
    expect(container.querySelectorAll("[id$='-hint']")).toHaveLength(0);
    for (const label of ["ASCE ID", "Position", "Joined on"]) expect(screen.getByLabelText(label)).not.toHaveAttribute("aria-describedby");
  });

  it("el campo ASCE ID solo admite números: descarta al momento letras, guiones y espacios", async () => {
    const user = userEvent.setup();
    render(<MemberForm mode="create" action={async () => ({ status: "idle" })} defaults={DEFAULTS} submitLabel="Add member" />);
    const input = screen.getByLabelText("ASCE ID");
    await user.type(input, "ASCE-12a3 4-5");
    expect(input).toHaveValue("12345");
    expect(input).toHaveAttribute("maxlength", "32");
  });

  it("'Design Team': casilla APAGADA por defecto, sin tarjeta, y se envía como designTeam=on solo si se marca", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionState> => ({ status: "idle" }));
    render(<MemberForm mode="create" action={action} defaults={DEFAULTS} submitLabel="Add member" />);
    const box = screen.getByRole("checkbox", { name: "Design Team" });
    expect(box).not.toBeChecked();
    expect(box).toHaveAttribute("name", "designTeam");
    expect(box.closest("label")?.className).not.toMatch(/\bborder\b|\bbg-white\b|\brounded-lg\b/);

    await user.type(screen.getByLabelText("ASCE ID"), "12345");
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect((action.mock.calls[0] as unknown as [ActionState, FormData])[1].has("designTeam")).toBe(false);

    await user.click(screen.getByRole("checkbox", { name: "Design Team" }));
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect((action.mock.calls[1] as unknown as [ActionState, FormData])[1].get("designTeam")).toBe("on");
  });

  it("al EDITAR muestra el valor guardado y se puede cambiar", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionState> => ({ status: "idle" }));
    render(<MemberForm mode="edit" action={action} defaults={{ ...DEFAULTS, id: "id-1", asceId: "001234", name: "Ana", isDesignTeam: true }} submitLabel="Save changes" />);
    expect(screen.getByRole("checkbox", { name: "Design Team" })).toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "Design Team" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect((action.mock.calls[0] as unknown as [ActionState, FormData])[1].has("designTeam")).toBe(false);
  });

  it("tras un error conserva lo elegido en la casilla (también si se desmarcó)", async () => {
    const user = userEvent.setup();
    const action = async (): Promise<ActionState> => ({ status: "error", message: "Please fix the highlighted fields.", fieldErrors: { asceId: "ASCE ID must contain numbers only." }, values: { asceId: "", designTeam: "off" } });
    render(<MemberForm mode="edit" action={action} defaults={{ ...DEFAULTS, id: "id-1", asceId: "001234", name: "Ana", isDesignTeam: true }} submitLabel="Save changes" />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("ASCE ID must contain numbers only.")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Design Team" })).not.toBeChecked();
  });
});

describe("MemberForm", () => {
  it("muestra todos los campos en inglés", () => {
    render(<MemberForm mode="create" action={async () => ({ status: "idle" })} defaults={DEFAULTS} submitLabel="Add member" />);
    for (const label of ["ASCE ID", "Full name", /Email/, "Joined on"]) expect(screen.getByLabelText(label)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Add member" })).toBeInTheDocument();
    // ASCE ID solo numérico: teclado numérico y descarta al escribir cualquier otro carácter.
    expect(screen.getByLabelText("ASCE ID")).toHaveAttribute("inputmode", "numeric");
    expect(screen.getByLabelText("ASCE ID")).toHaveAttribute("pattern", "[0-9]*");
    expect(screen.getByLabelText("Joined on")).toHaveValue("2026-09-19");
  });

  it("errores del servidor: mensajes en inglés por campo, el foco va al primer campo inválido y NO se pierde lo tecleado", async () => {
    const user = userEvent.setup();
    const action = vi.fn(async (): Promise<ActionState> => ({
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: { asceId: "ASCE ID must be 3–32 letters, numbers or hyphens.", email: "Enter a valid email address." },
      values: { asceId: "x", name: "Ana López", email: "no", joinedOn: "2026-09-19" },
    }));
    render(<MemberForm mode="create" action={action} defaults={DEFAULTS} submitLabel="Add member" />);

    await user.type(screen.getByLabelText("ASCE ID"), "x");
    await user.type(screen.getByLabelText("Full name"), "Ana López");
    await user.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() => expect(screen.getByText("Enter a valid email address.")).toBeInTheDocument());
    expect(screen.getByText("ASCE ID must be 3–32 letters, numbers or hyphens.")).toBeInTheDocument();
    expect(screen.getByText("Please fix the highlighted fields.")).toBeInTheDocument();
    expect(screen.getByLabelText("ASCE ID")).toHaveFocus();
    expect(screen.getByLabelText("ASCE ID")).toHaveValue("x");
    expect(screen.getByLabelText("Full name")).toHaveValue("Ana López");
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("alta correcta: avisa con onCreated (la página vuelve a la lista) y NO muestra ningún PIN ni diálogo", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const action = async (): Promise<ActionState> => ok({ message: "Ana López was added." });
    render(<MemberForm mode="create" action={action} defaults={DEFAULTS} submitLabel="Add member" onCreated={onCreated} />);

    await user.type(screen.getByLabelText("ASCE ID"), "ab-12");
    await user.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("pin-value")).toBeNull();
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bPIN\b/);
  });

  it("un alta fallida NO avisa de creación (se queda en el formulario con el error)", async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const action = async (): Promise<ActionState> => ({ status: "error", message: "That ASCE ID is already registered." });
    render(<MemberForm mode="create" action={action} defaults={DEFAULTS} submitLabel="Add member" onCreated={onCreated} />);
    await user.click(screen.getByRole("button", { name: "Add member" }));
    expect(await screen.findByText("That ASCE ID is already registered.")).toBeInTheDocument();
    expect(onCreated).not.toHaveBeenCalled();
  });

  it("edición correcta: confirma con 'Changes saved.' (y no avisa de creación)", async () => {
    const user = userEvent.setup();
    const action = async (): Promise<ActionState> => ok({ message: "Changes saved." });
    render(<MemberForm mode="edit" action={action} defaults={{ ...DEFAULTS, id: "id-1", asceId: "AB-12", name: "Ana" }} submitLabel="Save changes" />);
    await user.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByText("Changes saved.")).toBeInTheDocument();
    expect(screen.queryByTestId("pin-value")).toBeNull();
    expect(document.querySelector('input[name="id"]')).toHaveValue("id-1");
    expect(screen.getByLabelText("Joined on")).toBeRequired();
  });
});

describe("el PIN ya no existe en la interfaz de administración", () => {
  it("no quedan el diálogo de PIN de un solo uso ni el control 'Reset PIN' (se eliminaron del código)", () => {
    expect(Object.keys(Dialogs)).not.toContain("PinRevealDialog");
    expect(Object.keys(MemberControls)).not.toContain("ResetPinControl");
    expect(Object.keys(MemberControls)).toEqual(["MemberStatusControl"]);
  });

  it("el formulario de alta no ofrece nada relacionado con un PIN", () => {
    render(<MemberForm mode="create" action={async () => ({ status: "idle" })} defaults={DEFAULTS} submitLabel="Add member" />);
    expect(screen.queryByLabelText(/pin/i)).toBeNull();
    expect(document.body.textContent).not.toMatch(/\bPIN\b/);
  });
});

describe("ConfirmDialog", () => {
  it("abre al pulsar, Cancel cierra sin enviar, y Confirm envía los campos ocultos", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((fd: FormData) => void fd);
    render(
      <ConfirmDialog
        triggerLabel="Deactivate member"
        title="Deactivate Ana?"
        description="They won't be able to check in."
        confirmLabel="Deactivate"
        pendingLabel="Deactivating…"
        danger
        action={submit}
        hidden={{ id: "m-1", active: "false" }}
      />,
    );
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    expect(dialog).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Deactivate member" }));
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAccessibleName("Deactivate Ana?");
    expect(dialog).toHaveAccessibleDescription("They won't be able to check in.");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog).not.toHaveAttribute("open");
    expect(submit).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Deactivate member" }));
    await user.click(screen.getByRole("button", { name: "Deactivate" }));
    await waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
    const fd = submit.mock.calls[0][0];
    expect(fd.get("id")).toBe("m-1");
    expect(fd.get("active")).toBe("false");
  });

  it("se cierra solo cuando la acción responde", async () => {
    const { rerender } = render(
      <ConfirmDialog triggerLabel="Open" title="t" description="d" confirmLabel="Confirm" pendingLabel="…" action={() => {}} state={{ status: "idle" }} />,
    );
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await act(async () => dialog.showModal());
    expect(dialog).toHaveAttribute("open");
    rerender(<ConfirmDialog triggerLabel="Open" title="t" description="d" confirmLabel="Confirm" pendingLabel="…" action={() => {}} state={{ status: "error", message: "x" }} />);
    await waitFor(() => expect(dialog).not.toHaveAttribute("open"));
  });
});

describe("controles de estado", () => {
  it("miembro activo: ofrece desactivar (con confirmación) y explica que se conserva el historial", () => {
    render(<MemberStatusControl memberId="m-1" memberName="Ana" active action={async () => ({ status: "idle" })} />);
    expect(screen.getByRole("button", { name: "Deactivate member" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Reactivate member" })).toBeNull();
    expect(screen.getByText(/history is kept/)).toBeInTheDocument();
  });

  it("miembro inactivo: ofrece reactivar y promete conservar la fecha de ingreso original", () => {
    render(<MemberStatusControl memberId="m-1" memberName="Ana" active={false} action={async () => ({ status: "idle" })} />);
    expect(screen.getByRole("button", { name: "Reactivate member" })).toBeInTheDocument();
    expect(screen.getByText(/keeps their original join date/)).toBeInTheDocument();
    expect(document.querySelector('input[name="active"]')).toHaveValue("true");
  });

});
