/**
 * Rutas de API del administrador para la pantalla del QR:
 *   GET /api/admin/sessions/[id]/qr          (tokens con la hora del servidor)
 *   GET /api/admin/sessions/[id]/attendance  (asistencia en vivo)
 * Se prueba la autorización (sin administrador: 401 y NINGUNA consulta), el alcance (solo la sesión pedida) y que
 * nunca salga un hash ni un secreto.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKey } from "@/lib/crypto/keys";
import { verifyQrToken } from "@/lib/tokens";
import { SESSION_A, SESSION_B, T0 } from "../helpers/clock";

vi.mock("@/lib/auth/session", () => ({ getAdmin: vi.fn() }));

import { GET as getAttendance } from "@/app/api/admin/sessions/[id]/attendance/route";
import { GET as getQr } from "@/app/api/admin/sessions/[id]/qr/route";
import { getAdmin } from "@/lib/auth/session";

const getAdminMock = vi.mocked(getAdmin);
const SERVER_SECRET = "s".repeat(48);
const QR_KEY = deriveKey(SERVER_SECRET, "qr");

interface Call {
  table: string;
  ops: Array<[string, unknown[]]>;
}

/** Cliente falso: registra cada consulta (tabla + operaciones) y devuelve lo que se le configure por tabla. */
function fakeSupabase(data: {
  session?: Record<string, unknown> | null;
  sessionError?: { code: string; message: string };
  checkins?: unknown[];
  activeMembers?: number;
}) {
  const calls: Call[] = [];
  class Query {
    private call: Call;
    constructor(private table: string) {
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
    order(...a: unknown[]) {
      return this.op("order", a);
    }
    limit(...a: unknown[]) {
      return this.op("limit", a);
    }
    private result() {
      if (this.table === "sessions") return { data: data.session ?? null, error: data.sessionError ?? null };
      if (this.table === "checkins") return { data: data.checkins ?? [], error: null };
      if (this.table === "members") return { data: null, count: data.activeMembers ?? 0, error: null };
      return { data: null, error: { code: "42P01", message: "unexpected table" } };
    }
    maybeSingle() {
      this.call.ops.push(["maybeSingle", []]);
      return Promise.resolve(this.result());
    }
    then<T>(resolve: (v: unknown) => T, reject?: (e: unknown) => T) {
      return Promise.resolve(this.result()).then(resolve, reject);
    }
  }
  const sb = { from: (table: string) => new Query(table) } as unknown as SupabaseClient;
  return { sb, calls };
}

const asAdmin = (sb: SupabaseClient) => getAdminMock.mockResolvedValue({ user: { id: "admin-1" }, supabase: sb } as never);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = new Request("http://localhost/api");

const sessionRow = (over: Record<string, unknown> = {}) => ({
  id: SESSION_A,
  title: "Concrete Canoe Team Meeting",
  description: null,
  location: "Construction Workshop",
  scheduled_at: "2026-09-20T00:00:00Z",
  status: "active",
  required: true,
  opened_at: "2026-09-20T00:01:00Z",
  closed_at: null,
  created_at: "2026-09-19T00:00:00Z",
  ...over,
});

beforeAll(() => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "http://127.0.0.1:54321");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "publishable-test-key");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "service-role-test-key");
  vi.stubEnv("SERVER_SECRET", SERVER_SECRET);
  vi.stubEnv("PIN_PEPPER", "p".repeat(48));
});
beforeEach(() => {
  getAdminMock.mockReset();
  vi.useFakeTimers();
  vi.setSystemTime(T0 + 3_000);
});
afterEach(() => vi.useRealTimers());

describe("GET /api/admin/sessions/[id]/qr", () => {
  it("SIN ADMINISTRADOR: 401 genérico y NINGUNA consulta a la base de datos", async () => {
    getAdminMock.mockResolvedValue(null);
    const { sb, calls } = fakeSupabase({ session: sessionRow() });
    void sb;
    const res = await getQr(req, ctx(SESSION_A));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(calls).toHaveLength(0);
  });

  it("id que no es un UUID: 404 sin tocar la base de datos", async () => {
    const { sb, calls } = fakeSupabase({ session: sessionRow() });
    asAdmin(sb);
    for (const bad of ["abc", "../../etc/passwd", "1 OR 1=1", "", SESSION_A + "0"]) {
      expect((await getQr(req, ctx(bad))).status, bad).toBe(404);
    }
    expect(calls).toHaveLength(0);
  });

  it("sesión inexistente: 404; error de la base de datos: 503 SIN mensajes internos", async () => {
    asAdmin(fakeSupabase({ session: null }).sb);
    expect((await getQr(req, ctx(SESSION_A))).status).toBe(404);

    asAdmin(fakeSupabase({ sessionError: { code: "XX000", message: "secret internal detail: password=hunter2" } }).sb);
    const res = await getQr(req, ctx(SESSION_A));
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).not.toContain("hunter2");
  });

  it("SESIÓN ACTIVA: token actual y siguiente, firmados para ESA sesión, con la hora del SERVIDOR", async () => {
    asAdmin(fakeSupabase({ session: sessionRow() }).sb);
    const res = await getQr(req, ctx(SESSION_A));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);

    const body = await res.json();
    expect(Object.keys(body).sort()).toEqual(["current", "next", "serverNow", "status"]);
    expect(body.status).toBe("active");
    expect(body.serverNow).toBe(T0 + 3_000); // la hora del servidor, no la de ningún dispositivo
    expect(body.current).toMatchObject({ startsAtMs: T0, endsAtMs: T0 + 10_000 });
    expect(body.next).toMatchObject({ startsAtMs: T0 + 10_000, endsAtMs: T0 + 20_000 });

    // Los tokens son los del sistema aprobado: el servidor los acepta en su ventana y solo para esta sesión.
    expect(verifyQrToken({ key: QR_KEY, token: body.current.token, now: T0 + 3_000, graceMs: 5_000 })).toMatchObject({ ok: true, sessionId: SESSION_A });
    expect(verifyQrToken({ key: QR_KEY, token: body.next.token, now: T0 + 12_000, graceMs: 5_000 })).toMatchObject({ ok: true, sessionId: SESSION_A });
  });

  it("el token 'siguiente' todavía NO vale antes de su intervalo (solo lo tiene la pantalla para cambiar sin esperar a la red)", async () => {
    asAdmin(fakeSupabase({ session: sessionRow() }).sb);
    const body = await (await getQr(req, ctx(SESSION_A))).json();
    expect(verifyQrToken({ key: QR_KEY, token: body.next.token, now: T0 + 3_000, graceMs: 5_000 })).toEqual({ ok: false, reason: "not_yet_valid" });
  });

  it("la respuesta no lleva secretos ni claves", async () => {
    asAdmin(fakeSupabase({ session: sessionRow() }).sb);
    const text = JSON.stringify(await (await getQr(req, ctx(SESSION_A))).json());
    for (const secret of [SERVER_SECRET, "p".repeat(48), "service-role-test-key", "publishable-test-key"]) expect(text).not.toContain(secret);
  });

  it("SESIÓN CERRADA o BORRADOR: solo el estado, NINGÚN token (el QR deja de dibujarse)", async () => {
    for (const status of ["closed", "draft"]) {
      asAdmin(fakeSupabase({ session: sessionRow({ status }) }).sb);
      const body = await (await getQr(req, ctx(SESSION_A))).json();
      expect(body, status).toEqual({ status, serverNow: T0 + 3_000 });
    }
  });

  it("consulta con el cliente de la sesión del administrador y solo la sesión pedida", async () => {
    const { sb, calls } = fakeSupabase({ session: sessionRow() });
    asAdmin(sb);
    await getQr(req, ctx(SESSION_A));
    expect(calls).toHaveLength(1);
    expect(calls[0].table).toBe("sessions");
    expect(calls[0].ops).toContainEqual(["eq", ["id", SESSION_A]]);
  });
});

describe("GET /api/admin/sessions/[id]/attendance", () => {
  const checkin = (id: string, name: string, position: string, at: string) => ({ id, checked_in_at: at, members: { name, position } });

  it("SIN ADMINISTRADOR (p. ej. un usuario que no lo es o un estudiante): 401 y NINGUNA consulta", async () => {
    getAdminMock.mockResolvedValue(null);
    const { calls } = fakeSupabase({ session: sessionRow() });
    const res = await getAttendance(req, ctx(SESSION_A));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(calls).toHaveLength(0);
  });

  it("id inválido o sesión inexistente: 404", async () => {
    asAdmin(fakeSupabase({ session: null }).sb);
    expect((await getAttendance(req, ctx("abc"))).status).toBe(404);
    expect((await getAttendance(req, ctx(SESSION_A))).status).toBe(404);
  });

  it("devuelve estado, conteo, total de miembros activos y por asistente SOLO nombre, cargo y hora", async () => {
    asAdmin(
      fakeSupabase({
        session: sessionRow(),
        checkins: [checkin("c2", "Maria Lopez", "Safety Officer", "2026-09-20T00:12:00Z"), checkin("c1", "John Smith", "Member", "2026-09-20T00:10:00Z")],
        activeMembers: 25,
      }).sb,
    );
    const res = await getAttendance(req, ctx(SESSION_A));
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toMatch(/no-store/);
    const body = await res.json();
    expect(body).toMatchObject({ status: "active", title: "Concrete Canoe Team Meeting", location: "Construction Workshop", serverNow: T0 + 3_000, count: 2, total: 25 });
    expect(body.attendees).toEqual([
      { id: "c2", name: "Maria Lopez", position: "Safety Officer", checkedInAt: "2026-09-20T00:12:00Z" },
      { id: "c1", name: "John Smith", position: "Member", checkedInAt: "2026-09-20T00:10:00Z" },
    ]);
  });

  it("NUNCA expone pin_hash, ASCE ID, id de miembro ni secretos (aunque la base de datos los devolviera)", async () => {
    asAdmin(
      fakeSupabase({
        session: sessionRow(),
        checkins: [{ id: "c1", checked_in_at: "2026-09-20T00:10:00Z", pin_hash: "scrypt$v1$leak", ticket_nonce: "n", ip_hash: "h", members: { name: "Ana", position: "Member", pin_hash: "scrypt$v1$leak", asce_id: "SECRET-ID" } }],
        activeMembers: 1,
      }).sb,
    );
    const text = JSON.stringify(await (await getAttendance(req, ctx(SESSION_A))).json());
    for (const forbidden of ["pin_hash", "scrypt$", "SECRET-ID", "asce_id", "ticket_nonce", "ip_hash", "member_id", SERVER_SECRET, "service-role-test-key"]) {
      expect(text, forbidden).not.toContain(forbidden);
    }
  });

  it("la consulta pide solo columnas seguras y SOLO la sesión del id de la URL", async () => {
    const { sb, calls } = fakeSupabase({ session: sessionRow({ id: SESSION_B }), activeMembers: 3 });
    asAdmin(sb);
    await getAttendance(req, ctx(SESSION_B));

    const checkins = calls.find((c) => c.table === "checkins");
    expect(checkins?.ops).toContainEqual(["eq", ["session_id", SESSION_B]]);
    expect(checkins?.ops.filter(([op]) => op === "eq")).toHaveLength(1); // ningún otro filtro que amplíe el alcance
    const selectArgs = JSON.stringify(calls.flatMap((c) => c.ops.filter(([op]) => op === "select")));
    for (const forbidden of ["pin_hash", "asce_id", "*", "ticket_nonce", "ip_hash"]) expect(selectArgs, forbidden).not.toContain(forbidden);
    expect(calls.find((c) => c.table === "sessions")?.ops).toContainEqual(["eq", ["id", SESSION_B]]);
  });

  it("una sesión cerrada informa su estado (la pantalla del QR deja de mostrar el código en el siguiente sondeo)", async () => {
    asAdmin(fakeSupabase({ session: sessionRow({ status: "closed" }), checkins: [], activeMembers: 5 }).sb);
    const body = await (await getAttendance(req, ctx(SESSION_A))).json();
    expect(body).toMatchObject({ status: "closed", count: 0, total: 5, attendees: [] });
  });

  it("un check-in cuyo miembro no es visible (relación vacía) no se lista", async () => {
    asAdmin(fakeSupabase({ session: sessionRow(), checkins: [{ id: "c1", checked_in_at: "2026-09-20T00:10:00Z", members: null }], activeMembers: 1 }).sb);
    const body = await (await getAttendance(req, ctx(SESSION_A))).json();
    expect(body.attendees).toEqual([]);
    expect(body.count).toBe(0);
  });
});
