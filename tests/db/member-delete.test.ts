import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonce, TestDb } from "./helpers";

describe("Delete inactive members", () => {
  let db: TestDb;
  let admin: string;
  beforeEach(async () => { db = await TestDb.create(); admin = await db.adminUser(); });
  afterEach(async () => { await db.destroy(); });
  const actor = () => ({ role: "authenticated", sub: admin }) as const;
  it("rejects active profiles, including a profile reactivated before confirmation", async () => {
    const id = await db.member();
    await expect(db.as(actor(), (q) => q("delete from public.members where id = $1", [id]))).rejects.toThrow(/asce:member_must_be_inactive/);
    await db.query("update public.members set active = false, deactivated_on = current_date where id = $1", [id]);
    await db.query("update public.members set active = true, deactivated_on = null where id = $1", [id]);
    await expect(db.as(actor(), (q) => q("delete from public.members where id = $1", [id]))).rejects.toThrow(/asce:member_must_be_inactive/);
    expect((await db.query("select id from public.members where id = $1", [id])).rowCount).toBe(1);
  });
  it("deletes profile, check-ins, corrections and devices, retains audit and other members, and recalculates summaries", async () => {
    const id = await db.member();
    const other = await db.member();
    const session = await db.activeSession();
    await db.query("insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [session, id, nonce()]);
    await db.closeSession(session);
    await db.as(actor(), (q) => q("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'absent')", [session, id]));
    await db.as(actor(), (q) => q("update public.attendance_overrides set status = 'present' where session_id = $1 and member_id = $2", [session, id]));
    await db.query("insert into public.member_devices (member_id, token_hash, expires_at) values ($1, $2, now() + interval '1 day')", [id, randomBytes(32).toString("hex")]);
    await db.query("update public.members set active = false, deactivated_on = current_date where id = $1", [id]);
    expect((await db.query("select present_count, expected_count from public.session_attendance_summary where session_id = $1", [session])).rows[0]).toEqual({ present_count: 1, expected_count: 2 });
    await db.as(actor(), (q) => q("delete from public.members where id = $1", [id]));
    for (const table of ["checkins", "attendance_overrides", "member_devices"]) {
      expect((await db.query(`select member_id from public.${table} where member_id = $1`, [id])).rowCount).toBe(0);
    }
    expect((await db.query("select id from public.members where id = $1", [id])).rowCount).toBe(0);
    expect((await db.query("select id from public.members where id = $1", [other])).rowCount).toBe(1);
    expect((await db.query("select present_count, expected_count from public.session_attendance_summary where session_id = $1", [session])).rows[0]).toEqual({ present_count: 0, expected_count: 1 });
    const audit = (await db.query("select actor_id, detail from public.audit_log where action = 'member.delete' and entity_id = $1", [id])).rows[0];
    expect(audit).toEqual({ actor_id: admin, detail: { deleted_checkins: 1, deleted_corrections: 1, deleted_devices: 1 } });
    expect((await db.query("select id from public.audit_log where action = 'attendance.manual_change'")).rowCount).toBe(2);
  });
  it("denies anonymous, service role and unconfirmed users", async () => {
    const id = await db.member({ active: false });
    for (const role of ["anon", "service_role"] as const) await expect(db.as({ role }, (q) => q("delete from public.members where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
    const outsider = await db.authUser({ confirmed: false });
    expect((await db.as({ role: "authenticated", sub: outsider }, (q) => q("delete from public.members where id = $1", [id]))).rowCount).toBe(0);
    expect((await db.query("select id from public.members where id = $1", [id])).rowCount).toBe(1);
  });
  it("also deletes an inactive member with no attendance records", async () => {
    const id = await db.member({ active: false });
    expect((await db.as(actor(), (q) => q("delete from public.members where id = $1 returning id", [id]))).rows).toEqual([{ id }]);
  });
});
