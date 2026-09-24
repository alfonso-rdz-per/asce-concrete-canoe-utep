/**
 * Base de datos (Postgres real): lo que sostiene el check-in del estudiante SIN PIN —la tabla de intentos (auditoría y base de los
 * límites), sus restricciones y permisos— y la forma del alta de sesiones (solo nombre + Required; fecha del servidor).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonce, TestDb } from "./helpers";

const CHECK_VIOLATION = "23514";
const INSUFFICIENT_PRIVILEGE = "42501";
const IP = "a".repeat(64);

describe("checkin_attempts y alta de sesiones", () => {
  let db: TestDb;
  let n = 0;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const svc = <T>(fn: (q: Parameters<Parameters<TestDb["as"]>[1]>[0]) => Promise<T>) => db.as({ role: "service_role" }, fn);
  const record = (outcome: string, asceId: string, opts: { ticket?: string | null; ip?: string | null; session?: string | null } = {}) =>
    svc((q) =>
      q("insert into public.checkin_attempts (outcome, session_id, asce_id_tried, ticket_nonce, ip_hash) values ($1, $2, $3, $4, $5)", [
        outcome,
        opts.session ?? null,
        asceId,
        opts.ticket === undefined ? nonce(++n) : opts.ticket,
        opts.ip === undefined ? IP : opts.ip,
      ]),
    );

  describe("tabla de intentos", () => {
    it("guarda todos los resultados del check-in, incluidos los que nunca se muestran al estudiante", async () => {
      for (const outcome of ["success", "bad_credentials", "member_inactive", "ticket_invalid", "ticket_expired", "session_not_active", "already_checked_in", "rate_limited"]) {
        await record(outcome, `ZZ-${outcome}`.toUpperCase().replaceAll("_", "-"));
      }
      const r = await db.query("select outcome from public.checkin_attempts");
      expect(r.rowCount).toBe(8);
    });

    it("la IP NUNCA se guarda en claro: solo un HMAC de 64 hex (la restricción rechaza una IP)", async () => {
      for (const raw of ["203.0.113.10", "::1", "192.168.1.215", "a".repeat(63), "A".repeat(64), "g".repeat(64)]) {
        await expect(record("bad_credentials", "RAWIP", { ip: raw }), raw).rejects.toMatchObject({ code: CHECK_VIOLATION });
      }
      await record("bad_credentials", "RAWIP", { ip: IP });
      await record("bad_credentials", "RAWIP", { ip: null }); // sin IP (p. ej. en local) es válido
    });

    it("el nonce debe ser un nonce de 22 caracteres: no cabe un token QR ni un ticket completo", async () => {
      for (const whole of ["v1.AAAAAAAAAAAAAAAAAAAAAA.2z60w0.jd1u1VZ6L8DwLQAZNh3UMg", "t1.AAAAAAAAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.abc.def.CCCCCCCCCCCCCCCCCCCCCC"]) {
        await expect(record("bad_credentials", "NONCE", { ticket: whole })).rejects.toMatchObject({ code: CHECK_VIOLATION });
      }
    });

    it("el ASCE ID intentado se limita a 64 caracteres (texto controlado por quien intenta)", async () => {
      await expect(record("bad_credentials", "X".repeat(65))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it("la consulta de los LÍMITES (fallos por ticket, ASCE ID e IP desde una hora) cuenta solo bad_credentials y member_inactive", async () => {
      const ticket = nonce("limit-ticket");
      const ip = "b".repeat(64);
      await record("bad_credentials", "LIMIT-ID", { ticket, ip });
      await record("member_inactive", "LIMIT-ID", { ticket, ip });
      await record("success", "LIMIT-ID", { ticket, ip });
      await record("already_checked_in", "LIMIT-ID", { ticket, ip });
      await record("ticket_expired", "LIMIT-ID", { ticket, ip });
      await record("rate_limited", "LIMIT-ID", { ticket, ip });

      const count = (col: string, value: string) =>
        svc((q) =>
          q<{ n: string }>(
            `select count(*) as n from public.checkin_attempts
              where outcome in ('bad_credentials', 'member_inactive') and ${col} = $1 and at >= now() - interval '15 minutes'`,
            [value],
          ),
        );
      for (const [col, value] of [["ticket_nonce", ticket], ["asce_id_tried", "LIMIT-ID"], ["ip_hash", ip]] as const) {
        expect(Number((await count(col, value)).rows[0].n), col).toBe(2);
      }
      // Fuera de la ventana (pasada más de una hora) ya no cuentan: el bloqueo caduca solo.
      await db.query("update public.checkin_attempts set at = now() - interval '2 hours' where asce_id_tried = 'LIMIT-ID'");
      for (const [col, value] of [["ticket_nonce", ticket], ["asce_id_tried", "LIMIT-ID"], ["ip_hash", ip]] as const) {
        expect(Number((await count(col, value)).rows[0].n), `${col} fuera de ventana`).toBe(0);
      }
    });
  });

  describe("permisos (RLS): auditoría legible solo por administradores; el servidor solo escribe", () => {
    it("un administrador lee los intentos; anon, no administradores y los estudiantes, no", async () => {
      await record("bad_credentials", "AUDIT-ID");
      const admin = await db.adminUser();
      const seen = await db.as({ role: "authenticated", sub: admin }, (q) => q("select * from public.checkin_attempts where asce_id_tried = 'AUDIT-ID'"));
      expect(seen.rowCount).toBe(1);

      await expect(db.as({ role: "anon" }, (q) => q("select * from public.checkin_attempts"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      const outsider = await db.authUser({ confirmed: false });
      const none = await db.as({ role: "authenticated", sub: outsider }, (q) => q("select * from public.checkin_attempts"));
      expect(none.rowCount).toBe(0);
    });

    it("nadie puede falsear la auditoría desde la API: ni el administrador ni anon escriben, actualizan ni borran intentos", async () => {
      const admin = await db.adminUser();
      for (const actor of [{ role: "authenticated", sub: admin } as const, { role: "anon" } as const]) {
        await expect(db.as(actor, (q) => q("insert into public.checkin_attempts (outcome) values ('success')"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
        await expect(db.as(actor, (q) => q("update public.checkin_attempts set outcome = 'success'"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
        await expect(db.as(actor, (q) => q("delete from public.checkin_attempts"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      }
    });

    it("service_role inserta y purga por antigüedad, pero NO reescribe intentos ya registrados", async () => {
      await record("bad_credentials", "PURGE-ID");
      await expect(svc((q) => q("update public.checkin_attempts set outcome = 'success' where asce_id_tried = 'PURGE-ID'"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      const del = await svc((q) => q("delete from public.checkin_attempts where asce_id_tried = 'PURGE-ID'"));
      expect(del.rowCount).toBe(1);
    });
  });

  describe("el check-in NO usa PIN a nivel de base de datos (la columna ya no existe)", () => {
    it("el envío solo lee id, name y active del miembro; members ya no tiene ninguna columna de PIN", async () => {
      const member = await db.member({ asce_id: "ZZ-MAX-1", name: "Max Verstappen" });
      const r = await svc((q) => q<{ id: string; name: string; active: boolean }>("select id, name, active from public.members where asce_id = 'ZZ-MAX-1'"));
      expect(r.rows[0]).toEqual({ id: member, name: "Max Verstappen", active: true });
      const cols = await db.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'members'");
      expect(cols.rows.map((c) => c.column_name).filter((c) => /pin/i.test(c))).toEqual([]);
    });

    it("una asistencia por miembro y sesión y un ticket por check-in siguen impuestos por la BD (mismo cuerpo, sin PIN)", async () => {
      const [m1, m2] = await db.members(2);
      const s = await db.activeSession();
      const ins = (member: string, ticketNonce: string) =>
        svc((q) => q("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce, ip_hash) values ($1, $2, 1, $3, $4)", [s, member, ticketNonce, IP]));
      const t1 = nonce("t-one");
      await ins(m1, t1);
      await expect(ins(m1, nonce("t-two"))).rejects.toMatchObject({ constraint: "checkins_one_per_member_per_session" }); // duplicado
      await expect(ins(m2, t1)).rejects.toMatchObject({ constraint: "checkins_ticket_single_use" }); // anti-replay
      await db.closeSession(s);
      await expect(ins(m2, nonce("t-three"))).rejects.toMatchObject({ message: expect.stringContaining("asce:session_not_active") });
    });
  });

  describe("New Session: solo nombre + Required; la fecha la pone el servidor", () => {
    it("un administrador inserta SOLO title, scheduled_at y audience; description y location quedan NULL", async () => {
      const admin = await db.adminUser();
      const r = await db.as({ role: "authenticated", sub: admin }, (q) =>
        q<{ id: string; description: string | null; location: string | null; status: string; audience: string; opened_by: string | null }>(
          "insert into public.sessions (title, scheduled_at, audience) values ('Concrete Canoe Practice', now(), 'design_team') returning id, description, location, status, audience, opened_by",
        ),
      );
      expect(r.rows[0]).toMatchObject({ description: null, location: null, status: "draft", audience: "design_team", opened_by: null });
    });

    it("al activarla, opened_by y opened_at los fija la BD con SU reloj: el cliente no puede adelantarlos ni falsearlos", async () => {
      const admin = await db.adminUser();
      const created = await db.as({ role: "authenticated", sub: admin }, (q) => q<{ id: string }>("insert into public.sessions (title, scheduled_at, audience) values ('Practice', now(), 'remar_construction') returning id"));
      const id = created.rows[0].id;
      const before = Date.now();
      await db.as({ role: "authenticated", sub: admin }, (q) => q("update public.sessions set status = 'active' where id = $1", [id]));
      const row = await db.query<{ opened_by: string; opened_at: Date; status: string }>("select opened_by, opened_at, status from public.sessions where id = $1", [id]);
      expect(row.rows[0]).toMatchObject({ opened_by: admin, status: "active" });
      expect(Math.abs(row.rows[0].opened_at.getTime() - before)).toBeLessThan(10_000);
      await db.closeSession(id);
    });
  });
});
