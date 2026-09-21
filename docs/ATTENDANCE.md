# Attendance (asistencia)

Cómo se cuenta la asistencia en el panel de administración. Toda la lógica de conteo vive en la **base de datos** (vistas SQL); la aplicación solo
pide los números y les da formato. Los resultados de las pruebas están en [SUPABASE-VALIDATION.md](SUPABASE-VALIDATION.md).

## Dos cosas distintas: asistencia EN VIVO y resumen de reuniones CERRADAS

| | Sesión **activa** (en curso) | Sesión **cerrada** (ya celebrada) |
|---|---|---|
| Qué se muestra | Check-ins a medida que llegan: nombre, cargo y hora | Presentes / esperados, porcentaje y el roster con Present / Absent |
| Dónde | Pantalla del QR y página de la sesión (`getSessionLive`); columna «Attendance» de la lista de sesiones | `/admin/attendance` y la página de la sesión |
| Denominador | Miembros **activos hoy** del grupo de la sesión («12 / 25») | Miembros **esperados** en esa reunión (ver abajo) |
| Fuente | `checkins` (+ conteo de miembros activos) | `session_attendance_summary` y `session_attendance` |
| Correcciones | No (la base de datos las rechaza) | Sí: Present ↔ Absent |

`session_attendance_summary` **no** se usa para el conteo en vivo: una sesión activa aparece ahí con 0 esperados, 0 presentes y sin porcentaje, porque
todavía no cuenta para ningún porcentaje. La lista de sesiones usa los check-ins en vivo para la sesión activa.

## Población esperada, `expected_count`, `present_count` y `rate`

Todo sale de `session_attendance.counts_toward_rate`, la misma marca que alimenta el **porcentaje individual** de cada miembro (`member_attendance`).
Una fila (reunión, miembro) cuenta cuando:

1. la reunión está **cerrada**;
2. va dirigida al **grupo del miembro** (`Design Team` ↔ casilla `is_design_team`; `Rowing & Construction` ↔ el resto) o a **los dos equipos** (`both`, cuenta para todos);
3. y su **pertenencia al equipo estaba vigente en la fecha de la reunión** (`joined_on` ≤ fecha ≤ `deactivated_on`, hora de El Paso; la fecha es cuando
   realmente se abrió el check-in) — **o** su estado efectivo es Present: una asistencia real (o una corrección manual a Present) nunca se descarta.

`session_attendance_summary` (migración 13) resume esas filas por reunión:

| Columna | Significado |
|---|---|
| `session_id` | La reunión |
| `expected_count` | Filas con `counts_toward_rate` (miembros esperados) |
| `present_count` | De esas filas, las de estado efectivo `present`. **Nunca supera a `expected_count`** |
| `rate` | Entero de 0 a 100, o `NULL` si `expected_count = 0`. Se muestra «—» (nunca «0 %») |

Consecuencias, todas intencionales:

- **No es «activos hoy».** Una baja posterior no cambia el historial de una reunión ya celebrada, y quien se une después no aparece como ausente en reuniones anteriores.
- **Otro grupo no cuenta.** Un miembro que hace check-in en una reunión de otro grupo queda registrado (el check-in existe), pero no entra en presentes, esperados ni porcentaje, y no aparece en el roster.
- **Coherencia.** La suma de `expected_count` de todas las reuniones es igual a la suma de `counted_meetings` de todos los miembros, y la de `present_count` a la de `attended_meetings`.
- **Redondeo.** `rate` usa la misma aritmética (`float8`) y la misma regla (mitades hacia arriba) que `Math.round(attended / counted * 100)` de la aplicación
  (`src/lib/attendance.ts`). `round(present * 100.0 / expected)` con `numeric` **no** es equivalente (23 de 40 = 57,5 %: la aplicación da 57 y `numeric` 58).
- Una reunión sin ningún miembro en la base de datos no tiene fila en el resumen; la aplicación la trata como 0 de 0.

## Pantallas

- **`/admin/attendance`**: reuniones cerradas, las más recientes primero (tope de 200). Cada una muestra nombre, grupo, fecha, `presentes / esperados` y
  porcentaje, y enlaza a su detalle. Filtro por grupo: `All`, `Design Team`, `Rowing & Construction` (enlaces `?group=…`; cualquier otro valor es `All`; cada equipo incluye también las reuniones dirigidas a los dos).
- **`/admin/sessions/[id]`** (reunión cerrada): resumen y **roster** de los miembros esperados (nombre, ASCE ID, cargo, Present / Absent). El roster se pide a la base
  de datos (`session_attendance` filtrada por `counts_toward_rate`); la aplicación **no** reconstruye la población. Como solo se pintan los esperados,
  desde la interfaz no se puede elegir a un miembro de otro grupo ni fuera de esa población.
- La ficha de cada miembro conserva su historial y su porcentaje (`attended / counted`; sin reuniones que cuenten es «—»).

## Correcciones manuales (Present ↔ Absent)

- Solo en reuniones **cerradas** (la base de datos lo impone), con **confirmación** antes de guardar.
- Se guardan en `attendance_overrides` (una fila por reunión y miembro; se actualiza, **nunca se borra**). El check-in original se conserva: el estado efectivo es la corrección si existe;
  si no, el check-in; si no, ausente.
- Cada cambio de estado deja una fila en `audit_log` (`attendance.manual_change`: administrador, miembro, reunión, estado anterior y nuevo). `audit_log` es de solo inserción.
- Es la misma acción de servidor (`setAttendanceAction` → `setMemberAttendance`) para el roster y para la ficha del miembro: valida el administrador y los ids, y revalida la sesión,
  el historial, la lista de sesiones y la ficha.
- La base de datos admite una corrección para cualquier pareja (reunión cerrada, miembro), incluso de otro grupo (es historial y no afecta al conteo). La interfaz del roster no la ofrece.

## Seguridad

Solo administradores: las tres vistas son `security_invoker` con `SELECT` únicamente para `authenticated` (RLS de `sessions`, `members`, `checkins` y `attendance_overrides`); `anon` y
`service_role` no tienen permisos. Las páginas y acciones empiezan por `requireAdmin()`. No hay `select *`, ni funciones nuevas en `public`, ni APIs públicas nuevas.
