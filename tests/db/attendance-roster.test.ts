/**
 * Roster de una reunión cerrada y corrección Present <-> Absent, sobre Postgres real (la misma consulta que hace la aplicación):
 *   - el roster = filas de `session_attendance` con `counts_toward_rate` (la base de datos decide la población; la aplicación no la reconstruye);
 *   - casos límite: otro grupo, se unió después, dado de baja después, inactivo desde antes;
 *   - la corrección va por `attendance_overrides` con el JWT de un administrador: se refleja en el resumen, se audita y nunca borra nada.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { attendancePercent } from "../../src/lib/attendance";
import { nonce, TestDb } from "./helpers";

const TODAY = "(now() at time zone 'America/Denver')::date";
let seq = 0;

async function closedSession(db: TestDb, audience: "design_team" | "remar_construction", present: string[] = []): Promise<string> {
  const id = (await db.query<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ($1, now(), $2) returning id", [`Reunión ${++seq}`, audience])).rows[0].id;
  await db.query("update public.sessions set status = 'active' where id = $1", [id]);
  for (const m of present) await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, m, nonce(`ros${++seq}`)]);
  await db.closeSession(id);
  return id;
}

/** EXACTAMENTE la consulta de getSessionAttendanceDetail (src/lib/data/attendance.ts) para la población del roster. */
const rosterOf = async (db: TestDb, sessionId: string, actor: Parameters<TestDb["as"]>[0]) =>
  (
    await db.as(actor, (q) => q<{ member_id: string; status: string; source: string }>("select member_id, status, source from public.session_attendance where session_id = $1 and counts_toward_rate = true", [sessionId]))
  ).rows;
const summaryOf = async (db: TestDb, sessionId: string, actor: Parameters<TestDb["as"]>[0]) =>
  (await db.as(actor, (q) => q<{ present_count: number; expected_count: number; rate: number | null }>("select present_count, expected_count, rate from public.session_attendance_summary where session_id = $1", [sessionId]))).rows[0];

describe("Roster: la población esperada la decide la base de datos", () => {
  let db: TestDb;
  let admin: string;
  let m: Record<"G1" | "G2" | "D1" | "GI" | "GX" | "GN", string>;
  let S: { remar: string; design: string };

  beforeAll(async () => {
    db = await TestDb.create();
    admin = await db.adminUser();
    const [G1, G2, D1, GI, GX, GN] = await db.members(6);
    m = { G1, G2, D1, GI, GX, GN };
    for (const id of [G1, G2, GX]) await db.query(`update public.members set joined_on = ${TODAY} - 60 where id = $1`, [id]);
    await db.query(`update public.members set joined_on = ${TODAY} - 60, is_design_team = true where id = $1`, [D1]);
    await db.query(`update public.members set joined_on = ${TODAY} - 60, active = false, deactivated_on = ${TODAY} - 20 where id = $1`, [GI]); // baja ANTES de la reunión
    await db.query("update public.members set joined_on = date '2999-01-01' where id = $1", [GN]); // se une DESPUÉS de la reunión
    S = { remar: await closedSession(db, "remar_construction", [G1, GX, D1]), design: await closedSession(db, "design_team", [D1]) };
    await db.query(`update public.members set active = false, deactivated_on = ${TODAY} where id = $1`, [GX]); // baja DESPUÉS de la reunión
  });
  afterAll(async () => {
    await db.destroy();
  });

  const adminActor = () => ({ role: "authenticated", sub: admin }) as const;

  it("reunión general: aparecen quienes pertenecían al grupo en la fecha (incluido GX, dado de baja DESPUÉS); no aparecen el otro grupo, GI (baja antes) ni GN (se une después)", async () => {
    const roster = await rosterOf(db, S.remar, adminActor());
    expect(roster.map((r) => r.member_id).sort()).toEqual([m.G1, m.G2, m.GX].sort());
    const by = new Map(roster.map((r) => [r.member_id, r]));
    expect(by.get(m.G1)).toMatchObject({ status: "present", source: "check_in" });
    expect(by.get(m.GX)).toMatchObject({ status: "present", source: "check_in" }); // la reunión histórica conserva su pertenencia
    expect(by.get(m.G2)).toMatchObject({ status: "absent", source: "none" });
    // D1 hizo check-in en la reunión general (otro grupo): existe la fila cruda, pero NO está en el roster ni cuenta.
    const raw = await db.query<{ status: string; counts_toward_rate: boolean }>("select status, counts_toward_rate from public.session_attendance where session_id = $1 and member_id = $2", [S.remar, m.D1]);
    expect(raw.rows[0]).toEqual({ status: "present", counts_toward_rate: false });
  });

  it("reunión de Design Team: solo el miembro del Design Team", async () => {
    expect((await rosterOf(db, S.design, adminActor())).map((r) => r.member_id)).toEqual([m.D1]);
  });

  it("el tamaño del roster es exactamente expected_count y sus presentes son present_count, en cada reunión", async () => {
    for (const s of [S.remar, S.design]) {
      const roster = await rosterOf(db, s, adminActor());
      const sum = await summaryOf(db, s, adminActor());
      expect(roster.length).toBe(sum.expected_count);
      expect(roster.filter((r) => r.status === "present").length).toBe(sum.present_count);
    }
  });

  it("anon no lee nada y un usuario que no es administrador ve un roster vacío", async () => {
    await expect(rosterOf(db, S.remar, { role: "anon" })).rejects.toMatchObject({ code: "42501" });
    const outsider = await db.authUser({ confirmed: false });
    expect(await rosterOf(db, S.remar, { role: "authenticated", sub: outsider })).toEqual([]);
    expect(await summaryOf(db, S.remar, { role: "authenticated", sub: outsider })).toBeUndefined();
  });
});

describe("Corrección Present <-> Absent desde el roster (como la hace la aplicación: UPDATE y, si no hay fila, INSERT con la sesión del administrador)", () => {
  let db: TestDb;
  let admin: string;

  beforeAll(async () => {
    db = await TestDb.create();
    admin = await db.adminUser();
  });
  afterAll(async () => {
    await db.destroy();
  });

  /** setMemberAttendance (src/lib/data/attendance.ts): UPDATE y, si no existía la fila, INSERT. */
  const setAttendance = (session: string, member: string, status: "present" | "absent") =>
    db.as({ role: "authenticated", sub: admin }, async (q) => {
      const updated = await q("update public.attendance_overrides set status = $3 where session_id = $1 and member_id = $2 returning status", [session, member, status]);
      if (updated.rowCount === 0) await q("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, $3)", [session, member, status]);
    });
  const view = async (session: string) => ({
    summary: await summaryOf(db, session, { role: "authenticated", sub: admin }),
    roster: new Map((await rosterOf(db, session, { role: "authenticated", sub: admin })).map((r) => [r.member_id, r])),
  });

  it("se refleja en presentes, esperados, rate y roster; el check-in original se conserva; cada cambio queda en audit_log y nada se borra", async () => {
    const [a, b, c] = await db.members(3);
    const s = await closedSession(db, "remar_construction", [a]); // a presente; b y c ausentes
    expect((await view(s)).summary).toEqual({ present_count: 1, expected_count: 3, rate: 33 });

    await setAttendance(s, b, "present"); // Absent -> Present
    let v = await view(s);
    expect(v.summary).toEqual({ present_count: 2, expected_count: 3, rate: 67 });
    expect(v.roster.get(b)).toMatchObject({ status: "present", source: "manual" });

    await setAttendance(s, a, "absent"); // Present -> Absent (tenía check-in)
    v = await view(s);
    expect(v.summary).toEqual({ present_count: 1, expected_count: 3, rate: 33 });
    expect(v.roster.get(a)).toMatchObject({ status: "absent", source: "manual" });
    expect((await db.query("select 1 from public.checkins where session_id = $1 and member_id = $2", [s, a])).rowCount).toBe(1); // el check-in original SE CONSERVA

    await setAttendance(s, b, "absent"); // Present -> Absent otra vez: la fila de override se reutiliza
    v = await view(s);
    expect(v.summary).toEqual({ present_count: 0, expected_count: 3, rate: 0 });
    expect(attendancePercent({ counted: 3, attended: 0 })).toBe(0);
    expect((await db.query("select 1 from public.attendance_overrides where session_id = $1", [s])).rowCount).toBe(2); // una fila por (sesión, miembro): nunca se borra

    // Auditoría: quién, qué miembro, qué sesión, estado anterior y nuevo.
    const audit = await db.query<{ actor_id: string; entity_id: string; detail: { previous_status: string; new_status: string; session_id: string; member_id: string } }>(
      "select actor_id, entity_id, detail from public.audit_log where action = 'attendance.manual_change' and detail->>'session_id' = $1 order by at, id",
      [s],
    );
    expect(audit.rows.map((r) => [r.detail.member_id, r.detail.previous_status, r.detail.new_status])).toEqual([[b, "absent", "present"], [a, "present", "absent"], [b, "present", "absent"]]);
    for (const r of audit.rows) expect(r.actor_id).toBe(admin);

    // Ni el override ni el audit_log se pueden borrar (ni siquiera con permisos de propietario).
    await expect(db.query("delete from public.attendance_overrides where session_id = $1", [s])).rejects.toThrow(/asce:attendance_overrides_are_permanent/);
    await expect(db.query("delete from public.audit_log where action = 'attendance.manual_change'")).rejects.toThrow(/asce:audit_log_is_append_only/);
    void c;
  });

  it("solo en reuniones CERRADAS: una activa se rechaza aunque alguien fuerce la petición", async () => {
    const [a] = await db.members(1);
    const id = (await db.query<{ id: string }>("insert into public.sessions (title, scheduled_at) values ('Activa', now()) returning id")).rows[0].id;
    await db.query("update public.sessions set status = 'active' where id = $1", [id]);
    try {
      await expect(setAttendance(id, a, "present")).rejects.toThrow(/asce:attendance_session_not_closed/);
    } finally {
      await db.closeSession(id); // solo puede haber una sesión activa a la vez
    }
  });

  it("el cambio de un miembro de OTRO grupo no altera presentes ni esperados de la reunión (aunque alguien fuerce la petición)", async () => {
    const g = await db.member();
    const d = await db.member();
    await db.query("update public.members set is_design_team = true where id = $1", [d]);
    const s = await closedSession(db, "remar_construction");
    const before = (await view(s)).summary;
    await setAttendance(s, d, "present"); // la interfaz no lo ofrece; la base de datos lo admite como historial, pero no cuenta
    const after = await view(s);
    expect(after.summary).toEqual(before);
    expect(after.roster.has(d)).toBe(false);
    void g;
  });
});
