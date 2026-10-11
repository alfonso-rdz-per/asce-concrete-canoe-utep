/** Session types use stable database identifiers; "both" is historical only. */
export const TEAM_GROUPS = ["design_team", "remar_construction"] as const;
export type TeamGroup = (typeof TEAM_GROUPS)[number];

export const SELECTABLE_AUDIENCES = ["remar_construction", "design_team", "optional"] as const;
export const SESSION_AUDIENCES = [...SELECTABLE_AUDIENCES, "both"] as const;
export type SessionAudience = (typeof SESSION_AUDIENCES)[number];

/** Rowing is selected when opening New Session. */
export const DEFAULT_AUDIENCE: (typeof SELECTABLE_AUDIENCES)[number] = "remar_construction";

export const AUDIENCE_LABEL: Record<SessionAudience, string> = {
  design_team: "Design Team",
  remar_construction: "Rowing & Construction",
  optional: "Optional",
  both: "Rowing & Construction",
};

export function isSelectableAudience(value: unknown): value is (typeof SELECTABLE_AUDIENCES)[number] {
  return typeof value === "string" && (SELECTABLE_AUDIENCES as readonly string[]).includes(value);
}

/** Version 1 preserves the population used by historical meetings. */
export function isForMember(audience: SessionAudience, isDesignTeam: boolean, ruleVersion: number = 2): boolean {
  if (audience === "optional" || audience === "both") return true;
  if (ruleVersion === 1) return (audience === "design_team") === isDesignTeam;
  return audience !== "design_team" || isDesignTeam;
}
