# Validación contra Supabase Cloud real (Fases 0–4)

Fecha: 2026-09-18/20 · Proyecto: plan Free, Postgres 17.6 · Resultado: **correcto**. Este documento es cronológico: las secciones de las Fases 0–2
describen lo ejecutado entonces; el estado actual (migraciones 1–13 aplicadas) está al final, en «Fase 5 — migración 13».

## Qué se ejecutó en el SQL Editor (exactamente)

Todo se ejecutó como el rol `postgres` del panel. Las dos migraciones se cargaron en el editor
**byte a byte** desde `supabase/migrations/` (se comprobó el SHA-256 de cada archivo antes de pulsar Run).

| # | Contenido | SHA-256 (16 primeros hex) | Resultado |
|---|---|---|---|
| 1 | `supabase/migrations/20260919000000_schema.sql` (12 949 caracteres) | `b980d34a07d22662` | "Success. No rows returned" |
| 2 | `supabase/migrations/20260919000100_security.sql` (7 096 caracteres) | `c737a094e3a9aef1` | "Success. No rows returned" |

Al ejecutar la 1 el panel avisa: *"Potential issue detected: creates tables without enabling RLS"*. Se eligió
**"Run without RLS"** a propósito: el RLS lo activa la migración 2 y así se ejecuta el archivo tal cual, sin que
el panel le añada sentencias propias. (Entre ambas ejecuciones pasaron segundos y las tablas estaban vacías.)

Consultas de **solo lectura / auto-revertidas** para verificar el catálogo real (no cambian nada):
comprobación de RLS por tabla, permisos por columna, políticas, triggers, funciones, y una tabla + secuencia
de sondeo creadas dentro de un `DO` que termina en `RAISE EXCEPTION` (se revierte sola) para demostrar que
**los objetos nuevos en `public` nacen sin acceso** para `anon`, `authenticated` y `service_role`.
Otro `DO` auto-revertido comprobó, como propietario, que `audit_log` (UPDATE/DELETE/TRUNCATE), los check-ins
y la reapertura de sesiones cerradas quedan bloqueados por trigger.

`tests/supabase/promote-admin.sql` (promociona **solo** al usuario temporal de validación) y
`tests/supabase/cleanup.sql` (limpieza acotada por prefijo; `session_replication_role = replica` únicamente
dentro de su transacción; SHA-256 `40bd6c2f1f98e4df`) se ejecutaron también aquí.

## Cambio en el panel de Supabase (no es SQL)

*Authentication → Sign In / Providers → "Allow new users to sign up"*: **desactivado**. Verificado con
`/auth/v1/settings` (`disable_signup: true`) y con un intento real de registro (`422 signup_disabled`).
`Allow anonymous sign-ins` ya estaba desactivado.

## Cómo se repite la validación

```bash
node --env-file=.env.local scripts/supabase-validation/prepare.mjs   # 3 usuarios temporales confirmados (Fase 3: ya no hay paso de "promover")
npm run test:supabase                                                # 126 pruebas contra Supabase real (125 pasan, 1 omitida: sondeo)
npm run test:e2e                                                     # (opcional) Playwright + axe; crea/borra sus propios usuarios temporales
node --env-file=.env.local scripts/supabase-validation/cleanup.mjs   # borra los usuarios temporales
# SQL Editor: ejecutar tests/supabase/cleanup.sql                    # borra los datos ZZVAL- / [VALIDACIÓN]
```
(En las Fases 0–2 había un paso `promote-admin.sql`; la migración 3 lo hizo innecesario y el archivo se eliminó.)

`npm run test:supabase` **no forma parte de `npm test`**: necesita credenciales y red, y crea datos de prueba
(prefijo `ZZVAL-` en miembros, `[VALIDACIÓN]` en sesiones). Nunca imprime claves, contraseñas ni PIN.

## Resultados de las Fases 0–2 (40 pruebas reales; histórico)

- **Auth real**: login del administrador y de un usuario normal con JWT reales; contraseña incorrecta rechazada;
  registro público y sesión anónima cerrados.
- **RLS real**: `anon` sin acceso a las 6 tablas; usuario autenticado no administrador sin filas y sin poder
  escribir ni auto-promocionarse; administrador con solo las operaciones permitidas; `pin_hash` ya no existe (migración 10).
- **CRUD**: crear/actualizar/desactivar miembros (sin PIN), sesiones draft → active → closed,
  una sola activa, cerrada no se reabre, marcas de tiempo fijadas por la BD.
- **QR y tickets** con las claves reales, y **ensayo del flujo de check-in completo** (token → ticket → ASCE ID + Name → inserción; `tests/supabase/student-checkin.test.ts`: éxito, nombre incorrecto, ASCE ID inexistente, miembro inactivo, duplicado, ticket caducado, sesión cerrada, QR inválido y límites de intentos).
- **Unicidad**: mismo ticket para otro miembro → `checkins_ticket_single_use`; mismo miembro con ticket nuevo →
  `checkins_one_per_member_per_session`; sesión cerrada, borrador o miembro inactivo → rechazado por la app **y** por la BD.
- **Auditoría**: eliminar un check-in como administrador deja `audit_log` con el administrador como actor.
- **Concurrencia real (HTTP)**: 25 peticiones simultáneas del mismo miembro → exactamente 1 asistencia; un ticket usado
  a la vez por 10 miembros → exactamente 1; cierre de sesión mientras entran check-ins (peticiones escalonadas,
  aceptados/rechazados 6/9, 8/7 y 12/3) → ningún check-in posterior al cierre.

## Diferencias entre Postgres local (pruebas de `tests/db`) y Supabase real

| Tema | Local (Postgres 17.10 embebido) | Supabase real (17.6) |
|---|---|---|
| Roles y esquema `auth` | Imitados con `tests/db/supabase-shim.sql` | Nativos |
| Acceso a la base | Conexión directa (`pg`) | Solo vía API (PostgREST/Auth): no hay contraseña de BD en `.env.local` |
| Restricciones a nivel SQL como `postgres` | Probadas directamente | Probadas con bloques `DO` auto-revertidos en el SQL Editor |
| Concurrencia | 25–20 conexiones simultáneas reales | 25 peticiones HTTP simultáneas (cada una en su transacción) |
| Códigos de error | SQLSTATE nativo | Mismo SQLSTATE dentro de `error.code` de PostgREST |

No se encontraron diferencias de comportamiento que exijan cambiar el esquema.

## Notas

- El proyecto aparece etiquetado **"main · PRODUCTION"** en el panel de Supabase: es la etiqueta que Supabase pone a la rama
  por defecto de cualquier proyecto. Todavía no hay Vercel ni despliegue de producción.
- (Histórico, Fases 0–2) `service_role` no podía leer `admins` (por diseño) y los administradores se promocionaban con SQL como `postgres`.
  Desde la migración 3 (Fase 3) `public.admins` **ya no existe**: cualquier usuario confirmado de Supabase Auth es administrador (ver `docs/ADMIN-ACCESS.md`).
- Las claves de este proyecto son las JWT clásicas (`anon`/`service_role`); las claves nuevas `sb_publishable_/sb_secret_`
  no se han probado.

---

## Fase 3 — migraciones 3 y 4 aplicadas en Supabase real

Mismo procedimiento (SQL Editor como `postgres`, contenido cargado byte a byte y SHA-256 comprobado antes de ejecutar).

| # | Archivo | SHA-256 (16 hex) | Resultado |
|---|---|---|---|
| 3 | `20260919000200_admins_from_auth_users.sql` (1 642 car.) | `161d0db4c5b8b4a6` | Success. El panel avisa de "operaciones destructivas" por el `DROP TABLE public.admins` (0 filas). |
| 4 | `20260919000300_sessions_guard_allow_admin_deletion.sql` (2 326 car.) | `3a823185546718f8` | Success |

**Por qué existe la migración 4 (bug real encontrado en esta fase).** El trigger `sessions_guard` (migración 1) forzaba
`opened_by := old.opened_by` en cada `UPDATE`, lo que anulaba el `ON DELETE SET NULL` de la FK hacia `auth.users`. Con el modelo
"todo usuario de Auth es administrador" (revocar = borrar), un administrador que ya hubiera abierto una sesión **no se podía
borrar** (Supabase Auth devolvía HTTP 500). Se detectó porque el borrado del usuario temporal falló al limpiar. Tiene prueba de
regresión local (falla sin la migración) y real (`npm run test:supabase`, bloque *I*: el borrado devuelve 200).

**Resultados reales (47 pruebas):** todo lo de las Fases 0–2 actualizado al nuevo modelo, más:
- dos administradores confirmados (uno con `display_name`, otro sin él) operan con RLS;
- un usuario **sin confirmar** no puede iniciar sesión;
- un administrador **borrado** o **baneado** pierde el acceso al instante aunque su JWT siga vigente;
- `public.admins` ya no existe;
- **bloque *J* (guardián):** falla si el registro público, el inicio anónimo o un proveedor OAuth se habilitan; incluye un intento real
  de registro y de sesión anónima (ambos rechazados).

Limpieza de datos de prueba: `tests/supabase/cleanup.sql` (SHA-256 `40bd6c2f1f98e4df`) y `scripts/supabase-validation/cleanup.mjs`
(que ahora conserva el archivo de estado si algún borrado falla, para no dejar usuarios huérfanos).

---

## Fase 3 (ajustes) — migraciones 5 y 6: **APLICADAS en Supabase real**

Se validaron primero en el Postgres local (`tests/db`, 106 pruebas de BD) y después se aplicaron en Supabase real (ver la actualización más
abajo). Antes de aplicarlas, el panel de administración fallaba contra Supabase real porque las consultas de miembros piden la columna
`position`.

Procedimiento (el mismo de siempre): SQL Editor como `postgres`, contenido cargado byte a byte y SHA-256 comprobado antes de ejecutar,
**en este orden**. Al ejecutar la 6 el panel avisará de "tablas sin RLS": elige **"Run without RLS"** (la migración lo activa al final).

| # | Archivo | Caracteres | SHA-256 (16 hex) | Qué hace |
|---|---|---|---|---|
| 5 | `20260919000400_member_position.sql` | 1 326 | `33c927edd14cf250` | `members.position text not null default 'Member'` + constraint + grants por columna |
| 6 | `20260919000500_attendance_overrides.sql` | 11 469 | `b88ef1344ec60da3` | tipo `attendance_status`, tabla `attendance_overrides` (RLS, triggers de guarda/auditoría/no-borrado), vistas `session_attendance` y `member_attendance` |

`tests/supabase/cleanup.sql` cambió (ahora también limpia `attendance_overrides`, y solo si la tabla existe: puede ejecutarse antes de la
migración 6). Nuevo SHA-256 `bd5b74504a243eba`.

**Corrección manual de asistencia — diseño.** "Presente" sigue siendo una fila de `checkins` (inmutable). Una corrección de un administrador
se guarda aparte, en `attendance_overrides` (una fila por sesión y miembro; se actualiza, **nunca se borra**). Estado efectivo = override si
existe, si no check-in, si no ausente. Solo en reuniones **cerradas**. Cada cambio de estado lo audita un trigger en `audit_log`
(`action = 'attendance.manual_change'`; `detail` = `session_id`, `member_id`, `previous_status`, `new_status`, `changed_at`; `actor_id` = administrador).
No se añadió ninguna función a `public` (el guarda de RLS sigue exigiendo cero).

**Porcentaje de asistencia** (vistas SQL): reuniones cerradas y obligatorias, desde `joined_on` hasta `deactivated_on` (hora de El Paso, según cuándo
se abrió la reunión); una asistencia real nunca se descarta. Numerador ⊆ denominador, así que no supera el 100 %. Sin reuniones que cuenten: «—».

> **Actualización:** las migraciones 5 y 6 ya están aplicadas en Supabase real (comprobado con una lectura de solo lectura al iniciar la Fase 4).

**Diferencia entorno local vs real corregida:** el Postgres embebido de Windows usaba codificación WIN1252; ahora `tests/db/global-setup.ts` lo crea
en UTF8 (`--encoding=UTF8 --locale=C`), como Supabase.

---

## Fase 4 — migración 7: **APLICADA y validada en Supabase real**

Aplicada por el usuario en el SQL Editor y comprobada con una lectura de solo lectura (`sessions.location` responde 200; la vista
`session_attendance_summary` existe: `42501` para `service_role`, como debe ser). Validada en Postgres local (`tests/db`) y en Supabase real
(`tests/supabase/phase4.test.ts`, 25 pruebas; suite real completa 72/72) y con el flujo de navegador acotado
(`tests/e2e/checkin-flow.spec.ts`, 10/10).

> Nota: el archivo en disco quedó **sin el salto de línea final** (lo recorta el editor al guardar): SHA-256 `e26084101a2cf071`. Con ese `\n`
> el hash es el de la tabla de abajo (`80569c76a64c085a`). El SQL es idéntico.

Procedimiento usado (el de siempre): SQL Editor como `postgres`, contenido cargado y SHA-256 comprobado antes de ejecutar.

| # | Archivo | Caracteres | SHA-256 (16 hex) | Qué hace |
|---|---|---|---|---|
| 7 | `20260919000600_session_location.sql` | 1 872 | `80569c76a64c085a` | `sessions.location text` (nulo o 1–120, sin controles ni invisibles) + grants por columna para `authenticated` + vista `session_attendance_summary` (asistentes por sesión) |

No cambia RLS, ni el índice de "una sola sesión activa", ni el ciclo draft → active → closed, ni `checkins`. No se añade ninguna función a `public`.

---

## Cambios posteriores a la Fase 4: migraciones 8 a 12 (**APLICADAS** por el usuario en Supabase real)

Aplicadas por el usuario en el SQL Editor y comprobadas con una lectura de solo lectura del esquema real el 2026-09-20 (detalle en «Cierre de la Fase 4»).

| # | Archivo | Qué hace |
|---|---|---|
| 8 | `20260919000700_member_devices.sql` | Tabla `member_devices` («Remember me»: solo el HMAC del token, solo `service_role`, RLS sin políticas) + trigger que revoca los dispositivos al desactivar a un miembro |
| 9 | `20260919000800_session_delete_and_direct_start.sql` | `sessions_guard` admite crear una sesión ya **activa** (New Session ya no crea borradores) + `grant insert (status)`; borrar sesiones: `DELETE` para administradores con RLS, `ON DELETE CASCADE` en `checkins` y `attendance_overrides`, los overrides solo se pueden borrar en cascada, y trigger que deja `session.delete` en `audit_log` |
| 10 | `20260919000900_drop_member_pin.sql` | `alter table members drop column pin_hash` (irreversible; nada dependía de ella) |
| 11 | `20260919001000_member_design_team.sql` | `members.is_design_team boolean not null default false` (todos los miembros existentes quedan en false) + permisos por columna para administradores |
| 12 | `20260919001100_session_audience.sql` | `sessions.required` (booleano) se sustituye por `sessions.audience` (enum `session_audience`: `design_team` | `remar_construction`). Conversión: required=true → remar_construction; required=false → remar_construction (en la base real no hay sesiones opcionales). Recrea las vistas de asistencia: cada miembro cuenta las reuniones cerradas de SU grupo (`for_member`) |

Orden de aplicación (ya realizada): 8 → 9 → 10 → 11 → 12, en el SQL Editor como `postgres`. Los borradores históricos siguen siendo válidos. Los intentos de check-in
(`checkin_attempts`) se conservan al borrar una sesión (`session_id` pasa a nulo) y `audit_log` nunca se toca.

**Limpieza (`tests/supabase/cleanup.sql`, versión actual):** borra miembros `ZZVAL-…` y los IDs numéricos de prueba de los tests de navegador (seis ceros + un dígito 0-2 + 6 o 7 dígitos = 13–14 dígitos; un ASCE ID real no puede coincidir), sesiones `[VALIDACIÓN]…`, sus check-ins, correcciones, dispositivos recordados (`member_devices`), intentos y la auditoría de esos datos (incluido `session.delete`). Está probada sobre Postgres local en `tests/db/cleanup-sql.test.ts` (conserva un miembro y una sesión reales y es idempotente).

---

## Cierre de la Fase 4 (2026-09-20)

**Esquema real comprobado (solo lectura, vía la API REST de Supabase).** Las migraciones 8–12 están aplicadas: existe `member_devices`;
`members.pin_hash` ya no existe; `members.is_design_team` existe con `false` por defecto; `sessions.audience` existe y `sessions.required` ya no;
existen las vistas `session_attendance`, `session_attendance_summary` y `member_attendance`; `public.admins` no existe. `anon` recibe `401` (`42501`) en
las 7 tablas. Las vistas responden `403` a `service_role` **por diseño** (solo tienen `grant select … to authenticated`): su contenido se valida con
una sesión de administrador en `npm run test:supabase`, no con `service_role`.

**Resultados finales de la Fase 4**

| Prueba | Resultado |
|---|---|
| `npm run test:supabase` (Supabase real) | 114 pasadas, 1 omitida (sondeo), 0 fallidas |
| E2E acotados contra Supabase real, escritorio (`checkin-flow.spec.ts` + `members.spec.ts`) | 35 de 35 (19 + 16) |
| `npm test` (Vitest: unitarias, UI y BD local) | 44 archivos, 710 de 710 |
| `npm run typecheck`, `npm run lint`, `npm run build` | limpios |

**Limpieza de datos de prueba.** El usuario ejecutó `tests/supabase/cleanup.sql` en el SQL Editor (SHA-256
`a6e3c3f074d31ceb603a847d9f1a647e35f56248ffce5ffeb7a61f5884e96869`). Comprobación posterior de solo lectura: 0 miembros `ZZVAL-…` o con ID numérico de
prueba, 0 sesiones `[VALIDACIÓN]…`, 0 sesiones activas. Quedan, a propósito, dos tipos de filas que **no** se pueden distinguir de forma segura de datos
reales y por eso no se tocan:

- **`audit_log` (5 filas):** de las pruebas manuales del usuario (1 `attendance.manual_change` y 4 `session.delete`). El log es de solo inserción y
  `cleanup.sql` solo borra lo que se identifica por prefijo de prueba.
- **`checkin_attempts` (6 filas):** intentos de las corridas de pruebas con `session_id` y `asce_id_tried` nulos (`ticket_expired` con ticket vencido, y
  `success` de un check-in con dispositivo recordado cuya sesión de prueba se borró después). Sin ninguno de los dos campos no existe un criterio seguro para
  separarlos de intentos reales. No contienen datos personales.

**Higiene de las pruebas reales.** El 2026-09-20 se encontró un usuario temporal `zz-validation-opener-…@example.com` que una corrida fallida de
`npm run test:supabase` dejó en Supabase Auth (con la regla de la migración 3, un usuario confirmado es administrador). Se comprobó que era de pruebas
(patrón del correo, sin `display_name`, sin ninguna fila que lo referenciara) y se borró. Causa: dos pruebas de `tests/supabase/real.test.ts` (administrador borrado y
administrador que ya abrió sesiones) borraban al usuario dentro del cuerpo del test; ahora lo borran en un `finally`, así que ya no se quedan usuarios temporales
si falla una aserción.

---

## Sesiones para los dos equipos — migraciones 14 y 15: **PENDIENTES de aplicar en Supabase real**

Una sesión puede ir dirigida a Design Team, a Rowing & Construction o a **los dos** (`sessions.audience = 'both'`). Se aplican en el SQL Editor, **en este orden y por separado**:

| # | Archivo | Qué hace |
|---|---|---|
| 14 | `20260919001300_session_audience_both.sql` | `alter type public.session_audience add value 'both'`. Solo eso: no toca tablas, vistas ni datos |
| 15 | `20260919001400_session_audience_both_views.sql` | `create or replace view public.session_attendance`: `for_member` y `counts_toward_rate` tratan `both` como dirigida a todos los miembros. Mismas columnas; `member_attendance` y `session_attendance_summary` heredan la regla |

Validadas en Postgres 17 local (`npm run test:db`: 215 pasadas). Hasta que se apliquen, crear una sesión con las dos casillas marcadas falla en la base de datos; el resto de la aplicación no cambia.

## Fase 5 — migración 13 (Attendance): **APLICADA y validada en Supabase real** (2026-09-20)

| # | Archivo | SHA-256 |
|---|---|---|
| 13 | `20260919001200_session_summary_expected_rate.sql` (3 442 bytes) | `d82df8affc1caa53322c039bf7d930fc1e060a940be4ed49135fe4d0476ccce6` |

Aplicada por el usuario en el SQL Editor y comprobada con lecturas de solo lectura: `session_attendance_summary` tiene `session_id`, `present_count`, `expected_count` y `rate` (uuid,
integer, integer, integer); `session_attendance` y `member_attendance` conservan sus columnas; `anon` recibe `401` (`42501`) y `service_role` `403` en las tres vistas (solo `SELECT` para
`authenticated`). `security_invoker` se comprueba de forma funcional: un usuario autenticado que no es administrador ve 0 filas y el administrador ve la reunión
(`tests/supabase/attendance.test.ts`, bloque *E*). La definición de las vistas y su semántica están en [ATTENDANCE.md](ATTENDANCE.md).

**Cambio intencional de semántica.** `present_count` cuenta solo presentes de la población esperada (antes contaba a todos los presentes de la reunión) y una sesión ACTIVA aparece con
0 / 0 / `NULL`. Dos expectativas antiguas de `tests/supabase/phase4.test.ts` se actualizaron a esta definición (la sesión activa aún no cuenta; el presente de otro grupo no cuenta) y la lista
de sesiones muestra el conteo EN VIVO de la sesión activa. `rate` se calcula con `float8` porque `round(present * 100.0 / expected)` con `numeric` difiere de `Math.round` de la aplicación en 40 de
las 501 500 parejas con hasta 1000 esperados (por ejemplo 23 de 40).

**Resultados (2026-09-20)**

| Prueba | Resultado |
|---|---|
| `npm run test:supabase` (Supabase real; 5 archivos, uno omitido) | 125 pasadas, 1 omitida, 0 fallidas (11 nuevas en `tests/supabase/attendance.test.ts`: migración 13, roster, corrección con auditoría, historial, conteo en vivo, seguridad e invariantes) |
| Vitest (`npm test`: unitarias, UI y BD local) | 48 archivos, 785 pruebas |
| Playwright, `tests/e2e/attendance.spec.ts` (escritorio, iPhone y Android) | 21 de 21 (lista, filtro por grupo, roster, corrección con confirmación, táctil, diálogo dentro de la pantalla, estados de error, acceso sin sesión, axe) |
| Playwright, regresión en escritorio (check-in, miembros, autenticación, pantalla pública y pantallas) | todo pasa; `checkin-flow.spec.ts` 19 de 19 |
| Playwright, regresión en iPhone y Android (miembros, autenticación, pantalla pública y pantallas) | todo pasa |
| typecheck, lint, build | limpios |

**Dos pruebas de Playwright se ajustaron por causas identificadas** (no para «hacerlas pasar»): en `checkin-flow.spec.ts` (test 19) la página de una sesión CERRADA ahora muestra el roster de esperados en lugar de la lista de
check-ins, así que se busca la fila con la insignia «Present»; y en `members.spec.ts` («ASCE ID solo números») se espera a que la página hidrate antes de teclear, porque en WebKit (iPhone) teclear antes
hace que React reinicie el campo (diagnóstico con un spec temporal: el campo funciona en los tres perfiles una vez hidratada la página).

**Limpieza.** Los usuarios temporales de Auth los crea y borra el ejecutor (`try/finally`); tras la corrida no queda ninguno y los datos reales (2 reuniones y 1 miembro) siguen intactos. `tests/supabase/attendance.test.ts` elimina
las sesiones que crea (cascada a sus check-ins y correcciones) y `tests/e2e/attendance.spec.ts` también. No se pueden borrar por la API los miembros de prueba (`ZZVAL-…` o con ASCE ID numérico de prueba) ni las filas de
`audit_log` (solo inserción), ni los check-ins e intentos de las sesiones que las otras pruebas no eliminan: se limpian con `tests/supabase/cleanup.sql` en el SQL Editor (sin cambios: SHA-256
`a6e3c3f074d31ceb603a847d9f1a647e35f56248ffce5ffeb7a61f5884e96869`). Los intentos de check-in sin sesión ni ASCE ID (por ejemplo los de dispositivos recordados de sesiones ya eliminadas) no se pueden distinguir con seguridad de datos reales y se conservan.
