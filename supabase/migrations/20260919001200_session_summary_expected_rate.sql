-- ASCE UTEP · Fase 5 (Attendance / Historial) · session_attendance_summary: presentes, esperados y porcentaje por sesión.
--
-- Esta migración modifica SOLO la vista public.session_attendance_summary. No toca session_attendance ni member_attendance, ni tablas, ni
-- triggers, ni políticas. No crea ninguna función (ni en public ni en ningún otro esquema).
--
-- POBLACIÓN. La de siempre: la que ya alimenta el porcentaje individual. session_attendance.counts_toward_rate es la única fuente de verdad
-- (sesión CERRADA + dirigida al grupo del miembro + pertenencia vigente en la fecha de la reunión, o asistencia real que nunca se descarta).
-- Aquí no se repite esa lógica: solo se cuenta sobre esa marca. Por eso la suma de expected_count de todas las sesiones es igual a la suma de
-- member_attendance.counted_meetings, y la suma de present_count, a la de attended_meetings.
--
-- COLUMNAS (en este orden; las dos primeras conservan nombre, tipo y posición, y por eso basta CREATE OR REPLACE):
--   session_id      uuid
--   present_count   integer  Presentes DENTRO de esa población: filas con counts_toward_rate y estado efectivo 'present'.
--                            CAMBIO INTENCIONAL DE SEMÁNTICA: antes contaba a todos los presentes de la sesión (también de otro grupo, o fuera
--                            de su pertenencia al equipo). Ahora nunca puede superar a expected_count.
--   expected_count  integer  Filas con counts_toward_rate.
--   rate            integer  0-100, o NULL si expected_count = 0 (nunca hay división por cero).
--
-- REDONDEO. La aplicación calcula Math.round(attended / counted * 100) (src/lib/attendance.ts). Para que SQL y JavaScript den SIEMPRE el
-- mismo entero se usa la misma aritmética (float8 IEEE) y la misma regla de redondeo (mitades hacia arriba): floor(a / c * 100 + 0.5).
-- NO se usa round(a * 100.0 / c): con numeric exacto difiere de Math.round (por ejemplo 23 de 40 = 57,5: JavaScript da 57 porque
-- 23/40*100 vale 57,49999999999999 en coma flotante y numeric da 58; también 29/200, 57/200...). Con float8 coinciden en las 501 500 parejas
-- (presentes, esperados) con esperados de 1 a 1000 comprobadas. Como presentes <= esperados, el resultado va de 0 a 100.
--
-- SESIONES NO CERRADAS. Una sesión ACTIVA aparece con expected_count = 0, present_count = 0 y rate = NULL (aún no cuenta para ningún porcentaje;
-- la asistencia en vivo se lee de checkins). Un BORRADOR sigue sin tener fila, como antes.
--
-- SEGURIDAD. security_invoker = true (se aplica la RLS de quien consulta: solo administradores), SELECT solo para authenticated. CREATE OR
-- REPLACE conserva los grants existentes; se repite el GRANT para dejarlo explícito. anon y service_role no tienen ningún permiso.

create or replace view public.session_attendance_summary with (security_invoker = true) as
select
  t.session_id,
  t.present_count,
  t.expected_count,
  case
    when t.expected_count = 0 then null
    else floor((t.present_count::float8 / t.expected_count::float8) * 100 + 0.5)::int
  end as rate
from (
  select
    sa.session_id,
    (count(*) filter (where sa.counts_toward_rate and sa.status = 'present'))::int as present_count,
    (count(*) filter (where sa.counts_toward_rate))::int                            as expected_count
  from public.session_attendance sa
  group by sa.session_id
) t;

grant select on public.session_attendance_summary to authenticated;
