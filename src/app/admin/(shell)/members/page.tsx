import { Search, UserPlus, Users } from "lucide-react";
import type { Metadata } from "next";
import { MemberList } from "@/components/admin/MemberList";
import { Alert, Card, EmptyState, PageHeader } from "@/components/ui/Display";
import { ButtonLink, Button } from "@/components/ui/Button";
import { SelectField, TextField } from "@/components/ui/Fields";
import { requireAdmin } from "@/lib/auth/session";
import { listMembers, MEMBER_LIST_LIMIT } from "@/lib/data/members";

export const metadata: Metadata = { title: "Members" };

const STATUS_VALUES = ["all", "active", "inactive"] as const;
type StatusFilter = (typeof STATUS_VALUES)[number];

/** Filtro de búsqueda en el servidor sobre la lista ya cargada (sin construir filtros de PostgREST con texto del usuario). */
function normalize(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

export default async function MembersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { supabase } = await requireAdmin();
  const params = await searchParams;

  const q = (typeof params.q === "string" ? params.q : "").slice(0, 80).trim();
  const statusParam = typeof params.status === "string" ? params.status : "all";
  const status: StatusFilter = (STATUS_VALUES as readonly string[]).includes(statusParam) ? (statusParam as StatusFilter) : "all";

  const result = await listMembers(supabase);
  const all = result.ok ? result.data : [];
  const needle = normalize(q);
  const members = all.filter((m) => {
    if (status === "active" && !m.active) return false;
    if (status === "inactive" && m.active) return false;
    if (!needle) return true;
    return normalize(m.name).includes(needle) || normalize(m.asce_id).includes(needle) || normalize(m.email ?? "").includes(needle);
  });

  return (
    <>
      <PageHeader
        title="Members"
        actions={
          <ButtonLink href="/admin/members/new">
            <UserPlus aria-hidden="true" className="h-5 w-5" />
            Add member
          </ButtonLink>
        }
      />

      {!result.ok ? <Alert variant="danger">{result.error.message}</Alert> : null}

      <Card>
        <form method="get" role="search" aria-label="Filter members" className="grid gap-4 border-b border-line p-4 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
          <TextField label="Search" name="q" defaultValue={q} placeholder="Name, ASCE ID or email" type="search" autoComplete="off" maxLength={80} />
          <SelectField label="Status" name="status" defaultValue={status}>
            <option value="all">All members</option>
            <option value="active">Active</option>
            <option value="inactive">Inactive</option>
          </SelectField>
          <Button type="submit" variant="secondary">
            <Search aria-hidden="true" className="h-5 w-5" />
            Apply
          </Button>
        </form>

        {members.length === 0 ? (
          all.length === 0 ? (
            <EmptyState
              icon={<Users className="h-7 w-7" />}
              title="No members yet"
              description="Add your first member to get the team started."
              action={<ButtonLink href="/admin/members/new">Add member</ButtonLink>}
            />
          ) : (
            <EmptyState
              icon={<Search className="h-7 w-7" />}
              title="No members match"
              description="Try a different search or status filter."
              action={<ButtonLink href="/admin/members" variant="secondary">Clear filters</ButtonLink>}
            />
          )
        ) : (
          <>
            <p role="status" className="border-b border-line px-5 py-3 text-sm text-muted">
              Showing {members.length} of {all.length} {all.length === 1 ? "member" : "members"}
              {all.length >= MEMBER_LIST_LIMIT ? ` (the list is limited to ${MEMBER_LIST_LIMIT})` : ""}
            </p>
            <MemberList members={members} />
          </>
        )}
      </Card>
    </>
  );
}
