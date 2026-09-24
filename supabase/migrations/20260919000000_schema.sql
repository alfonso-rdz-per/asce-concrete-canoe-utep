-- ASCE UTEP · Asistencia · Esquema inicial (tablas, restricciones, triggers de integridad).
-- Los permisos y las políticas RLS están en la migración siguiente (…_security.sql).
--
-- Principios:
--  * La base de datos es la última línea de defensa: las invariantes críticas
--    (una asistencia por miembro y sesión, sin check-ins fuera de una sesión
--    activa, sesiones cerradas que no se reabren, auditoría inmutable) se
--    imponen aquí, además de en la aplicación.
--  * Los mensajes de error de los triggers empiezan por "asce:<código>" para
--    que la aplicación y las pruebas puedan distinguirlos.

create schema if not exists private;

-- ---------------------------------------------------------------------------
-- Tipos
-- ---------------------------------------------------------------------------
create type public.session_status as enum ('draft', 'active', 'closed');

create type public.attempt_outcome as enum (
  'success',
  'bad_credentials',
  'member_inactive',
  'ticket_invalid',
  'ticket_expired',
  'session_not_active',
  'already_checked_in',
  'rate_limited'
);

-- ---------------------------------------------------------------------------
-- admins: usuarios de Supabase Auth con rol de administrador
-- ---------------------------------------------------------------------------
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- members
-- ---------------------------------------------------------------------------
create table public.members (
  id             uuid primary key default gen_random_uuid(),
  asce_id        text not null,
  name           text not null,
  email          text,
  pin_hash       text not null,
  active         boolean not null default true,
  -- Fecha (hora de El Paso) desde la que el miembro está obligado a asistir.
  joined_on      date not null default ((now() at time zone 'America/Denver')::date),
  deactivated_on date,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  constraint members_asce_id_key unique (asce_id),
  -- La aplicación normaliza (recorta y pasa a mayúsculas) antes de guardar.
  constraint members_asce_id_format check (asce_id ~ '^[A-Z0-9-]{3,32}$'),
  constraint members_name_length check (char_length(btrim(name)) between 1 and 120),
  constraint members_email_format check (
    email is null
    or (char_length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+$')
  ),
  -- Impide guardar un PIN en claro por error: solo el formato de hash de la app.
  constraint members_pin_hash_format check (pin_hash like 'scrypt$v1$%'),
  constraint members_active_matches_deactivation check (active = (deactivated_on is null)),
  constraint members_deactivated_after_joined check (
    deactivated_on is null or deactivated_on >= joined_on
  )
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------
create table public.sessions (
  id           uuid primary key default gen_random_uuid(),
  title        text not null,
  description  text,
  scheduled_at timestamptz not null,
  status       public.session_status not null default 'draft',
  -- false = evento opcional: no cuenta para el porcentaje de asistencia.
  required     boolean not null default true,
  opened_at    timestamptz,
  closed_at    timestamptz,
  opened_by    uuid references auth.users (id) on delete set null,
  created_by   uuid default auth.uid() references auth.users (id) on delete set null,
  created_at   timestamptz not null default now(),

  constraint sessions_title_length check (char_length(btrim(title)) between 1 and 160),
  constraint sessions_description_length check (
    description is null or char_length(description) <= 2000
  ),
  constraint sessions_status_timestamps check (
    (status = 'draft'  and opened_at is null and closed_at is null)
    or (status = 'active' and opened_at is not null and closed_at is null)
    or (status = 'closed' and opened_at is not null and closed_at is not null
        and closed_at >= opened_at)
  )
);

-- Una sola sesión activa a la vez.
create unique index sessions_single_active on public.sessions ((true)) where status = 'active';
create index sessions_scheduled_at_idx on public.sessions (scheduled_at desc);

-- ---------------------------------------------------------------------------
-- checkins
-- ---------------------------------------------------------------------------
create table public.checkins (
  id            uuid primary key default gen_random_uuid(),
  session_id    uuid not null references public.sessions (id) on delete restrict,
  member_id     uuid not null references public.members (id) on delete restrict,
  checked_in_at timestamptz not null default now(),
  -- Slot del token QR y nonce del ticket usados: solo para auditoría.
  token_slot    bigint not null,
  ticket_nonce  text not null,
  -- HMAC de la IP (nunca la IP en claro).
  ip_hash       text,

  -- Una asistencia por miembro y sesión.
  constraint checkins_one_per_member_per_session unique (session_id, member_id),
  -- Un ticket produce como máximo un check-in.
  constraint checkins_ticket_single_use unique (session_id, ticket_nonce),
  constraint checkins_token_slot_nonneg check (token_slot >= 0),
  constraint checkins_nonce_format check (ticket_nonce ~ '^[A-Za-z0-9_-]{22}$'),
  constraint checkins_ip_hash_format check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$')
);

create index checkins_member_idx on public.checkins (member_id);

-- ---------------------------------------------------------------------------
-- checkin_attempts: auditoría de intentos y base del rate limiting (en Postgres)
-- ---------------------------------------------------------------------------
create table public.checkin_attempts (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  outcome       public.attempt_outcome not null,
  session_id    uuid references public.sessions (id) on delete set null,
  -- Texto controlado por quien intenta: la aplicación lo normaliza y trunca.
  asce_id_tried text,
  ticket_nonce  text,
  ip_hash       text,

  constraint checkin_attempts_asce_id_length check (
    asce_id_tried is null or char_length(asce_id_tried) <= 64
  ),
  constraint checkin_attempts_nonce_format check (
    ticket_nonce is null or ticket_nonce ~ '^[A-Za-z0-9_-]{22}$'
  ),
  constraint checkin_attempts_ip_hash_format check (ip_hash is null or ip_hash ~ '^[0-9a-f]{64}$')
);

-- Los límites cuentan fallos de credenciales (incluye "miembro inactivo", que
-- hacia fuera es indistinguible de un PIN incorrecto).
create index checkin_attempts_asce_id_idx
  on public.checkin_attempts (asce_id_tried, at desc)
  where outcome in ('bad_credentials', 'member_inactive');
create index checkin_attempts_ip_idx
  on public.checkin_attempts (ip_hash, at desc)
  where outcome in ('bad_credentials', 'member_inactive');
create index checkin_attempts_ticket_idx
  on public.checkin_attempts (ticket_nonce, at desc)
  where outcome in ('bad_credentials', 'member_inactive');
create index checkin_attempts_at_idx on public.checkin_attempts (at);

-- ---------------------------------------------------------------------------
-- audit_log: solo inserción
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  -- Sin FK a propósito: la auditoría debe sobrevivir a la baja de un usuario.
  actor_id    uuid,
  action      text not null,
  entity_type text not null,
  entity_id   text,
  detail      jsonb not null default '{}'::jsonb,

  constraint audit_log_action_length check (char_length(action) between 1 and 64),
  constraint audit_log_entity_type_length check (char_length(entity_type) between 1 and 64)
);

create index audit_log_at_idx on public.audit_log (at desc);

-- ---------------------------------------------------------------------------
-- Funciones de trigger (esquema privado: no expuesto por la API de Supabase)
-- ---------------------------------------------------------------------------
create function private.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger members_set_updated_at
  before update on public.members
  for each row execute function private.set_updated_at();

-- Ciclo de vida de sesiones: draft -> active -> closed, y closed es definitivo.
-- Las marcas de tiempo las pone la base de datos (nunca el cliente).
create function private.sessions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
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
    new.opened_by := old.opened_by;
  elsif new.status = 'active' then
    new.opened_at := clock_timestamp();
    new.closed_at := null;
    new.opened_by := auth.uid();
  else -- closed
    new.opened_at := old.opened_at;
    new.closed_at := clock_timestamp();
    new.opened_by := old.opened_by;
  end if;
  return new;
end;
$$;

create trigger sessions_guard
  before insert or update on public.sessions
  for each row execute function private.sessions_guard();

-- Un check-in solo entra si la sesión está activa y el miembro también.
-- `for share` serializa contra el cierre de la sesión (UPDATE de su fila): o el
-- check-in entra antes del cierre, o ve la sesión cerrada y se rechaza. Además,
-- la hora la fija la base de datos, tras tomar el candado.
create function private.checkins_guard_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_status public.session_status;
  v_active boolean;
begin
  select s.status into v_status from public.sessions s where s.id = new.session_id for share;
  if v_status is distinct from 'active' then
    raise exception 'asce:session_not_active';
  end if;

  select m.active into v_active from public.members m where m.id = new.member_id for share;
  if v_active is distinct from true then
    raise exception 'asce:member_not_active';
  end if;

  new.checked_in_at := clock_timestamp();
  return new;
end;
$$;

create trigger checkins_guard_insert
  before insert on public.checkins
  for each row execute function private.checkins_guard_insert();

-- Los check-ins no se editan: solo se crean o (un administrador) se eliminan.
create function private.checkins_block_update() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'asce:checkins_are_immutable';
end;
$$;

create trigger checkins_block_update
  before update on public.checkins
  for each row execute function private.checkins_block_update();

-- Eliminar un check-in SIEMPRE deja rastro, con independencia del código de la app.
create function private.checkins_audit_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.audit_log (actor_id, action, entity_type, entity_id, detail)
  values (
    auth.uid(),
    'checkin.delete',
    'checkin',
    old.id::text,
    jsonb_build_object(
      'session_id', old.session_id,
      'member_id', old.member_id,
      'checked_in_at', old.checked_in_at,
      'token_slot', old.token_slot
    )
  );
  return old;
end;
$$;

create trigger checkins_audit_delete
  after delete on public.checkins
  for each row execute function private.checkins_audit_delete();

-- audit_log es de solo inserción (también frente a service_role).
create function private.audit_log_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'asce:audit_log_is_append_only';
end;
$$;

create trigger audit_log_no_update_delete
  before update or delete on public.audit_log
  for each row execute function private.audit_log_append_only();

create trigger audit_log_no_truncate
  before truncate on public.audit_log
  for each statement execute function private.audit_log_append_only();
