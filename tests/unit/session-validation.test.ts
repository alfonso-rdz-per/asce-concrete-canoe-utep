import { AUDIENCE_LABEL, audienceFromGroups, DEFAULT_AUDIENCE, groupsFromAudience, isForMember, SESSION_AUDIENCES, TEAM_GROUPS } from "@/lib/session-audience";
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

const AUDIENCE_ERROR = "Choose a valid team: Design Team or Rowing & Construction.";

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

describe("New Session: solo Session Name + Required (Design Team y/o Rowing & Construction)", () => {
  it("con el nombre y el grupo basta: sin descripción, ubicación, fecha ni hora", () => {
    expect(parseSessionForm(form({ title: "Concrete Canoe Practice", audience: "remar_construction" }))).toEqual({
      ok: true,
      data: { title: "Concrete Canoe Practice", audience: "remar_construction" },
    });
  });

  it("REQUIRED ya no es un booleano: dos equipos (Design Team y Rowing & Construction) que se pueden elegir por separado o los dos a la vez", () => {
    expect(TEAM_GROUPS).toEqual(["design_team", "remar_construction"]);
    expect(SESSION_AUDIENCES).toEqual(["design_team", "remar_construction", "both"]);
    expect(AUDIENCE_LABEL).toEqual({ design_team: "Design Team", remar_construction: "Rowing & Construction", both: "Both teams" });
    expect(DEFAULT_AUDIENCE).toBe("remar_construction");
    expect(parseSessionForm(form({ title: "Practice", audience: "design_team" }))).toMatchObject({ ok: true, data: { audience: "design_team" } });
    expect(parseSessionForm(form({ title: "Practice", audience: "remar_construction" }))).toMatchObject({ ok: true, data: { audience: "remar_construction" } });
  });

  it("MARCAR LAS DOS casillas guarda la audiencia \"both\" (en cualquier orden; un valor repetido no cambia nada)", () => {
    expect(parseSessionForm(formMulti("Practice", ["design_team", "remar_construction"]))).toEqual({ ok: true, data: { title: "Practice", audience: "both" } });
    expect(parseSessionForm(formMulti("Practice", ["remar_construction", "design_team"]))).toMatchObject({ ok: true, data: { audience: "both" } });
    expect(parseSessionForm(formMulti("Practice", ["design_team", "design_team"]))).toMatchObject({ ok: true, data: { audience: "design_team" } });
  });

  it("casillas <-> audiencia: audienceFromGroups y groupsFromAudience son inversas", () => {
    expect(audienceFromGroups(new Set(["design_team"]))).toBe("design_team");
    expect(audienceFromGroups(new Set(["remar_construction"]))).toBe("remar_construction");
    expect(audienceFromGroups(new Set(["design_team", "remar_construction"]))).toBe("both");
    expect(audienceFromGroups(new Set())).toBeNull();
    for (const audience of SESSION_AUDIENCES) expect(audienceFromGroups(new Set(groupsFromAudience(audience)))).toBe(audience);
  });

  it("un valor que no sea una de las dos casillas se RECHAZA en el servidor (incluidos los booleanos antiguos y \"both\" enviado a mano)", () => {
    for (const bad of ["on", "true", "false", "required", "optional", "Design Team", "DESIGN_TEAM", "design-team", "everyone", "both", " design_team"]) {
      expect(parseSessionForm(form({ title: "Practice", audience: bad })), JSON.stringify(bad)).toEqual({
        ok: false,
        fieldErrors: { audience: AUDIENCE_ERROR },
      });
    }
    // Un valor válido acompañado de uno inválido tampoco pasa.
    expect(parseSessionForm(formMulti("Practice", ["design_team", "everyone"]))).toEqual({ ok: false, fieldErrors: { audience: AUDIENCE_ERROR } });
  });

  it("NO es obligatorio marcar ninguna casilla: sin ninguna marcada (o el campo ausente), cae al valor por defecto (remar_construction) sin error", () => {
    expect(parseSessionForm(form({ title: "Practice" }))).toEqual({ ok: true, data: { title: "Practice", audience: DEFAULT_AUDIENCE } });
    expect(parseSessionForm(formMulti("Practice", []))).toEqual({ ok: true, data: { title: "Practice", audience: DEFAULT_AUDIENCE } });
    expect(parseSessionForm(form({ title: "Practice", audience: "" }))).toEqual({ ok: false, fieldErrors: { audience: AUDIENCE_ERROR } }); // "" enviado a mano no es "ninguna casilla"
    // El campo antiguo 'required' ya no significa nada.
    expect(parseSessionForm(form({ title: "Practice", required: "on" }))).toMatchObject({ ok: true });
  });

  it("la regla de grupo: Design Team <-> miembros del Design Team; Rowing & Construction <-> el resto; Both teams <-> todos", () => {
    expect(isForMember("design_team", true)).toBe(true);
    expect(isForMember("design_team", false)).toBe(false);
    expect(isForMember("remar_construction", false)).toBe(true);
    expect(isForMember("remar_construction", true)).toBe(false);
    expect(isForMember("both", true)).toBe(true);
    expect(isForMember("both", false)).toBe(true);
  });

  it("el nombre es obligatorio: sin él, error en inglés sobre ese campo", () => {
    expect(parseSessionForm(form({ title: "  ", audience: "design_team" }))).toEqual({ ok: false, fieldErrors: { title: "Enter a session name." } });
    expect(parseSessionForm(new FormData()).ok).toBe(false);
  });

  it("IGNORA descripción, ubicación, fecha, estado, quién/cuándo empezó y cualquier otro campo (un POST manipulado no cambia nada)", () => {
    const r = parseSessionForm(
      form({ title: "Practice", audience: "design_team", description: "x", location: "Lab", scheduledAt: "2001-01-01T00:00", status: "closed", opened_by: "x", opened_at: "2020-01-01", pin: "123456" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(Object.keys(r.data).sort()).toEqual(["audience", "title"]);
  });

  it("ya no hay 'intent' ni borradores: aunque un POST manipulado lo envíe, se ignora y la sesión siempre se crea activa", () => {
    for (const intent of ["start", "draft", "activate", ""]) {
      const r = parseSessionForm(form({ title: "P", audience: "design_team", intent }));
      expect(r, intent).toMatchObject({ ok: true });
      if (r.ok) expect(r.data).not.toHaveProperty("intent");
    }
  });

  it("un campo de tipo archivo cuenta como vacío (no lanza)", () => {
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
