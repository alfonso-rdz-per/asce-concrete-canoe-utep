import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import type { ReactNode } from "react";

/** Componentes de presentación sencillos (tarjetas, avisos, insignias, estados vacíos, cabeceras). */

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-xl border border-line bg-white shadow-card ${className}`.trim()}>{children}</div>;
}

export function StatCard({ label, value, hint }: { label: string; value: number | string; hint?: string }) {
  return (
    <Card className="p-5">
      <p className="text-sm font-medium text-muted">{label}</p>
      <p className="mt-2 text-4xl font-bold tracking-tight text-navy">{value}</p>
      {hint ? <p className="mt-1 text-sm text-muted">{hint}</p> : null}
    </Card>
  );
}

const ALERT_STYLES = {
  info: { box: "border-line bg-mist text-navy", icon: Info, role: "status" as const },
  success: { box: "border-line bg-mist text-navy", icon: CheckCircle2, role: "status" as const },
  danger: { box: "border-danger/30 bg-danger-bg text-danger", icon: AlertTriangle, role: "alert" as const },
};

export function Alert({
  variant = "info",
  title,
  children,
  className = "",
}: {
  variant?: keyof typeof ALERT_STYLES;
  title?: string;
  children?: ReactNode;
  className?: string;
}) {
  const { box, icon: Icon, role } = ALERT_STYLES[variant];
  return (
    <div role={role} className={`flex gap-3 rounded-lg border p-4 text-sm ${box} ${className}`.trim()}>
      <Icon aria-hidden="true" className="mt-0.5 h-5 w-5 shrink-0" />
      <div className="space-y-1">
        {title ? <p className="font-semibold">{title}</p> : null}
        {children ? <div>{children}</div> : null}
      </div>
    </div>
  );
}

export function Badge({ tone, children }: { tone: "active" | "inactive" | "draft" | "live"; children: ReactNode }) {
  const STYLES = {
    active: "bg-mist text-navy ring-1 ring-inset ring-blue/30",
    inactive: "bg-white text-muted ring-1 ring-inset ring-line",
    // Borrador: aún no ha empezado (contorno navy, sin relleno).
    draft: "bg-white text-navy ring-1 ring-inset ring-navy/40",
    // En curso: el único estado con relleno de color.
    live: "bg-blue text-white",
  } as const;
  const styles = STYLES[tone];
  return <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${styles}`}>{children}</span>;
}

export function EmptyState({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 px-6 py-12 text-center">
      <div aria-hidden="true" className="flex h-14 w-14 items-center justify-center rounded-full bg-mist text-blue">
        {icon}
      </div>
      <h2 className="text-lg font-semibold text-navy">{title}</h2>
      <p className="max-w-sm text-muted">{description}</p>
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: string; actions?: ReactNode }) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-navy sm:text-3xl">{title}</h1>
        {description ? <p className="mt-1 text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </div>
  );
}

export function Avatar({ initials, tone = "onDark" }: { initials: string; tone?: "onDark" | "onLight" }) {
  const styles = tone === "onDark" ? "bg-sky text-navy-deep" : "bg-navy text-white";
  return (
    <span aria-hidden="true" className={`inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-bold ${styles}`}>
      {initials}
    </span>
  );
}
