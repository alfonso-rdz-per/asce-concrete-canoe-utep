-- Limpia los datos de negocio creados por la suite de validación real.
-- Todo se identifica por prefijo: ZZVAL- (miembros creados directamente por las pruebas), IDs NUMÉRICOS de prueba (miembros creados por la
-- interfaz en los tests de navegador: seis ceros + un dígito 0-2 + 6 o 7 dígitos, es decir 13–14 dígitos; un ASCE ID real no puede coincidir
-- porque tiene menos dígitos), [VALIDACIÓN] (sesiones) y zzval.% (auditoría).
--
-- Se ejecuta como `postgres` y desactiva los triggers de usuario SOLO dentro de esta
-- transacción (`session_replication_role = replica`), porque audit_log es de solo inserción
-- y los check-ins son inmutables. Nada de esto está al alcance de anon, authenticated ni service_role.
begin;
set local session_replication_role = replica;

-- Miembros de prueba (un solo criterio para todo el archivo).
create temporary table _test_members on commit drop as
  select id, asce_id from public.members
   where asce_id like 'ZZVAL-%'
      or asce_id ~ '^000000[0-2][0-9]{6,7}$';

delete from public.audit_log
 where action like 'zzval.%'
    or (action = 'session.delete' and detail->>'title' like '[VALIDACIÓN]%')
    or detail->>'session_id' in (select id::text from public.sessions where title like '[VALIDACIÓN]%')
    or detail->>'member_id'  in (select id::text from _test_members);

delete from public.checkin_attempts
 where asce_id_tried like 'ZZVAL-%'                                   -- (incluye IDs inexistentes que probaron los intentos)
    or asce_id_tried = '9999999999'                              -- ID inexistente de los tests de navegador
    or asce_id_tried in (select asce_id from _test_members)
    or session_id in (select id from public.sessions where title like '[VALIDACIÓN]%');

delete from public.checkins
 where session_id in (select id from public.sessions where title like '[VALIDACIÓN]%')
    or member_id  in (select id from _test_members);

-- Correcciones manuales de asistencia (nunca se borran por API: el trigger lo impide; aquí sí, con los triggers desactivados).
-- Solo si la tabla existe: este archivo también debe poder ejecutarse ANTES de aplicar esa migración.
do $$
begin
  if to_regclass('public.attendance_overrides') is not null then
    delete from public.attendance_overrides
     where session_id in (select id from public.sessions where title like '[VALIDACIÓN]%')
        or member_id  in (select id from _test_members);
  end if;
end
$$;

-- Dispositivos recordados ("Remember me") de los miembros de prueba. Con los triggers y las claves foráneas desactivados no se borrarían
-- solos al eliminar al miembro. Solo si la tabla existe (migración 8).
do $$
begin
  if to_regclass('public.member_devices') is not null then
    delete from public.member_devices where member_id in (select id from _test_members);
  end if;
end
$$;

delete from public.sessions where title like '[VALIDACIÓN]%';
delete from public.members  where id in (select id from _test_members);

commit;
