import Link from "next/link";
import { Badge } from "@/components/ui/Display";
import type { Member } from "@/lib/data/members";
import { formatDateOnly } from "@/lib/dates";

/** Lista de miembros: tabla en pantallas anchas, tarjetas apiladas en móvil. */
export function MemberList({ members }: { members: Member[] }) {
  return (
    <>
      <div className="hidden overflow-x-auto md:block">
        <table className="w-full text-left">
          <caption className="sr-only">Team members</caption>
          <thead className="border-b border-line bg-surface text-sm text-muted">
            <tr>
              <th scope="col" className="px-5 py-3 font-semibold">Name</th>
              <th scope="col" className="px-5 py-3 font-semibold">ASCE ID</th>
              <th scope="col" className="px-5 py-3 font-semibold">Position</th>
              <th scope="col" className="px-5 py-3 font-semibold">Email</th>
              <th scope="col" className="px-5 py-3 font-semibold">Joined</th>
              <th scope="col" className="px-5 py-3 font-semibold">Status</th>
              <th scope="col" className="px-5 py-3 text-right font-semibold">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {members.map((m) => (
              <tr key={m.id}>
                <th scope="row" className="px-5 py-3 font-semibold text-ink">{m.name}</th>
                <td className="px-5 py-3 font-mono text-sm">{m.asce_id}</td>
                <td className="px-5 py-3 text-ink">{m.position}</td>
                <td className="px-5 py-3 text-muted">{m.email ?? "—"}</td>
                <td className="px-5 py-3 text-muted">{formatDateOnly(m.joined_on)}</td>
                <td className="px-5 py-3">
                  <Badge tone={m.active ? "active" : "inactive"}>{m.active ? "Active" : "Inactive"}</Badge>
                </td>
                <td className="px-5 py-3 text-right">
                  <Link
                    href={`/admin/members/${m.id}/edit`}
                    className="inline-flex min-h-11 items-center rounded-lg px-3 font-semibold text-blue underline-offset-4 hover:underline"
                  >
                    Edit<span className="sr-only"> {m.name}</span>
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ul className="divide-y divide-line md:hidden">
        {members.map((m) => (
          <li key={m.id} className="space-y-2 px-4 py-4">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-semibold text-ink">{m.name}</p>
                <p className="font-mono text-sm text-muted">{m.asce_id}</p>
                <p className="text-sm text-ink">{m.position}</p>
              </div>
              <Badge tone={m.active ? "active" : "inactive"}>{m.active ? "Active" : "Inactive"}</Badge>
            </div>
            <p className="truncate text-sm text-muted">{m.email ?? "No email"}</p>
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted">Joined {formatDateOnly(m.joined_on)}</p>
              <Link
                href={`/admin/members/${m.id}/edit`}
                className="inline-flex min-h-11 items-center rounded-lg px-3 font-semibold text-blue underline-offset-4 hover:underline"
              >
                Edit<span className="sr-only"> {m.name}</span>
              </Link>
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
