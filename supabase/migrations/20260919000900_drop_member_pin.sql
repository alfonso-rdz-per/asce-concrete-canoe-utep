-- ASCE UTEP · Se elimina el PIN del sistema.
--
-- El PIN dejó de ser una credencial del check-in (ahora es ASCE ID + Name) y se eliminó "Reset PIN". Ninguna funcionalidad legítima
-- depende ya de `members.pin_hash`: ninguna vista, trigger, política ni código de la aplicación la lee o la escribe (verificado antes
-- de escribir esta migración). Se ELIMINA la columna, no se oculta.
--
-- IRREVERSIBLE: los hashes existentes se pierden (no sirven para nada). El DROP COLUMN arrastra su restricción
-- (`members_pin_hash_format`) y las concesiones por columna que tuviera `authenticated` sobre ella.
--
-- Orden de aplicación: después de desplegar la versión de la aplicación que ya no inserta `pin_hash`.

alter table public.members drop column pin_hash;
