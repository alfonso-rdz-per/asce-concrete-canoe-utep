-- ASCE UTEP · Asistencia · Permisos y RLS.
--
-- Modelo de acceso:
--  * `anon`  (visitantes): sin acceso a NINGUNA tabla. Los estudiantes nunca
--    hablan con Supabase; solo llaman a nuestras rutas de servidor.
--  * `authenticated` (sesión de Supabase Auth): solo actúa si además está en
--    `admins` (RLS con private.is_admin()). Permisos por columna: ni siquiera un
--    administrador puede leer `pin_hash` desde el navegador.
--  * `service_role` (solo servidor, omite RLS): permisos mínimos para la ruta de
--    check-in. Los triggers de la migración anterior siguen aplicando.
--
-- Todo se concede de forma EXPLÍCITA. Primero se retira lo que Supabase concede
-- por defecto a las tablas nuevas de `public`, así el resultado no depende de la
-- configuración `auto_expose_new_tables` del proyecto.

-- ---------------------------------------------------------------------------
-- 1. Retirar concesiones por defecto (existentes y futuras)
-- ---------------------------------------------------------------------------
revoke all on all tables    in schema public from public, anon, authenticated, service_role;
revoke all on all sequences in schema public from public, anon, authenticated, service_role;
revoke all on all functions in schema public from public, anon, authenticated, service_role;

-- Objetos que se creen en `public` en migraciones futuras nacerán sin acceso.
alter default privileges in schema public revoke all on tables    from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on sequences from public, anon, authenticated, service_role;
alter default privileges in schema public revoke all on functions from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2. Esquema privado y comprobación de administrador
-- ---------------------------------------------------------------------------
revoke all on schema private from public, anon;
grant usage on schema private to authenticated, service_role;

-- SECURITY DEFINER para poder leer `admins` sin concederle nada a `authenticated`.
-- search_path vacío: nada se resuelve por accidente en otro esquema.
create function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.admins a where a.user_id = (select auth.uid()))
$$;

revoke all on function private.is_admin() from public, anon;
grant execute on function private.is_admin() to authenticated, service_role;

-- Las funciones de trigger no se invocan directamente.
revoke all on function private.set_updated_at()         from public, anon, authenticated;
revoke all on function private.sessions_guard()         from public, anon, authenticated;
revoke all on function private.checkins_guard_insert()  from public, anon, authenticated;
revoke all on function private.checkins_block_update()  from public, anon, authenticated;
revoke all on function private.checkins_audit_delete()  from public, anon, authenticated;
revoke all on function private.audit_log_append_only()  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Permisos de tabla (mínimo necesario)
-- ---------------------------------------------------------------------------
-- authenticated: lista explícita de columnas. `pin_hash` NO se puede leer.
-- Consecuencia: el cliente debe seleccionar columnas por nombre (`select *` falla).
grant select (id, asce_id, name, email, active, joined_on, deactivated_on, created_at, updated_at)
  on public.members to authenticated;
grant insert (asce_id, name, email, pin_hash, joined_on)
  on public.members to authenticated;
grant update (asce_id, name, email, pin_hash, active, joined_on, deactivated_on)
  on public.members to authenticated;
-- Sin DELETE: los miembros se desactivan, no se borran.

grant select on public.sessions to authenticated;
grant insert (title, description, scheduled_at, required) on public.sessions to authenticated;
grant update (title, description, scheduled_at, required, status) on public.sessions to authenticated;

-- Los check-ins los crea solo el servidor; un administrador puede consultarlos y
-- eliminarlos (el trigger de auditoría lo registra siempre).
grant select, delete on public.checkins to authenticated;

grant select on public.checkin_attempts to authenticated;
grant select on public.audit_log to authenticated;

-- `admins`: nadie desde el navegador. Se gestiona con SQL/panel de Supabase.

-- service_role: solo lo que necesita la ruta de check-in.
grant select on public.members to service_role;
grant select on public.sessions to service_role;
grant select, insert on public.checkins to service_role;
grant select, insert, delete on public.checkin_attempts to service_role;  -- delete: purga por antigüedad
grant select, insert on public.audit_log to service_role;
grant usage, select on sequence public.checkin_attempts_id_seq to service_role;
grant usage, select on sequence public.audit_log_id_seq to service_role;

-- ---------------------------------------------------------------------------
-- 4. Row Level Security en TODAS las tablas
-- ---------------------------------------------------------------------------
alter table public.admins           enable row level security;
alter table public.members          enable row level security;
alter table public.sessions         enable row level security;
alter table public.checkins         enable row level security;
alter table public.checkin_attempts enable row level security;
alter table public.audit_log        enable row level security;

-- `admins` no tiene políticas: denegado para todos salvo service_role/propietario.

create policy members_admin_select on public.members
  for select to authenticated using ((select private.is_admin()));
create policy members_admin_insert on public.members
  for insert to authenticated with check ((select private.is_admin()));
create policy members_admin_update on public.members
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy sessions_admin_select on public.sessions
  for select to authenticated using ((select private.is_admin()));
create policy sessions_admin_insert on public.sessions
  for insert to authenticated with check ((select private.is_admin()));
create policy sessions_admin_update on public.sessions
  for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));

create policy checkins_admin_select on public.checkins
  for select to authenticated using ((select private.is_admin()));
create policy checkins_admin_delete on public.checkins
  for delete to authenticated using ((select private.is_admin()));

create policy checkin_attempts_admin_select on public.checkin_attempts
  for select to authenticated using ((select private.is_admin()));

create policy audit_log_admin_select on public.audit_log
  for select to authenticated using ((select private.is_admin()));
