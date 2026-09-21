import { randomBytes, randomUUID } from "node:crypto";
import { inject } from "vitest";
import pg from "pg";

const TEMPLATE_DB = "asce_template";

export type Actor =
  | { role: "anon" }
  | { role: "authenticated"; sub: string }
  | { role: "service_role" };

export type Query = <R extends pg.QueryResultRow = pg.QueryResultRow>(
  sql: string,
  params?: unknown[],
) => Promise<pg.QueryResult<R>>;

const ROLE_SQL: Record<Actor["role"], string> = {
  anon: "set local role anon",
  authenticated: "set local role authenticated",
  service_role: "set local role service_role",
};

function claimsFor(actor: Actor): { claims: string; sub: string } {
  const sub = actor.role === "authenticated" ? actor.sub : "";
  const claims = JSON.stringify(actor.role === "authenticated" ? { sub, role: actor.role } : { role: actor.role });
  return { claims, sub };
}

function connect(database: string): pg.Client {
  return new pg.Client({
    host: "127.0.0.1",
    port: inject("pgPort"),
    user: "postgres",
    password: "postgres",
    database,
  });
}

/** Base de datos aislada, clonada de la plantilla con todas las migraciones aplicadas. */
export class TestDb {
  private constructor(
    readonly name: string,
    private readonly superuser: pg.Client,
  ) {}

  static async create(): Promise<TestDb> {
    const name = `t_${randomBytes(6).toString("hex")}`;
    const ctl = connect("postgres");
    await ctl.connect();
    try {
      await ctl.query(`create database ${name} template ${TEMPLATE_DB}`);
    } finally {
      await ctl.end();
    }
    const superuser = connect(name);
    await superuser.connect();
    return new TestDb(name, superuser);
  }

  /** Como superusuario (omite permisos y RLS; los triggers SÍ aplican). */
  query: Query = (sql, params) => this.superuser.query(sql, params);

  /**
   * Ejecuta `fn` en una transacción con el rol y los claims JWT indicados,
   * igual que PostgREST. Confirma si `fn` termina; revierte y relanza si falla.
   */
  async as<T>(actor: Actor, fn: (q: Query) => Promise<T>): Promise<T> {
    return runAs(this.superuser, actor, fn);
  }

  /** Conexión independiente (para pruebas de concurrencia) con el rol fijado a nivel de sesión. */
  async connectAs(actor: Actor): Promise<pg.Client> {
    const client = connect(this.name);
    await client.connect();
    await client.query(ROLE_SQL[actor.role].replace("set local role", "set role"));
    const { claims, sub } = claimsFor(actor);
    await client.query("select set_config('request.jwt.claims', $1, false), set_config('request.jwt.claim.sub', $2, false)", [claims, sub]);
    return client;
  }

  async destroy(): Promise<void> {
    await this.superuser.end();
    const ctl = connect("postgres");
    await ctl.connect();
    try {
      await ctl.query(`drop database if exists ${this.name} with (force)`);
    } finally {
      await ctl.end();
    }
  }

  // --- Fixtures (como superusuario) -----------------------------------------

  /**
   * Usuario de Supabase Auth. Por defecto CONFIRMADO (= administrador según la migración 3).
   * Con `confirmed: false`, `anonymous`, `bannedUntil` o `deleted` se obtienen los casos que NO son administrador.
   */
  async authUser(
    opts: { email?: string | null; confirmed?: boolean; anonymous?: boolean; bannedUntil?: string | null; deleted?: boolean } = {},
  ): Promise<string> {
    const email = opts.email === undefined ? `${randomUUID()}@example.test` : opts.email;
    const r = await this.query<{ id: string }>(
      `insert into auth.users (email, email_confirmed_at, is_anonymous, banned_until, deleted_at)
       values ($1, $2, $3, $4, $5) returning id`,
      [
        email,
        opts.confirmed === false ? null : new Date().toISOString(),
        opts.anonymous ?? false,
        opts.bannedUntil ?? null,
        opts.deleted ? new Date().toISOString() : null,
      ],
    );
    return r.rows[0].id;
  }

  /** Administrador = usuario confirmado, no anónimo, no baneado y no borrado. */
  async adminUser(): Promise<string> {
    return this.authUser();
  }

  async member(overrides: { asce_id?: string; name?: string; active?: boolean } = {}): Promise<string> {
    const asce = overrides.asce_id ?? `ID${randomBytes(4).toString("hex").toUpperCase()}`;
    const r = await this.query<{ id: string }>(
      `insert into public.members (asce_id, name) values ($1, $2) returning id`,
      [asce, overrides.name ?? "Miembro de prueba"],
    );
    const id = r.rows[0].id;
    if (overrides.active === false) {
      await this.query("update public.members set active = false, deactivated_on = current_date where id = $1", [id]);
    }
    return id;
  }

  /** `n` miembros creados uno tras otro (un solo cliente no admite consultas simultáneas). */
  async members(n: number): Promise<string[]> {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) ids.push(await this.member());
    return ids;
  }

  async draftSession(title = "Reunión de prueba"): Promise<string> {
    const r = await this.query<{ id: string }>(
      "insert into public.sessions (title, scheduled_at) values ($1, now()) returning id",
      [title],
    );
    return r.rows[0].id;
  }

  async activeSession(title?: string): Promise<string> {
    const id = await this.draftSession(title);
    await this.query("update public.sessions set status = 'active' where id = $1", [id]);
    return id;
  }

  async closeSession(id: string): Promise<void> {
    await this.query("update public.sessions set status = 'closed' where id = $1", [id]);
  }
}

async function runAs<T>(client: pg.Client, actor: Actor, fn: (q: Query) => Promise<T>): Promise<T> {
  const { claims, sub } = claimsFor(actor);
  await client.query("begin");
  try {
    await client.query(ROLE_SQL[actor.role]);
    await client.query("select set_config('request.jwt.claims', $1, true), set_config('request.jwt.claim.sub', $2, true)", [claims, sub]);
    const result = await fn((sql, params) => client.query(sql, params));
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback");
    throw err;
  }
}

/** Nonce de ticket válido (22 caracteres base64url), distinto por cada `n`. */
export function nonce(n: number | string = randomBytes(16).toString("hex")): string {
  return Buffer.from(String(n).padEnd(16, "_").slice(0, 16), "utf8").toString("base64url");
}
