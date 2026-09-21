# Puesta en marcha

Estado: **Fase 5 implementada** (Attendance / Historial: reuniones cerradas, roster y correcciones; ver [ATTENDANCE.md](ATTENDANCE.md)) sobre la Fase 4 (sesiones, QR dinámico,
check-in del estudiante con ASCE ID + Name, Remember me, grupos Design Team / Rowing & Construction (o los dos a la vez)) y las Fases 0–3. Hoja de ruta en el [README](../README.md).

## Requisitos

- Node.js ≥ 22 (probado con 24).
- **No hace falta Docker** para las pruebas: usan un Postgres 17 real embebido
  (`embedded-postgres`). Docker solo sería necesario para `supabase start` (Supabase local completo).

## Comandos

```bash
npm install
npm run lint
npm run typecheck
npm test              # unitarias + componentes (jsdom) + base de datos (48 archivos, 785 pruebas, ≈ 20 s)
npm run test:unit     # solo lógica pura, criptografía y pruebas estáticas de seguridad
npm run test:ui       # solo componentes (jsdom)
npm run test:db       # solo migraciones, RLS y concurrencia (Postgres local)
npm run test:supabase # validación contra Supabase REAL (no forma parte de npm test; ver docs/SUPABASE-VALIDATION.md)
npm run test:e2e      # Playwright + axe (escritorio, iPhone/WebKit, Android) contra Supabase REAL; compila y crea/borra usuarios temporales
npm run build
```

## Variables de entorno

Copia `.env.example` a `.env.local`. Genera cada secreto con:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"
```

| Variable | Uso | Rotación |
|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | URL del proyecto de Supabase (es pública) | — |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Clave publicable (`anon`) de Supabase; `anon` no tiene acceso a ninguna tabla | Desde el panel de Supabase |
| `SERVER_SECRET` | Claves de tokens QR y tickets (HKDF) | Invalida los QR/tickets vigentes y deja de reconocer los dispositivos recordados («Remember me»): los estudiantes solo se identifican otra vez. También deriva la clave que anonimiza las IPs de los intentos |
| `SUPABASE_SERVICE_ROLE_KEY` | Cliente `service_role` (solo servidor) | Desde el panel de Supabase |
| `QR_GRACE_MS` | Gracia tras los 10 s del QR (0–15000, defecto 5000) | — |
| `TICKET_TTL_SECONDS` | Vida del ticket (60–600, defecto 180) | — |

El PIN y `PIN_PEPPER` ya no existen: si tu `.env.local` o Vercel aún tienen `PIN_PEPPER`, se ignora y se puede borrar.
Nunca subas `.env.local` al repositorio (está en `.gitignore`).

## Supabase (nube, plan Free)

1. Crea el proyecto. Recomendado: región de EE. UU. Este, cerca de la región de Vercel `iad1`.
2. **Desactiva los registros públicos**: Authentication → Sign In / Providers → desactiva
   "Allow new users to sign up". (`supabase/config.toml` ya lo hace, pero solo para el entorno
   local; en la nube es un ajuste del panel.)
3. Aplica las **15 migraciones** de `supabase/migrations/` en orden (de `…000000_schema.sql` a `…001400_session_audience_both_views.sql`) con la CLI
   (`npx supabase link` y `npx supabase db push`) o pegándolas una por una en el editor SQL. No edites las ya aplicadas: los cambios van
   en migraciones nuevas. **Las migraciones 14 (`…001300_session_audience_both.sql`) y 15 (`…001400_session_audience_both_views.sql`) se ejecutan por SEPARADO, en ese
   orden** (PostgreSQL no deja usar un valor de enum recién añadido en la misma ejecución): pega y ejecuta la 14; después, la 15.
4. **Administradores**: no hay tabla de administradores (`public.admins` se eliminó en la migración 3). **Cualquier usuario confirmado de
   Supabase Auth es administrador**: Authentication → Users → "Add user" (correo + contraseña de ≥ 12 caracteres, marcando *Auto Confirm
   User*), y opcionalmente en *user metadata* `{"display_name": "Nombre Apellido"}`. No hay que ejecutar ningún SQL. Solo se crean usuarios
   que deban ser administradores; ver [ADMIN-ACCESS.md](ADMIN-ACCESS.md).

> Las migraciones se probaron contra un Postgres 17 real local (con una capa que imita los roles y el esquema
> `auth`) **y contra Supabase Cloud real**. Detalle exacto de lo ejecutado y de los resultados en
> [docs/SUPABASE-VALIDATION.md](SUPABASE-VALIDATION.md). Al pegar la migración 1 en el SQL Editor, elige
> **"Run without RLS"** (el RLS lo activa la migración 2).

### Consecuencia de los permisos por columna

Los administradores tienen permisos **por columna** en las tablas, así que las consultas de la aplicación listan siempre las columnas
explícitamente (`select id, asce_id, name, …`) en lugar de `select *`.

## Plan Free: dos cosas a vigilar

- **Pausa por inactividad**: Supabase Free pausa el proyecto tras ~1 semana con poca actividad
  ([docs](https://supabase.com/docs/guides/platform/free-project-pausing)). Un cron diario de Vercel
  Hobby (permitido: 1 vez al día, sin coste) con una consulta trivial lo evitaría; se añadirá junto con
  el despliegue en Vercel (fase por planificar; hoy no hay Vercel ni producción) y hay que confirmar en la
  práctica que cuenta como actividad.
- **Vercel Hobby es solo para uso no comercial** (definición en
  [Fair Use](https://vercel.com/docs/limits/fair-use-guidelines#commercial-usage): ganancia
  económica de *cualquiera* que participe en producirlo, cobros, publicidad…). Una app de asistencia
  gratuita para un capítulo estudiantil no encaja en esos ejemplos.
