-- ASCE UTEP · Una sesión puede ir dirigida a LOS DOS equipos a la vez · PASO 2 de 2.
--
-- Requiere que la migración anterior (…001300_session_audience_both, que añade el valor 'both' al enum) ya se haya ejecutado y confirmado.
--
-- Esta migración modifica SOLO la vista public.session_attendance. No toca tablas, triggers, políticas ni las otras vistas
-- (member_attendance y session_attendance_summary se calculan sobre `counts_toward_rate` de esta vista, así que heredan la regla nueva sin
-- cambios). No crea ninguna función. Los datos existentes no cambian: ninguna sesión tiene todavía la audiencia 'both'.
--
-- REGLA NUEVA (lo único que cambia respecto a la migración …001100):
--   * for_member: la sesión va dirigida al miembro si su audiencia es 'both' (todos los miembros), o si coincide con su grupo
--     (design_team <-> is_design_team). Antes solo existía la segunda condición.
--   * counts_toward_rate: usa esa misma condición. El resto (sesión CERRADA, pertenencia vigente en la fecha de la reunión o asistencia real
--     que nunca se descarta) no cambia. Sigue valiendo attended <= counted, así que el porcentaje nunca supera el 100 %.
--
-- Mismas columnas, mismo orden y mismos tipos que antes, por eso basta CREATE OR REPLACE (se conservan los permisos). security_invoker = true:
-- se aplica la RLS de quien consulta (solo administradores).

create or replace view public.session_attendance with (security_invoker = true) as
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
    and (s.audience = 'both' or ((s.audience = 'design_team') = m.is_design_team))
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
  (s.audience = 'both' or ((s.audience = 'design_team') = m.is_design_team)) as for_member
from public.sessions s
cross join public.members m
left join public.checkins c
       on c.session_id = s.id and c.member_id = m.id
left join public.attendance_overrides o
       on o.session_id = s.id and o.member_id = m.id
where s.status <> 'draft';

grant select on public.session_attendance to authenticated;
