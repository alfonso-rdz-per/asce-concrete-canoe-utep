-- ASCE UTEP · Una sesión puede ir dirigida a LOS DOS equipos (Design Team y Rowing & Construction) a la vez.
--
-- PASO 1 de 2. Esta migración SOLO añade el valor 'both' al enum public.session_audience. No toca tablas, vistas, políticas ni datos:
-- todas las sesiones existentes conservan su audiencia.
--
-- Va en un archivo aparte a propósito: PostgreSQL no permite USAR un valor de enum en la misma transacción en la que se añadió
-- ("unsafe use of new value"). La migración siguiente (…001400_session_audience_both_views) usa 'both' en las vistas de asistencia, y por
-- eso debe ejecutarse DESPUÉS de esta, en una ejecución distinta (en el SQL Editor: pegar y ejecutar este archivo, y luego el siguiente).
--
-- El identificador remar_construction del enum se conserva tal cual (solo cambia la etiqueta que ve el usuario: "Rowing & Construction").
-- No crea ninguna función ni cambia permisos.

alter type public.session_audience add value if not exists 'both';
