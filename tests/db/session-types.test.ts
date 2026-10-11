import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nonce, TestDb } from "./helpers";

describe("New session attendance rules", () => {
  let db: TestDb;
  let admin: string;
  let design: string[];
  let general: string[];
  beforeEach(async () => {
    db = await TestDb.create();
    admin = await db.adminUser();
    design = await db.members(10);
    general = await db.members(5);
    await db.query("update public.members set is_design_team = true where id = any($1::uuid[])", [design]);
  });
  afterEach(async () => { await db.destroy(); });
  const asAdmin = () => ({ role: "authenticated", sub: admin }) as const;
  async function meeting(audience: "design_team" | "remar_construction" | "optional", present: string[]) {
    const result = await db.as(asAdmin(), (q) => q<{ id: string; attendance_rule_version: number }>(
      "insert into public.sessions (title, scheduled_at, audience, status) values ('Meeting', now(), $1, 'active') returning id, attendance_rule_version", [audience],
    ));
    expect(result.rows[0].attendance_rule_version).toBe(2);
    const id = result.rows[0].id;
    for (const member of present) await db.as({ role: "service_role" }, (q) => q(
      "insert into public.checkins (session_id, member_id, token_slot, ticket_nonce) values ($1, $2, 1, $3)", [id, member, nonce()],
    ));
    await db.as(asAdmin(), (q) => q("update public.sessions set status = 'closed' where id = $1", [id]));
    return id;
  }
  const summary = async (id: string) => (await db.as(asAdmin(), (q) => q(
    "select present_count, expected_count, rate, extra_count from public.session_attendance_summary where session_id = $1", [id],
  ))).rows[0];
  it("5 design and 5 guests out of 10 design members gives 50% and 5 extras", async () => {
    const id = await meeting("design_team", [...design.slice(0, 5), ...general]);
    expect(await summary(id)).toEqual({ present_count: 5, expected_count: 10, rate: 50, extra_count: 5 });
    const extras = await db.as(asAdmin(), (q) => q("select member_id from public.session_attendance where session_id = $1 and not for_member and status = 'present'", [id]));
    expect(extras.rows.map((r) => r.member_id).sort()).toEqual([...general].sort());
    const rates = await db.as(asAdmin(), (q) => q("select member_id, counted_meetings, attended_meetings from public.member_attendance"));
    for (const row of rates.rows) {
      expect(row.counted_meetings).toBe(design.includes(row.member_id) ? 1 : 0);
      expect(row.attended_meetings).toBe(design.slice(0, 5).includes(row.member_id) ? 1 : 0);
    }
  });
  it("Rowing expects everyone, including design members", async () => {
    const id = await meeting("remar_construction", [design[0], general[0]]);
    expect(await summary(id)).toEqual({ present_count: 2, expected_count: 15, rate: 13, extra_count: 0 });
    const rows = (await db.as(asAdmin(), (q) => q("select counted_meetings from public.member_attendance"))).rows;
    expect(rows.every((r) => r.counted_meetings === 1)).toBe(true);
  });
  it("Optional records attendees and a full roster without changing any member percentage, including manual corrections", async () => {
    await meeting("remar_construction", [design[0]]);
    const before = (await db.query("select * from public.member_attendance order by member_id")).rows;
    const id = await meeting("optional", [design[0], general[0]]);
    expect(await summary(id)).toEqual({ present_count: 2, expected_count: 15, rate: 13, extra_count: 0 });
    expect((await db.query("select * from public.member_attendance order by member_id")).rows).toEqual(before);
    await db.as(asAdmin(), (q) => q("insert into public.attendance_overrides (session_id, member_id, status) values ($1, $2, 'present')", [id, design[1]]));
    expect((await summary(id)).present_count).toBe(3);
    expect((await db.query("select * from public.member_attendance order by member_id")).rows).toEqual(before);
    expect((await db.query("select member_id from public.session_attendance where session_id = $1 and is_expected", [id])).rowCount).toBe(15);
  });
  it("administrators cannot overwrite the rule version", async () => {
    const id = await meeting("optional", []);
    await expect(db.as(asAdmin(), (q) => q("update public.sessions set attendance_rule_version = 1 where id = $1", [id]))).rejects.toMatchObject({ code: "42501" });
  });
});
