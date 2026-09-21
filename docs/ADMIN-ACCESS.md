# Acceso de administradores

## La regla

**Cualquier usuario válido de Supabase Auth es administrador de la aplicación.** "Válido" significa, en el
momento de cada petición:

- tiene correo y está **confirmado**,
- **no es anónimo**,
- **no está baneado**,
- **no está borrado**.

No existe tabla de administradores (`public.admins` se eliminó en la migración 3). No hay registro público:
los usuarios se crean directamente en **Supabase → Authentication → Users**.

## Cómo se aplica (defensa en capas)

| Capa | Qué hace | Dónde |
|---|---|---|
| **Base de datos (autoridad)** | `private.is_admin()` consulta `auth.users` en cada petición; todas las políticas RLS la usan. Revocar (borrar/banear) surte efecto de inmediato aunque el JWT siga vigente. | `supabase/migrations/…_admins_from_auth_users.sql` |
| **DAL de la aplicación** | `requireAdmin()` valida el JWT contra Supabase Auth (`getUser()`) y aplica el espejo JS de la regla. Cada página, layout y Server Action lo llama por sí misma. | `src/lib/auth/session.ts`, `is-admin.ts` |
| **Proxy** | Solo comprobación optimista (¿hay sesión?) y refresco de cookies. No es autoridad. | `src/proxy.ts` |
| **Guardián de configuración** | Como el único "candado" es quién puede crear usuarios en Auth, se vigila que **el registro público, el inicio anónimo y los proveedores OAuth sigan desactivados**. | ver abajo |

Una prueba de **paridad** ejecuta la misma matriz de usuarios contra la función SQL (Postgres real) y contra el
espejo JS y exige el mismo resultado (`tests/db/admin-rule.test.ts`).

## Guardián de la configuración de Auth

`src/lib/auth/auth-settings.ts` evalúa `/auth/v1/settings` y **falla cerrado**. Se usa en dos sitios:

1. **Aviso en el panel** (`AuthSettingsWarning`): si detecta registro abierto, inicio anónimo u OAuth no
   autorizado, todas las páginas del panel muestran un aviso rojo. Se consulta cada 5 min; si la consulta falla
   no se muestra nada.
2. **Prueba automática contra Supabase real** (`npm run test:supabase`, bloque *J*): **FALLA** si
   - el registro público está habilitado,
   - el inicio de sesión anónimo está habilitado, o
   - aparece un proveedor OAuth no autorizado (la lista de autorizados está vacía a propósito).

## Operación diaria

- **Añadir un administrador:** Supabase → Authentication → Users → *Add user* (correo + contraseña de ≥ 12
  caracteres, marcando *Auto Confirm User*). Puede iniciar sesión de inmediato.
- **Nombre visible:** en el mismo usuario, *user metadata* → `{"display_name": "Nombre Apellido"}`. La app **solo
  lo lee** (`user.user_metadata.display_name`), no hay pantalla para editarlo. Sin `display_name` se usa la
  parte anterior al `@` del correo. Saludo: `Welcome, <primera palabra>`.
- **Revocar:** borrar o banear al usuario en Supabase. Deja de tener acceso en la siguiente petición.
  (La migración 4 garantiza que se puede borrar a un administrador que ya abrió sesiones.)
- **Regla operativa:** en este proyecto de Supabase **solo se crean usuarios que deban ser administradores**.
  No actives *Allow new users to sign up*, *Allow anonymous sign-ins* ni ningún proveedor.

## `display_name` es texto no confiable

`user_metadata` lo puede modificar el propio usuario. Por eso la app lo limpia (caracteres de control y de
reordenación bidireccional, espacios, 60 caracteres), React lo escapa al pintarlo y **nunca** se usa para
autorizar. La autorización no depende de ningún dato editable por el usuario.

## Mejora futura (no implementada a propósito): recuperación de contraseña

En la Fase 3 **no hay** "Forgot password" ni cambio de contraseña dentro de la app: los administradores se
gestionan desde Supabase Authentication. El correo integrado de Supabase Free está muy limitado (pocos correos
por hora y solo a miembros de la organización), así que no es fiable para esto. Si más adelante se configura
un SMTP propio gratuito, se podría añadir un flujo de recuperación (`resetPasswordForEmail` + página de nueva
contraseña) y, opcionalmente, un cambio de contraseña autenticado. Requiere aprobar esa fase.
