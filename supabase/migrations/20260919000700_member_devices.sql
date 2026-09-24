-- ASCE UTEP · "Remember me on this device" (dispositivos recordados del estudiante).
--
-- MODELO DE SEGURIDAD. El dispositivo NO guarda credenciales: guarda un TOKEN ALEATORIO de 256 bits en una cookie HttpOnly
-- (nunca en localStorage). Aquí solo se guarda un HMAC-SHA256 de ese token (con una clave derivada de SERVER_SECRET que NO está
-- en la base de datos): un volcado de esta tabla no permite reconstruir ni usar ningún token. El token identifica AL MIEMBRO, no
-- sustituye al QR: el check-in sigue exigiendo ticket vigente, sesión activa, miembro activo y una asistencia por sesión.
--
-- Vida y revocación:
--   * `expires_at`: caducidad (la app la fija a 180 días desde el último uso, con tope de 365 días desde la creación).
--   * `revoked_at`: revocado ("Not you? Switch member"), reemplazado, o miembro DESACTIVADO (trigger de abajo).
--   * Un dispositivo revocado o caducado nunca vuelve a valer; el estudiante simplemente se identifica otra vez.
--
-- Acceso: SOLO service_role (la ruta del estudiante). Sin políticas para `authenticated` ni `anon`: los administradores tampoco
-- pueden leer esta tabla desde el navegador (no hay nada que necesiten ver, y así los hashes no salen de la base de datos).

create table public.member_devices (
  id           uuid primary key default gen_random_uuid(),
  member_id    uuid not null references public.members (id) on delete cascade,
  token_hash   text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz not null,
  revoked_at   timestamptz,

  constraint member_devices_token_hash_key unique (token_hash),
  constraint member_devices_token_hash_format check (token_hash ~ '^[0-9a-f]{64}$'),
  constraint member_devices_expiry_after_creation check (expires_at > created_at)
);

-- Dispositivos vigentes de un miembro (para limitar cuántos puede tener y para revocarlos).
create index member_devices_active_idx on public.member_devices (member_id, created_at desc) where revoked_at is null;
-- Purga de filas viejas.
create index member_devices_expires_idx on public.member_devices (expires_at);

alter table public.member_devices enable row level security;
-- Sin políticas: denegado para anon y authenticated. service_role la usa (con GRANT explícito, mínimo necesario).

grant select, insert, update, delete on public.member_devices to service_role;

-- Desactivar a un miembro revoca TODOS sus dispositivos recordados (con independencia del código de la app). Al reactivarlo no
-- reviven: tendrá que identificarse otra vez.
create function private.members_revoke_devices() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.member_devices
     set revoked_at = clock_timestamp()
   where member_id = new.id
     and revoked_at is null;
  return null;
end;
$$;

create trigger members_revoke_devices
  after update of active on public.members
  for each row when (old.active is true and new.active is false)
  execute function private.members_revoke_devices();

revoke all on function private.members_revoke_devices() from public, anon, authenticated;
