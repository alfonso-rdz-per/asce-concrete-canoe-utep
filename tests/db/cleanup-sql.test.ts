/**
 * tests/supabase/cleanup.sql (lo ejecuta el usuario en el SQL Editor) se prueba aquí sobre Postgres real: borra SOLO los datos de prueba
 * (ZZVAL-, IDs numéricos de prueba de 13–14 dígitos y sesiones [VALIDACIÓN]) y NUNCA toca a un miembro o sesión reales.
 */
import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nonce, TestDb } from "./helpers";

const SQL = fs.readFileSync(path.resolve(import.meta.dirname, "../supabase/cleanup.sql"), "utf8");

describe("tests/supabase/cleanup.sql", () => {
  let db: TestDb;
  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const count = async (sql: string, params: unknown[] = []) => Number((await db.query<{ n: string }>(sql, params)).rows[0].n);

  it("limpia miembros, sesiones, check-ins, correcciones, dispositivos, intentos y auditoría de prueba; conserva lo real", async () => {
    // --- datos REALES (no deben tocarse): un miembro de 7 dígitos, otro con un ID largo que NO es de prueba, una sesión real cerrada.
    const real = await db.member({ asce_id: "1234567", name: "Real Person" });
    const realLong = await db.member({ asce_id: "20261234567890", name: "Real Long" }); // 14 dígitos pero no empieza por seis ceros
    const realSession = await db.activeSession("Concrete Canoe Practice");
    await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [realSession, real, nonce("real")]);
    await db.closeSession(realSession);
    await db.query("insert into public.member_devices (member_id, token_hash, expires_at) values ($1, $2, now() + interval '30 days')", [real, "a".repeat(64)]);
    await db.query("insert into public.checkin_attempts (outcome, asce_id_tried) values ('bad_credentials', '1234567')");

    // --- datos de PRUEBA (deben desaparecer)
    const zz = await db.member({ asce_id: "ZZVAL-ABC123", name: "Z" });
    const numeric = [await db.member({ asce_id: "00000001234567", name: "N1" }), await db.member({ asce_id: "0000001234567", name: "N2" }), await db.member({ asce_id: "0000002123456", name: "N3" })];
    const testSession = await db.activeSession("[VALIDACIÓN] sesión de prueba");
    for (const m of [zz, ...numeric]) await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [testSession, m, nonce(`t${m}`)]);
    await db.closeSession(testSession);
    await db.query("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'absent')", [testSession, zz]);
    for (const [i, m] of [zz, ...numeric].entries()) await db.query("insert into public.member_devices (member_id, token_hash, expires_at) values ($1, $2, now() + interval '30 days')", [m, String(i).repeat(64)]);
    await db.query("insert into public.checkin_attempts (outcome, asce_id_tried) values ('bad_credentials', 'ZZVAL-NOPE'), ('bad_credentials', '9999999999')");
    const doomed = await db.activeSession("[VALIDACIÓN] borrada por Delete Session");
    await db.closeSession(doomed);
    await db.query("delete from public.sessions where id = $1", [doomed]); // deja audit_log 'session.delete' con el título de prueba

    expect(await count("select count(*) as n from public.audit_log where action = 'session.delete'")).toBe(1);

    await db.query(SQL);

    // Lo de prueba se fue…
    expect(await count("select count(*) as n from public.members where asce_id like 'ZZVAL-%' or asce_id ~ '^000000[0-2][0-9]{6,7}$'")).toBe(0);
    expect(await count("select count(*) as n from public.sessions where title like '[VALIDACIÓN]%'")).toBe(0);
    expect(await count("select count(*) as n from public.checkins where session_id = $1", [testSession])).toBe(0);
    expect(await count("select count(*) as n from public.attendance_overrides")).toBe(0);
    expect(await count("select count(*) as n from public.member_devices where member_id = any($1)", [[zz, ...numeric]])).toBe(0);
    expect(await count("select count(*) as n from public.checkin_attempts where asce_id_tried in ('ZZVAL-NOPE', '9999999999')")).toBe(0);
    expect(await count("select count(*) as n from public.audit_log where action = 'session.delete'")).toBe(0);
    // …y lo real sigue intacto.
    expect(await count("select count(*) as n from public.members where id = any($1)", [[real, realLong]])).toBe(2);
    expect(await count("select count(*) as n from public.sessions where id = $1", [realSession])).toBe(1);
    expect(await count("select count(*) as n from public.checkins where session_id = $1", [realSession])).toBe(1);
    expect(await count("select count(*) as n from public.member_devices where member_id = $1", [real])).toBe(1);
    expect(await count("select count(*) as n from public.checkin_attempts where asce_id_tried = '1234567'")).toBe(1);
    // Los triggers vuelven a estar activos tras la transacción (audit_log sigue siendo de solo inserción).
    await db.query("insert into public.audit_log (action, entity_type) values ('x', 'x')");
    await expect(db.query("delete from public.audit_log")).rejects.toThrow(/asce:audit_log_is_append_only/);
  });

  it("se puede ejecutar dos veces seguidas (idempotente) y sobre una base vacía", async () => {
    await db.query(SQL);
    await db.query(SQL);
  });

  it("el criterio de miembros de prueba no puede coincidir con un ASCE ID real (siete dígitos o menos)", () => {
    const test = /^000000[0-2][0-9]{6,7}$/;
    for (const realId of ["1234567", "0000000", "0000001", "001234", "20261234", "000000012345"]) expect(test.test(realId), realId).toBe(false);
    for (const testId of ["00000001234567", "0000000123456", "0000001234567", "0000002123456"]) expect(test.test(testId), testId).toBe(true);
    expect(SQL).toContain("^000000[0-2][0-9]{6,7}$");
  });
});
