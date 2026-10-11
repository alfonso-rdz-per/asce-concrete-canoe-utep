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

describe("SessionForm: single session type", () => {
  it("offers three native radio options, with Rowing selected", () => {
    render(<SessionForm action={idle} />);
    expect(screen.getByLabelText("Session Name")).toBeRequired();
    const options = within(screen.getByRole("group", { name: "Session type" })).getAllByRole("radio");
    expect(options.map((o) => (o as HTMLInputElement).value)).toEqual(["remar_construction", "design_team", "optional"]);
    expect(screen.getByRole("radio", { name: "Rowing & Construction" })).toBeChecked();
    expect(screen.queryByRole("checkbox")).toBeNull();
    expect(screen.getAllByRole("textbox")).toHaveLength(1);
    for (const option of options) expect(option.closest("label")?.className).toContain("min-h-12");
  });
  it.each(["Design Team", "Optional"])("selecting %s unselects Rowing and sends one audience", async (label) => {
    const user = userEvent.setup();
    const action = vi.fn<Act>(async () => ({ status: "idle" }));
    render(<SessionForm action={action} />);
    await user.type(screen.getByLabelText("Session Name"), "Practice");
    await user.click(screen.getByRole("radio", { name: label }));
    expect(screen.getByRole("radio", { name: "Rowing & Construction" })).not.toBeChecked();
    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.getAll("audience")).toEqual([label === "Optional" ? "optional" : "design_team"]);
    expect([...fd.keys()].sort()).toEqual(["audience", "title"]);
  });
  it("a selected option cannot be unchecked by clicking it again", async () => {
    const user = userEvent.setup();
    render(<SessionForm action={idle} />);
    await user.click(screen.getByRole("radio", { name: "Rowing & Construction" }));
    expect(screen.getByRole("radio", { name: "Rowing & Construction" })).toBeChecked();
  });
  it("preserves Optional on validation failure and focuses the title error", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", message: "Please fix the highlighted field.", fieldErrors: { title: "Enter a session name." }, values: { title: "", audience: "optional" } });
    render(<SessionForm action={action} />);
    await user.click(screen.getByRole("radio", { name: "Optional" }));
    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    expect(await screen.findByText("Enter a session name.")).toBeInTheDocument();
    expect(screen.getByLabelText("Session Name")).toHaveFocus();
    expect(screen.getByRole("radio", { name: "Optional" })).toBeChecked();
  });
  it("blocks starting another session while one is active", () => {
    render(<SessionForm action={idle} activeSession={{ id: "s-1", title: "Team meeting" }} />);
    expect(screen.getByRole("link", { name: "Open the QR screen" })).toHaveAttribute("href", "/admin/sessions/s-1/qr");
    expect(screen.queryByRole("button", { name: "Start check-in" })).toBeNull();
  });
  it("links an audience error to the radio group and focuses it", async () => {
    const user = userEvent.setup();
    const action: Act = async () => ({ status: "error", message: "Please fix the highlighted field.", fieldErrors: { audience: "Choose one session type." }, values: { title: "Practice", audience: "" } });
    render(<SessionForm action={action} />);
    await user.click(screen.getByRole("button", { name: "Start check-in" }));
    expect(await screen.findByText("Choose one session type.")).toBeInTheDocument();
    const group = screen.getByRole("radiogroup", { name: "Session type" });
    expect(group).toHaveAttribute("aria-invalid", "true");
    expect(group).toHaveAccessibleDescription("Choose one session type.");
    expect(group).toHaveFocus();
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
