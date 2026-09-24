import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin", useRouter: () => ({ push: vi.fn() }) }));

import { AttendanceHistory, type AttendanceHistoryItem } from "@/components/admin/AttendanceHistory";
import { MemberForm } from "@/components/admin/MemberForm";
import { MemberList } from "@/components/admin/MemberList";
import { MemberRoster, type RosterRow } from "@/components/admin/MemberRoster";
import { StartCheckInCard } from "@/components/admin/StartCheckInCard";
import type { ActionState } from "@/lib/action-state";
import type { Member } from "@/lib/data/members";
import { POSITION_OPTIONS } from "@/lib/positions";

const DEFAULTS = { asceId: "", name: "", email: "", joinedOn: "2026-09-19" };
const idle = async (): Promise<ActionState> => ({ status: "idle" });

describe("MemberForm: cargo (position)", () => {
  it("ofrece exactamente los cargos pedidos y 'Member' por defecto; Custom Position está oculto", () => {
    render(<MemberForm mode="create" action={idle} defaults={DEFAULTS} submitLabel="Add member" />);
    const select = screen.getByLabelText("Position") as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.value)).toEqual([...POSITION_OPTIONS]);
    expect(select).toHaveValue("Member");
    expect(screen.queryByLabelText("Custom Position")).toBeNull();
  });

  it("al elegir 'Other' aparece 'Custom Position' (obligatorio) y al volver a un cargo predefinido desaparece", async () => {
    const user = userEvent.setup();
    render(<MemberForm mode="create" action={idle} defaults={DEFAULTS} submitLabel="Add member" />);
    await user.selectOptions(screen.getByLabelText("Position"), "Other");
    const custom = screen.getByLabelText("Custom Position");
    expect(custom).toBeRequired();
    expect(custom).toHaveAttribute("maxlength", "60");
    expect(custom.className).toContain("text-base"); // >= 16 px: sin zoom en iOS
    await user.selectOptions(screen.getByLabelText("Position"), "Safety Officer");
    expect(screen.queryByLabelText("Custom Position")).toBeNull();
  });

  it("envía el cargo elegido y, con 'Other', el texto personalizado", async () => {
    const user = userEvent.setup();
    const action = vi.fn<(prev: ActionState, fd: FormData) => Promise<ActionState>>(async () => ({ status: "idle" }));
    render(<MemberForm mode="create" action={action} defaults={DEFAULTS} submitLabel="Add member" />);

    await user.selectOptions(screen.getByLabelText("Position"), "Project Manager");
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect(action.mock.calls[0][1].get("position")).toBe("Project Manager");
    expect(action.mock.calls[0][1].has("customPosition")).toBe(false);

    await user.selectOptions(screen.getByLabelText("Position"), "Other");
    await user.type(screen.getByLabelText("Custom Position"), "Logistics Lead");
    await user.click(screen.getByRole("button", { name: "Add member" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(2));
    expect(action.mock.calls[1][1].get("position")).toBe("Other");
    expect(action.mock.calls[1][1].get("customPosition")).toBe("Logistics Lead");
  });

  it("edición: un cargo de la lista se preselecciona; uno personalizado abre 'Other' con el texto", () => {
    const { unmount } = render(<MemberForm mode="edit" action={idle} defaults={{ ...DEFAULTS, id: "m-1", position: "Testing Engineer" }} submitLabel="Save changes" />);
    expect(screen.getByLabelText("Position")).toHaveValue("Testing Engineer");
    expect(screen.queryByLabelText("Custom Position")).toBeNull();
    unmount();

    render(<MemberForm mode="edit" action={idle} defaults={{ ...DEFAULTS, id: "m-1", position: "Outreach Lead" }} submitLabel="Save changes" />);
    expect(screen.getByLabelText("Position")).toHaveValue("Other");
    expect(screen.getByLabelText("Custom Position")).toHaveValue("Outreach Lead");
  });

  it("'Other' sin texto: el error del servidor aparece en Custom Position, con foco, y no se pierde lo elegido", async () => {
    const user = userEvent.setup();
    const action = async (): Promise<ActionState> => ({
      status: "error",
      message: "Please fix the highlighted fields.",
      fieldErrors: { customPosition: "Enter the custom position." },
      values: { asceId: "AB-12", name: "Ana", email: "", joinedOn: "2026-09-19", position: "Other", customPosition: "" },
    });
    render(<MemberForm mode="create" action={action} defaults={DEFAULTS} submitLabel="Add member" />);
    await user.selectOptions(screen.getByLabelText("Position"), "Other");
    await user.click(screen.getByRole("button", { name: "Add member" }));

    await waitFor(() => expect(screen.getByText("Enter the custom position.")).toBeInTheDocument());
    const custom = screen.getByLabelText("Custom Position"); // el campo se vuelve a montar con el error: se consulta DESPUÉS
    expect(custom).toHaveAttribute("aria-invalid", "true");
    expect(custom).toHaveFocus();
    expect(screen.getByLabelText("Position")).toHaveValue("Other");
  });
});

describe("MemberList muestra el cargo", () => {
  const member = (over: Partial<Member>): Member => ({
    id: "m-1",
    asce_id: "AB-12",
    name: "Ana López",
    email: null,
    position: "Safety Officer",
    is_design_team: false,
    active: true,
    joined_on: "2026-09-01",
    deactivated_on: null,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    ...over,
  });

  it("columna Position en la tabla y línea de cargo en la tarjeta móvil", () => {
    render(<MemberList members={[member({}), member({ id: "m-2", name: "Bo", position: "Outreach Lead" })]} />);
    expect(screen.getByRole("columnheader", { name: "Position" })).toBeInTheDocument();
    expect(screen.getAllByText("Safety Officer").length).toBeGreaterThanOrEqual(2); // tabla + tarjeta
    expect(screen.getAllByText("Outreach Lead").length).toBeGreaterThanOrEqual(2);
  });
});

describe("MemberRoster (dashboard)", () => {
  const rows: RosterRow[] = [
    { id: "a", name: "John Smith", asceId: "123456", position: "Project Manager", percent: 94 },
    { id: "b", name: "Maria Lopez", asceId: "123457", position: "Structural Analysis Engineer", percent: 86 },
    { id: "c", name: "Alex Johnson", asceId: "123458", position: "Member", percent: 100 },
    { id: "d", name: "New Person", asceId: "999999", position: "Member", percent: null },
  ];

  it("columnas exactas: Member, ASCE ID, Position, Attendance (sin fecha de ingreso ni estado)", () => {
    render(<MemberRoster rows={rows} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Member", "ASCE ID", "Position", "Attendance"]);
    expect(screen.queryByText(/joined/i)).toBeNull();
    expect(screen.queryByText(/^(active|inactive)$/i)).toBeNull();
  });

  it("cada fila muestra nombre (enlace a su edición), ASCE ID, cargo y porcentaje", () => {
    render(<MemberRoster rows={rows} />);
    const row = screen.getByRole("link", { name: "Maria Lopez" }).closest("tr") as HTMLElement;
    expect(screen.getByRole("link", { name: "Maria Lopez" })).toHaveAttribute("href", "/admin/members/b/edit");
    expect(within(row).getAllByText("123457").length).toBeGreaterThan(0);
    expect(within(row).getAllByText(/Structural Analysis Engineer/).length).toBeGreaterThan(0);
    expect(within(row).getByText("86%")).toBeInTheDocument();
    expect(screen.getByText("94%")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("sin reuniones que cuenten se muestra «—» (con texto para lectores de pantalla), nunca 0 %", () => {
    render(<MemberRoster rows={rows} />);
    const row = screen.getByRole("link", { name: "New Person" }).closest("tr") as HTMLElement;
    expect(within(row).getByText("No meetings yet")).toHaveClass("sr-only");
    expect(within(row).queryByText(/%/)).toBeNull();
  });

  it("es una tabla con leyenda accesible y sin barras con estilo en línea (la CSP de producción las bloquearía)", () => {
    const { container } = render(<MemberRoster rows={rows} />);
    expect(screen.getByRole("table", { name: "Member roster with attendance" })).toBeInTheDocument();
    expect(container.querySelector("[style]")).toBeNull();
  });
});

describe("StartCheckInCard (Fase 4: funcional)", () => {
  it("es la llamada principal: 'Start Check-In' lleva al formulario de nueva sesión", () => {
    render(<StartCheckInCard />);
    expect(screen.getByRole("link", { name: "Start Check-In" })).toHaveAttribute("href", "/admin/sessions/new");
    expect(screen.getByRole("heading", { name: "Ready to take attendance?" })).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull(); // ya no hay botón desactivado
  });

  it("con un check-in en curso NO ofrece crear otro: 'Resume Check-In' lleva a la pantalla del QR de esa sesión", () => {
    render(<StartCheckInCard active={{ id: "s-1", title: "Team meeting" }} />);
    expect(screen.getByRole("link", { name: "Resume Check-In" })).toHaveAttribute("href", "/admin/sessions/s-1/qr");
    expect(screen.queryByRole("link", { name: "Start Check-In" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Team meeting" })).toBeInTheDocument();
    expect(screen.getByText("Check-in in progress")).toBeInTheDocument();
  });

  it("ya no habla de ubicación (New Session no la pide)", () => {
    const { container } = render(<StartCheckInCard active={{ id: "s-1", title: "Team meeting" }} />);
    expect(container.textContent).not.toMatch(/location/i);
    render(<StartCheckInCard />);
    // Sin check-in en curso, la tarjeta ya NO muestra el párrafo explicativo: solo el título y el botón.
    expect(screen.queryByText(/Name the session, start a check-in/)).toBeNull();
    expect(screen.getByRole("heading", { name: "Ready to take attendance?" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Start Check-In" })).toHaveAttribute("href", "/admin/sessions/new");
  });
});

describe("AttendanceHistory (corrección manual)", () => {
  const rows: AttendanceHistoryItem[] = [
    { sessionId: "s-3", title: "Sunday build", dateLabel: "Sep 21, 2026", sessionStatus: "active", audience: "remar_construction", forMember: true, status: "absent", source: "none" },
    { sessionId: "s-2", title: "Design review", dateLabel: "Sep 14, 2026", sessionStatus: "closed", audience: "remar_construction", forMember: true, status: "present", source: "check_in" },
    { sessionId: "s-1", title: "Guest workshop", dateLabel: "Sep 7, 2026", sessionStatus: "closed", audience: "design_team", forMember: false, status: "present", source: "manual" },
  ];

  it("muestra Meeting · Date · Status con los estados Present/Absent", () => {
    render(<AttendanceHistory memberId="m-1" memberName="Ana" rows={rows} action={idle} />);
    expect(screen.getAllByRole("columnheader").map((h) => h.textContent)).toEqual(["Meeting", "Date", "Status", "Change"]);
    const design = screen.getByRole("rowheader", { name: /Design review/ }).closest("tr") as HTMLElement;
    expect(within(design).getByText("Present")).toBeInTheDocument();
    const active = screen.getByRole("rowheader", { name: /Sunday build/ }).closest("tr") as HTMLElement;
    expect(within(active).getByText("Absent")).toBeInTheDocument();
  });

  it("solo las reuniones CERRADAS se pueden corregir; la que está en curso no", () => {
    render(<AttendanceHistory memberId="m-1" memberName="Ana" rows={rows} action={idle} />);
    const active = screen.getByRole("rowheader", { name: /Sunday build/ }).closest("tr") as HTMLElement;
    expect(within(active).queryByRole("button")).toBeNull();
    expect(within(active).getByText("In progress")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Mark Ana absent for Design review" })).toBeInTheDocument(); // presente -> ofrece Absent
    expect(screen.getByRole("button", { name: "Mark Ana absent for Guest workshop" })).toBeInTheDocument();
  });

  it("marca lo puesto a mano y avisa de que una reunión de OTRO grupo no cuenta para el porcentaje", () => {
    render(<AttendanceHistory memberId="m-1" memberName="Ana" rows={rows} action={idle} />);
    const workshop = screen.getByRole("rowheader", { name: /Guest workshop/ }).closest("tr") as HTMLElement;
    expect(within(workshop).getByText("Set manually")).toBeInTheDocument();
    expect(within(workshop).getByText(/Design Team · not counted in the percentage/)).toBeInTheDocument();
    expect(within(workshop).queryByText(/Optional/)).toBeNull();
  });

  it("cambiar Present -> Absent pide confirmación y envía miembro, reunión y NUEVO estado (nada se borra)", async () => {
    const user = userEvent.setup();
    const action = vi.fn<(prev: ActionState, fd: FormData) => Promise<ActionState>>(async () => ({ status: "success", message: "Marked as Absent." }));
    render(<AttendanceHistory memberId="m-1" memberName="Ana" rows={rows} action={action} />);

    await user.click(screen.getByRole("button", { name: "Mark Ana absent for Design review" }));
    const dialog = document.querySelector("dialog[open]") as HTMLDialogElement;
    expect(dialog).toHaveAccessibleName("Mark Ana as Absent?");
    expect(dialog).toHaveTextContent("recorded in the audit log");
    expect(action).not.toHaveBeenCalled(); // todavía no se envió: primero hay que confirmar

    await user.click(within(dialog).getByRole("button", { name: "Mark Absent" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect(fd.get("id")).toBe("m-1");
    expect(fd.get("sessionId")).toBe("s-2");
    expect(fd.get("status")).toBe("absent");
    expect(await screen.findByText("Marked as Absent.")).toBeInTheDocument();
  });

  it("Absent -> Present ofrece 'Mark present'", () => {
    const absentRows: AttendanceHistoryItem[] = [{ ...rows[1], status: "absent", source: "none" }];
    render(<AttendanceHistory memberId="m-1" memberName="Ana" rows={absentRows} action={idle} />);
    expect(screen.getByRole("button", { name: "Mark Ana present for Design review" })).toHaveTextContent("Mark present");
  });

  it("un error del servidor se muestra en inglés junto a la fila", async () => {
    const user = userEvent.setup();
    const action = async (): Promise<ActionState> => ({ status: "error", message: "Attendance can only be edited for closed meetings." });
    render(<AttendanceHistory memberId="m-1" memberName="Ana" rows={[rows[1]]} action={action} />);
    await user.click(screen.getByRole("button", { name: /Mark Ana absent/ }));
    await user.click(within(document.querySelector("dialog[open]") as HTMLElement).getByRole("button", { name: "Mark Absent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Attendance can only be edited for closed meetings.");
  });

  it("sin reuniones: estado vacío claro", () => {
    render(<AttendanceHistory memberId="m-1" memberName="Ana" rows={[]} action={idle} />);
    expect(screen.getByText(/No meetings yet/)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
