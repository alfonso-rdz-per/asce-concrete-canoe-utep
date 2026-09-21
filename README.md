# ASCE | UTEP Concrete Canoe Team · Check-In

Registro de asistencia del equipo de Concrete Canoe. El administrador muestra un QR que cambia cada 10 s; los
miembros lo escanean con la cámara del teléfono, introducen su ASCE ID y su nombre (Name), y el servidor valida todo.
Sin apps que instalar. La interfaz está 100 % en inglés.

**Estado: Fase 5 (Attendance / Historial) implementada y validada** sobre la Fase 4 (sesiones, QR dinámico, ticket y check-in del estudiante con ASCE ID + Name, Remember me, grupos Design Team / Rowing & Construction (o los dos a la vez), corrección manual de asistencia y borrado de sesiones). Migraciones 1–13 aplicadas en Supabase real. Validación: 125 pruebas contra Supabase real (1 omitida), 785 pruebas de Vitest, E2E con Playwright en escritorio, iPhone y Android (incluye 21 pruebas de Attendance), typecheck, lint y build limpios; detalle en [docs/SUPABASE-VALIDATION.md](docs/SUPABASE-VALIDATION.md). Aún no hay despliegue.

Ya existe: login de administradores, panel, Miembros (alta, edición, desactivar/reactivar, cargo, Design Team), sesiones, pantalla del QR, check-in del estudiante, dashboard con porcentaje de asistencia por miembro, el historial de cada miembro (con corrección Present ↔ Absent) y **Attendance**: historial de reuniones cerradas con presentes / esperados y porcentaje (filtro por grupo) y, en cada reunión cerrada, el roster de los miembros esperados con corrección Present ↔ Absent (ver [docs/ATTENDANCE.md](docs/ATTENDANCE.md)). Marca `ASCE | UTEP` (con marcadores hasta tener los logos oficiales), footer con Instagram, interfaz 100 % en inglés, CSP con nonce y accesibilidad (Playwright + axe).

## Hoja de ruta

| Fase | Contenido | Estado |
|---|---|---|
| 0–2 | Esquema, seguridad/RLS, tokens y tickets | Hecha |
| 3 | Login de administradores, panel, Miembros, marca, CSP, accesibilidad | Hecha |
| 4 | Sesiones, QR dinámico, check-in del estudiante (incluye lo que el plan original llamaba «Fase 5», con límites de intentos y auditoría), Remember me, grupos, borrado de sesiones | Cerrada |
| 5 | **Attendance / Historial**: `/admin/attendance` (reuniones cerradas con fecha, grupo, presentes / esperados, porcentaje y filtro por grupo) y detalle de sesión cerrada con el roster Present/Absent y corrección manual (migración 13: `session_attendance_summary` con `expected_count` y `rate`) | Hecha |
| Después | Despliegue en Vercel Hobby y cron diario contra la pausa por inactividad de Supabase Free. Aún no se ha tocado Vercel ni producción | Por planificar |

`docs/PHASE-3-PROPOSAL.md` es un documento **histórico**: su tabla de cortes (§0.1) describe el plan original, que esta hoja de ruta reemplaza.

- [Puesta en marcha](docs/SETUP.md)
- [Attendance: cómo se cuenta la asistencia (en vivo vs. reuniones cerradas, esperados, porcentaje, correcciones)](docs/ATTENDANCE.md)
- [Tokens QR y tickets: qué demuestran y qué no](docs/TOKENS.md)
- [Acceso de administradores](docs/ADMIN-ACCESS.md)
- [Validación contra Supabase real](docs/SUPABASE-VALIDATION.md)
- [Logos pendientes](public/brand/README.md)

## Stack (todo gratuito)

Next.js 16 · TypeScript · Tailwind · Inter (autoalojada) · Supabase (Postgres + Auth) · Vercel Hobby · Vitest · Playwright + axe.

## Estructura

```
src/lib/
  tokens.ts        token QR firmado (HMAC), ventana de validez con gracia
  tickets.ts       ticket firmado que se canjea al escanear
  device-token.ts  token de «Remember me» (256 bits aleatorios, solo se guarda su HMAC), caducidad y revocación
  member-name.ts   comparación de «Name» (sin acentos/mayúsculas; nombre completo o prefijo de palabras completas)
  checkin/         puerta QR/ticket y check-in del estudiante (ASCE ID + Name, límites y auditoría)
  time.ts          reloj inyectable (la hora autoritativa es la del servidor)
  env.ts           validación de variables de entorno (solo servidor)
  crypto/          HKDF, HMAC, codificación de ids
  supabase/server.ts cliente de sesión de administrador (cookies HttpOnly, aplica RLS)
  supabase/admin.ts  cliente service_role (server-only; lo usa el check-in del estudiante)
  auth/              requireAdmin (DAL), regla de administrador, display_name, guardián de Auth
  data/members.ts    acceso a miembros con lista explícita de columnas
  data/attendance.ts dashboard, historial por miembro, corrección manual, historial de reuniones cerradas y roster (RLS del admin)
  attendance.ts · positions.ts   porcentaje/estados/formato de asistencia y cargos (sin dependencias)
  data/sessions.ts   sesiones (borrador → activa → cerrada), asistencia en vivo y lista con el conteo en vivo de la activa (RLS del admin)
  checkin/gate.ts    canje del QR por ticket y validación del ticket (puro: hora/claves/BD inyectadas)
  checkin/server.ts  cableado de producción de la puerta (hora del servidor, claves, service_role)
  qr-display.ts      qué QR dibujar / cuándo refrescar (anclado a la hora del servidor)
src/proxy.ts           CSP con nonce, refresco de sesión y redirección optimista
src/app/(public)/      inicio de estudiantes y destino del QR (/c/[token]) · src/app/admin/  login, panel, miembros, sesiones y Attendance
src/app/admin/sessions/[id]/qr   pantalla del QR (pantalla completa, fuera del shell) · src/app/api/admin/sessions/[id]/{qr,attendance}   API del admin
src/components/        brand (ASCE | UTEP, footer, olas), ui, admin
supabase/migrations/   15 migraciones (las 13 primeras aplicadas en Supabase real; la 14 y la 15, sesiones para los dos equipos, PENDIENTES): esquema, seguridad/RLS, administrador desde Auth, corrección de
                       borrado, cargo (position), correcciones manuales de asistencia + vistas del porcentaje, ubicación de sesiones,
                       dispositivos recordados, borrado de sesiones + inicio directo, PIN eliminado, Design Team, grupo de la sesión (audience),
                       resumen por reunión con esperados y porcentaje (session_attendance_summary), sesiones dirigidas a los dos equipos (audience = both)
tests/unit/            lógica pura, criptografía, pruebas estáticas de seguridad, guarda de idioma
tests/ui/              componentes (jsdom)
tests/db/              RLS, integridad, concurrencia y regla de administrador (Postgres 17 real)
tests/supabase/        validación contra Supabase REAL
tests/e2e/             Playwright + axe (escritorio, iPhone, Android)
```

## Principios de seguridad

- El servidor es la única autoridad: el navegador no decide validez, sesión, nombre ni duplicados.
- Los estudiantes nunca acceden a Supabase; `anon` no tiene acceso a ninguna tabla.
- `service_role` solo existe en módulos `server-only` (el build falla si se importa desde el cliente).
- Las invariantes críticas también se imponen en la base de datos (unicidad, sesiones que no se
  reabren, sin check-ins fuera de una sesión activa, auditoría de solo inserción).

## Grupos: Design Team y Rowing & Construction

- Cada miembro tiene la casilla **Design Team** (`members.is_design_team`, apagada por defecto).
- Cada sesión se crea con **Required**, dos casillas que se pueden marcar **a la vez**: *Design Team* (dirigida a los miembros del Design Team) y
  *Rowing & Construction* (dirigida al grupo general, es decir, a los miembros que no son del Design Team). Con una sola casilla la sesión va a ese
  grupo; con las dos, a **todos** los miembros. Se guarda en `sessions.audience` (enum `design_team` | `remar_construction` | `both`; el identificador
  `remar_construction` se conserva por compatibilidad, la etiqueta visible es «Rowing & Construction»). Requiere las migraciones 14 y 15.
- El porcentaje de asistencia de cada miembro cuenta las reuniones cerradas de **su** grupo y las dirigidas a los dos; una reunión del otro grupo no cuenta (aunque asista).
  La regla vive en las vistas de la base de datos (`session_attendance.for_member`). El denominador de la asistencia en vivo («12 / 25») son los
  miembros activos del grupo de la sesión.
- El ASCE ID son **solo números** (validado en el navegador y en el servidor).
