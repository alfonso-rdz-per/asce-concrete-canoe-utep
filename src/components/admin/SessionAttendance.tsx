"use client";

import { useActionState } from "react";
import { Badge } from "@/components/ui/Display";
import { ConfirmDialog } from "@/components/ui/Dialogs";
import { IDLE, type ActionState } from "@/lib/action-state";
import { formatRate, otherStatus, statusLabel, type MeetingSummary, type RosterRow } from "@/lib/attendance";

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

/**
 * Asistencia de UNA reunión CERRADA: presentes / esperados / porcentaje y el roster de los miembros esperados con Present / Absent.
 * Los números y la lista vienen de la base de datos (no se calculan aquí): tras una corrección, la acción revalida la página y todo se actualiza.
 * Solo se pintan los miembros esperados, así que desde la interfaz no se puede elegir a alguien de otro grupo ni fuera de la población de la reunión.
 * La corrección no borra nada: queda en `attendance_overrides`, se conserva el check-in original y se audita en `audit_log`.
 */
export function SessionAttendance({
  sessionId,
  sessionTitle,
  summary,
  roster,
  action,
}: {
  sessionId: string;
  sessionTitle: string;
  summary: MeetingSummary;
  roster: RosterRow[];
  action: Action;
}) {
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <h2 className="text-lg font-bold text-navy">Attendance</h2>
        <p className="tabular-nums text-muted" data-testid="attendance-summary">
          <span className="text-2xl font-bold text-navy">{summary.present}</span> / {summary.expected} present
          <span aria-hidden="true"> · </span>
          <span className="font-bold text-navy">
            <span className="sr-only">Attendance rate </span>
            {formatRate(summary.rate)}
          </span>
        </p>
      </div>

      {roster.length === 0 ? (
        <p className="text-muted">No members were expected at this meeting.</p>
      ) : (
        <>
          <p className="mb-2 text-sm text-muted">
            Correct anyone who was marked wrongly. Nothing is deleted: every change is recorded in the audit log, and the original check-in is kept.
          </p>
          <ul className="divide-y divide-line">
            {roster.map((row) => (
              <RosterItem key={row.memberId} sessionId={sessionId} sessionTitle={sessionTitle} row={row} action={action} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function RosterItem({ sessionId, sessionTitle, row, action }: { sessionId: string; sessionTitle: string; row: RosterRow; action: Action }) {
  const [state, formAction] = useActionState(action, IDLE);
  const next = otherStatus(row.status);

  return (
    <li className="py-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1 basis-48">
          <p className="break-words font-semibold text-ink">{row.name}</p>
          <p className="break-words text-sm text-muted">
            {row.asceId} · {row.position}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <div>
            <Badge tone={row.status === "present" ? "active" : "inactive"}>{statusLabel(row.status)}</Badge>
            {row.source === "manual" ? <span className="block text-xs text-muted">Set manually</span> : null}
          </div>
          <ConfirmDialog
            triggerLabel={`Mark ${statusLabel(next).toLowerCase()}`}
            triggerAriaLabel={`Mark ${row.name} ${statusLabel(next).toLowerCase()} for ${sessionTitle}`}
            triggerSize="sm"
            title={`Mark ${row.name} as ${statusLabel(next)}?`}
            description={`This changes their attendance for “${sessionTitle}”. The change is recorded in the audit log, and any original check-in is kept.`}
            confirmLabel={`Mark ${statusLabel(next)}`}
            pendingLabel="Saving…"
            action={formAction}
            hidden={{ id: row.memberId, sessionId, status: next }}
            state={state}
          />
        </div>
      </div>
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
    </li>
  );
}
