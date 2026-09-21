-- ASCE UTEP · Eliminar sesiones + crear una sesión YA ACTIVA (sin borrador intermedio).
--
-- 1) CREAR ACTIVA EN UN SOLO PASO. Hasta ahora toda sesión nacía como borrador y luego se activaba (dos sentencias: si la segunda
--    fallaba quedaba un borrador de más). Ahora `sessions_guard` también admite un INSERT con status 'active': la base de datos fija
--    `opened_at` (reloj del servidor) y `opened_by` (auth.uid()), y el índice único `sessions_single_active` decide atómicamente si
--    ya había otra activa. Los borradores ANTIGUOS siguen siendo válidos (el estado `draft` sigue existiendo); solo la interfaz
--    dejó de crearlos. Sigue prohibido insertar una sesión ya cerrada.
--
-- 2) ELIMINAR UNA SESIÓN (solo administradores, con RLS). Qué pasa con lo relacionado:
--      checkins             -> se ELIMINAN con la sesión (ON DELETE CASCADE). Cada fila borrada sigue dejando su rastro
--                              `checkin.delete` en audit_log (trigger existente), con el administrador como actor.
--      attendance_overrides -> se ELIMINAN con la sesión (ON DELETE CASCADE). Su trigger que impedía cualquier DELETE ahora solo
--                              permite el borrado cuando la sesión padre YA no existe (es decir, en cascada); un DELETE directo
--                              sobre un override sigue rechazado. Cada cambio manual ya quedó en audit_log en su momento.
--      checkin_attempts     -> se CONSERVAN con session_id = NULL (ON DELETE SET NULL, ya existía): son auditoría y base del
--                              límite de intentos; borrarlos permitiría reiniciar los límites.
--      audit_log            -> NUNCA se toca (append-only). Además, borrar una sesión escribe `session.delete` con una
--                              instantánea (título, estado, fechas, cuántos check-ins y correcciones se llevó, quién la abrió).
--    Resultado: ninguna fila queda huérfana y la auditoría sobrevive. Una sesión ACTIVA también puede borrarse: desde ese instante
--    el servidor ya no la encuentra, así que rechaza su QR, sus tickets y cualquier check-in.

-- ---- 1. Crear directamente activa ------------------------------------------------------------------------------------
create or replace function private.sessions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'active' then
      new.opened_at := clock_timestamp();
      new.closed_at := null;
      new.opened_by := auth.uid();
      return new;
    end if;
    if new.status <> 'draft' then
      raise exception 'asce:session_must_start_as_draft';
    end if;
    new.opened_at := null;
    new.closed_at := null;
    new.opened_by := null;
    return new;
  end if;

  if old.status = 'closed' and new.status <> 'closed' then
    raise exception 'asce:session_closed_is_final';
  end if;
  if old.status = 'draft' and new.status not in ('draft', 'active') then
    raise exception 'asce:session_invalid_transition';
  end if;
  if old.status = 'active' and new.status not in ('active', 'closed') then
    raise exception 'asce:session_invalid_transition';
  end if;

  if new.status = old.status then
    new.opened_at := old.opened_at;
    new.closed_at := old.closed_at;
    -- Conservar, o pasar a NULL (ON DELETE SET NULL de la FK); nunca cambiar a otro usuario.
    if new.opened_by is not null then
      new.opened_by := old.opened_by;
    end if;
  elsif new.status = 'active' then
    new.opened_at := clock_timestamp();
    new.closed_at := null;
    new.opened_by := auth.uid();
  else -- closed
    new.opened_at := old.opened_at;
    new.closed_at := clock_timestamp();
    if new.opened_by is not null then
      new.opened_by := old.opened_by;
    end if;
  end if;
  return new;
end;
$$;

-- El cliente puede pedir 'draft' (histórico) o 'active'; el trigger rechaza cualquier otro valor.
grant insert (status) on public.sessions to authenticated;

-- ---- 2. Eliminar sesiones --------------------------------------------------------------------------------------------
alter table public.checkins
  drop constraint checkins_session_id_fkey,
  add constraint checkins_session_id_fkey foreign key (session_id) references public.sessions (id) on delete cascade;

alter table public.attendance_overrides
  drop constraint attendance_overrides_session_id_fkey,
  add constraint attendance_overrides_session_id_fkey foreign key (session_id) references public.sessions (id) on delete cascade;

-- Los overrides siguen siendo permanentes SALVO cuando desaparece su sesión: en el borrado en cascada la sesión padre ya no existe.
create or replace function private.attendance_overrides_block_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- TRUNCATE (disparador de sentencia): no hay fila `old`; siempre prohibido.
  if tg_level = 'STATEMENT' then
    raise exception 'asce:attendance_overrides_are_permanent';
  end if;
  if exists (select 1 from public.sessions s where s.id = old.session_id) then
    raise exception 'asce:attendance_overrides_are_permanent';
  end if;
  return old;
end;
$$;

-- Rastro de la eliminación, ANTES de borrar (con la sesión aún presente para contar lo que se va con ella).
create function private.sessions_audit_delete() returns trigger
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
      'required', old.required,
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

create trigger sessions_audit_delete
  before delete on public.sessions
  for each row execute function private.sessions_audit_delete();

revoke all on function private.sessions_audit_delete() from public, anon, authenticated;
revoke all on function private.attendance_overrides_block_delete() from public, anon, authenticated;

-- Solo administradores (mismo modelo que el resto de tablas). El permiso es de TABLA: no hay columnas que proteger al borrar.
grant delete on public.sessions to authenticated;

create policy sessions_admin_delete on public.sessions
  for delete to authenticated using ((select private.is_admin()));
