# Propuesta de Fase 3 — ASCE | UTEP Concrete Canoe Team · Check-In

Estado: **APROBADA con decisiones definitivas** (joined_on se conserva al reactivar; sin editar display_name; sin recuperación de contraseña; Playwright + axe aprobados) e **implementada**. Documento histórico: lo realmente implementado está en el README y en docs/ADMIN-ACCESS.md.
Interfaz final: **100 % en inglés.** Este documento está en español porque es para el equipo de desarrollo.

> **Cambios posteriores (documento histórico):** el check-in del estudiante ya NO usa PIN sino **ASCE ID + Name** (ver `docs/TOKENS.md`), y «New Session» solo pide **Session Name** + **Required** (la fecha/hora y quién la abrió los guarda el servidor). Donde este documento habla de PIN en el flujo del estudiante o de Description/Location/Scheduled date al crear una sesión, prevalece lo indicado aquí.

## 0. Resumen ejecutivo

1. **Regla de administradores (cambio de arquitectura de seguridad, explicado en §B).** Cualquier usuario de Supabase Auth
   *confirmado, no anónimo, no baneado y no borrado* es administrador. Se implementa **leyendo `auth.users` desde
   `private.is_admin()`** y eliminando `public.admins`. RLS, permisos por columna y demás protecciones se mantienen.
2. **`display_name`** sale de `user.user_metadata.display_name` (los 3 usuarios actuales ya lo tienen). Sin tabla nueva.
3. **Tu pedido A–P abarca lo que antes eran las fases 3 a 6.** Para respetar *AUDITAR → PROPONER → APROBAR → … → DETENERSE*,
   propongo cortarlo en **4 entregas**, cada una con su parada (ver §0.1). Este documento diseña todo; solo se implementa lo que apruebes.
4. **Logos:** no existen como archivos en el proyecto (la imagen de referencia es un tablero compuesto, no una fuente de assets).
   Se usarán **marcadores de posición claramente rotulados** hasta que aportes los archivos oficiales (lista exacta en §J).
5. **Migraciones nuevas:** una en la Fase 3 (admin desde Auth), una en la Fase 4 (`sessions.location`), una en la Fase 6 (vista de asistencia).
   Ninguna se ejecuta hasta que apruebes la fase correspondiente. Las migraciones 1 y 2 (ya aplicadas) **no se editan**.

### 0.1 Cortes propuestos

| Entrega | Contenido | Migración |
|---|---|---|
| **Fase 3** | Sistema de diseño + marca + footer, acceso de administradores (login/logout), shell del panel, dashboard base, **Miembros (CRUD con PIN de un solo uso)**, página de inicio para estudiantes, CSP con nonce, textos en inglés | `…_admins_from_auth_users.sql` |
| **Fase 4** | Sesiones (crear/editar/abrir/cerrar, con *Location*), **pantalla del QR con rotación de 10 s**, asistencia en vivo, métricas del dashboard | `…_session_location.sql` |
| **Fase 5** | **Check-in del estudiante** (`/c/[token]` → ticket → ASCE ID + PIN → confirmación), rate limiting en Postgres, intentos auditados | ninguna (usa el esquema existente; añade el propósito de clave `ip` en código) |
| **Fase 6** | Historial, **porcentaje de asistencia por miembro**, eliminar check-in con auditoría | `…_attendance_stats.sql` |

---

## A. Arquitectura actual (auditada)

```
Next.js 16.3.5 (App Router, Turbopack) ── hoy: una página provisional en español (`lang="es"`)
 └─ src/lib   tokens.ts · tickets.ts · pin.ts · time.ts · env.ts · crypto/{keys,ids,server-keys}.ts · supabase/admin.ts
                (todo probado; `admin.ts` = cliente service_role, server-only)
Supabase (Postgres 17.6, plan Free) ── 6 tablas: admins(0 filas) · members · sessions · checkins · checkin_attempts · audit_log
 ├─ RLS en todas · private.is_admin() (lee public.admins) · permisos por columna (pin_hash ilegible)
 └─ 7 triggers de integridad (sesión draft→active→closed, check-in solo en sesión activa, inmutabilidad, auditoría…)
Auth ── 3 usuarios (confirmados, no anónimos, sin bans; los 3 con display_name) · registros públicos y anónimos CERRADOS
Pruebas ── 169 locales (Postgres 17 real embebido) + 40 contra Supabase real (`npm run test:supabase`)
```

**Lo que NO existe todavía:** `@supabase/ssr`, `proxy.ts`, sesión de administrador en la app, componentes de UI, tokens de diseño,
cualquier texto en inglés, `sessions.location`. La UI real es 100 % trabajo nuevo.

## B. Autenticación de administradores

### B.1 La regla nueva y por qué cambia la arquitectura de seguridad

Hoy hay **dos candados independientes**: (1) existir en Auth y (2) tener una fila en `public.admins`. Tu regla elimina el (2).
Queda **un único candado: quién puede crear/confirmar usuarios en Supabase Auth.** Eso es aceptable y sencillo *si* ese candado
se mantiene cerrado. Estado auditado hoy: `disable_signup = true`, anónimos desactivados, ningún proveedor OAuth, confirmación de correo activada.

### B.2 Solución recomendada (B): `is_admin()` lee `auth.users`; se elimina `public.admins`

```sql
-- (ilustrativo; no se ejecuta hasta aprobar) migración 3
create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from auth.users u
     where u.id = (select auth.uid())
       and u.email is not null and u.email_confirmed_at is not null
       and not u.is_anonymous and u.deleted_at is null
       and (u.banned_until is null or u.banned_until <= now())
  )
$$;
drop table public.admins;   -- 0 filas en local y en Supabase real
```

- **Los 3 usuarios actuales son administradores al aplicarla**, y cualquier usuario futuro creado en el panel de Supabase también,
  sin insertar nada a mano.
- **Revocación inmediata:** borrar o banear a un usuario en Supabase lo deja sin acceso en la *siguiente* petición aunque su JWT siga
  vigente (la función consulta la base cada vez; no depende del token).
- **No se expone nada de `auth.users`:** la función es `SECURITY DEFINER` con `search_path` vacío, devuelve solo un booleano
  y sigue sin ser invocable por `anon`. La app nunca lee `auth.users`.
- `create or replace` conserva los permisos y las políticas existentes: **ninguna política RLS cambia**.

### B.3 Alternativas descartadas

| Alternativa | Por qué no |
|---|---|
| **A. Mantener `admins` + trigger que la sincroniza desde `auth.users`** | Dos fuentes de verdad; hay que cubrir INSERT, confirmación (UPDATE), baneo y borrado; el trigger sobre `auth.users` es más frágil. Solo ganaría "defensa en profundidad" que tu regla renuncia deliberadamente. |
| **C. Claim `app_metadata.role = admin`** | Habría que marcar a cada usuario a mano: contradice tu requisito. |

### B.4 Compensaciones que propongo (para que el único candado no se degrade en silencio)

1. **Prueba automática de configuración** (en `npm run test:supabase`): falla si `disable_signup` deja de ser `true`, si se activan los
   inicios anónimos o algún proveedor OAuth.
2. **Aviso opcional en el dashboard** *(necesita tu OK)*: si `/auth/v1/settings` indica registros abiertos, el panel muestra
   "Sign-ups are enabled in Supabase — every new account becomes an admin." (consulta pública, en caché 5 min).
3. **Regla operativa documentada** (`docs/ADMIN-ACCESS.md`): en este proyecto de Supabase solo se crean usuarios que deban ser administradores.

### B.5 Flujo de inicio de sesión

- `/admin/login`: correo + contraseña → Server Action → `signInWithPassword` **en el servidor**. Error genérico
  ("Invalid email or password."). Sin registro, sin "olvidé mi contraseña" (ver decisiones: el correo integrado de Supabase Free es muy limitado).
- Sesión con `@supabase/ssr` **solo en servidor**: cookies `HttpOnly; Secure; SameSite=Lax`. **No hay cliente Supabase en el navegador**
  (así la clave anon ni siquiera viaja en el bundle). Refresco de token en `src/proxy.ts`.
- **Tres capas de comprobación:** (1) `proxy.ts`: redirección optimista y CSP; (2) *Data Access Layer* `requireAdmin()` que llama a
  `supabase.auth.getUser()` (valida el JWT contra Auth) una vez por petición, con `cache()` de React; (3) **cada Server Action y cada
  Route Handler vuelve a llamar a `requireAdmin()`** (la documentación de Next avisa de que las acciones son alcanzables por POST directo).
  La autoridad final sigue siendo RLS.
- `next` tras el login: solo rutas internas bajo `/admin` (validación anti open-redirect).
- Cerrar sesión: Server Action POST.

## C. Panel de administración

Navegación (sidebar en escritorio, cabecera + menú en móvil, como en la referencia): **Dashboard · Sessions · Members · Attendance**.
No se incluyen "Team" ni "Settings" de la referencia (fuera de alcance).

| Ruta | Contenido | Fase |
|---|---|---|
| `/admin/login` | Formulario de acceso con marca `ASCE | UTEP` | 3 |
| `/admin` | "Welcome, {first name}", tarjetas (Active members; luego Today/This week), sesión activa, últimos check-ins | 3 base · 4 métricas |
| `/admin/members` · `/new` · `/[id]/edit` | Lista con búsqueda y filtro Active/Inactive/All; alta; edición; desactivar/reactivar; reiniciar PIN | 3 |
| `/admin/sessions` · `/new` · `/[id]` · `/[id]/qr` | Ver §E y §F | 4 |
| `/admin/attendance` | Historial y porcentajes (§H) | 6 |

Estados vacíos, errores y confirmaciones destructivas (desactivar, reiniciar PIN, cerrar sesión de asistencia) con `<dialog>` nativo.

## D. Miembros (Fase 3)

- **Crear:** ASCE ID (normalizado: recortado y en mayúsculas, mismo patrón que la BD), Name, Email (opcional), Joined on (por defecto hoy en
  El Paso). El **servidor genera el PIN** (`generatePin`), lo hashea (`hashPin` + pepper) y lo muestra **una sola vez** en un diálogo
  ("Share this PIN with {name} now. It won't be shown again.") con botón Copy. No se guarda en el cliente ni en la URL.
- **Editar:** nombre, correo, ASCE ID, fecha de ingreso. **Reset PIN** genera uno nuevo (mismo diálogo de un solo uso).
- **Desactivar / reactivar:** desactivar fija `deactivated_on` = hoy (America/Denver). *Pregunta abierta:* al reactivar, ¿se reinicia
  `joined_on` a hoy para no penalizar el periodo inactivo en el porcentaje? (recomendado: sí, editable).
- **Ver:** tabla en escritorio, tarjetas en móvil, con badge Active/Inactive y el porcentaje cuando exista (Fase 6).
- Acceso a datos por un módulo `server-only` con **lista explícita de columnas** (`select *` falla por diseño: `pin_hash`).
- Errores de BD (`23505`, `23514`, `asce:*`) → mensajes en inglés ("That ASCE ID is already registered."). Nunca se muestra un error crudo.

## E. Sesiones (Fase 4)

Campos: **Title**, **Description**, **Location** (texto informativo: *no* GPS ni verificación), **Scheduled date/time**, **Required / Optional**, **Status**
(Draft → Active → Closed). Crear/editar en *draft*; **Open attendance** (una sola activa, ya impuesto por la BD); **Close attendance** con
confirmación (irreversible: una sesión cerrada no se reabre). Lista con filtros por estado; detalle con asistentes.
La ubicación se muestra en el detalle, en la pantalla del QR y en la confirmación del estudiante. *(Migración 4: columna `location`.)*

## F. Pantalla del QR (Fase 4)

- `GET /api/admin/sessions/[id]/qr` (solo administradores, `no-store`) devuelve `{ current, next, serverNow }` con los tokens ya existentes
  (`issueQrTokens`). El navegador **no genera ni valida** nada: solo dibuja.
- **Rotación de 10 s anclada al servidor:** la cuenta atrás usa `performance.now()` a partir de `serverNow` (compensando la mitad del RTT); el
  reloj del teléfono del administrador no interviene. El cambio al token `next` es atómico y sin animación; se pide el siguiente par ~2 s antes.
  Si se pierde la conexión y el intervalo termina, **el QR se oculta** ("Reconnecting…") en lugar de mostrar uno vencido. Al volver a la pestaña se resincroniza.
- QR con `qrcode.react` (SVG, corrección M, margen de 4 módulos, **siempre negro sobre blanco**), tamaño `min(92vw, 78dvh)`, botón de pantalla
  completa, **Screen Wake Lock** para que el iPhone no se bloquee. URL = `origin + /c/<token>`; sin scanner ni entrada manual.
- Encabezado de la pantalla: título de la sesión, *Location*, contador "Expires in 7s", "Attendees: 18".

## G. Check-in del estudiante (Fase 5; diseño aquí para validar la experiencia)

1. Cámara nativa → abre `/c/<token>`.
2. El servidor valida el token (HMAC → vigencia → sesión `active` en la BD). Si falla: "This QR code has expired. Scan the code currently shown by your admin."
3. Si es válido emite un **ticket firmado de 3 min** (no una prueba de proximidad; ver `docs/TOKENS.md`) y muestra el formulario **ASCE ID + PIN**.
4. Server Action: verifica ticket, sesión activa, miembro y PIN (`verifyPin`/`verifyPinDummy`), aplica rate limiting (Postgres) e inserta el check-in.
5. Confirmación **"Check-in successful!"**: nombre, sesión, fecha, hora y *Location*.
6. Errores genéricos ("ASCE ID or PIN is incorrect.") sin distinguir qué falló.

`/` (Fase 3) es la entrada sin token: instrucciones ("Open your phone camera and scan the QR code shown by your team admin"), sin botón de escaneo.

## H. Asistencia (Fase 4 en vivo · Fase 6 historial y %)

- **En vivo:** sondeo cada 3 s a `GET /api/admin/sessions/[id]/attendance` (sin Realtime, por decisión previa).
- **Historial:** por sesión (asistentes/ausentes) y por miembro; eliminar un check-in (solo admin, con confirmación, siempre auditado).
- **Porcentaje:** sesiones `closed` + `required` desde `joined_on` (y hasta `deactivated_on`), más cualquier sesión a la que asistió; vista SQL (migración 5).

## I. Nombre visible (`display_name`)

`getDisplayName(user)` → `user.user_metadata.display_name` recortado (1–60 caracteres, sin caracteres de control ni de reordenación bidireccional);
si falta, la parte local del correo. Saludo: **"Welcome, {primera palabra}"**. Menú de usuario: nombre completo + correo + avatar con iniciales.
`user_metadata` **lo puede editar el propio usuario**, así que se trata como texto no confiable (React lo escapa) y **nunca** se usa para autorizar.
No se leen nombres de otros administradores (no se lee `auth.users`); por eso no se mostrará "opened by {name}".

## J. Marca

- **Un único componente `BrandMark`** dibuja `[ASCE] | [UTEP]` (dos variantes: sobre fondo oscuro y sobre claro). Nada más en la app renderiza "ASCE" suelto.
  Aparece en: cabecera de estudiante, login, cabecera/sidebar del panel, pantalla de confirmación y footer.
- **Assets que necesito de ti (no invento ni genero logos):**
  `public/brand/asce-logo.svg` y `asce-logo-white.svg`, `public/brand/utep-logo.svg` y `utep-logo-white.svg` — horizontales, fondo transparente,
  SVG preferido (o PNG ≥ 640 px de ancho). Fuentes oficiales: guía de marca de ASCE para capítulos y portal de marca de UTEP. **Confirma que tu
  capítulo tiene permiso de uso.** Mientras tanto, `LogoSlot` muestra un recuadro discontinuo rotulado "ASCE logo" / "UTEP logo".
  "Concrete Canoe Team" se escribe como texto tipográfico normal (es un nombre, no un logo).
- **Footer** (`SiteFooter`, en todas las páginas visibles): `ASCE | UTEP` en monocromo pequeño + `Instagram · @asceconcretecanoe` enlazado a
  `https://www.instagram.com/asceconcretecanoe/` (`target="_blank" rel="noopener noreferrer"`, texto discreto). En páginas de estudiante queda al fondo
  (`min-h-dvh` + `mt-auto`, con `safe-area-inset-bottom` en iPhone). *No he podido verificar que esa cuenta exista.*
- El favicon actual es el de Next; se sustituirá cuando haya logo oficial (no se fabrica uno).

## K. Diseño responsivo

| | iPhone / Android | Escritorio |
|---|---|---|
| Estudiante | 1 columna `max-w-md`, botones ≥ 48 px, `dvh` y safe-area, inputs ≥ 16 px (sin zoom en iOS), PIN `inputmode="numeric"` enmascarado, ASCE ID en mayúsculas sin autocorrección | Tarjeta centrada, mismo flujo |
| Admin | Cabecera + menú desplegable, tablas → tarjetas, QR ocupa el ancho | Sidebar fija, tablas, modo pantalla completa del QR para proyector |

Solo tema claro (la referencia lo es; se elimina el modo oscuro del scaffold). Contraste medido (WCAG): blanco sobre navy **12,6:1**, blanco sobre azul de acción
**6,7:1**, navy sobre superficie **11,8:1**; texto secundario ≥ 4,5:1. Foco visible, `aria-live` en errores, `prefers-reduced-motion` respetado (las olas son estáticas).
Matriz objetivo: Safari iOS 17+, Chrome Android, Chrome/Edge/Safari de escritorio.

## L. Seguridad

**Se mantiene íntegro:** HMAC-SHA256, autenticidad antes de vigencia, tiempo constante, separación de dominio QR/ticket, `UNIQUE(session_id, ticket_nonce)`,
scrypt + pepper, `verifyPinDummy`, RLS en todas las tablas, `anon` sin acceso, `pin_hash` ilegible, `audit_log` de solo inserción, ciclo de sesiones,
marcas de tiempo fijadas por la BD, sin check-in fuera de sesión activa ni de miembros inactivos, check-ins inmutables, auditoría al eliminar,
guarda contra NaN, `server-only` para `service_role`.

**Nuevo en la Fase 3:** regla de admin desde Auth y sus compensaciones (§B) · cookies HttpOnly y **sin cliente Supabase en el navegador** ·
`requireAdmin()` dentro de cada acción · validación zod + mensajes en inglés (nunca errores crudos) · PIN de un solo uso y `no-store` ·
**CSP con nonce** (pendiente desde la Fase 0; obliga a renderizado dinámico en todas las rutas, sin coste relevante) · anti open-redirect ·
`display_name` tratado como texto no confiable · sin enlaces externos salvo Instagram con `noopener noreferrer`.

**Recomendación opcional (necesita tu OK):** trigger de auditoría sobre `members` que registre crear/desactivar/reactivar/reiniciar PIN
(sin valores de `pin_hash`). Añadiría una segunda migración en la Fase 3.

## M. Cambios de base de datos

| Migración | Fase | Contenido |
|---|---|---|
| `2026…_admins_from_auth_users.sql` | 3 | `create or replace private.is_admin()` leyendo `auth.users`; `drop table public.admins` |
| *(opcional)* `2026…_members_audit.sql` | 3 | trigger de auditoría de miembros |
| `2026…_session_location.sql` | 4 | `sessions.location text` (nulo o 1–120 caracteres) + `grant insert/update (location)` para `authenticated` |
| `2026…_attendance_stats.sql` | 6 | vista/función del porcentaje de asistencia |

Las migraciones 1 y 2 **no se tocan**. Ninguna se ejecuta sin aprobación. La 3 se aplica en Supabase real con el mismo procedimiento verificado por hash.

## N. Archivos (Fase 3)

**Crear**
- `supabase/migrations/2026…_admins_from_auth_users.sql`
- `src/proxy.ts` · `src/lib/supabase/server.ts` · `src/lib/auth/{session,is-admin,display-name,safe-redirect}.ts`
- `src/lib/data/members.ts` · `src/lib/validation/member.ts` · `src/lib/errors.ts`
- `src/app/(public)/{layout,page}.tsx` · `src/app/(admin)/admin/{layout,page}.tsx` · `admin/login/{page,actions}.tsx` · `admin/members/{page,actions}.tsx` + `new/` + `[id]/edit/`
- `src/app/{not-found,error}.tsx` (en inglés)
- `src/components/brand/{BrandMark,LogoSlot,SiteFooter,WaveDivider}.tsx`
- `src/components/ui/{Button,Card,Field,Input,Badge,Alert,EmptyState,ConfirmDialog,Avatar,PageHeader,DataList}.tsx`
- `src/components/admin/{AdminShell,SideNav,MobileNav,UserMenu,MemberForm,MemberList,PinRevealDialog}.tsx`
- `public/brand/README.md` (especificación de assets; sin logos)
- Tests (§O) · `docs/ADMIN-ACCESS.md`

**Modificar**
`src/app/layout.tsx` (`lang="en"`, metadatos, fuente) · `src/app/globals.css` (tokens de diseño, sin modo oscuro) · `next.config.ts` (la CSP pasa a `proxy.ts`) ·
`package.json` (dependencias/scripts) · `vitest.config.mts` (proyecto `ui`) · `tests/db/{supabase-shim.sql,helpers.ts,rls.test.ts}` ·
`tests/supabase/{real.test.ts}` · `scripts/supabase-validation/prepare.mjs` · `docs/SETUP.md` · `README.md`

**Eliminar**
`tests/supabase/promote-admin.sql` (ya no hace falta) · `src/app/page.tsx` actual (se reemplaza por `(public)/page.tsx`). La tabla `public.admins` desaparece por la migración.

**Dependencias nuevas (todas gratuitas):** `@supabase/ssr` (MIT), `lucide-react` (ISC, iconos de línea como en la referencia), `@fontsource-variable/inter` (OFL, autoalojada:
sin Google Fonts); de desarrollo: `@testing-library/react`, `@testing-library/user-event`, `jsdom`. Sin librerías de componentes.

## O. Pruebas

- **BD local (Postgres real):** matriz de `is_admin()` (confirmado ✓; sin confirmar, anónimo, baneado, borrado, sin correo, uid inexistente ✗; ban vencido ✓); la
  tabla `admins` ya no existe; los 3 tipos de usuario pasan/fallan igual que antes en RLS; revocación inmediata al borrar. El `shim` de `auth.users` gana las columnas reales.
- **Unitarias:** `getDisplayName`/saludo (respaldos, caracteres de control, longitud) · `isAdminUser` con la **misma matriz** que la BD (prueba de paridad) ·
  anti open-redirect (`//evil.com`, `/\evil`, `javascript:`) · esquemas zod de miembros · mapeador de errores → inglés · **guarda de idioma**
  (ningún texto en español en `src/app` ni `src/components`) · `BrandMark` como único lugar con "ASCE" · footer con href/rel exactos.
- **UI (jsdom):** `MemberForm` (mensajes en inglés), `PinRevealDialog` (se muestra una vez y se borra), `ConfirmDialog`, navegación activa, login (error genérico).
- **Supabase real (`test:supabase` ampliada):** los usuarios confirmados son admin (crean/editan miembros vía la capa de datos); sin confirmar no inician sesión;
  **baneado y borrado quedan denegados aunque su JWT siga vigente**; guardas de configuración (registros, anónimos, OAuth); `pin_hash` nunca se devuelve.
- **Opcional (necesita tu OK):** Playwright con perfiles iPhone/Pixel/escritorio + axe (accesibilidad): login → alta de miembro → PIN → editar → desactivar, y capturas.

## P. Cómo se usa la imagen de referencia

**Se toma (lenguaje visual):** hero azul marino con titular grande y tarjeta blanca superpuesta · "Check-In" como protagonista · botones anchos y claros ·
pantalla de éxito centrada (icono de check, tarjeta resumen, botón único) · dashboard con sidebar navy y fila activa azul, barra superior con chip de usuario,
tarjetas de métricas y tabla limpia · olas y una pequeña silueta de canoa **solo** en el hero/éxito · versión móvil con cabecera y menú.
**Paleta medida** en la imagen: navy `#003070` · azul de acción `#0060B0` · ola azul `#004088`/`#3A98E2` · cian/azul claro para acentos · superficies `#F0F8FF`/blanco.
Tipografía: sans geométrica de peso alto en títulos (Inter variable, autoalojada). Iconos de línea (lucide).

**No se toma:** los logos ni la foto de los remeros · las ilustraciones tal cual (olas y canoa se dibujan como SVG propio, simple) · el **escáner QR interno** y **"Ingresar código de ticket"**
(descartados) · "Team"/"Settings" · los textos en español · el significado de "Ubicación" como lugar verificado. Copia en inglés derivada de la referencia:
*"Check-In — Register your attendance and be part of the team."*

---

## Decisiones que necesito de ti

**Bloquean la Fase 3**
1. ¿Apruebas la solución B (`is_admin()` lee `auth.users`, se elimina `public.admins`) y las compensaciones de §B.4 (incluido el aviso opcional del dashboard)?
2. ¿Apruebas cortar el trabajo en las 4 entregas de §0.1?
3. **Logos:** ¿puedes dejar en `public/brand/` los 4 archivos de §J y confirmar el permiso de uso? Si no, seguimos con marcadores rotulados.

**Asumiré estos valores por defecto salvo que digas lo contrario**
4. Al reactivar un miembro se reinicia `joined_on` a hoy (editable).
5. Saludo con la primera palabra de `display_name`; respaldo: parte local del correo (el correo completo solo en el menú de usuario).
6. Solo tema claro; fuente Inter autoalojada; sin librería de componentes.
7. Sin "Forgot password" ni cambio de contraseña dentro de la app: se gestionan desde el panel de Supabase.
8. Los comentarios de código siguen en español; **todo texto visible al usuario, en inglés**.
9. Sin trigger de auditoría de miembros ni Playwright/axe **salvo que los apruebes**.
