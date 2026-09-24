/**
 * Migración 3: administrador = usuario válido de Supabase Auth (confirmado, no anónimo,
 * no baneado, no borrado). Se prueba contra Postgres real y se compara con el espejo JS.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { isAdminUser, type AdminCandidate } from "@/lib/auth/is-admin";
import { TestDb } from "./helpers";

const HOUR = 3_600_000;

interface Variant {
  name: string;
  expected: boolean;
  seed: Parameters<TestDb["authUser"]>[0];
  /** Los mismos datos, tal como los devuelve Supabase Auth a la aplicación. */
  user: (now: number) => AdminCandidate;
}

const VARIANTS: Variant[] = [
  {
    name: "confirmado, normal",
    expected: true,
    seed: {},
    user: () => ({ email: "a@example.test", email_confirmed_at: new Date().toISOString() }),
  },
  {
    name: "correo sin confirmar",
    expected: false,
    seed: { confirmed: false },
    user: () => ({ email: "a@example.test", email_confirmed_at: null }),
  },
  {
    name: "anónimo (aunque esté 'confirmado')",
    expected: false,
    seed: { anonymous: true },
    user: () => ({ email: "a@example.test", email_confirmed_at: new Date().toISOString(), is_anonymous: true }),
  },
  {
    name: "baneado (baneo vigente)",
    expected: false,
    seed: { bannedUntil: new Date(Date.now() + 24 * HOUR).toISOString() },
    user: (now) => ({ email: "a@example.test", email_confirmed_at: new Date().toISOString(), banned_until: new Date(now + 24 * HOUR).toISOString() }),
  },
  {
    name: "baneo ya vencido",
    expected: true,
    seed: { bannedUntil: new Date(Date.now() - HOUR).toISOString() },
    user: (now) => ({ email: "a@example.test", email_confirmed_at: new Date().toISOString(), banned_until: new Date(now - HOUR).toISOString() }),
  },
  {
    name: "borrado (deleted_at)",
    expected: false,
    seed: { deleted: true },
    user: () => ({ email: "a@example.test", email_confirmed_at: new Date().toISOString(), deleted_at: new Date().toISOString() }),
  },
  {
    name: "sin correo (p. ej. solo teléfono)",
    expected: false,
    seed: { email: null },
    user: () => ({ email: null, email_confirmed_at: new Date().toISOString() }),
  },
];

describe("Regla de administrador (migración 3)", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const isAdminSql = async (sub: string) => {
    const r = await db.as({ role: "authenticated", sub }, (q) => q<{ v: boolean }>("select private.is_admin() as v"));
    return r.rows[0].v;
  };

  describe("matriz de usuarios (SQL real) y paridad con el espejo JS", () => {
    for (const v of VARIANTS) {
      it(`${v.name} -> ${v.expected ? "ES" : "NO es"} administrador`, async () => {
        const id = await db.authUser(v.seed);
        expect(await isAdminSql(id)).toBe(v.expected);
        expect(isAdminUser(v.user(Date.now()), Date.now())).toBe(v.expected); // paridad
      });
    }

    it("un uid que no existe en auth.users NO es administrador", async () => {
      expect(await isAdminSql(crypto.randomUUID())).toBe(false);
    });

    it("un token sin `sub` (sin usuario) NO es administrador", async () => {
      await db.query("begin");
      try {
        await db.query("set local role authenticated");
        await db.query("select set_config('request.jwt.claims', '{\"role\":\"authenticated\"}', true), set_config('request.jwt.claim.sub', '', true)");
        const r = await db.query<{ v: boolean }>("select private.is_admin() as v");
        expect(r.rows[0].v).toBe(false);
      } finally {
        await db.query("rollback");
      }
    });
  });

  describe("espejo JS: casos límite y datos ilegibles (falla cerrado)", () => {
    const base = { email: "a@example.test", email_confirmed_at: "2026-01-01T00:00:00Z" };
    it("null/undefined y correo vacío", () => {
      expect(isAdminUser(null, Date.now())).toBe(false);
      expect(isAdminUser(undefined, Date.now())).toBe(false);
      expect(isAdminUser({ ...base, email: "" }, Date.now())).toBe(false);
    });
    it("baneo ilegible o hora inválida -> no administrador", () => {
      expect(isAdminUser({ ...base, banned_until: "no-es-una-fecha" }, Date.now())).toBe(false);
      expect(isAdminUser({ ...base, banned_until: "2030-01-01T00:00:00Z" }, Number.NaN)).toBe(false);
    });
    it("baneo que vence justo ahora ya no bloquea (mismo criterio que `<= now()`)", () => {
      const now = Date.parse("2026-05-05T00:00:00Z");
      expect(isAdminUser({ ...base, banned_until: "2026-05-05T00:00:00Z" }, now)).toBe(true);
      expect(isAdminUser({ ...base, banned_until: "2026-05-05T00:00:01Z" }, now)).toBe(false);
    });
  });

  describe("efectos sobre RLS", () => {
    it("VARIOS usuarios confirmados son administradores a la vez (los 3 usuarios actuales)", async () => {
      const ids = [await db.authUser(), await db.authUser(), await db.authUser()];
      for (const sub of ids) {
        const r = await db.as({ role: "authenticated", sub }, (q) =>
          q("insert into public.members (asce_id, name) values ($1, 'Miembro') returning id", [`AD${sub.slice(0, 6).toUpperCase()}`]),
        );
        expect(r.rowCount).toBe(1);
      }
    });

    it("un usuario NO administrador no ve ni escribe nada", async () => {
      const outsider = await db.authUser({ confirmed: false });
      const seen = await db.as({ role: "authenticated", sub: outsider }, (q) => q("select id from public.members"));
      expect(seen.rowCount).toBe(0);
      await expect(
        db.as({ role: "authenticated", sub: outsider }, (q) => q("insert into public.members (asce_id, name) values ('NOADM1', 'x')")),
      ).rejects.toMatchObject({ code: "42501" });
    });

    it("REVOCACIÓN INMEDIATA: banear o borrar al usuario le quita el acceso con el MISMO token", async () => {
      const id = await db.authUser();
      const insert = (asce: string) =>
        db.as({ role: "authenticated", sub: id }, (q) => q("insert into public.members (asce_id, name) values ($1, 'x')", [asce]));

      await insert("REVOKE1"); // es administrador

      await db.query("update auth.users set banned_until = now() + interval '1 day' where id = $1", [id]);
      await expect(insert("REVOKE2")).rejects.toMatchObject({ code: "42501" });

      await db.query("update auth.users set banned_until = null where id = $1", [id]);
      await insert("REVOKE3"); // levantar el baneo devuelve el acceso

      await db.query("delete from auth.users where id = $1", [id]);
      await expect(insert("REVOKE4")).rejects.toMatchObject({ code: "42501" });
    });

    it("REGRESIÓN: se puede BORRAR a un administrador que ya abrió y cerró sesiones (opened_by/created_by pasan a NULL)", async () => {
      const id = await db.authUser();
      const asAdmin = (fn: (q: Parameters<Parameters<TestDb["as"]>[1]>[0]) => Promise<unknown>) => db.as({ role: "authenticated", sub: id }, fn);

      const s = await asAdmin((q) => q<{ id: string }>("insert into public.sessions (title, scheduled_at) values ('Abierta por el admin', now()) returning id"));
      const sessionId = (s as { rows: { id: string }[] }).rows[0].id;
      await asAdmin((q) => q("update public.sessions set status = 'active' where id = $1", [sessionId]));
      const opened = await db.query<{ opened_by: string; created_by: string; opened_at: Date }>(
        "select opened_by, created_by, opened_at from public.sessions where id = $1",
        [sessionId],
      );
      expect(opened.rows[0].opened_by).toBe(id);
      expect(opened.rows[0].created_by).toBe(id);
      await asAdmin((q) => q("update public.sessions set status = 'closed' where id = $1", [sessionId]));
      const before = await db.query<{ opened_at: Date; closed_at: Date }>("select opened_at, closed_at from public.sessions where id = $1", [sessionId]);

      // Antes de la corrección esto fallaba con una violación de la clave foránea.
      await db.query("delete from auth.users where id = $1", [id]);

      const after = await db.query<{ opened_by: string | null; created_by: string | null; opened_at: Date; closed_at: Date; status: string }>(
        "select opened_by, created_by, opened_at, closed_at, status from public.sessions where id = $1",
        [sessionId],
      );
      expect(after.rows[0].opened_by).toBeNull();
      expect(after.rows[0].created_by).toBeNull();
      expect(after.rows[0].status).toBe("closed"); // el historial se conserva íntegro
      expect(after.rows[0].opened_at.getTime()).toBe(before.rows[0].opened_at.getTime());
      expect(after.rows[0].closed_at.getTime()).toBe(before.rows[0].closed_at.getTime());
    });

    it("opened_by sigue sin poder cambiarse a OTRO usuario (solo conservarse o pasar a NULL)", async () => {
      const a = await db.authUser();
      const b = await db.authUser();
      const sessionId = await db.draftSession();
      await db.as({ role: "authenticated", sub: a }, (q) => q("update public.sessions set status = 'active' where id = $1", [sessionId]));
      await db.query("update public.sessions set opened_by = $1 where id = $2", [b, sessionId]); // intento de falsear (superusuario)
      const r = await db.query<{ opened_by: string }>("select opened_by from public.sessions where id = $1", [sessionId]);
      expect(r.rows[0].opened_by).toBe(a);
      await db.closeSession(sessionId);
    });

    it("public.admins ya no existe y la función sigue cerrada para anon", async () => {
      const t = await db.query<{ t: string | null }>("select to_regclass('public.admins')::text as t");
      expect(t.rows[0].t).toBeNull();
      await expect(db.as({ role: "anon" }, (q) => q("select private.is_admin()"))).rejects.toMatchObject({ code: "42501" });
    });

    it("la función sigue siendo SECURITY DEFINER con search_path vacío", async () => {
      const r = await db.query<{ definer: boolean; cfg: string[] }>(
        `select p.prosecdef as definer, p.proconfig as cfg
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'private' and p.proname = 'is_admin'`,
      );
      expect(r.rows[0].definer).toBe(true);
      expect(r.rows[0].cfg).toContain('search_path=""');
    });
  });
});
