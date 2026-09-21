-- ASCE UTEP · Fase 4 · Ubicación (texto) de las sesiones + conteo de asistencia por sesión.
--
-- `location` es SOLO TEXTO informativo ("Construction Workshop"): no hay GPS, mapas, coordenadas
-- ni ninguna verificación de lugar. Nulo o 1–120 caracteres, sin caracteres de control ni de formato
-- invisibles (ancho cero, reordenación bidireccional: un texto que "se lee" distinto de lo que es).
--
-- Permisos: `authenticated` tiene concesiones POR COLUMNA en sessions (insert/update), así que la
-- columna nueva hay que concederla explícitamente. SELECT ya es de tabla completa (también
-- `service_role`, que la usa la ruta de canje del QR). Las políticas RLS no cambian.
--
-- La regla de una sola sesión activa (`sessions_single_active`) y todo el ciclo draft -> active ->
-- closed siguen imponiéndose en la base de datos (migración 1); esta migración no los toca.

alter table public.sessions
  add column location text;

alter table public.sessions
  add constraint sessions_location_valid check (
    location is null
    or (
      char_length(btrim(location)) between 1 and 120
      and location !~ '[[:cntrl:]]'
      and location !~ '[\x200b-\x200f\x202a-\x202e\x2060-\x2064\x2066-\x2069\xfeff]'
    )
  );

grant insert (location) on public.sessions to authenticated;
grant update (location) on public.sessions to authenticated;

-- Asistentes por sesión (estado EFECTIVO: check-in y correcciones manuales). security_invoker: aplica la RLS
-- del administrador que consulta; anon y service_role no tienen acceso. Un borrador no tiene filas (cuenta 0).
create view public.session_attendance_summary with (security_invoker = true) as
select
  sa.session_id,
  (count(*) filter (where sa.status = 'present'))::int as present_count
from public.session_attendance sa
group by sa.session_id;

grant select on public.session_attendance_summary to authenticated;