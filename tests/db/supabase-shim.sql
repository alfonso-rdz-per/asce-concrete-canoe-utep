-- Imita, sobre un Postgres normal, lo mínimo que Supabase ya trae de fábrica y que
-- nuestras migraciones dan por existente: el esquema `auth` y las concesiones por
-- defecto. Las pruebas de RLS (roles, claims JWT, permisos por columna) se
-- ejecutan contra el Postgres real, no contra un simulador.
--
-- Los ROLES (globales del clúster) los crea global-setup.ts.

create schema auth;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text unique,
  email_confirmed_at timestamptz,
  is_anonymous       boolean not null default false,
  deleted_at         timestamptz,
  banned_until       timestamptz,
  raw_user_meta_data jsonb not null default '{}'::jsonb,
  created_at         timestamptz not null default now()
);

-- Definiciones equivalentes a las de Supabase Auth.
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create function auth.role() returns text language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid(), auth.role() to anon, authenticated, service_role;

-- PEOR CASO: concesiones automáticas de Supabase sobre `public` (comportamiento
-- "auto_expose_new_tables = true"). Las migraciones deben neutralizarlas.
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
