import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/sessions", useRouter: () => ({ push: vi.fn() }) }));
// La Server Action real usa cookies/Supabase: aquí se sustituye por una acción falsa.
vi.mock("@/app/admin/(shell)/sessions/actions", () => ({ startSessionAction: vi.fn(async () => ({ status: "idle" })) }));

import { NavLinks } from "@/components/admin/NavLinks";
import { CloseSessionControl, DeleteSessionControl, StartSessionButton } from "@/components/admin/SessionControls";
import { SessionForm } from "@/components/admin/SessionForm";
import { SessionList } from "@/components/admin/SessionList";
import type { ActionState } from "@/lib/action-state";
import type { SessionListItem } from "@/lib/data/sessions";

type Act = (prev: ActionState, fd: FormData) => Promise<ActionState>;
const idle: Act = async () => ({ status: "idle" });

describe("navegación del panel", () => {
  it("Dashboard · Sessions · Members · Attendance, en ese orden", () => {
    render(<NavLinks />);
    const links = within(screen.getByRole("navigation", { name: "Main" })).getAllByRole("link");
    expect(links.map((l) => l.textContent)).toEqual(["Dashboard", "Sessions", "Members", "Attendance"]);
    expect(links.map((l) => l.getAttribute("href"))).toEqual(["/admin", "/admin/sessions", "/admin/members", "/admin/attendance"]);
  });

  it("marca la sección activa (también en subrutas como /admin/sessions/…)", () => {
    render(<NavLinks />);
    expect(screen.getByRole("link", { name: "Sessions" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Dashboard" })).not.toHaveAttribute("aria-current");
  });
});

describe("SessionForm: New Session solo pide Session Name + Required (Design Team y/o Rowing & Construction)", () => {
  it("dos campos: 'Session Name' (obligatorio) y 'Required' con DOS casillas; por defecto solo Rowing & Construction", () => {
    render(<SessionForm action={idle} />);
    expect(screen.getByLabelText("Session Name")).toBeRequired();
    expect(screen.getByLabelText("Session Name")).toHaveAttribute("placeholder", "Concrete Canoe Practice");
    const group = screen.getByRole("group", { name: "Required" });
    const options = within(group).getAllByRole("checkbox");
    expect(options.map((o) => (o as HTMLInputElement).value)).toEqual(["design_team", "remar_construction"]);
    expect(within(group).getByRole("checkbox", { name: "Design Team" })).not.toBeChecked();
    expect(within(group).getByRole("checkbox", { name: "Rowing & Construction" })).toBeChecked();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    expect(screen.queryByRole("switch")).toBeNull(); // ya no es un booleano
    expect(screen.queryByRole("radio")).toBeNull(); // ya no son excluyentes: se pueden marcar las dos
    expect(screen.queryByText(/Remar/)).toBeNull(); // la etiqueta visible es en inglés: Rowing & Construction
  });

  it("NO pide descripción, ubicación, fecha ni hora (ni GPS, mapas o coordenadas)", () => {
    const { container } = render(<SessionForm action={idle} />);
    for (const label of [/description/i, /location/i, /schedul/i, /date/i, /time/i]) expect(screen.queryByLabelText(label), String(label)).toBeNull();
    expect(container.querySelector('input[type="datetime-local"], input[type="date"], input[type="time"], textarea')).toBeNull();
    expect(container.textContent).not.toMatch(/GPS|geolocation|coordinates|latitude|longitude|\bmap\b|bluetooth|nfc|wi-?fi|my location|description|location/i);
  });

  it("todo el texto es inglés y no queda rastro de Optional / On / Off", () => {
    const { container } = render(<SessionForm action={idle} />);
    expect(container.textContent).not.toMatch(/optional|\bon\b|\boff\b/i);
    expect(container.textContent).not.toMatch(/[áéíóúñ¿¡]/i);
  });

  it("UN solo botón: 'Start check-in'. NO existe 'Save as draft' ni ningún borrador", () => {
    const { container } = render(<SessionForm action={idle} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Start check-in" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /draft/i })).toBeNull();
    expect(container.textContent).not.toMatch(/draft/i);
    expect(container.querySelector('[name="intent"]')).toBeNull();
  });

  it("'Required' es un grupo LIMPIO de dos casillas nativas, sin tarjeta alrededor del grupo", () => {
    render(<SessionForm action={idle} />);
    const group = screen.getByRole("group", { name: "Required" });
    expect(group.tagName).toBe("FIELDSET");
    expect(group.className).not.toMatch(/\bborder\b|\bbg-white\b|\bshadow/);
    for (const box of within(group).getAllByRole("checkbox")) expect(box).toHaveAttribute("name", "audience");
  });

  it("envía SOLO el nombre y el grupo al pulsar 'Start check-in' (sin 'required', sin 'intent', sin fecha, sin ubicación)", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    render(<SessionForm action={action} />);
    await user.type(screen.getByLabelText("Session Name"), "Concrete Canoe Practice");
    await user.click(screen.getByRole("button", { name: "Start check-in" }));

    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("title")).toBe("Concrete Canoe Practice");
    expect(fd.get("audience")).toBe("remar_construction");
    expect([...fd.keys()].sort()).toEqual(["audience", "title"]);
  });

  it("se puede elegir SOLO Design Team (desmarcando la otra casilla)", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    render(<SessionForm action={action} />);
    await user.type(screen.getByLabelText("Session Name"), "Design review");
    await user.click(screen.getByRole("checkbox", { name: "Design Team" }));
    await user.click(screen.getByRole("checkbox", { name: "Rowing & Construction" }));
    expect(screen.getByRole("checkbox", { name: "Design Team" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rowing & Construction" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].getAll("audience")).toEqual(["design_team"]);
  });

  it("SE PUEDEN MARCAR LAS DOS a la vez (con clic y con el teclado) y se envían las dos", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    render(<SessionForm action={action} />);
    await user.type(screen.getByLabelText("Session Name"), "Whole team meeting");
    await user.click(screen.getByRole("checkbox", { name: "Design Team" }));
    expect(screen.getByRole("checkbox", { name: "Design Team" })).toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rowing & Construction" })).toBeChecked(); // marcar una NO desmarca la otra

    // Teclado: con el foco en la casilla, Espacio la desmarca y la vuelve a marcar.
    screen.getByRole("checkbox", { name: "Rowing & Construction" }).focus();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "Rowing & Construction" })).not.toBeChecked();
    await user.keyboard(" ");
    expect(screen.getByRole("checkbox", { name: "Rowing & Construction" })).toBeChecked();

    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].getAll("audience").sort()).toEqual(["design_team", "remar_construction"]);
  });

  it("errores del servidor: en inglés, con foco en el campo y SIN perder lo tecleado ni las casillas elegidas (una o las dos)", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({
      status: "error",
      message: "Please fix the highlighted field.",
      fieldErrors: { title: "Enter a session name." },
      values: { title: "", audience: "design_team,remar_construction" },
    });
    render(<SessionForm action={action} />);
    await user.click(screen.getByRole("button", { name: "Start check-in" }));

    expect(await screen.findByText("Enter a session name.")).toBeInTheDocument();
    expect(screen.getByText("Please fix the highlighted field.")).toBeInTheDocument();
    expect(screen.getByLabelText("Session Name")).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByLabelText("Session Name")).toHaveFocus();
    expect(screen.getByRole("checkbox", { name: "Design Team" })).toBeChecked(); // lo elegido se respeta…
    expect(screen.getByRole("checkbox", { name: "Rowing & Construction" })).toBeChecked(); // …incluidas las dos a la vez
  });

  it("un error del grupo (ninguna casilla marcada) se muestra junto a las opciones y las deja sin marcar", async () => {
    const user = userEvent.setup();
    const message = "Choose at least one team: Design Team or Rowing & Construction.";
    const action: Act = async () => ({ status: "error", message: "Please fix the highlighted field.", fieldErrors: { audience: message }, values: { title: "x", audience: "" } });
    render(<SessionForm action={action} />);
    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "Design Team" })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "Rowing & Construction" })).not.toBeChecked();
  });

  it("con un check-in en curso NO ofrece abrir otro: avisa y enlaza a su QR (sin botón de guardar borrador)", () => {
    render(<SessionForm action={idle} activeSession={{ id: "s-1", title: "Team meeting" }} />);
    expect(screen.getByText("A check-in is already in progress")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open the QR screen" })).toHaveAttribute("href", "/admin/sessions/s-1/qr");
    expect(screen.queryByRole("button", { name: "Start check-in" })).toBeNull();
    expect(screen.queryByRole("button", { name: /draft/i })).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("campos >= 16 px y objetivos táctiles >= 48 px (sin zoom automático en iOS)", () => {
    render(<SessionForm action={idle} />);
    expect(screen.getByLabelText("Session Name").className).toContain("text-base");
    expect(screen.getByLabelText("Session Name").className).toContain("min-h-12");
    expect(screen.getByRole("button", { name: "Start check-in" }).className).toContain("min-h-12");
    for (const box of screen.getAllByRole("checkbox")) expect(box.closest("label")?.className).toContain("min-h-12");
  });
});

describe("DeleteSessionControl: eliminar una sesión desde su detalle", () => {
  it("muestra 'Delete Session' y NO elimina nada hasta confirmar en el diálogo", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    render(<DeleteSessionControl sessionId="s-9" active={false} checkinCount={0} action={action} />);
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    expect(dialog).not.toHaveAttribute("open");

    await user.click(screen.getByRole("button", { name: "Delete Session" }));
    expect(dialog).toHaveAttribute("open");
    expect(dialog).toHaveAccessibleName("Delete this session?");
    expect(dialog).toHaveAccessibleDescription("This will permanently delete the session and its associated attendance records.");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(dialog).not.toHaveAttribute("open");
    expect(action).not.toHaveBeenCalled(); // cancelar no envía nada
  });

  it("al confirmar envía SOLO el id de la sesión", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    render(<DeleteSessionControl sessionId="s-9" active={false} checkinCount={0} action={action} />);
    await user.click(screen.getByRole("button", { name: "Delete Session" }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await user.click(within(dialog).getByRole("button", { name: "Delete Session" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("id")).toBe("s-9");
    expect([...fd.keys()]).toEqual(["id"]);
  });

  it("una sesión ACTIVA avisa de forma explícita de que el QR y los check-ins dejan de funcionar al instante", async () => {
    const user = userEvent.setup();
    render(<DeleteSessionControl sessionId="s-9" active checkinCount={12} action={idle} />);
    await user.click(screen.getByRole("button", { name: "Delete Session" }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    expect(dialog).toHaveAccessibleDescription(/Check-in is still open.*stops the QR code and rejects any check-in immediately.*permanently delete the session and its associated attendance records/);
    expect(screen.getByText("12 check-ins will be deleted with it.")).toBeInTheDocument();
  });

  it("si el servidor rechaza el borrado, muestra el error en inglés", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", message: "That session no longer exists." });
    render(<DeleteSessionControl sessionId="s-9" active={false} checkinCount={1} action={action} />);
    await user.click(screen.getByRole("button", { name: "Delete Session" }));
    const dialog = document.querySelector("dialog") as HTMLDialogElement;
    await user.click(within(dialog).getByRole("button", { name: "Delete Session" }));
    expect(await screen.findByText("That session no longer exists.")).toBeInTheDocument();
    expect(screen.getByText("1 check-in will be deleted with it.")).toBeInTheDocument();
  });
});

describe("StartSessionButton y CloseSessionControl", () => {
  it("StartSessionButton envía el id de la sesión y muestra el error del servidor (p. ej. ya hay otra activa)", async () => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "error", message: "A check-in is already in progress. Close it before starting another one." }));
    render(<StartSessionButton sessionId="s-9" sessionTitle="Design review" action={action} />);
    await user.click(screen.getByRole("button", { name: "Start check-in for Design review" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("id")).toBe("s-9");
    expect(await screen.findByRole("alert")).toHaveTextContent("A check-in is already in progress");
  });

  it("CloseSessionControl pide confirmación (cierre definitivo) y avisa con onClosed solo si el servidor confirma", async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    const action = vi.fn<Act>(async () => ({ status: "success", message: "Check-in closed." }));
    render(<CloseSessionControl sessionId="s-9" sessionTitle="Design review" action={action} onClosed={onClosed} />);

    await user.click(screen.getByRole("button", { name: "Close check-in" }));
    const dialog = document.querySelector("dialog[open]") as HTMLElement;
    expect(dialog).toHaveAccessibleName("Close check-in for “Design review”?");
    expect(dialog).toHaveTextContent("Closing is final");
    expect(action).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(action).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Close check-in" }));
    await user.click(within(document.querySelector("dialog[open]") as HTMLElement).getByRole("button", { name: "Close check-in" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("id")).toBe("s-9");
    await waitFor(() => expect(onClosed).toHaveBeenCalledTimes(1));
  });

  it("si el servidor rechaza el cierre, NO avisa como cerrado y muestra el error", async () => {
    const user = userEvent.setup();
    const onClosed = vi.fn();
    const action: Act = async () => ({ status: "error", message: "That session is already closed." });
    render(<CloseSessionControl sessionId="s-9" sessionTitle="X" action={action} onClosed={onClosed} />);
    await user.click(screen.getByRole("button", { name: "Close check-in" }));
    await user.click(within(document.querySelector("dialog[open]") as HTMLElement).getByRole("button", { name: "Close check-in" }));
    expect(await screen.findByText("That session is already closed.")).toBeInTheDocument();
    expect(onClosed).not.toHaveBeenCalled();
  });
});

describe("SessionList: 'Started by' y fecha/hora", () => {
  const base = { description: null, closed_at: null, created_at: "2026-09-01T00:00:00Z" };
  const sessions: SessionListItem[] = [
    { ...base, id: "s-3", title: "Concrete Canoe Practice", location: null, scheduled_at: "2026-09-20T01:40:00Z", opened_at: "2026-09-20T01:42:00Z", opened_by: "u-lesley", status: "active", audience: "remar_construction", presentCount: 12 },
    { ...base, id: "s-2", title: "Design review", location: null, scheduled_at: "2026-09-14T00:00:00Z", opened_at: null, opened_by: null, status: "draft", audience: "design_team", presentCount: 0 },
    // Sesión ANTIGUA (Fase 4): con ubicación y con un administrador que ya no existe (opened_by nulo).
    { ...base, id: "s-1", title: "Kickoff", location: "Room 101", scheduled_at: "2026-09-01T00:00:00Z", opened_at: "2026-09-01T18:30:00Z", opened_by: null, closed_at: "2026-09-01T19:30:00Z", status: "closed", audience: "remar_construction", presentCount: 20 },
  ];
  const starters = new Map([["u-lesley", "Lesley"]]);

  it("columnas Session · Required · Status · Attendance (sin columna de fecha aparte)", () => {
    render(<SessionList sessions={sessions} starters={starters} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Session", "Required", "Status", "Attendance", "Actions"]);
    expect(screen.getAllByRole("row")).toHaveLength(4);
  });

  it("muestra 'Started by Lesley', la fecha y hora de inicio (El Paso), el grupo (Rowing & Construction) y Active", () => {
    render(<SessionList sessions={sessions} starters={starters} />);
    const row = screen.getByRole("link", { name: "Concrete Canoe Practice" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("Started by Lesley")).toBeInTheDocument();
    expect(within(row).getByText("Sep 19, 2026 · 7:42 PM")).toBeInTheDocument();
    expect(within(row).getAllByText("Rowing & Construction").length).toBeGreaterThan(0);
    expect(within(row).queryByText(/Optional/)).toBeNull();
    expect(within(row).getByText("Active")).toBeInTheDocument();
    expect(within(row).getByText("12")).toBeInTheDocument();
  });

  it("un borrador no dice quién lo empezó: muestra cuándo se creó; Design Team y Draft", () => {
    render(<SessionList sessions={sessions} starters={starters} />);
    const row = screen.getByRole("link", { name: "Design review" }).closest("tr") as HTMLElement;
    expect(within(row).queryByText(/Started by/)).toBeNull();
    expect(within(row).getByText("Created Sep 13, 2026 · 6:00 PM")).toBeInTheDocument();
    expect(within(row).getAllByText("Design Team").length).toBeGreaterThan(0);
    expect(within(row).getByText("Draft")).toBeInTheDocument();
    expect(within(row).getByText("—")).toBeInTheDocument();
  });

  it("COMPATIBILIDAD: una sesión antigua (con ubicación, sin administrador conocido) sigue legible", () => {
    render(<SessionList sessions={sessions} starters={starters} />);
    const row = screen.getByRole("link", { name: "Kickoff" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("Location: Room 101")).toBeInTheDocument();
    expect(within(row).getByText("Sep 1, 2026 · 12:30 PM")).toBeInTheDocument();
    expect(within(row).queryByText(/Started by/)).toBeNull();
    expect(within(row).getByText("Closed")).toBeInTheDocument();
    expect(within(row).getByText("20")).toBeInTheDocument();
  });

  it("si Auth no devolvió nombres, la lista funciona igual (solo omite 'Started by')", () => {
    render(<SessionList sessions={sessions} starters={new Map()} />);
    expect(screen.queryByText(/Started by/)).toBeNull();
    expect(screen.getByText("Sep 19, 2026 · 7:42 PM")).toBeInTheDocument();
  });

  it("la acción depende del estado: Active -> 'Open QR'; Draft -> 'Start check-in'; Closed -> 'View'", () => {
    render(<SessionList sessions={sessions} starters={starters} />);
    expect(screen.getByRole("link", { name: "Open QR for Concrete Canoe Practice" })).toHaveAttribute("href", "/admin/sessions/s-3/qr");
    expect(screen.getByRole("button", { name: "Start check-in for Design review" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View Kickoff" })).toHaveAttribute("href", "/admin/sessions/s-1");
  });
});
