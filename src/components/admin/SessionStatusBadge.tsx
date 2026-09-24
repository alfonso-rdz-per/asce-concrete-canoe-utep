import { Badge } from "@/components/ui/Display";
import type { SessionStatus } from "@/lib/data/sessions";

/** Draft · Active · Closed (los tres estados del esquema; no hay más). */
export function SessionStatusBadge({ status }: { status: SessionStatus }) {
  if (status === "active") return <Badge tone="live">Active</Badge>;
  if (status === "draft") return <Badge tone="draft">Draft</Badge>;
  return <Badge tone="inactive">Closed</Badge>;
}
