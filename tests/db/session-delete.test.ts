/**
 * Eliminar una sesión (migración 9), sobre Postgres real: solo administradores, con RLS; se llevan sus check-ins y correcciones
 * manuales SIN dejar filas huérfanas; los intentos de check-in y la auditoría se conservan; una sesión ACTIVA también se puede
 * borrar (y desde ese instante ya no admite check-ins). Los overrides siguen siendo permanentes salvo en ese borrado en cascada.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonce, TestDb, type Query } from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";

describe("Eliminar sesiones", () => {
  let db: TestDb;
  let seq = 0;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const asAdmin = async <T>(adminId: string, fn: (q: Query) => Promise<T>) => db.as({ role: "authenticated", sub: adminId }, fn);
  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0].n);

  /** Sesión con `n` asistentes y una corrección manual; queda `closed` (o `active` si se pide). */
  async function sessionWithRecords(opts: { n?: number; active?: boolean } = {}) {
    const members = await db.members(opts.n ?? 2);
    const id = await db.activeSession(`Con registros ${++seq}`);
    for (const m of members) {
      await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, m, nonce(`del${++seq}`)]);
    }
    if (!opts.active) await db.closeSession(id);
    // Corrección manual (override) de un miembro que NO asistió.
    const extra = await db.member();
    if (!opts.active) await db.query("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'present')", [id, extra]);
    return { id, members, extra };
  }

  it("un administrador borra una sesión cerrada: se van sus check-ins y correcciones, sin filas huérfanas", async () => {
    const admin = await db.adminUser();
    const { id } = await sessionWithRecords({ n: 3 });
    expect(await count("select count(*) as n from public.checkins where session_id = $1", [id])).toBe(3);
    expect(await count("select count(*) as n from public.attendance_overrides where session_id = $1", [id])).toBe(1);

    const r = await asAdmin(admin, (q) => q("delete from public.sessions where id = $1", [id]));
    expect(r.rowCount).toBe(1);

    expect(await count("select count(*) as n from public.sessions where id = $1", [id])).toBe(0);
    expect(await count("select count(*) as n from public.checkins where session_id = $1", [id])).toBe(0);
    expect(await count("select count(*) as n from public.attendance_overrides where session_id = $1", [id])).toBe(0);
    // Ninguna fila apunta a una sesión que ya no existe.
    expect(await count("select count(*) as n from public.checkins c left join public.sessions s on s.id = c.session_id where s.id is null")).toBe(0);
    expect(await count("select count(*) as n from public.attendance_overrides o left join public.sessions s on s.id = o.session_id where s.id is null")).toBe(0);
  });

  it("deja rastro en audit_log: 'session.delete' con instantánea y quién la borró, y un 'checkin.delete' por cada asistencia", async () => {
    const admin = await db.adminUser();
    const { id } = await sessionWithRecords({ n: 2 });
    await asAdmin(admin, (q) => q("delete from public.sessions where id = $1", [id]));

    const del = await db.query<{ actor_id: string; entity_type: string; detail: Record<string, unknown> }>(
      "select actor_id, entity_type, detail from public.audit_log where action = 'session.delete' and entity_id = $1",
      [id],
    );
    expect(del.rowCount).toBe(1);
    expect(del.rows[0]).toMatchObject({ actor_id: admin, entity_type: "session" });
    expect(del.rows[0].detail).toMatchObject({ status: "closed", audience: "remar_construction", deleted_checkins: 2, deleted_corrections: 1 });
    expect(String(del.rows[0].detail.title)).toContain("Con registros");

    const perCheckin = await count("select count(*) as n from public.audit_log where action = 'checkin.delete' and detail->>'session_id' = $1", [id]);
    expect(perCheckin).toBe(2);
  });

  it("los intentos de check-in se CONSERVAN (auditoría y límites): quedan con session_id nulo", async () => {
    const admin = await db.adminUser();
    const id = await db.activeSession("Con intentos");
    await db.query("insert into public.checkin_attempts (outcome, session_id, asce_id_tried, ticket_nonce) values ('bad_credentials', $1, 'ZZ-ATT', $2)", [id, nonce("att")]);
    await db.closeSession(id);
    await asAdmin(admin, (q) => q("delete from public.sessions where id = $1", [id]));
    const r = await db.query<{ session_id: string | null }>("select session_id from public.checkin_attempts where asce_id_tried = 'ZZ-ATT'");
    expect(r.rows).toEqual([{ session_id: null }]);
  });

  it("una sesión ACTIVA también se puede borrar; desde ese instante ya no admite check-ins", async () => {
    const admin = await db.adminUser();
    const { id, members } = await sessionWithRecords({ n: 1, active: true });
    await asAdmin(admin, (q) => q("delete from public.sessions where id = $1", [id]));
    expect(await count("select count(*) as n from public.sessions where id = $1", [id])).toBe(0);

    // La sesión ya no existe: ni el servidor puede registrar un check-in (el trigger lo rechaza) ni queda ninguna activa.
    await expect(
      db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, members[0], nonce("late")]),
    ).rejects.toThrow(/asce:session_not_active/);
    expect(await count("select count(*) as n from public.sessions where status = 'active'")).toBe(0);
    // Ya se puede abrir otra.
    const next = await db.activeSession("Siguiente");
    await db.closeSession(next);
  });

  it("un borrador histórico se puede borrar igual", async () => {
    const admin = await db.adminUser();
    const id = await db.draftSession("Borrador viejo");
    const r = await asAdmin(admin, (q) => q("delete from public.sessions where id = $1", [id]));
    expect(r.rowCount).toBe(1);
  });

  it("SOLO administradores: anon, un usuario que no es administrador y service_role NO pueden borrar sesiones", async () => {
    const id = await db.draftSession("Intocable");
    const outsider = await db.authUser({ confirmed: false });
    const anonymous = await db.authUser({ anonymous: true, email: null });

    await expect(db.as({ role: "anon" }, (q) => q("delete from public.sessions where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(db.as({ role: "service_role" }, (q) => q("delete from public.sessions where id = $1", [id]))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    for (const sub of [outsider, anonymous]) {
      const r = await db.as({ role: "authenticated", sub }, (q) => q("delete from public.sessions where id = $1", [id]));
      expect(r.rowCount, "RLS: sin filas visibles, nada se borra").toBe(0);
    }
    expect(await count("select count(*) as n from public.sessions where id = $1", [id])).toBe(1);
  });

  it("las correcciones manuales siguen siendo PERMANENTES mientras la sesión exista (DELETE directo rechazado)", async () => {
    const { id, extra } = await sessionWithRecords({ n: 1 });
    await expect(db.query("delete from public.attendance_overrides where session_id = $1 and member_id = $2", [id, extra])).rejects.toThrow(/asce:attendance_overrides_are_permanent/);
    await expect(db.query("truncate public.attendance_overrides")).rejects.toThrow(/asce:attendance_overrides_are_permanent/);
    expect(await count("select count(*) as n from public.attendance_overrides where session_id = $1", [id])).toBe(1);
  });

  it("borrar un miembro con asistencias sigue prohibido (el historial de miembros no se toca)", async () => {
    const { members } = await sessionWithRecords({ n: 1 });
    await expect(db.query("delete from public.members where id = $1", [members[0]])).rejects.toMatchObject({ code: "23503" });
  });

  it("borrar dos sesiones no afecta a las demás", async () => {
    const admin = await db.adminUser();
    const keep = await sessionWithRecords({ n: 2 });
    const gone = await sessionWithRecords({ n: 2 });
    await asAdmin(admin, (q) => q("delete from public.sessions where id = $1", [gone.id]));
    expect(await count("select count(*) as n from public.checkins where session_id = $1", [keep.id])).toBe(2);
    expect(await count("select count(*) as n from public.attendance_overrides where session_id = $1", [keep.id])).toBe(1);
  });
});
