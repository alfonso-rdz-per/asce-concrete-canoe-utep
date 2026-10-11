import { AUDIENCE_LABEL, DEFAULT_AUDIENCE, isForMember, SELECTABLE_AUDIENCES } from "@/lib/session-audience";
import { describe, expect, it, vi } from "vitest";
import { elPasoLocalToIso, formatDateDotTime, toElPasoLocal } from "@/lib/dates";
import { describeDbError } from "@/lib/errors";
import { parseSessionForm, parseTitle } from "@/lib/validation/session";

const form = (values: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(values)) fd.set(k, v);
  return fd;
};

/** Como el navegador: una pareja audience=<valor> por cada casilla marcada. */
const formMulti = (title: string, audiences: string[]) => {
  const fd = new FormData();
  fd.set("title", title);
  for (const a of audiences) fd.append("audience", a);
  return fd;
};

const AUDIENCE_ERROR = "Choose one option: Rowing & Construction, Design Team or Optional.";

describe("hora de El Paso <-> instante UTC (con horario de verano)", () => {
  it("septiembre (MDT, UTC-6) y enero (MST, UTC-7)", () => {
    expect(elPasoLocalToIso("2026-09-19T18:00")).toBe("2026-09-20T00:00:00.000Z");
    expect(elPasoLocalToIso("2026-01-15T12:00")).toBe("2026-01-15T19:00:00.000Z");
  });

  it("ida y vuelta: toElPasoLocal(elPasoLocalToIso(x)) === x", () => {
    for (const local of ["2026-09-19T18:00", "2026-01-15T07:30", "2026-03-08T12:00", "2026-11-01T23:59", "2027-06-30T00:00"]) {
      expect(toElPasoLocal(Date.parse(elPasoLocalToIso(local) as string)), local).toBe(local);
    }
  });

  it("rechaza fechas y horas imposibles o con otro formato", () => {
    for (const bad of ["2026-02-30T10:00", "2026-13-01T10:00", "2026-09-19T25:00", "2026-09-19T10:60", "2026-09-19", "2026-09-19 18:00", "", "hoy", 5, null, undefined]) {
      expect(elPasoLocalToIso(bad), String(bad)).toBeNull();
    }
  });
});

describe("fecha y hora visibles: 'Sep 19, 2026 · 7:42 PM' (hora de El Paso)", () => {
  it("formatea con el separador ·", () => {
    expect(formatDateDotTime("2026-09-20T01:42:00Z")).toBe("Sep 19, 2026 · 7:42 PM");
    expect(formatDateDotTime("2026-01-15T19:05:00Z")).toBe("Jan 15, 2026 · 12:05 PM");
  });
  it("tolera basura", () => {
    expect(formatDateDotTime("nope")).toBe("—");
  });
});

describe("Session Name", () => {
  it("obligatorio; recorta y colapsa espacios", () => {
    expect(parseTitle("   ").error).toBe("Enter a session name.");
    expect(parseTitle("  Concrete   Canoe  Practice ").value).toBe("Concrete Canoe Practice");
  });
  it("máximo 160 y sin caracteres de control ni invisibles", () => {
    expect(parseTitle("x".repeat(161)).error).toBe("Session name must be 160 characters or fewer.");
    expect(parseTitle("x".repeat(160)).value).toHaveLength(160);
    for (const bad of ["Practice\u0000", "Practice\u202e", "Prac\u200btice"]) expect(parseTitle(bad).error, JSON.stringify(bad)).toBe("Session name contains invalid characters.");
  });
});

describe("New Session: one audience", () => {
  it("offers three English options and defaults to Rowing", () => {
    expect(SELECTABLE_AUDIENCES).toEqual(["remar_construction", "design_team", "optional"]);
    expect(DEFAULT_AUDIENCE).toBe("remar_construction");
    expect(AUDIENCE_LABEL.optional).toBe("Optional");
    expect(AUDIENCE_LABEL.both).toBe("Rowing & Construction");
  });
  it.each(SELECTABLE_AUDIENCES)("accepts %s", (audience) => {
    expect(parseSessionForm(form({ title: "Practice", audience }))).toEqual({ ok: true, data: { title: "Practice", audience } });
  });
  it("rejects missing, duplicated, multiple and manipulated choices", () => {
    for (const audiences of [[], [""], ["both"], ["on"], ["Design Team"], ["design_team", "optional"], ["design_team", "design_team"]]) {
      expect(parseSessionForm(formMulti("Practice", audiences))).toEqual({ ok: false, fieldErrors: { audience: AUDIENCE_ERROR } });
    }
  });
  it("expects everyone for Rowing and Optional, only design for Design Team", () => {
    for (const audience of ["remar_construction", "optional", "both"] as const) {
      expect(isForMember(audience, true)).toBe(true);
      expect(isForMember(audience, false)).toBe(true);
    }
    expect(isForMember("design_team", true)).toBe(true);
    expect(isForMember("design_team", false)).toBe(false);
    expect(isForMember("remar_construction", true, 1)).toBe(false);
  });
  it("requires a title and ignores protected or obsolete fields", () => {
    expect(parseSessionForm(form({ title: "  ", audience: "design_team" }))).toEqual({ ok: false, fieldErrors: { title: "Enter a session name." } });
    expect(parseSessionForm(form({ title: "Practice", audience: "optional", description: "x", location: "Lab", scheduledAt: "2001-01-01", status: "closed", attendance_rule_version: "1", intent: "draft", required: "on" }))).toEqual({ ok: true, data: { title: "Practice", audience: "optional" } });
  });
  it("rejects files without throwing", () => {
    const fd = new FormData();
    fd.set("title", new File(["x"], "x.txt"));
    expect(parseSessionForm(fd).ok).toBe(false);
  });
});

describe("la fecha y hora las pone el SERVIDOR al crear la sesión", () => {
  it("createAndStartSession crea la sesión YA ACTIVA (un solo INSERT); scheduled_at = hora del servidor (inyectada), sin descripción ni ubicación; opened_at/opened_by los fija la BD", async () => {
    vi.resetModules();
    const { createAndStartSession } = await import("@/lib/data/sessions");
    const inserted: Array<Record<string, unknown>> = [];
    const sb = {
      from: () => ({
        insert: (row: Record<string, unknown>) => {
          inserted.push(row);
          return { select: () => ({ single: async () => ({ data: { id: "s-1", status: "draft", ...row }, error: null }) }) };
        },
      }),
    };
    const serverNow = Date.parse("2026-09-20T01:42:00Z");
    const r = await createAndStartSession(sb as never, { title: "Concrete Canoe Practice", audience: "design_team" }, serverNow);
    expect(r.ok).toBe(true);
    expect(inserted).toEqual([{ title: "Concrete Canoe Practice", scheduled_at: "2026-09-20T01:42:00.000Z", audience: "design_team", status: "active" }]);
    // El cliente NO envía quién ni cuándo (lo pone la base de datos con su reloj y auth.uid()).
    expect(Object.keys(inserted[0])).not.toEqual(expect.arrayContaining(["description", "location", "opened_by", "opened_at"]));
  });

  it("sin hora inyectada usa la hora actual del servidor (no la de ningún formulario)", async () => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-20T03:00:00Z"));
    try {
      const { createAndStartSession } = await import("@/lib/data/sessions");
      let row: Record<string, unknown> = {};
      const sb = { from: () => ({ insert: (r: Record<string, unknown>) => ((row = r), { select: () => ({ single: async () => ({ data: { id: "s" }, error: null }) }) }) }) };
      await createAndStartSession(sb as never, { title: "P", audience: "remar_construction" });
      expect(row.scheduled_at).toBe("2026-09-20T03:00:00.000Z");
      expect(row.audience).toBe("remar_construction");
      expect(row).not.toHaveProperty("required");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("errores de sesiones (mensajes en inglés)", () => {
  it("una sola sesión activa", () => {
    const msg = describeDbError({ code: "23505", message: 'duplicate key value violates unique constraint "sessions_single_active"' }).message;
    expect(msg).toBe("A check-in is already in progress. Close it before starting another one.");
  });
  it("ciclo de vida y restricciones", () => {
    expect(describeDbError({ code: "P0001", message: "asce:session_closed_is_final" }).message).toBe("That session is already closed.");
    expect(describeDbError({ code: "P0001", message: "asce:session_invalid_transition" }).message).toBe("That session can't be changed that way.");
    expect(describeDbError({ code: "23514", message: 'violates check constraint "sessions_location_valid"' })).toMatchObject({ field: "location" });
    expect(describeDbError({ code: "23514", message: 'violates check constraint "sessions_title_length"' })).toMatchObject({ field: "title" });
  });
});
