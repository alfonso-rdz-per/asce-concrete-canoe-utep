-- ASCE UTEP · Fase 3 · Corrección: se debe poder BORRAR a un administrador que ya abrió sesiones.
--
-- Problema (migración 1): private.sessions_guard() fijaba `new.opened_by := old.opened_by` en cada
-- UPDATE para que el cliente no pudiera falsear quién abrió la sesión. Pero eso también anulaba el
-- `ON DELETE SET NULL` de la clave foránea sessions.opened_by -> auth.users: al borrar al usuario,
-- Postgres intentaba poner opened_by = NULL, el trigger lo devolvía al valor anterior y la FK
-- rechazaba el borrado (HTTP 500 en Supabase Auth). Con el modelo "todo usuario de Auth es
-- administrador" borrar al usuario es la forma de revocarlo, así que debe funcionar SIEMPRE.
--
-- Solución: `opened_by` solo puede CONSERVARSE o PASAR A NULL (la acción de la FK). Nunca puede
-- cambiarse a otro usuario. (Además, `authenticated` no tiene permiso de UPDATE sobre esa columna.)
-- El resto de la función es idéntico a la migración 1.

create or replace function private.sessions_guard() returns trigger
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
    -- Conservar, o pasar a NULL (ON DELETE SET NULL); nunca cambiar a otro usuario.
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
