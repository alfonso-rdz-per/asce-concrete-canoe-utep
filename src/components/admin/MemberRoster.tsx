import Link from "next/link";

export interface RosterRow {
  id: string;
  name: string;
  asceId: string;
  position: string;
  /** 0–100, o null si aún no tiene reuniones que cuenten. */
  percent: number | null;
}

/** Barra de progreso en SVG con atributos (no CSS): la CSP de producción no admite `style` en línea. */
function Bar({ percent }: { percent: number }) {
  return (
    <svg aria-hidden="true" focusable="false" width="96" height="8" viewBox="0 0 96 8" className="hidden shrink-0 sm:block">
      <rect width="96" height="8" rx="4" className="fill-mist" />
      {percent > 0 ? <rect width={Math.max(8, (percent / 100) * 96)} height="8" rx="4" className="fill-blue" /> : null}
    </svg>
  );
}

/**
 * Roster del dashboard: Member · ASCE ID · Position · Attendance. Una sola tabla responsive: en móvil el ASCE ID y
 * el cargo pasan bajo el nombre y las columnas se reducen a Member + Attendance.
 */
export function MemberRoster({ rows }: { rows: RosterRow[] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <caption className="sr-only">Member roster with attendance</caption>
        <thead className="border-b border-line bg-surface text-sm text-muted">
          <tr>
            <th scope="col" className="px-4 py-3 font-semibold sm:px-5">Member</th>
            <th scope="col" className="hidden px-5 py-3 font-semibold md:table-cell">ASCE ID</th>
            <th scope="col" className="hidden px-5 py-3 font-semibold md:table-cell">Position</th>
            <th scope="col" className="px-4 py-3 text-right font-semibold sm:px-5 md:text-left">Attendance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="min-w-0 px-4 py-3 font-semibold text-ink sm:px-5">
                <Link href={`/admin/members/${row.id}/edit`} className="inline-flex min-h-11 items-center underline-offset-4 hover:underline">
                  {row.name}
                </Link>
                <span className="mt-0.5 block text-sm font-normal text-muted md:hidden">
                  <span className="font-mono">{row.asceId}</span> · {row.position}
                </span>
              </th>
              <td className="hidden px-5 py-3 font-mono text-sm md:table-cell">{row.asceId}</td>
              <td className="hidden px-5 py-3 text-ink md:table-cell">{row.position}</td>
              <td className="px-4 py-3 sm:px-5">
                {row.percent === null ? (
                  <span className="block text-right text-muted md:text-left">
                    —<span className="sr-only">No meetings yet</span>
                  </span>
                ) : (
                  <span className="flex items-center justify-end gap-3 md:justify-start">
                    <Bar percent={row.percent} />
                    <span className="w-12 text-right font-semibold tabular-nums text-navy md:text-left">{row.percent}%</span>
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
