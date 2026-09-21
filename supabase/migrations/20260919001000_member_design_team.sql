-- ASCE UTEP · Miembros: casilla "Design Team" (`members.is_design_team`).
--
-- `false` por defecto: TODOS los miembros existentes quedan con false (pertenecen al grupo general, "Remar and Construction").
-- Solo dice a qué grupo pertenece el miembro; no cambia quién puede hacer check-in ni ningún permiso.
--
-- Permisos: `authenticated` (administradores) tiene concesiones POR COLUMNA en members, así que la columna nueva hay que
-- concederla explícitamente (lectura, alta y edición), igual que `position` en la migración 5. service_role ya lee toda la tabla.
-- RLS, triggers y demás restricciones no cambian.

alter table public.members
  add column is_design_team boolean not null default false;

grant select (is_design_team) on public.members to authenticated;
grant insert (is_design_team) on public.members to authenticated;
grant update (is_design_team) on public.members to authenticated;
