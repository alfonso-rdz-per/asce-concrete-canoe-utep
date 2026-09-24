/**
 * Attendance (reuniones cerradas): capa de datos con un cliente Supabase FALSO, helpers puros y guardas estáticas de seguridad.
 * Lo que se comprueba aquí es QUÉ se le pide a la base de datos (tabla, columnas, filtros): la población esperada la decide la base de datos
 * (`counts_toward_rate`), la aplicación no la reconstruye. Los números reales de la vista se prueban en tests/db y tests/supabase.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { ATTENDANCE_GROUPS, attendancePercent, formatRate, parseAttendanceGroup } from "@/lib/attendance";
import { getSessionAttendanceDetail, listClosedMeetings, MEETING_LIST_LIMIT } from "@/lib/data/attendance";
import { listSessions } from "@/lib/data/sessions";

type Op = [string, unknown[]];
interface Call {
  table: string;
  ops: Op[];
}
type Reply = { data?: unknown; error?: { code?: string; message: string } | null; count?: number | null };

/** Cliente falso: registra cada consulta (tabla + operaciones encadenadas) y responde lo que devuelva `reply` para esa consulta. */
function fakeSupabase(reply: (call: Call) => Reply) {
  const calls: Call[] = [];
  class Query implements PromiseLike<Reply & { data: unknown; error: unknown }> {
    readonly call: Call;
    constructor(table: string) {
      this.call = { table, ops: [] };
      calls.push(this.call);
    }
    private op(name: string, args: unknown[]) {
      this.call.ops.push([name, args]);
      return this;
    }
    select(...a: unknown[]) {
      return this.op("select", a);
    }
    eq(...a: unknown[]) {
      return this.op("eq", a);
    }
    in(...a: unknown[]) {
      return this.op("in", a);
    }
    order(...a: unknown[]) {
      return this.op("order", a);
    }
    limit(...a: unknown[]) {
      return this.op("limit", a);
    }
    maybeSingle() {
      return this.op("maybeSingle", []);
    }
    then<T1, T2>(onfulfilled?: ((v: Reply & { data: unknown; error: unknown }) => T1 | PromiseLike<T1>) | null, onrejected?: ((e: unknown) => T2 | PromiseLike<T2>) | null) {
      const r = reply(this.call);
      return Promise.resolve({ data: null, error: null, ...r }).then(onfulfilled, onrejected);
    }
  }
  const sb = { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
  return { sb, calls, of: (table: string) => calls.filter((c) => c.table === table) };
}

const opsNamed = (call: Call, name: string) => call.ops.filter(([n]) => n === name).map(([, args]) => args);
const selectColumns = (call: Call) => opsNamed(call, "select")[0]?.[0] as string;
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

// ---------------------------------------------------------------------------------------------------------------------------------
describe("parseAttendanceGroup", () => {
  it("admite exactamente All, Design Team y Rowing & Construction; cualquier otra cosa es 'all'", () => {
    expect([...ATTENDANCE_GROUPS]).toEqual(["all", "design_team", "remar_construction"]);
    expect(parseAttendanceGroup("design_team")).toBe("design_team");
    expect(parseAttendanceGroup("remar_construction")).toBe("remar_construction");
    expect(parseAttendanceGroup("all")).toBe("all");
    for (const bad of [undefined, null, "", "DESIGN_TEAM", "design_team&x=1", "design_team,remar_construction", "'; drop table sessions;--", 7, ["design_team"], {}]) {
      expect(parseAttendanceGroup(bad), String(bad)).toBe("all");
    }
  });
});

describe("formatRate", () => {
  it("NULL (nadie esperado) es «—», nunca «0%»", () => {
    expect(formatRate(null)).toBe("—");
    expect(formatRate(undefined)).toBe("—");
    expect(formatRate(Number.NaN)).toBe("—");
    expect(formatRate(0)).toBe("0%");
  });
  it("da formato a 0-100 y NUNCA muestra más de 100 % ni menos de 0 %", () => {
    expect(formatRate(75)).toBe("75%");
    expect(formatRate(100)).toBe("100%");
    expect(formatRate(150)).toBe("100%");
    expect(formatRate(-3)).toBe("0%");
    expect(formatRate(57.4)).toBe("57%");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("listClosedMeetings", () => {
  const sessionRow = (n: number, over: Record<string, unknown> = {}) => ({
    id: uuid(n),
    title: `Reunión ${n}`,
    audience: n % 2 ? "design_team" : "remar_construction",
    opened_at: `2026-09-${String(10 + (n % 15)).padStart(2, "0")}T18:00:00Z`,
    scheduled_at: "2026-09-01T00:00:00Z",
    ...over,
  });

  it("pide a la base de datos SOLO las cerradas, las más recientes primero, con columnas explícitas y sin filtro de grupo para 'all'", async () => {
    const { sb, calls } = fakeSupabase(() => ({ data: [] }));
    const r = await listClosedMeetings(sb, "all");
    expect(r).toEqual({ ok: true, data: { meetings: [], truncated: false } });
    expect(calls).toHaveLength(1); // sin sesiones no hace falta pedir resúmenes
    const c = calls[0];
    expect(c.table).toBe("sessions");
    expect(selectColumns(c)).toBe("id, title, audience, opened_at, scheduled_at");
    expect(opsNamed(c, "eq")).toEqual([["status", "closed"]]);
    expect(opsNamed(c, "order")).toEqual([["opened_at", { ascending: false }]]);
    expect(opsNamed(c, "limit")).toEqual([[MEETING_LIST_LIMIT]]);
  });

  it("el filtro por equipo se aplica en la base de datos (in audience) e INCLUYE las reuniones dirigidas a los dos equipos (\"both\")", async () => {
    for (const group of ["design_team", "remar_construction"] as const) {
      const { sb, calls } = fakeSupabase(() => ({ data: [] }));
      await listClosedMeetings(sb, group);
      expect(opsNamed(calls[0], "eq")).toEqual([["status", "closed"]]);
      expect(opsNamed(calls[0], "in")).toEqual([["audience", [group, "both"]]]);
    }
  });

  it("une cada reunión con su resumen (presentes / esperados / rate); sin fila de resumen es 0 de 0 y sin porcentaje", async () => {
    const { sb, calls, of } = fakeSupabase((c) => {
      if (c.table === "sessions") return { data: [sessionRow(1), sessionRow(2, { opened_at: null }), sessionRow(3)] };
      return { data: [{ session_id: uuid(1), present_count: 8, expected_count: 10, rate: 80 }, { session_id: uuid(2), present_count: 0, expected_count: 0, rate: null }] };
    });
    const r = await listClosedMeetings(sb, "all");
    expect(r.ok && r.data.meetings).toEqual([
      { sessionId: uuid(1), title: "Reunión 1", heldAt: "2026-09-11T18:00:00Z", audience: "design_team", present: 8, expected: 10, rate: 80 },
      { sessionId: uuid(2), title: "Reunión 2", heldAt: "2026-09-01T00:00:00Z", audience: "remar_construction", present: 0, expected: 0, rate: null }, // sin opened_at: fecha programada
      { sessionId: uuid(3), title: "Reunión 3", heldAt: "2026-09-13T18:00:00Z", audience: "design_team", present: 0, expected: 0, rate: null }, // sin fila en el resumen
    ]);
    const summary = of("session_attendance_summary");
    expect(summary).toHaveLength(1);
    expect(selectColumns(summary[0])).toBe("session_id, present_count, expected_count, rate");
    expect(calls.map((c) => c.table)).toEqual(["sessions", "session_attendance_summary"]);
  });

  it("los resúmenes se piden por lotes de 50 ids (URL corta) y se recomponen todos", async () => {
    const many = Array.from({ length: 120 }, (_, i) => sessionRow(i + 1));
    const { sb, of } = fakeSupabase((c) => {
      if (c.table === "sessions") return { data: many };
      const ids = opsNamed(c, "in")[0][1] as string[];
      return { data: ids.map((id) => ({ session_id: id, present_count: 1, expected_count: 2, rate: 50 })) };
    });
    const r = await listClosedMeetings(sb, "all");
    const batches = of("session_attendance_summary").map((c) => (opsNamed(c, "in")[0][1] as string[]).length);
    expect(batches).toEqual([50, 50, 20]);
    expect(r.ok && r.data.meetings).toHaveLength(120);
    expect(r.ok && r.data.meetings.every((m) => m.rate === 50 && m.present === 1 && m.expected === 2)).toBe(true);
  });

  it("avisa cuando el historial llega al tope (hay más reuniones que las mostradas)", async () => {
    const full = Array.from({ length: MEETING_LIST_LIMIT }, (_, i) => sessionRow(i + 1));
    const { sb } = fakeSupabase((c) => (c.table === "sessions" ? { data: full } : { data: [] }));
    const r = await listClosedMeetings(sb, "all");
    expect(r.ok && r.data.truncated).toBe(true);
  });

  it("un error de la base de datos (sesiones o resumen) devuelve un mensaje para el usuario, nunca el error crudo", async () => {
    const boom = { code: "XX000", message: 'relation "public.secret_table" exploded' };
    const a = await listClosedMeetings(fakeSupabase(() => ({ error: boom })).sb, "all");
    expect(a.ok).toBe(false);
    const b = await listClosedMeetings(fakeSupabase((c) => (c.table === "sessions" ? { data: [sessionRow(1)] } : { error: boom })).sb, "all");
    expect(b.ok).toBe(false);
    for (const r of [a, b]) expect(JSON.stringify(r)).not.toContain("secret_table");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("getSessionAttendanceDetail", () => {
  const SID = uuid(99);
  const member = (n: number, name: string, over: Record<string, unknown> = {}) => ({
    id: uuid(n), asce_id: `000${n}`, name, email: null, position: "Member", is_design_team: false, active: true,
    joined_on: "2026-01-01", deactivated_on: null, created_at: "", updated_at: "", ...over,
  });
  const members = [member(1, "zoe Zamora", { position: "Safety Officer" }), member(2, "Ana Álvarez"), member(3, "ana álvarez", { asce_id: "0009" }), member(4, "Otro Grupo", { is_design_team: true })];
  const setup = (over: { summary?: unknown; population?: unknown; errors?: Partial<Record<string, { code?: string; message: string }>> } = {}) =>
    fakeSupabase((c) => {
      if (over.errors?.[c.table]) return { error: over.errors[c.table] };
      if (c.table === "session_attendance_summary") return { data: over.summary === undefined ? { session_id: SID, present_count: 1, expected_count: 3, rate: 33 } : over.summary };
      if (c.table === "session_attendance")
        return {
          data:
            over.population ??
            [
              { member_id: uuid(1), status: "present", source: "check_in" },
              { member_id: uuid(2), status: "absent", source: "none" },
              { member_id: uuid(3), status: "present", source: "manual" },
              { member_id: uuid(77), status: "present", source: "check_in" }, // miembro que no se puede leer: se omite
            ],
        };
      return { data: members };
    });

  it("la POBLACIÓN la pide la base de datos: session_attendance de esa sesión filtrada por counts_toward_rate = true (sin reconstruir nada en TypeScript)", async () => {
    const { sb, calls, of } = setup();
    await getSessionAttendanceDetail(sb, SID);
    const [pop] = of("session_attendance");
    expect(selectColumns(pop)).toBe("member_id, status, source");
    expect(opsNamed(pop, "eq")).toEqual([["session_id", SID], ["counts_toward_rate", true]]);
    // Nunca se filtra por members.active, por grupo ni por fechas: la lista de miembros solo aporta nombre, ASCE ID y cargo.
    const [m] = of("members");
    expect(opsNamed(m, "eq")).toEqual([]);
    for (const c of calls) for (const [name, args] of c.ops.filter(([n]) => n === "eq" || n === "in" || n === "order")) expect(`${name}:${String(args[0])}`, c.table).not.toMatch(/active|is_design_team|joined_on|deactivated_on|audience/);
    // Resumen: solo esa sesión, con columnas explícitas.
    const [s] = of("session_attendance_summary");
    expect(selectColumns(s)).toBe("session_id, present_count, expected_count, rate");
    expect(opsNamed(s, "eq")).toEqual([["session_id", SID]]);
  });

  it("devuelve el resumen y el roster con nombre, ASCE ID, cargo y estado, ordenado por nombre; omite lo que no se puede leer", async () => {
    const r = await getSessionAttendanceDetail(setup().sb, SID);
    expect(r.ok && r.data.summary).toEqual({ present: 1, expected: 3, rate: 33 });
    expect(r.ok && r.data.roster).toEqual([
      { memberId: uuid(2), name: "Ana Álvarez", asceId: "0002", position: "Member", status: "absent", source: "none" },
      { memberId: uuid(3), name: "ana álvarez", asceId: "0009", position: "Member", status: "present", source: "manual" },
      { memberId: uuid(1), name: "zoe Zamora", asceId: "0001", position: "Safety Officer", status: "present", source: "check_in" },
    ]);
    // «Otro Grupo» (Design Team) no está en la población, así que no aparece: no se puede corregir desde la interfaz.
    expect(JSON.stringify(r)).not.toContain("Otro Grupo");
  });

  it("sin nadie esperado o sin fila de resumen: 0 de 0, sin porcentaje y roster vacío (no rompe)", async () => {
    const r = await getSessionAttendanceDetail(setup({ summary: null, population: [] }).sb, SID);
    expect(r).toEqual({ ok: true, data: { summary: { present: 0, expected: 0, rate: null }, roster: [] } });
  });

  it("los errores de la base de datos se convierten en mensajes para el usuario", async () => {
    for (const table of ["session_attendance_summary", "session_attendance", "members"]) {
      const r = await getSessionAttendanceDetail(setup({ errors: { [table]: { code: "XX000", message: "boom interno" } } }).sb, SID);
      expect(r.ok, table).toBe(false);
      expect(JSON.stringify(r), table).not.toContain("boom interno");
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("listSessions: el conteo de la sesión ACTIVA es el EN VIVO (la migración 13 haría que el resumen la muestre en 0)", () => {
  const base = { description: null, location: null, scheduled_at: "2026-09-20T00:00:00Z", opened_at: null, opened_by: null, closed_at: null, created_at: "2026-09-19T00:00:00Z" };
  const sessions = [
    { ...base, id: uuid(1), title: "Activa", status: "active", audience: "remar_construction" },
    { ...base, id: uuid(2), title: "Cerrada", status: "closed", audience: "design_team" },
    { ...base, id: uuid(3), title: "Borrador", status: "draft", audience: "remar_construction" },
  ];
  const build = (checkins: Reply = { count: 3 }) =>
    fakeSupabase((c) => {
      if (c.table === "sessions") return { data: sessions };
      if (c.table === "session_attendance_summary") return { data: [{ session_id: uuid(1), present_count: 0, expected_count: 0, rate: null }, { session_id: uuid(2), present_count: 8, expected_count: 10, rate: 80 }] };
      return checkins;
    });

  it("activa = check-ins en vivo (3, no 0); cerrada = present_count del resumen; borrador = 0", async () => {
    const { sb, of } = build();
    const r = await listSessions(sb);
    expect(r.ok && Object.fromEntries(r.data.map((s) => [s.title, s.presentCount]))).toEqual({ Activa: 3, Cerrada: 8, Borrador: 0 });
    // El conteo en vivo es UNA consulta de conteo (sin traer filas) solo de la sesión activa.
    const live = of("checkins");
    expect(live).toHaveLength(1);
    expect(opsNamed(live[0], "select")[0]).toEqual(["id", { count: "exact", head: true }]);
    expect(opsNamed(live[0], "eq")).toEqual([["session_id", uuid(1)]]);
  });

  it("sin sesión activa no se consulta checkins", async () => {
    const { sb, of } = fakeSupabase((c) => (c.table === "sessions" ? { data: sessions.filter((s) => s.status !== "active") } : { data: [] }));
    await listSessions(sb);
    expect(of("checkins")).toHaveLength(0);
  });

  it("un error al contar los check-ins en vivo se informa (no se muestra un 0 falso)", async () => {
    const r = await listSessions(build({ error: { code: "XX000", message: "boom" } }).sb);
    expect(r.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("el porcentaje individual no cambia (Attendance no lo toca)", () => {
  it("attended / counted con el mismo redondeo de siempre: 0/0 -> null, límites 0-100, 23/40 -> 57", () => {
    expect(attendancePercent({ counted: 0, attended: 0 })).toBeNull();
    expect(attendancePercent({ counted: 4, attended: 3 })).toBe(75);
    expect(attendancePercent({ counted: 40, attended: 23 })).toBe(57);
    expect(attendancePercent({ counted: 2, attended: 3 })).toBe(100); // nunca más de 100
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
describe("guardas estáticas de seguridad de Attendance", () => {
  const ROOT = path.resolve(import.meta.dirname, "../..");
  const read = (f: string) => readFileSync(path.join(ROOT, f), "utf8");
  /** Solo el CÓDIGO: sin comentarios (explican reglas y mencionan a propósito lo que NO se hace). */
  const code = (f: string) => read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
  const FILES = [
    "src/app/admin/(shell)/attendance/page.tsx",
    "src/components/admin/AttendanceOverview.tsx",
    "src/components/admin/SessionAttendance.tsx",
    "src/lib/data/attendance.ts",
  ];

  it("la página exige administrador ANTES de tocar datos, y valida el filtro de la URL", () => {
    const page = code("src/app/admin/(shell)/attendance/page.tsx");
    expect(page.indexOf("await requireAdmin()")).toBeGreaterThan(-1);
    expect(page.indexOf("await requireAdmin()")).toBeLessThan(page.indexOf("listClosedMeetings("));
    expect(page).toMatch(/parseAttendanceGroup\(/);
  });

  it("sin service_role, sin select('*') y sin funciones RPC en el código nuevo", () => {
    for (const f of FILES) {
      const text = code(f);
      expect(text, f).not.toMatch(/supabase\/admin|createServiceRoleClient|SUPABASE_SERVICE_ROLE_KEY|service_role/);
      expect(text, f).not.toMatch(/select\(\s*["'`]\s*\*\s*["'`]|select\(\s*\)|["'`]\*["'`]/);
      expect(text, f).not.toMatch(/\.rpc\(/);
    }
  });

  it("la población esperada NO se reconstruye en la aplicación: nada de active / is_design_team / joined_on / deactivated_on en el código de Attendance", () => {
    const data = code("src/lib/data/attendance.ts");
    const attendanceSection = data.slice(data.indexOf("listClosedMeetings"));
    expect(attendanceSection).toMatch(/counts_toward_rate/);
    expect(attendanceSection).not.toMatch(/joined_on|deactivated_on|is_design_team|\.active\b|["']active["']/);
    for (const f of ["src/components/admin/SessionAttendance.tsx", "src/components/admin/AttendanceOverview.tsx"]) {
      expect(code(f), f).not.toMatch(/joined_on|deactivated_on|is_design_team|\.active\b/);
    }
  });

  it("el componente del cliente no importa módulos de servidor y solo envía id, sessionId y status (validados de nuevo en el servidor)", () => {
    const c = code("src/components/admin/SessionAttendance.tsx");
    expect(c).toMatch(/^"use client"/);
    expect(c).not.toMatch(/data\/attendance|data\/members|supabase|server-only|auth\/session/);
    expect(c).toMatch(/hidden=\{\{ id: row\.memberId, sessionId, status: next \}\}/);
  });

  it("la corrección reutiliza la acción existente (que empieza por requireAdmin) y revalida sesión, historial y lista", () => {
    const a = code("src/app/admin/(shell)/members/actions.ts");
    const body = a.slice(a.indexOf("export async function setAttendanceAction"));
    expect(body).toMatch(/await requireAdmin\(\)/);
    expect(body).toMatch(/idSchema\.safeParse\(formData\.get\("sessionId"\)\)/);
    expect(body).toMatch(/isAttendanceStatus\(status\)/);
    expect(body).toMatch(/setMemberAttendance\(/);
    for (const p of ["`/admin/sessions/${sessionId.data}`", '"/admin/attendance"', '"/admin/sessions"']) expect(body).toContain(`revalidatePath(${p})`);
    // La página de la sesión pasa esa misma acción al roster (no hay una API pública nueva).
    expect(code("src/app/admin/(shell)/sessions/[id]/page.tsx")).toMatch(/action=\{setAttendanceAction\}/);
  });

  it("la migración 13 sigue intacta (hash exacto)", async () => {
    const { createHash } = await import("node:crypto");
    const sql = readFileSync(path.join(ROOT, "supabase/migrations/20260919001200_session_summary_expected_rate.sql"));
    expect(createHash("sha256").update(sql).digest("hex")).toBe("d82df8affc1caa53322c039bf7d930fc1e060a940be4ed49135fe4d0476ccce6");
  });
});
