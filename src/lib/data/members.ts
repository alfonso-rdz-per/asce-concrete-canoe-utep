import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { maxDateOnly, todayInElPaso } from "@/lib/dates";
import { describeDbError, NOT_FOUND_MEMBER, type UserFacingError } from "@/lib/errors";
import type { MemberInput } from "@/lib/validation/member";

/**
 * Acceso a datos de miembros (solo servidor). Todo va con el cliente de la SESIÓN del administrador:
 * RLS aplica de verdad. Las columnas se listan SIEMPRE explícitamente (sin `select *`).
 */
export const MEMBER_COLUMNS = "id, asce_id, name, email, position, is_design_team, active, joined_on, deactivated_on, created_at, updated_at";

/** Tope defensivo de la lista (un equipo de concrete canoe son decenas de personas). */
export const MEMBER_LIST_LIMIT = 500;

export interface Member {
  id: string;
  asce_id: string;
  name: string;
  email: string | null;
  position: string;
  /** Casilla "Design Team" (false por defecto; los miembros anteriores a la casilla quedaron en false). */
  is_design_team: boolean;
  active: boolean;
  joined_on: string;
  deactivated_on: string | null;
  created_at: string;
  updated_at: string;
}

export type Result<T> = { ok: true; data: T } | { ok: false; error: UserFacingError };

const fail = (error: UserFacingError): { ok: false; error: UserFacingError } => ({ ok: false, error });

export async function listMembers(sb: SupabaseClient): Promise<Result<Member[]>> {
  const { data, error } = await sb.from("members").select(MEMBER_COLUMNS).order("name", { ascending: true }).limit(MEMBER_LIST_LIMIT);
  if (error) return fail(describeDbError(error));
  return { ok: true, data: (data ?? []) as unknown as Member[] };
}

export async function getMember(sb: SupabaseClient, id: string): Promise<Result<Member>> {
  const { data, error } = await sb.from("members").select(MEMBER_COLUMNS).eq("id", id).maybeSingle();
  if (error) return fail(describeDbError(error));
  if (!data) return fail({ message: NOT_FOUND_MEMBER });
  return { ok: true, data: data as unknown as Member };
}

/** Alta de un miembro (solo datos de identidad: el check-in usa ASCE ID + Name). */
export async function createMember(sb: SupabaseClient, input: MemberInput): Promise<Result<{ member: Member }>> {
  const row: Record<string, unknown> = { asce_id: input.asceId, name: input.name, email: input.email, position: input.position, is_design_team: input.isDesignTeam };
  if (input.joinedOn) row.joined_on = input.joinedOn;

  const { data, error } = await sb.from("members").insert(row).select(MEMBER_COLUMNS).single();
  if (error) return fail(describeDbError(error));
  return { ok: true, data: { member: data as unknown as Member } };
}

export async function updateMember(sb: SupabaseClient, id: string, input: MemberInput): Promise<Result<Member>> {
  const changes: Record<string, unknown> = { asce_id: input.asceId, name: input.name, email: input.email, position: input.position, is_design_team: input.isDesignTeam };
  if (input.joinedOn) changes.joined_on = input.joinedOn;

  const { data, error } = await sb.from("members").update(changes).eq("id", id).select(MEMBER_COLUMNS);
  if (error) return fail(describeDbError(error));
  if (!data || data.length === 0) return fail({ message: NOT_FOUND_MEMBER });
  return { ok: true, data: data[0] as unknown as Member };
}

/**
 * Desactivar / reactivar. `joined_on` NO se toca nunca aquí (es la fecha desde la que el miembro
 * pertenece al equipo; solo el administrador la corrige a mano en el formulario de edición).
 */
export async function setMemberActive(sb: SupabaseClient, id: string, active: boolean): Promise<Result<Member>> {
  let changes: Record<string, unknown>;
  if (active) {
    changes = { active: true, deactivated_on: null };
  } else {
    const current = await getMember(sb, id);
    if (!current.ok) return current;
    // La BD exige deactivated_on >= joined_on: si la fecha de ingreso está en el futuro, se usa esa.
    changes = { active: false, deactivated_on: maxDateOnly(todayInElPaso(), current.data.joined_on) };
  }
  const { data, error } = await sb.from("members").update(changes).eq("id", id).select(MEMBER_COLUMNS);
  if (error) return fail(describeDbError(error));
  if (!data || data.length === 0) return fail({ message: NOT_FOUND_MEMBER });
  return { ok: true, data: data[0] as unknown as Member };
}
