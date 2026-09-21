/**
 * Dispositivos recordados ("Remember me", migración 8), sobre Postgres real: solo service_role, solo el HMAC del token, formato y
 * caducidad impuestos por la BD, y revocación automática al desactivar al miembro.
 */
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TestDb } from "./helpers";

const INSUFFICIENT_PRIVILEGE = "42501";
const hash = () => randomBytes(32).toString("hex");

describe("member_devices", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await TestDb.create();
  });
  afterAll(async () => {
    await db.destroy();
  });

  const svc = { role: "service_role" } as const;
  const insertDevice = (memberId: string, tokenHash = hash(), expiresInterval = "180 days") =>
    db.query<{ id: string }>(
      `insert into public.member_devices (member_id, token_hash, expires_at) values ($1, $2, now() + $3::interval) returning id`,
      [memberId, tokenHash, expiresInterval],
    );

  it("solo service_role la usa: anon y los administradores NO pueden leerla ni escribirla (ni ven hashes)", async () => {
    const member = await db.member();
    await insertDevice(member);
    const admin = await db.adminUser();
    await expect(db.as({ role: "anon" }, (q) => q("select * from public.member_devices"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(db.as({ role: "authenticated", sub: admin }, (q) => q("select * from public.member_devices"))).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    await expect(
      db.as({ role: "authenticated", sub: admin }, (q) => q("insert into public.member_devices (member_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')", [member, hash()])),
    ).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
    const own = await db.as(svc, (q) => q("select id, member_id, revoked_at from public.member_devices where member_id = $1", [member]));
    expect(own.rowCount).toBe(1);
  });

  it("guarda solo un HMAC de 64 hex: rechaza un token en claro (d1.…) y un hash repetido", async () => {
    const member = await db.member();
    await expect(insertDevice(member, "d1." + randomBytes(32).toString("base64url"))).rejects.toMatchObject({ constraint: "member_devices_token_hash_format" });
    await expect(insertDevice(member, "ABC")).rejects.toMatchObject({ constraint: "member_devices_token_hash_format" });
    const h = hash();
    await insertDevice(member, h);
    await expect(insertDevice(member, h)).rejects.toMatchObject({ constraint: "member_devices_token_hash_key" });
  });

  it("la caducidad debe ser posterior a la creación", async () => {
    const member = await db.member();
    await expect(insertDevice(member, hash(), "-1 hour")).rejects.toMatchObject({ constraint: "member_devices_expiry_after_creation" });
  });

  it("desactivar al miembro revoca TODOS sus dispositivos; reactivarlo no los revive", async () => {
    const member = await db.member();
    const other = await db.member();
    await insertDevice(member);
    await insertDevice(member);
    await insertDevice(other);

    await db.query("update public.members set active = false, deactivated_on = current_date where id = $1", [member]);
    const revoked = await db.query<{ n: string }>("select count(*) as n from public.member_devices where member_id = $1 and revoked_at is not null", [member]);
    expect(Number(revoked.rows[0].n)).toBe(2);
    const untouched = await db.query<{ n: string }>("select count(*) as n from public.member_devices where member_id = $1 and revoked_at is null", [other]);
    expect(Number(untouched.rows[0].n)).toBe(1);

    await db.query("update public.members set active = true, deactivated_on = null where id = $1", [member]);
    const stillRevoked = await db.query<{ n: string }>("select count(*) as n from public.member_devices where member_id = $1 and revoked_at is null", [member]);
    expect(Number(stillRevoked.rows[0].n)).toBe(0);
  });

  it("editar otros datos del miembro no revoca sus dispositivos", async () => {
    const member = await db.member();
    await insertDevice(member);
    await db.query("update public.members set name = 'Otro nombre' where id = $1", [member]);
    const r = await db.query<{ n: string }>("select count(*) as n from public.member_devices where member_id = $1 and revoked_at is null", [member]);
    expect(Number(r.rows[0].n)).toBe(1);
  });

  it("service_role puede revocar, renovar y purgar (update/delete), pero no hay política para nadie más", async () => {
    const member = await db.member();
    const { rows } = await insertDevice(member);
    await db.as(svc, (q) => q("update public.member_devices set revoked_at = now() where id = $1", [rows[0].id]));
    await db.as(svc, (q) => q("update public.member_devices set last_used_at = now(), expires_at = now() + interval '200 days' where id = $1", [rows[0].id]));
    const del = await db.as(svc, (q) => q("delete from public.member_devices where id = $1", [rows[0].id]));
    expect(del.rowCount).toBe(1);
  });
});
