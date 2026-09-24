import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonce, TestDb } from "./helpers";

const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";

const insertCheckin = "insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, $3, $4) returning id, checked_in_at";

describe("Integridad de datos", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  describe("members", () => {
    const insert = (asce: string, name = "Ana", email: string | null = null) =>
      db.query("insert into public.members (asce_id, name, email) values ($1, $2, $3)", [asce, name, email]);

    it("ASCE ID único", async () => {
      await insert("DUP1");
      await expect(insert("DUP1")).rejects.toMatchObject({ code: UNIQUE_VIOLATION, constraint: "members_asce_id_key" });
    });

    it("ASCE ID solo en formato normalizado (mayúsculas, dígitos, guion)", async () => {
      for (const bad of ["ab", "abc123", "12 34", "12'34", "A".repeat(33), ""]) {
        await expect(insert(bad), bad).rejects.toMatchObject({ code: CHECK_VIOLATION });
      }
      await insert("ABC-123");
    });

    it("nombre no vacío ni solo espacios", async () => {
      await expect(insert("NAME1", "   ")).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insert("NAME2", "x".repeat(121))).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it("email opcional pero con formato razonable", async () => {
      await insert("MAIL1", "Ana", "ana@example.test");
      await expect(insert("MAIL2", "Ana", "no-es-un-email")).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(insert("MAIL3", "Ana", "a b@example.test")).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it("active y deactivated_on siempre coherentes", async () => {
      const id = await db.member({ asce_id: "ACT01" });
      await expect(db.query("update public.members set active = false where id = $1", [id])).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(db.query("update public.members set deactivated_on = current_date where id = $1", [id])).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await db.query("update public.members set active = false, deactivated_on = current_date where id = $1", [id]);
      await expect(
        db.query("update public.members set deactivated_on = joined_on - 1 where id = $1", [id]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });

    it("joined_on por defecto es la fecha de hoy en América/Denver", async () => {
      const id = await db.member({ asce_id: "JOIN1" });
      const r = await db.query<{ ok: boolean }>(
        "select joined_on = (now() at time zone 'America/Denver')::date as ok from public.members where id = $1",
        [id],
      );
      expect(r.rows[0].ok).toBe(true);
    });

    it("updated_at avanza al modificar", async () => {
      const id = await db.member({ asce_id: "UPD01" });
      const before = await db.query<{ updated_at: Date }>("select updated_at from public.members where id = $1", [id]);
      await new Promise((r) => setTimeout(r, 15));
      await db.query("update public.members set name = 'Otro' where id = $1", [id]);
      const after = await db.query<{ updated_at: Date }>("select updated_at from public.members where id = $1", [id]);
      expect(after.rows[0].updated_at.getTime()).toBeGreaterThan(before.rows[0].updated_at.getTime());
    });
  });

  describe("sessions: ciclo de vida", () => {
    it("solo se crean en draft o ya ACTIVAS (nunca cerradas), aunque el que inserta sea superusuario; las marcas las pone la BD", async () => {
      await expect(
        db.query("insert into public.sessions (title, scheduled_at, status) values ('x', now(), 'closed')"),
      ).rejects.toThrow(/asce:session_must_start_as_draft/);

      // Ya activa: opened_at lo fija el reloj de la BD (el valor del cliente se ignora) y closed_at nace vacío.
      const r = await db.query<{ id: string; status: string; opened_at: Date; closed_at: Date | null }>(
        "insert into public.sessions (title, scheduled_at, status, opened_at) values ('directa', now(), 'active', '2000-01-01') returning id, status, opened_at, closed_at",
      );
      expect(r.rows[0].status).toBe("active");
      expect(r.rows[0].closed_at).toBeNull();
      expect(r.rows[0].opened_at.getUTCFullYear()).toBeGreaterThan(2020);
      // Y sigue mandando el índice único: no puede haber otra activa a la vez.
      await expect(
        db.query("insert into public.sessions (title, scheduled_at, status) values ('otra', now(), 'active')"),
      ).rejects.toMatchObject({ constraint: "sessions_single_active" });
      await db.closeSession(r.rows[0].id);
    });

    it("draft -> active -> closed, con marcas de tiempo puestas por la base de datos", async () => {
      const id = await db.draftSession();
      const draft = await db.query("select opened_at, closed_at from public.sessions where id = $1", [id]);
      expect(draft.rows[0]).toEqual({ opened_at: null, closed_at: null });

      // Un cliente que intenta fijar sus propias marcas de tiempo es ignorado.
      await db.query("update public.sessions set status = 'active', opened_at = '2000-01-01' where id = $1", [id]);
      const active = await db.query<{ opened_at: Date; closed_at: Date | null }>("select opened_at, closed_at from public.sessions where id = $1", [id]);
      expect(active.rows[0].opened_at.getFullYear()).toBeGreaterThan(2020);
      expect(active.rows[0].closed_at).toBeNull();

      await db.query("update public.sessions set status = 'closed', closed_at = '2000-01-01' where id = $1", [id]);
      const closed = await db.query<{ opened_at: Date; closed_at: Date }>("select opened_at, closed_at from public.sessions where id = $1", [id]);
      expect(closed.rows[0].closed_at.getTime()).toBeGreaterThanOrEqual(closed.rows[0].opened_at.getTime());
      expect(closed.rows[0].closed_at.getFullYear()).toBeGreaterThan(2020);
    });

    it("una sesión cerrada NO se reabre", async () => {
      const id = await db.activeSession();
      await db.closeSession(id);
      await expect(db.query("update public.sessions set status = 'active' where id = $1", [id])).rejects.toThrow(/asce:session_closed_is_final/);
      await expect(db.query("update public.sessions set status = 'draft' where id = $1", [id])).rejects.toThrow(/asce:session_closed_is_final/);
    });

    it("no hay saltos de estado (draft->closed, active->draft)", async () => {
      const a = await db.draftSession();
      await expect(db.query("update public.sessions set status = 'closed' where id = $1", [a])).rejects.toThrow(/asce:session_invalid_transition/);
      await db.query("update public.sessions set status = 'active' where id = $1", [a]);
      await expect(db.query("update public.sessions set status = 'draft' where id = $1", [a])).rejects.toThrow(/asce:session_invalid_transition/);
      await db.closeSession(a);
    });

    it("las marcas de tiempo quedan congeladas al editar otros campos", async () => {
      const id = await db.activeSession();
      const before = await db.query<{ opened_at: Date }>("select opened_at from public.sessions where id = $1", [id]);
      await db.query("update public.sessions set title = 'Nuevo título', opened_at = now() + interval '1 day' where id = $1", [id]);
      const after = await db.query<{ opened_at: Date; title: string }>("select opened_at, title from public.sessions where id = $1", [id]);
      expect(after.rows[0].title).toBe("Nuevo título");
      expect(after.rows[0].opened_at.getTime()).toBe(before.rows[0].opened_at.getTime());
      await db.closeSession(id);
    });

    it("una sola sesión activa a la vez", async () => {
      const a = await db.activeSession();
      const b = await db.draftSession();
      await expect(db.query("update public.sessions set status = 'active' where id = $1", [b])).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "sessions_single_active",
      });
      await db.closeSession(a);
      await db.query("update public.sessions set status = 'active' where id = $1", [b]); // ya se puede
      await db.closeSession(b);
    });

    it("título obligatorio y acotado", async () => {
      await expect(db.query("insert into public.sessions (title, scheduled_at) values ('  ', now())")).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(db.query("insert into public.sessions (title, scheduled_at) values ($1, now())", ["x".repeat(161)])).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  describe("checkins", () => {
    it("crea un check-in en una sesión activa; la hora la fija la base de datos", async () => {
      const s = await db.activeSession();
      const m = await db.member();
      const r = await db.query<{ checked_in_at: Date }>(
        "insert into public.checkins (session_id, member_id, checked_in_at, token_slot, ticket_nonce) values ($1, $2, '2001-01-01', 5, $3) returning checked_in_at",
        [s, m, nonce("a")],
      );
      expect(r.rows[0].checked_in_at.getFullYear()).toBeGreaterThan(2020); // se ignoró la hora del cliente
      await db.closeSession(s);
    });

    it("un miembro solo tiene UNA asistencia por sesión (restricción de base de datos)", async () => {
      const s = await db.activeSession();
      const m = await db.member();
      await db.query(insertCheckin, [s, m, 1, nonce("1")]);
      await expect(db.query(insertCheckin, [s, m, 2, nonce("2")])).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "checkins_one_per_member_per_session",
      });
      await db.closeSession(s);
    });

    it("el mismo miembro sí puede asistir a sesiones distintas", async () => {
      const m = await db.member();
      for (let i = 0; i < 2; i++) {
        const s = await db.activeSession();
        await db.query(insertCheckin, [s, m, 1, nonce("dup-ok")]); // mismo nonce, distinta sesión: permitido
        await db.closeSession(s);
      }
    });

    it("un ticket (nonce) produce como máximo UN check-in por sesión", async () => {
      const s = await db.activeSession();
      const m1 = await db.member();
      const m2 = await db.member();
      await db.query(insertCheckin, [s, m1, 1, nonce("shared")]);
      await expect(db.query(insertCheckin, [s, m2, 1, nonce("shared")])).rejects.toMatchObject({
        code: UNIQUE_VIOLATION,
        constraint: "checkins_ticket_single_use",
      });
      await db.closeSession(s);
    });

    it("rechaza sesiones en draft, cerradas o inexistentes", async () => {
      const m = await db.member();
      const draft = await db.draftSession();
      await expect(db.query(insertCheckin, [draft, m, 1, nonce("d")])).rejects.toThrow(/asce:session_not_active/);

      const closed = await db.activeSession();
      await db.closeSession(closed);
      await expect(db.query(insertCheckin, [closed, m, 1, nonce("c")])).rejects.toThrow(/asce:session_not_active/);

      await expect(
        db.query(insertCheckin, ["00000000-0000-4000-8000-000000000000", m, 1, nonce("n")]),
      ).rejects.toThrow(/asce:session_not_active/);
    });

    it("rechaza miembros desactivados", async () => {
      const s = await db.activeSession();
      const inactive = await db.member({ active: false });
      await expect(db.query(insertCheckin, [s, inactive, 1, nonce("i")])).rejects.toThrow(/asce:member_not_active/);
      await db.closeSession(s);
    });

    it("valida formato de nonce, slot e ip_hash", async () => {
      const s = await db.activeSession();
      const m = await db.member();
      await expect(db.query(insertCheckin, [s, m, 1, "corto"])).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(db.query(insertCheckin, [s, m, -1, nonce("x")])).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await expect(
        db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce, ip_hash) values ($1, $2, 1, $3, '1.2.3.4')", [s, m, nonce("y")]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
      await db.closeSession(s);
    });

    it("los check-ins son inmutables (ni siquiera un superusuario los edita)", async () => {
      const s = await db.activeSession();
      const m = await db.member();
      const r = await db.query<{ id: string }>(insertCheckin, [s, m, 1, nonce("imm")]);
      await expect(db.query("update public.checkins set member_id = member_id where id = $1", [r.rows[0].id])).rejects.toThrow(/asce:checkins_are_immutable/);
      await db.closeSession(s);
    });

    it("no se puede borrar un miembro con asistencias (historial protegido); borrar la SESIÓN se prueba en session-delete.test.ts", async () => {
      const s = await db.activeSession();
      const m = await db.member();
      await db.query(insertCheckin, [s, m, 1, nonce("keep")]);
      await expect(db.query("delete from public.members where id = $1", [m])).rejects.toMatchObject({ code: "23503" });
      await db.closeSession(s);
    });

    it("borrar un check-in sin sesión de usuario (service role) también queda auditado, con actor nulo", async () => {
      const s = await db.activeSession();
      const m = await db.member();
      const r = await db.query<{ id: string }>(insertCheckin, [s, m, 3, nonce("aud")]);
      await db.query("delete from public.checkins where id = $1", [r.rows[0].id]);
      const a = await db.query("select actor_id, action from public.audit_log where entity_id = $1", [r.rows[0].id]);
      expect(a.rows).toEqual([{ actor_id: null, action: "checkin.delete" }]);
      await db.closeSession(s);
    });
  });

  describe("audit_log: solo inserción", () => {
    it("no se puede actualizar, borrar ni truncar (ni como superusuario)", async () => {
      await db.query("insert into public.audit_log (action, entity_type) values ('t', 't')");
      await expect(db.query("update public.audit_log set action = 'x'")).rejects.toThrow(/asce:audit_log_is_append_only/);
      await expect(db.query("delete from public.audit_log")).rejects.toThrow(/asce:audit_log_is_append_only/);
      await expect(db.query("truncate public.audit_log")).rejects.toThrow(/asce:audit_log_is_append_only/);
    });
  });

  describe("checkin_attempts", () => {
    it("acepta cada resultado definido y valida formatos", async () => {
      const outcomes = ["success", "bad_credentials", "member_inactive", "ticket_invalid", "ticket_expired", "session_not_active", "already_checked_in", "rate_limited"];
      for (const o of outcomes) {
        await db.query("insert into public.checkin_attempts (outcome, asce_id_tried, ticket_nonce) values ($1, 'X1', $2)", [o, nonce(o)]);
      }
      await expect(db.query("insert into public.checkin_attempts (outcome) values ('invented')")).rejects.toMatchObject({ code: "22P02" });
      await expect(
        db.query("insert into public.checkin_attempts (outcome, asce_id_tried) values ('success', $1)", ["x".repeat(65)]),
      ).rejects.toMatchObject({ code: CHECK_VIOLATION });
    });
  });

  describe("concurrencia", () => {
    it("25 peticiones simultáneas del mismo miembro producen exactamente 1 asistencia", async () => {
      const s = await db.activeSession();
      const m = await db.member();
      const clients = await Promise.all(Array.from({ length: 25 }, () => db.connectAs({ role: "service_role" })));
      try {
        const results = await Promise.allSettled(
          clients.map((c, i) => c.query(insertCheckin, [s, m, 1, nonce(`race-${i}`)])),
        );
        const ok = results.filter((r) => r.status === "fulfilled");
        const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
        expect(ok).toHaveLength(1);
        expect(failed).toHaveLength(24);
        for (const f of failed) expect(f.reason).toMatchObject({ code: UNIQUE_VIOLATION });
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      const n = await db.query<{ n: number }>("select count(*)::int as n from public.checkins where session_id = $1", [s]);
      expect(n.rows[0].n).toBe(1);
      await db.closeSession(s);
    });

    it("un mismo ticket usado a la vez por 10 miembros distintos produce exactamente 1 asistencia", async () => {
      const s = await db.activeSession();
      const members = await db.members(10);
      const clients = await Promise.all(members.map(() => db.connectAs({ role: "service_role" })));
      try {
        const results = await Promise.allSettled(clients.map((c, i) => c.query(insertCheckin, [s, members[i], 1, nonce("one-ticket")])));
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }
      await db.closeSession(s);
    });

    it("cerrar la sesión mientras entran check-ins: ninguno queda registrado después del cierre", async () => {
      for (let round = 0; round < 6; round++) {
        const s = await db.activeSession(`carrera ${round}`);
        const members = await db.members(20);
        const clients = await Promise.all(members.map(() => db.connectAs({ role: "service_role" })));
        try {
          const inserts = clients.map((c, i) => c.query(insertCheckin, [s, members[i], 1, nonce(`r${round}-${i}`)]));
          await new Promise((r) => setTimeout(r, round * 3));
          const closing = db.closeSession(s);
          const results = await Promise.allSettled(inserts);
          await closing;

          for (const r of results) {
            if (r.status === "rejected") expect(String(r.reason?.message)).toMatch(/asce:session_not_active/);
          }
        } finally {
          await Promise.all(clients.map((c) => c.end()));
        }

        const violations = await db.query<{ n: number }>(
          `select count(*)::int as n
             from public.checkins c join public.sessions s on s.id = c.session_id
            where c.session_id = $1 and c.checked_in_at >= s.closed_at`,
          [s],
        );
        expect(violations.rows[0].n, `ronda ${round}`).toBe(0);

        // Y una vez cerrada, nada más entra.
        await expect(db.query(insertCheckin, [s, members[0], 9, nonce(`late-${round}`)])).rejects.toThrow(/asce:session_not_active/);
      }
    });
  });
});
