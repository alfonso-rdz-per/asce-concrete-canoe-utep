import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    pgPort: number;
  }
}

const ROOT = path.resolve(import.meta.dirname, "../..");
export const TEMPLATE_DB = "asce_template";

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as net.AddressInfo;
      srv.close(() => resolve(port));
    });
  });
}

async function withClient<T>(port: number, database: string, fn: (c: pg.Client) => Promise<T>) {
  const client = new pg.Client({ host: "127.0.0.1", port, user: "postgres", password: "postgres", database });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Levanta un Postgres 17 real (sin Docker), crea los roles de Supabase y una
 * base "plantilla" con el shim de `auth` + TODAS las migraciones de
 * supabase/migrations en orden. Cada prueba clona esa plantilla.
 */
export default async function setup(project: TestProject) {
  // embedded-postgres registra async-exit-hook, que en `beforeExit` llama a process.exit(0): eso taparía el código de salida con el
  // que Vitest señala pruebas fallidas (la CI saldría en verde). Si ya hay un código de error fijado, se conserva.
  const exit = process.exit.bind(process);
  process.exit = ((code?: number | string | null) => exit(code === 0 && process.exitCode ? process.exitCode : code)) as typeof process.exit;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "asce-pg-"));
  const port = await freePort();
  const server = new EmbeddedPostgres({
    databaseDir: dataDir,
    user: "postgres",
    password: "postgres",
    port,
    // Supabase usa UTF8. En Windows initdb tomaría WIN1252 (la configuración regional del sistema) y rechazaría
    // cualquier carácter fuera de Latin-1 (p. ej. los de formato bidireccional de members_position_valid).
    initdbFlags: ["--encoding=UTF8", "--locale=C"],
    persistent: false,
    onLog: () => {},
    onError: () => {},
  });

  await server.initialise();
  await server.start();

  await withClient(port, "postgres", async (c) => {
    await c.query(`
      create role anon nologin noinherit;
      create role authenticated nologin noinherit;
      create role service_role nologin noinherit bypassrls;
    `);
    await c.query(`create database ${TEMPLATE_DB}`);
  });

  await withClient(port, TEMPLATE_DB, async (c) => {
    await c.query(fs.readFileSync(path.join(ROOT, "tests/db/supabase-shim.sql"), "utf8"));
    const dir = path.join(ROOT, "supabase/migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      try {
        await c.query(fs.readFileSync(path.join(dir, file), "utf8"));
      } catch (err) {
        throw new Error(`Falló la migración ${file}: ${(err as Error).message}`);
      }
    }
  });

  project.provide("pgPort", port);

  return async () => {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
}
