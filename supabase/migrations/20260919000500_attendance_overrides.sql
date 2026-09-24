-- ASCE UTEP · Fase 3 · Corrección manual de asistencia + porcentaje de asistencia.
--
-- PROBLEMA. "Presente" = existe una fila en `checkins`, y esa tabla es inmutable por diseño (trigger
-- `checkins_are_immutable`), solo la inserta service_role con el slot del QR y el nonce del ticket
-- (NOT NULL), y la única forma de "quitar" una asistencia sería BORRAR la fila. Fabricar una fila de
-- check-in falsa (con slot/nonce inventados) o borrar la real son atajos frágiles: se pierde el rastro
-- de lo que el estudiante hizo de verdad.
--
-- SOLUCIÓN. Una tabla aparte, `attendance_overrides`: UNA fila por (sesión, miembro) que registra la
-- decisión manual de un administrador ('present' | 'absent'). El estado EFECTIVO es:
--     override si existe  ->  si no, 'present' cuando hay check-in  ->  si no, 'absent'.
-- `checkins`, su inmutabilidad y todo el flujo del estudiante quedan intactos. Las filas de override
-- se ACTUALIZAN (Present <-> Absent) pero NUNCA se borran. Cada cambio deja una fila en `audit_log`
-- escrita por un trigger (no depende del código de la app).
--
-- Reglas que impone la base de datos:
--   * solo se corrige la asistencia de sesiones CERRADAS (una sesión cerrada es definitiva; así el
--     override nunca compite con un check-in del estudiante en curso);
--   * quién y cuándo lo pone la base de datos (nunca el cliente);
--   * la clave (sesión, miembro) no cambia; no se borra ni se trunca;
--   * un override que no cambia el estado efectivo se rechaza al crearlo (no genera auditoría vacía);
--     reescribir el mismo estado en una fila existente es un no-op idempotente y tampoco se audita.
--
-- No se crea ninguna función en public (la API no debe exponer funciones): la aplicación hace UPDATE y,
-- si aún no hay fila, INSERT sobre la tabla, con la misma RLS, permisos por columna y triggers.
--
-- El porcentaje se calcula en SQL (vistas) y no en la app: PostgREST corta las respuestas a 1000 filas
-- y sumar check-ins en JavaScript daría porcentajes silenciosamente incorrectos.

create type public.attendance_status as enum ('present', 'absent');

-- ---------------------------------------------------------------------------
-- Tabla
-- ---------------------------------------------------------------------------
create table public.attendance_overrides (
  session_id uuid not null references public.sessions (id) on delete restrict,
  member_id  uuid not null references public.members (id) on delete restrict,
  status     public.attendance_status not null,
  -- Administrador que hizo el último cambio. Sin auditoría aquí: la auditoría es audit_log.
  changed_by uuid references auth.users (id) on delete set null,
  changed_at timestamptz not null default now(),

  primary key (session_id, member_id)
);

create index attendance_overrides_member_idx on public.attendance_overrides (member_id);

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
create function private.attendance_overrides_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status  public.session_status;
  v_natural public.attendance_status;
begin
  if tg_op = 'INSERT' then
    -- `for share` serializa contra cambios de estado de la sesión.
    select s.status into v_status from public.sessions s where s.id = new.session_id for share;
    if v_status is distinct from 'closed' then
      raise exception 'asce:attendance_session_not_closed';
    end if;

    v_natural := case
      when exists (select 1 from public.checkins c where c.session_id = new.session_id and c.member_id = new.member_id)
      then 'present'::public.attendance_status
      else 'absent'::public.attendance_status
    end;
    if new.status = v_natural then
      raise exception 'asce:attendance_no_change';
    end if;

    new.changed_by := auth.uid();
    new.changed_at := clock_timestamp();
    return new;
  end if;

  -- UPDATE
  if new.session_id <> old.session_id or new.member_id <> old.member_id then
    raise exception 'asce:attendance_key_is_final';
  end if;

  if new.status is not distinct from old.status then
    -- Sin cambio de estado: solo se admite la acción ON DELETE SET NULL de changed_by (al borrar al
    -- administrador). Nada más se reescribe y no se audita.
    new.changed_at := old.changed_at;
    if new.changed_by is not null then
      new.changed_by := old.changed_by;
    end if;
  else
    new.changed_by := auth.uid();
    new.changed_at := clock_timestamp();
  end if;
  return new;
end;
$$;

create trigger attendance_overrides_guard
  before insert or update on public.attendance_overrides
  for each row execute function private.attendance_overrides_guard();

-- Cada cambio de estado deja rastro: quién (actor), qué miembro, qué sesión, estado anterior y nuevo, cuándo.
create function private.attendance_overrides_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_previous public.attendance_status;
begin
  if tg_op = 'INSERT' then
    v_previous := case
      when exists (select 1 from public.checkins c where c.session_id = new.session_id and c.member_id = new.member_id)
      then 'present'::public.attendance_status
      else 'absent'::public.attendance_status
    end;
  else
    v_previous := old.status;
  end if;

  insert into public.audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    auth.uid(),
    'attendance.manual_change',
    'attendance',
    new.session_id::text || ':' || new.member_id::text,
    jsonb_build_object(
      'session_id', new.session_id,
      'member_id', new.member_id,
      'previous_status', v_previous,
      'new_status', new.status,
      'changed_at', new.changed_at
    )
  );
  return null;
end;
$$;

create trigger attendance_overrides_audit_insert
  after insert on public.attendance_overrides
  for each row execute function private.attendance_overrides_audit();

create trigger attendance_overrides_audit_update
  after update on public.attendance_overrides
  for each row when (old.status is distinct from new.status)
  execute function private.attendance_overrides_audit();

-- Nunca se borra (ni siquiera con permisos de propietario): el historial de correcciones es permanente.
create function private.attendance_overrides_block_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'asce:attendance_overrides_are_permanent';
end;
$$;

create trigger attendance_overrides_no_delete
  before delete on public.attendance_overrides
  for each row execute function private.attendance_overrides_block_delete();

create trigger attendance_overrides_no_truncate
  before truncate on public.attendance_overrides
  for each statement execute function private.attendance_overrides_block_delete();

revoke all on function private.attendance_overrides_guard()         from public, anon, authenticated;
revoke all on function private.attendance_overrides_audit()         from public, anon, authenticated;
revoke all on function private.attendance_overrides_block_delete()  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Permisos y RLS (mismo modelo que el resto: solo administradores, mínimo necesario)
-- ---------------------------------------------------------------------------
-- Sin DELETE para nadie. changed_by / changed_at los fija el trigger: el cliente no puede escribirlos.
grant select on public.attendance_overrides to authenticated;
grant insert (session_id, member_id, status) on public.attendance_overrides to authenticated;
grant update (status) on public.attendance_overrides to authenticated;

alter table public.attendance_overrides enable row level security;

create policy attendance_overrides_admin_select on public.attendance_overrides
  for select to authenticated using ((select private.is_admin()));
create policy attendance_overrides_admin_insert on public.attendance_overrides
  for insert to authenticated with check ((select private.is_admin()));
create policy attendance_overrides_admin_update on public.attendance_overrides
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

-- ---------------------------------------------------------------------------
-- Vistas (security_invoker: aplican la RLS del administrador que consulta; anon no tiene acceso)
-- ---------------------------------------------------------------------------
-- Una fila por (sesión no borrador, miembro) con el estado efectivo.
--
-- Regla del porcentaje (`counts_toward_rate`), la misma de docs/PHASE-3-PROPOSAL.md §H:
--   * solo reuniones CERRADAS y OBLIGATORIAS (required);
--   * cuenta para el miembro si la reunión ocurrió mientras pertenecía al equipo
--     (joined_on <= fecha de la reunión <= deactivated_on, en hora de El Paso)
--     O si su estado efectivo es Present (una asistencia real nunca se descarta);
--   * la fecha de la reunión es cuando realmente se abrió (opened_at); scheduled_at solo como respaldo.
-- Como todo lo presente cuenta y el numerador es un subconjunto del denominador, NUNCA supera el 100 %.
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
    and s.required
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
  s.required                             as session_required
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

grant select on public.session_attendance to authenticated;
grant select on public.member_attendance to authenticated;
