-- ASCE UTEP · Fase 3 · Cargo (position) de cada miembro.
--
-- Los cargos predefinidos los define la aplicación (Member, Project Manager, …, Other). Cuando el
-- administrador elige "Other" se guarda el TEXTO PERSONALIZADO, así que la base de datos no puede
-- restringir a una lista cerrada: solo garantiza un texto razonable (1–60 caracteres, sin
-- caracteres de control ni de formato invisibles: ancho cero y reordenación bidireccional, que
-- permitirían un cargo que "se lee" distinto de lo que es). Los miembros existentes quedan como 'Member'.
--
-- Permisos: `authenticated` solo tiene concesiones POR COLUMNA (pin_hash es ilegible), así que la
-- columna nueva hay que concederla explícitamente. `service_role` ya tiene SELECT de la tabla.
-- Las políticas RLS no cambian (son por fila, no por columna).

alter table public.members
  add column position text not null default 'Member';

alter table public.members
  add constraint members_position_valid check (
    char_length(btrim(position)) between 1 and 60
    and position !~ '[[:cntrl:]]'
    and position !~ '[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]'
  );

grant select (position) on public.members to authenticated;
grant insert (position) on public.members to authenticated;
grant update (position) on public.members to authenticated;
