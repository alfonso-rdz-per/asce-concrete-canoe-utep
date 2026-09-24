import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ usePathname: () => "/admin/attendance", useRouter: () => ({ push: vi.fn() }) }));

import { AttendanceGroupFilter, AttendanceMeetingList } from "@/components/admin/AttendanceOverview";
import { SessionAttendance } from "@/components/admin/SessionAttendance";
import type { ActionState } from "@/lib/action-state";
import type { MeetingSummary, RosterRow } from "@/lib/attendance";
import type { MeetingRow } from "@/lib/data/attendance";

const idle = async (): Promise<ActionState> => ({ status: "idle" });
const MEETINGS: MeetingRow[] = [
  { sessionId: "s-3", title: "Concrete Canoe Meeting", heldAt: "2026-09-19T18:00:00Z", audience: "design_team", present: 8, expected: 10, rate: 80 },
  { sessionId: "s-2", title: "Sunday build", heldAt: "2026-09-13T15:00:00Z", audience: "remar_construction", present: 0, expected: 0, rate: null },
  { sessionId: "s-1", title: "Kickoff", heldAt: "2026-09-01T15:00:00Z", audience: "remar_construction", present: 12, expected: 12, rate: 100 },
];

describe("Attendance: filtro por grupo", () => {
  it("ofrece All, Design Team y Rowing & Construction como enlaces (GET) y marca el activo con aria-current", () => {
    render(<AttendanceGroupFilter group="design_team" />);
    const nav = screen.getByRole("navigation", { name: "Filter by group" });
    const links = within(nav).getAllByRole("link");
    expect(links.map((l) => [l.textContent, l.getAttribute("href")])).toEqual([
      ["All", "/admin/attendance"],
      ["Design Team", "/admin/attendance?group=design_team"],
      ["Rowing & Construction", "/admin/attendance?group=remar_construction"],
    ]);
    expect(links.map((l) => l.getAttribute("aria-current"))).toEqual([null, "page", null]);
  });

  it("'All' está activo por defecto y los botones son cómodos al tacto (alto mínimo 44 px)", () => {
    render(<AttendanceGroupFilter group="all" />);
    expect(screen.getByRole("link", { name: "All" })).toHaveAttribute("aria-current", "page");
    for (const l of screen.getAllByRole("link")) expect(l.className).toContain("min-h-11");
  });
});

describe("Attendance: historial de reuniones cerradas", () => {
  it("cada reunión muestra nombre, grupo, fecha, presentes / esperados, porcentaje y enlaza a su detalle", () => {
    render(<AttendanceMeetingList meetings={MEETINGS} />);
    const link = screen.getByRole("link", { name: /Concrete Canoe Meeting/ });
    expect(link).toHaveAttribute("href", "/admin/sessions/s-3");
    expect(link).toHaveTextContent("Concrete Canoe Meeting");
    expect(link).toHaveTextContent("Design Team · Sep 19, 2026");
    expect(link).toHaveTextContent("8 / 10");
    expect(link).toHaveTextContent("80%");
    expect(link.className).toContain("min-h-11");
    // Nombre accesible completo (lectores de pantalla).
    expect(link).toHaveAccessibleName(/8 of 10 present, attendance rate 80%/);
  });

  it("nadie esperado: 0 / 0 y el porcentaje es «—», no «0%»", () => {
    render(<AttendanceMeetingList meetings={MEETINGS} />);
    const row = screen.getByRole("link", { name: /Sunday build/ });
    expect(row).toHaveTextContent("0 / 0");
    expect(row).toHaveTextContent("—");
    expect(row).not.toHaveTextContent("0%");
  });

  it("todos presentes es 100 % y una tasa fuera de rango nunca se muestra por encima de 100 %", () => {
    render(<AttendanceMeetingList meetings={[MEETINGS[2], { ...MEETINGS[0], sessionId: "s-9", title: "Raro", rate: 150 }]} />);
    expect(screen.getByRole("link", { name: /Kickoff/ })).toHaveTextContent("12 / 12");
    expect(screen.getByRole("link", { name: /Kickoff/ })).toHaveTextContent("100%");
    expect(screen.getByRole("link", { name: /Raro/ })).toHaveTextContent("100%");
    expect(document.body.textContent).not.toMatch(/1[0-9]{2}%(?<!100%)/); // ningún «1xx%» distinto de 100 %
  });

  it("es una lista (una entrada por reunión), en el orden recibido", () => {
    render(<AttendanceMeetingList meetings={MEETINGS} />);
    const items = screen.getAllByRole("listitem");
    expect(items).toHaveLength(3);
    expect([/^Concrete Canoe Meeting/, /^Sunday build/, /^Kickoff/].map((re, i) => re.test(items[i].textContent ?? ""))).toEqual([true, true, true]);
    expect(items[1]).toHaveTextContent("Rowing & Construction · Sep 13, 2026");
  });
});

describe("Attendance: detalle de una reunión cerrada (roster)", () => {
  const summary: MeetingSummary = { present: 2, expected: 3, rate: 67 };
  const roster: RosterRow[] = [
    { memberId: "m-1", name: "Ana Pérez", asceId: "1234567", position: "Safety Officer", status: "present", source: "check_in" },
    { memberId: "m-2", name: "Beto Ruiz", asceId: "7654321", position: "Member", status: "absent", source: "none" },
    { memberId: "m-3", name: "Carla Soto", asceId: "1111111", position: "Project Manager", status: "present", source: "manual" },
  ];
  const renderRoster = (action: (prev: ActionState, fd: FormData) => Promise<ActionState> = idle, over: Partial<{ summary: MeetingSummary; roster: RosterRow[] }> = {}) =>
    render(<SessionAttendance sessionId="s-3" sessionTitle="Concrete Canoe Meeting" summary={over.summary ?? summary} roster={over.roster ?? roster} action={action} />);

  it("muestra presentes / esperados y el porcentaje", () => {
    renderRoster();
    const s = screen.getByTestId("attendance-summary");
    expect(s).toHaveTextContent("2 / 3 present");
    expect(s).toHaveTextContent("67%");
  });

  it("cada fila trae nombre, ASCE ID, cargo y Present / Absent; lo puesto a mano se marca", () => {
    renderRoster();
    const ana = screen.getByText("Ana Pérez").closest("li") as HTMLElement;
    expect(ana).toHaveTextContent("1234567 · Safety Officer");
    expect(within(ana).getByText("Present")).toBeInTheDocument();
    expect(within(ana).queryByText("Set manually")).toBeNull();
    const beto = screen.getByText("Beto Ruiz").closest("li") as HTMLElement;
    expect(within(beto).getByText("Absent")).toBeInTheDocument();
    const carla = screen.getByText("Carla Soto").closest("li") as HTMLElement;
    expect(within(carla).getByText("Set manually")).toBeInTheDocument();
  });

  it("solo hay un control por miembro ESPERADO: no existe forma de elegir a nadie que no esté en el roster", () => {
    renderRoster();
    expect(screen.getAllByRole("button")).toHaveLength(roster.length);
    expect(screen.getByRole("button", { name: "Mark Ana Pérez absent for Concrete Canoe Meeting" })).toHaveTextContent("Mark absent"); // presente -> ofrece Absent
    expect(screen.getByRole("button", { name: "Mark Beto Ruiz present for Concrete Canoe Meeting" })).toHaveTextContent("Mark present"); // ausente -> ofrece Present
    for (const b of screen.getAllByRole("button")) expect(b.className).toContain("min-h-11"); // botones cómodos en iPhone
  });

  it("Present -> Absent pide confirmación y envía miembro, reunión y NUEVO estado; el error o el éxito se muestran junto a la fila", async () => {
    const user = userEvent.setup();
    const action = vi.fn<(prev: ActionState, fd: FormData) => Promise<ActionState>>(async () => ({ status: "success", message: "Marked as Absent." }));
    renderRoster(action);

    await user.click(screen.getByRole("button", { name: "Mark Ana Pérez absent for Concrete Canoe Meeting" }));
    const dialog = document.querySelector("dialog[open]") as HTMLDialogElement;
    expect(dialog).toHaveAccessibleName("Mark Ana Pérez as Absent?");
    expect(dialog).toHaveTextContent("recorded in the audit log");
    expect(dialog).toHaveTextContent("original check-in is kept");
    expect(action).not.toHaveBeenCalled(); // primero hay que confirmar

    await user.click(within(dialog).getByRole("button", { name: "Mark Absent" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    const fd = action.mock.calls[0][1];
    expect([fd.get("id"), fd.get("sessionId"), fd.get("status")]).toEqual(["m-1", "s-3", "absent"]);
    expect(await screen.findByText("Marked as Absent.")).toBeInTheDocument();
  });

  it("Absent -> Present envía 'present'", async () => {
    const user = userEvent.setup();
    const action = vi.fn<(prev: ActionState, fd: FormData) => Promise<ActionState>>(async () => ({ status: "success", message: "Marked as Present." }));
    renderRoster(action);
    await user.click(screen.getByRole("button", { name: "Mark Beto Ruiz present for Concrete Canoe Meeting" }));
    await user.click(within(document.querySelector("dialog[open]") as HTMLElement).getByRole("button", { name: "Mark Present" }));
    await waitFor(() => expect(action).toHaveBeenCalledTimes(1));
    expect([action.mock.calls[0][1].get("id"), action.mock.calls[0][1].get("status")]).toEqual(["m-2", "present"]);
  });

  it("un error del servidor se muestra en inglés junto a la fila", async () => {
    const user = userEvent.setup();
    const action = async (): Promise<ActionState> => ({ status: "error", message: "Attendance can only be edited for closed meetings." });
    renderRoster(action);
    await user.click(screen.getByRole("button", { name: "Mark Ana Pérez absent for Concrete Canoe Meeting" }));
    await user.click(within(document.querySelector("dialog[open]") as HTMLElement).getByRole("button", { name: "Mark Absent" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Attendance can only be edited for closed meetings.");
  });

  it("nadie esperado: 0 / 0, «—» y un mensaje razonable (no rompe ni muestra controles)", () => {
    renderRoster(idle, { summary: { present: 0, expected: 0, rate: null }, roster: [] });
    expect(screen.getByTestId("attendance-summary")).toHaveTextContent("0 / 0 present");
    expect(screen.getByTestId("attendance-summary")).toHaveTextContent("—");
    expect(screen.getByText("No members were expected at this meeting.")).toBeInTheDocument();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });

  it("todos presentes = 100 %; nadie presente = 0 % (con esperados, el 0 % sí se muestra)", () => {
    const { unmount } = renderRoster(idle, { summary: { present: 3, expected: 3, rate: 100 } });
    expect(screen.getByTestId("attendance-summary")).toHaveTextContent("3 / 3 present");
    expect(screen.getByTestId("attendance-summary")).toHaveTextContent("100%");
    unmount();
    renderRoster(idle, { summary: { present: 0, expected: 3, rate: 0 } });
    expect(screen.getByTestId("attendance-summary")).toHaveTextContent("0 / 3 present");
    expect(screen.getByTestId("attendance-summary")).toHaveTextContent("0%");
  });
});
