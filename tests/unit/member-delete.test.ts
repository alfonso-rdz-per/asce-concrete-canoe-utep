import { beforeEach, describe, expect, it, vi } from "vitest";
import { deleteInactiveMember } from "@/lib/data/members";
import { deleteMemberAction } from "@/app/admin/(shell)/members/actions";
import { requireAdmin } from "@/lib/auth/session";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";

vi.mock("@/lib/auth/session", () => ({ requireAdmin: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/navigation", () => ({ redirect: vi.fn(() => { throw new Error("redirected"); }) }));

const ID = "00000000-0000-4000-8000-000000000001";
function client(reply: { data: Array<{ id: string }> | null; error: { message: string } | null }) {
  const select = vi.fn(async () => reply);
  const eq = vi.fn(() => ({ select }));
  const remove = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ delete: remove }));
  return { sb: { from } as never, from, remove, eq, select };
}
beforeEach(() => { vi.clearAllMocks(); });
describe("Delete member action", () => {
  it("authenticates, deletes only the requested profile, invalidates admin screens and redirects", async () => {
    const fake = client({ data: [{ id: ID }], error: null });
    vi.mocked(requireAdmin).mockResolvedValue({ supabase: fake.sb } as never);
    const fd = new FormData(); fd.set("id", ID);
    await expect(deleteMemberAction({ status: "idle" }, fd)).rejects.toThrow("redirected");
    expect(requireAdmin).toHaveBeenCalledTimes(1);
    expect(fake.from).toHaveBeenCalledWith("members");
    expect(fake.eq).toHaveBeenCalledWith("id", ID);
    expect(fake.select).toHaveBeenCalledWith("id");
    expect(revalidatePath).toHaveBeenCalledWith("/admin", "layout");
    expect(redirect).toHaveBeenCalledWith("/admin/members");
  });
  it("rejects invalid IDs before any database mutation", async () => {
    const fake = client({ data: [], error: null });
    vi.mocked(requireAdmin).mockResolvedValue({ supabase: fake.sb } as never);
    const fd = new FormData(); fd.set("id", "invalid");
    expect(await deleteMemberAction({ status: "idle" }, fd)).toEqual({ status: "error", message: "That member no longer exists." });
    expect(fake.from).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
  it("does not mutate data if authorization fails", async () => {
    const fake = client({ data: [], error: null });
    vi.mocked(requireAdmin).mockRejectedValue(new Error("unauthorized"));
    await expect(deleteMemberAction({ status: "idle" }, new FormData())).rejects.toThrow("unauthorized");
    expect(fake.remove).not.toHaveBeenCalled();
  });
  it("shows an English error when a profile was reactivated, without redirecting", async () => {
    const fake = client({ data: null, error: { message: "asce:member_must_be_inactive" } });
    vi.mocked(requireAdmin).mockResolvedValue({ supabase: fake.sb } as never);
    const fd = new FormData(); fd.set("id", ID);
    expect(await deleteMemberAction({ status: "idle" }, fd)).toEqual({ status: "error", message: "Deactivate this member before deleting their profile." });
    expect(revalidatePath).not.toHaveBeenCalled();
    expect(redirect).not.toHaveBeenCalled();
  });
  it("reports a profile already removed by another administrator", async () => {
    const fake = client({ data: [], error: null });
    expect(await deleteInactiveMember(fake.sb, ID)).toEqual({ ok: false, error: { message: "That member no longer exists." } });
  });
});
