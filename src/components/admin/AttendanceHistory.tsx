"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/Display";
import { ConfirmDialog } from "@/components/ui/Dialogs";
import { IDLE, type ActionState } from "@/lib/action-state";
import { otherStatus, statusLabel, type AttendanceSource, type AttendanceStatus } from "@/lib/attendance";
import { AUDIENCE_LABEL, type SessionAudience } from "@/lib/session-audience";

export interface AttendanceHistoryItem {
  sessionId: string;
  title: string;
  /** Fecha ya formateada en el servidor (zona horaria del equipo): evita diferencias entre servidor y navegador. */
  dateLabel: string;
  sessionStatus: "active" | "closed";
  /** A qué grupo iba dirigida la reunión. */
  audience: SessionAudience;
  /** ¿Iba dirigida al grupo de este miembro? Si no, no cuenta para su porcentaje. */
  forMember: boolean;
  status: AttendanceStatus;
  source: AttendanceSource;
}

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * Historial de asistencia de un miembro con corrección manual (Present <-> Absent). La corrección NO borra
 * nada: queda registrada aparte y en el registro de auditoría. Solo se edita en reuniones cerradas.
 */
export function AttendanceHistory({
  memberId,
  memberName,
  rows,
  action,
}: {
  memberId: string;
  memberName: string;
  rows: AttendanceHistoryItem[];
  action: Action;
}) {
  if (rows.length === 0) {
    return <p className="text-muted">No meetings yet. Attendance will appear here once meetings are held.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <caption className="sr-only">Attendance history for {memberName}</caption>
        <thead className="border-b border-line text-sm text-muted">
          <tr>
            <th scope="col" className="py-3 pr-4 font-semibold">Meeting</th>
            <th scope="col" className="hidden px-4 py-3 font-semibold sm:table-cell">Date</th>
            <th scope="col" className="px-4 py-3 font-semibold">Status</th>
            <th scope="col" className="py-3 pl-4 text-right font-semibold">
              <span className="sr-only">Change</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((row) => (
            <AttendanceRow key={row.sessionId} memberId={memberId} memberName={memberName} row={row} action={action} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AttendanceRow({ memberId, memberName, row, action }: { memberId: string; memberName: string; row: AttendanceHistoryItem; action: Action }) {
  const [state, formAction] = useActionState(action, IDLE);
  const next = otherStatus(row.status);
  const editable = row.sessionStatus === "closed";

  return (
    <tr>
      <th scope="row" className="py-3 pr-4 align-top font-semibold text-ink">
        <span className="block">{row.title}</span>
        <span className="block text-sm font-normal text-muted sm:hidden">{row.dateLabel}</span>
        {row.forMember ? null : <span className="block text-sm font-normal text-muted">{AUDIENCE_LABEL[row.audience]} · not counted in the percentage</span>}
      </th>
      <td className="hidden px-4 py-3 align-top text-muted sm:table-cell">{row.dateLabel}</td>
      <td className="px-4 py-3 align-top">
        <Badge tone={row.status === "present" ? "active" : "inactive"}>{statusLabel(row.status)}</Badge>
        {row.source === "manual" ? <span className="mt-1 block text-xs text-muted">Set manually</span> : null}
      </td>
      <td className="py-3 pl-4 text-right align-top">
        {editable ? (
          <ConfirmDialog
            triggerLabel={`Mark ${statusLabel(next).toLowerCase()}`}
            triggerAriaLabel={`Mark ${memberName} ${statusLabel(next).toLowerCase()} for ${row.title}`}
            triggerSize="sm"
            title={`Mark ${memberName} as ${statusLabel(next)}?`}
            description={`This changes their attendance for “${row.title}”. The change is recorded in the audit log, and any original check-in is kept.`}
            confirmLabel={`Mark ${statusLabel(next)}`}
            pendingLabel="Saving…"
            action={formAction}
            hidden={{ id: memberId, sessionId: row.sessionId, status: next }}
            state={state}
          />
        ) : (
          <span className="text-sm text-muted">In progress</span>
        )}
        {state.status === "error" ? (
          <p role="alert" className="mt-1 text-sm font-medium text-danger">
            {state.message}
          </p>
        ) : null}
        {state.status === "success" && state.message ? (
          <p role="status" className="mt-1 text-sm text-muted">
            {state.message}
          </p>
        ) : null}
      </td>
    </tr>
  );
}
