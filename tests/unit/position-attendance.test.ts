import { describe, expect, it } from "vitest";
import { attendancePercent, averageAttendance, isAttendanceStatus, otherStatus, statusLabel } from "@/lib/attendance";
import { formatMeetingDate } from "@/lib/dates";
import { describeDbError } from "@/lib/errors";
import { canonicalPreset, DEFAULT_POSITION, OTHER_POSITION, POSITION_OPTIONS, splitPosition } from "@/lib/positions";
import { parseMemberForm, parsePosition } from "@/lib/validation/member";

const TODAY = "2026-09-19";
const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};
const BASE = { asceId: "12345", name: "Ana", email: "", joinedOn: "" };

describe("cargos predefinidos", () => {
  it("son exactamente los pedidos, en ese orden, y el predeterminado es Member", () => {
    expect([...POSITION_OPTIONS]).toEqual([
      "Member",
      "Project Manager",
      "Project Engineer",
      "Construction/Foreman Officer",
      "Safety Officer",
      "Aesthetics & QA/QC Officer",
      "Structural Analysis Engineer",
      "Mix Design Engineer",
      "Testing Engineer",
      "Other",
    ]);
    expect(DEFAULT_POSITION).toBe("Member");
  });

  it("splitPosition: un cargo de la lista -> su opción; cualquier otro texto -> 'Other' + texto; vacío -> Member", () => {
    expect(splitPosition("Safety Officer")).toEqual({ preset: "Safety Officer", custom: "" });
    expect(splitPosition("safety officer")).toEqual({ preset: "Safety Officer", custom: "" });
    expect(splitPosition("Outreach Lead")).toEqual({ preset: "Other", custom: "Outreach Lead" });
    expect(splitPosition("")).toEqual({ preset: "Member", custom: "" });
    expect(splitPosition(null)).toEqual({ preset: "Member", custom: "" });
    expect(canonicalPreset("  mix design engineer ")).toBe("Mix Design Engineer");
    expect(canonicalPreset("Other")).toBeUndefined();
  });
});

describe("parsePosition", () => {
  it("cada cargo predefinido se guarda tal cual (el texto libre se ignora)", () => {
    for (const p of POSITION_OPTIONS.filter((o) => o !== OTHER_POSITION)) {
      expect(parsePosition(p, "texto ignorado")).toEqual({ value: p });
    }
  });

  it("sin valor (formulario antiguo) -> Member", () => {
    expect(parsePosition("", "")).toEqual({ value: "Member" });
  });

  it("'Other' guarda el TEXTO PERSONALIZADO (recortado y con espacios colapsados)", () => {
    expect(parsePosition("Other", "  Outreach    Lead ")).toEqual({ value: "Outreach Lead" });
  });

  it("'Other' con texto vacío o solo espacios: error en el campo Custom Position", () => {
    for (const empty of ["", "   ", "\t\n"]) {
      expect(parsePosition("Other", empty)).toEqual({ field: "customPosition", error: "Enter the custom position." });
    }
  });

  it("'Other' rechaza demasiado largo, caracteres de control y el literal 'Other'", () => {
    expect(parsePosition("Other", "x".repeat(61)).error).toBe("Position must be 60 characters or fewer.");
    expect(parsePosition("Other", "x".repeat(60)).value).toHaveLength(60);
    // Control (NUL), reordenación bidireccional (U+202E) y ancho cero (U+200B): todos rechazados.
    for (const bad of ["Lead\u0000", "Lead\u202e", "Le\u200bad"]) expect(parsePosition("Other", bad).error, JSON.stringify(bad)).toBe("Position contains invalid characters.");
    expect(parsePosition("Other", " other ").error).toBe("Enter the specific position instead of “Other”.");
  });

  it("'Other' con un texto que coincide con un cargo de la lista lo guarda con la grafía canónica", () => {
    expect(parsePosition("Other", "safety officer")).toEqual({ value: "Safety Officer" });
  });

  it("un valor que no está en la lista se rechaza (POST manipulado)", () => {
    expect(parsePosition("CEO", "")).toEqual({ field: "position", error: "Choose a position from the list." });
    expect(parsePosition("<script>", "")).toEqual({ field: "position", error: "Choose a position from the list." });
    expect(parsePosition("safety officer", "").error).toBe("Choose a position from the list."); // el desplegable envía la grafía exacta
  });
});

describe("parseMemberForm con cargo", () => {
  it("por defecto guarda 'Member'", () => {
    const r = parseMemberForm(form(BASE), { mode: "create", today: TODAY });
    expect(r).toMatchObject({ ok: true, data: { position: "Member" } });
  });

  it("guarda el cargo elegido", () => {
    const r = parseMemberForm(form({ ...BASE, position: "Project Manager" }), { mode: "edit", today: TODAY });
    expect(r).toMatchObject({ ok: false }); // (edición exige joinedOn) ...
    const ok = parseMemberForm(form({ ...BASE, joinedOn: TODAY, position: "Project Manager" }), { mode: "edit", today: TODAY });
    expect(ok).toMatchObject({ ok: true, data: { position: "Project Manager" } });
  });

  it("con 'Other' guarda el texto personalizado", () => {
    const r = parseMemberForm(form({ ...BASE, position: "Other", customPosition: "Logistics Lead" }), { mode: "create", today: TODAY });
    expect(r).toMatchObject({ ok: true, data: { position: "Logistics Lead" } });
  });

  it("'Other' sin texto: el error va en customPosition y se suma a los demás errores", () => {
    const r = parseMemberForm(form({ ...BASE, asceId: "x", position: "Other", customPosition: "  " }), { mode: "create", today: TODAY });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(Object.keys(r.fieldErrors).sort()).toEqual(["asceId", "customPosition"]);
  });
});

describe("porcentaje de asistencia (presentación)", () => {
  it("redondea a entero y nunca supera 100 ni baja de 0", () => {
    expect(attendancePercent({ counted: 3, attended: 2 })).toBe(67);
    expect(attendancePercent({ counted: 4, attended: 4 })).toBe(100);
    expect(attendancePercent({ counted: 10, attended: 0 })).toBe(0);
    expect(attendancePercent({ counted: 2, attended: 5 })).toBe(100); // defensivo: dato imposible, tope 100
    expect(attendancePercent({ counted: 2, attended: -3 })).toBe(0);
  });

  it("sin reuniones que cuenten no hay porcentaje (null, no 0 %)", () => {
    expect(attendancePercent({ counted: 0, attended: 0 })).toBeNull();
    expect(attendancePercent({ counted: -1, attended: 0 })).toBeNull();
    expect(attendancePercent({ counted: Number.NaN, attended: 1 })).toBeNull();
  });

  it("el promedio usa solo miembros con reuniones que cuenten", () => {
    expect(averageAttendance([])).toBeNull();
    expect(averageAttendance([{ counted: 0, attended: 0 }])).toBeNull();
    expect(
      averageAttendance([
        { counted: 4, attended: 4 }, // 100
        { counted: 4, attended: 2 }, // 50
        { counted: 0, attended: 0 }, // sin datos: no cuenta
      ]),
    ).toBe(75);
    expect(averageAttendance([{ counted: 1, attended: 9 }])).toBe(100);
  });

  it("estados: etiquetas en inglés, alternancia y validación de entrada", () => {
    expect(statusLabel("present")).toBe("Present");
    expect(statusLabel("absent")).toBe("Absent");
    expect(otherStatus("present")).toBe("absent");
    expect(otherStatus("absent")).toBe("present");
    for (const good of ["present", "absent"]) expect(isAttendanceStatus(good)).toBe(true);
    for (const bad of ["Present", "PRESENT", "late", "", null, undefined, 1, {}]) expect(isAttendanceStatus(bad)).toBe(false);
  });
});

describe("errores de asistencia y fechas", () => {
  it("traduce los errores de la base de datos a inglés (nunca el crudo)", () => {
    expect(describeDbError({ code: "P0001", message: "asce:attendance_session_not_closed" }).message).toBe("Attendance can only be edited for closed meetings.");
    expect(describeDbError({ code: "P0001", message: "asce:attendance_no_change" }).message).toBe("That attendance is already set to that status.");
    expect(describeDbError({ code: "23503", message: 'violates foreign key constraint "attendance_overrides_member_id_fkey"' }).message).toBe("That meeting or member no longer exists.");
    expect(describeDbError({ code: "42501", message: "permission denied for table attendance_overrides" }).message).toContain("permission");
    expect(describeDbError({ code: "23514", message: 'violates check constraint "members_position_valid"' })).toMatchObject({ field: "customPosition" });
  });

  it("formatMeetingDate usa la zona horaria del equipo y tolera basura", () => {
    expect(formatMeetingDate("2026-09-19T20:00:00Z")).toBe("Sep 19, 2026");
    // 03:00 UTC del 20 sigue siendo el 19 en El Paso (UTC-6 en septiembre)
    expect(formatMeetingDate("2026-09-20T03:00:00Z")).toBe("Sep 19, 2026");
    expect(formatMeetingDate("no-es-fecha")).toBe("—");
  });
});
