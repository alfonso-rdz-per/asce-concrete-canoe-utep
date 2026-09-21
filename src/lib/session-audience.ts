/**
 * A QUÉ GRUPO(S) va dirigida una sesión (el "Required" de New Session; ya no es un booleano). Hay dos equipos y una sesión puede ir
 * dirigida a uno o a los dos:
 *   design_team        -> "Design Team":            miembros con `is_design_team = true`.
 *   remar_construction -> "Rowing & Construction":  el grupo general (miembros con `is_design_team = false`).
 *   both               -> "Both teams":             todos los miembros, de los dos grupos.
 * Los valores son los del enum `public.session_audience` de la base de datos (el identificador `remar_construction` se conserva tal cual
 * para no renombrar el enum); las etiquetas son las que ve el usuario (en inglés).
 */
export const TEAM_GROUPS = ["design_team", "remar_construction"] as const;
export type TeamGroup = (typeof TEAM_GROUPS)[number];

export const SESSION_AUDIENCES = [...TEAM_GROUPS, "both"] as const;
export type SessionAudience = (typeof SESSION_AUDIENCES)[number];

/** Grupo general: es la casilla que llega marcada al abrir New Session. */
export const DEFAULT_AUDIENCE: SessionAudience = "remar_construction";

export const AUDIENCE_LABEL: Record<SessionAudience, string> = {
  design_team: "Design Team",
  remar_construction: "Rowing & Construction",
  both: "Both teams",
};

export function isSessionAudience(value: unknown): value is SessionAudience {
  return typeof value === "string" && (SESSION_AUDIENCES as readonly string[]).includes(value);
}

export function isTeamGroup(value: unknown): value is TeamGroup {
  return typeof value === "string" && (TEAM_GROUPS as readonly string[]).includes(value);
}

/** Casillas marcadas -> audiencia guardada. Una sola casilla = ese grupo; las dos = "both"; ninguna = null (no válido). */
export function audienceFromGroups(groups: ReadonlySet<TeamGroup>): SessionAudience | null {
  if (groups.has("design_team") && groups.has("remar_construction")) return "both";
  if (groups.has("design_team")) return "design_team";
  if (groups.has("remar_construction")) return "remar_construction";
  return null;
}

/** Audiencia guardada -> casillas marcadas (la operación inversa, para volver a pintar el formulario). */
export function groupsFromAudience(audience: SessionAudience): TeamGroup[] {
  return audience === "both" ? [...TEAM_GROUPS] : [audience];
}

/** ¿La sesión va dirigida al grupo de este miembro? (Design Team <-> is_design_team; "both" = todos). Misma regla que la vista `session_attendance`. */
export function isForMember(audience: SessionAudience, isDesignTeam: boolean): boolean {
  return audience === "both" || (audience === "design_team") === isDesignTeam;
}
