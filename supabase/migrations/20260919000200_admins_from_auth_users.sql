-- ASCE UTEP · Fase 3 · Administradores = usuarios válidos de Supabase Auth.
--
-- CAMBIO DE MODELO (aprobado explícitamente): ya no existe la tabla `public.admins`.
-- Es administrador CUALQUIER usuario de Supabase Auth que cumpla, en el momento de cada petición:
--   * tiene correo y está confirmado (email_confirmed_at)
--   * no es anónimo (is_anonymous)
--   * no está borrado (deleted_at)
--   * no está baneado (banned_until vigente)
--
-- Seguridad:
--   * El único "candado" pasa a ser quién puede crear/confirmar usuarios en Auth. Por eso los
--     registros públicos y los inicios anónimos DEBEN seguir desactivados (la aplicación y las
--     pruebas lo vigilan).
--   * La función se evalúa contra la base de datos en cada petición: borrar o banear a un usuario
--     le retira el acceso de inmediato, aunque su JWT siga vigente.
--   * SECURITY DEFINER con search_path vacío; devuelve solo un booleano; sigue sin ser invocable
--     por `anon`. La aplicación nunca lee auth.users.
--   * `create or replace` conserva los permisos y TODAS las políticas RLS existentes.

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
      from auth.users u
     where u.id = (select auth.uid())
       and u.email is not null
       and u.email_confirmed_at is not null
       and not u.is_anonymous
       and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
  )
$$;

-- La tabla ya no interviene en ninguna política ni función (las políticas usan private.is_admin()).
drop table public.admins;
