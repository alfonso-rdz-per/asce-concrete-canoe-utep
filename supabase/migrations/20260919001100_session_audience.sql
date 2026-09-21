-- ASCE UTEP · "Required" de una sesión ya no es un booleano: es a QUÉ GRUPO va dirigida.
--
-- Opciones (y solo estas dos, en la interfaz "Required"):
--   design_team          -> "Design Team":            sesión dirigida a los miembros con members.is_design_team = true.
--   remar_construction   -> "Remar and Construction": sesión dirigida al grupo general (miembros con is_design_team = false).
--
-- CONVERSIÓN DE LOS DATOS EXISTENTES (explícita y documentada):
--   sessions.required = true   -> audience = 'remar_construction'  (hasta hoy TODOS los miembros eran el grupo general)
--   sessions.required = false  -> audience = 'remar_construction'  (no existe una opción "opcional"; una sesión opcional antigua
--                                                                  pasa a contar como cualquier reunión del grupo general)
-- Como todos los miembros existentes quedan con is_design_team = false (migración anterior), los porcentajes de las reuniones
-- obligatorias NO cambian. Verificado con una lectura de solo lectura antes de escribir esta migración: en la base real no hay
-- ninguna sesión con required = false, así que la segunda regla no altera ningún dato hoy.
--
-- Qué cambia en la base de datos:
--   * tipo enum public.session_audience y columna sessions.audience (NOT NULL, por defecto 'remar_construction');
--   * se ELIMINA sessions.required (no se deja el booleano viejo con otro significado);
--   * las vistas de asistencia se recrean (dependían de required): el porcentaje de un miembro cuenta las reuniones CERRADAS de SU
--     grupo (design_team para is_design_team = true; remar_construction para el resto); una reunión de otro grupo no cuenta;
--   * el rastro 'session.delete' guarda audience en lugar de required;
--   * permisos por columna para audience (alta y edición por administradores). RLS y triggers no cambian.
--
-- Requiere las migraciones anteriores (en especial la que crea members.is_design_team y la que crea sessions_audit_delete).

create type public.session_audience as enum ('design_team', 'remar_construction');

-- 1. Columna nueva con el valor de conversión (todas las filas existentes reciben 'remar_construction').
alter table public.sessions
  add column audience public.session_audience not null default 'remar_construction';

-- 2. Las vistas dependen de sessions.required: se eliminan (en orden de dependencia) para poder quitar la columna.
drop view public.session_attendance_summary;
drop view public.member_attendance;
drop view public.session_attendance;

alter table public.sessions drop column required;

-- 3. Permisos por columna (los de `required` desaparecieron con la columna).
grant insert (audience) on public.sessions to authenticated;
grant update (audience) on public.sessions to authenticated;

-- 4. El rastro de la eliminación de una sesión guarda su grupo.
create or replace function private.sessions_audit_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    auth.uid(),
    'session.delete',
    'session',
    old.id::text,
    jsonb_build_object(
      'title', old.title,
      'status', old.status,
      'audience', old.audience,
      'scheduled_at', old.scheduled_at,
      'opened_at', old.opened_at,
      'closed_at', old.closed_at,
      'opened_by', old.opened_by,
      'deleted_checkins', (select count(*) from public.checkins c where c.session_id = old.id),
      'deleted_corrections', (select count(*) from public.attendance_overrides o where o.session_id = old.id)
    )
  );
  return old;
end;
$$;

-- 5. Vistas de asistencia (security_invoker: aplican la RLS del administrador que consulta; anon no tiene acceso).
-- Una fila por (sesión no borrador, miembro) con el estado efectivo.
--
-- `for_member`: la sesión va dirigida al grupo del miembro (design_team <-> is_design_team).
-- Regla del porcentaje (`counts_toward_rate`), la misma de siempre salvo que "obligatoria" pasa a ser "de su grupo":
--   * solo reuniones CERRADAS dirigidas al grupo del miembro;
--   * cuenta si la reunión ocurrió mientras pertenecía al equipo (joined_on <= fecha <= deactivated_on, hora de El Paso)
--     O si su estado efectivo es Present (una asistencia real de su grupo nunca se descarta);
--   * la fecha de la reunión es cuando realmente se abrió (opened_at); scheduled_at solo como respaldo.
-- El numerador es un subconjunto del denominador, así que NUNCA supera el 100 %.
create view public.session_attendance with (security_invoker = true) as
select
  s.id                                   as session_id,
  m.id                                   as member_id,
  case
    when o.status is not null then o.status
    when c.id is not null     then 'present'::public.attendance_status
    else                           'absent'::public.attendance_status
  end                                    as status,
  case
    when o.status is not null then 'manual'
    when c.id is not null     then 'check_in'
    else                           'none'
  end                                    as source,
  (
    s.status = 'closed'
    and ((s.audience = 'design_team') = m.is_design_team)
    and (
      coalesce(o.status = 'present', c.id is not null)
      or (
        (coalesce(s.opened_at, s.scheduled_at) at time zone 'America/Denver')::date >= m.joined_on
        and (
          m.deactivated_on is null
          or (coalesce(s.opened_at, s.scheduled_at) at time zone 'America/Denver')::date <= m.deactivated_on
        )
      )
    )
  )                                      as counts_toward_rate,
  s.title                                as session_title,
  coalesce(s.opened_at, s.scheduled_at)  as session_held_at,
  s.status                               as session_status,
  s.audience                             as session_audience,
  ((s.audience = 'design_team') = m.is_design_team) as for_member
from public.sessions s
cross join public.members m
left join public.checkins c
       on c.session_id = s.id and c.member_id = m.id
left join public.attendance_overrides o
       on o.session_id = s.id and o.member_id = m.id
where s.status <> 'draft';

-- Una fila por miembro con los conteos del porcentaje (el % lo calcula la app: attended / counted).
create view public.member_attendance with (security_invoker = true) as
select
  m.id as member_id,
  (count(*) filter (where sa.counts_toward_rate))::int                                as counted_meetings,
  (count(*) filter (where sa.counts_toward_rate and sa.status = 'present'))::int      as attended_meetings
from public.members m
left join public.session_attendance sa on sa.member_id = m.id
group by m.id;

-- Asistentes por sesión (estado EFECTIVO: check-in y correcciones manuales). Un borrador no tiene filas (cuenta 0).
create view public.session_attendance_summary with (security_invoker = true) as
select
  sa.session_id,
  (count(*) filter (where sa.status = 'present'))::int as present_count
from public.session_attendance sa
group by sa.session_id;

grant select on public.session_attendance to authenticated;
grant select on public.member_attendance to authenticated;
grant select on public.session_attendance_summary to authenticated;
