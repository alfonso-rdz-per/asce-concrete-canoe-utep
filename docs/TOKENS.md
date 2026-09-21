# Token QR y ticket: qué demuestran y qué no

## La cadena completa

```
QR de 10 s ──▶ demuestra ACCESO al QR mostrado en ese momento
     │
     ▼ (se canjea al abrir la página, con la hora del servidor)
Ticket de 3 min ──▶ permite completar cómodamente la identificación
     │
     ▼ (POST con ticket + ASCE ID + Name, o el dispositivo recordado)
Identidad ──▶ ASCE ID + Name, o "Remember me": el dispositivo dice QUIÉN es el miembro
     │
     ▼ (miembro activo + sesión activa)
Check-in ──▶ una asistencia por miembro y sesión (restricciones de BD)
```

## Aclaración importante sobre el ticket

**El ticket de 3 minutos NO es una prueba adicional de proximidad ni un mecanismo de anti-replay absoluto.**

- La **única** señal de presencia es haber presentado un token QR vigente al canjearlo.
- El ticket existe solo por comodidad: escribir ASCE ID + Name toma 15–40 s, más que la vida
  visible del QR. Sin ticket habría que completar el formulario dentro de esos 10 s.
- Dentro de sus 3 minutos el ticket puede reutilizarse para *intentar* credenciales varias
  veces. Ese abuso lo acota el rate limiting (límite por ticket, por ASCE ID y por IP; ver «Check-in del estudiante»).
- Ninguna de las dos piezas es una prueba criptográfica de distancia física. Es un mecanismo
  práctico de presencia. Un cómplice presente puede reenviar el QR en vivo dentro de la
  ventana; la mitigación es operativa (el administrador ve la lista en vivo y puede eliminar
  un check-in, siempre con rastro en `audit_log`).

### Propiedades que el ticket SÍ tiene

| Propiedad | Cómo se garantiza |
|---|---|
| Firmado | HMAC-SHA256 (clave `ticket`, derivada de `SERVER_SECRET`), 128 bits, comparación en tiempo constante |
| Ligado a una sesión | El MAC cubre `sessionId`; cambiarlo lo invalida |
| Con expiración | 3 min por defecto (`TICKET_TTL_SECONDS`), medidos con la hora del servidor; la fecha de emisión está firmada, no se puede prolongar |
| Sujeto a sesión activa | El servidor comprueba en la BD que la sesión siga `active` al canjear **y** al enviar el check-in; además un trigger impide insertar check-ins fuera de una sesión activa |
| Asociado al check-in | `ticket_nonce` y `token_slot` se guardan en `checkins` (auditoría) |
| Protegido contra reutilización | `UNIQUE(session_id, ticket_nonce)`: un ticket produce como máximo **un** check-in exitoso |

## Token QR

Formato `v1.<sessionId>.<slot>.<mac>` (~55 caracteres → QR de baja densidad).

- `slot = floor(hora_servidor_ms / 10 000)`.
- `mac = HMAC-SHA256(clave "qr", "asce/qr/v1|<sessionId>|<slot>")` truncado a 128 bits.
- **Sin almacenamiento**: no se escribe nada en la base de datos por cada QR. Cerrar la sesión
  invalida todos los tokens porque el servidor exige que la sesión esté `active`.
- **Multiuso dentro de su ventana**, a propósito: el QR se muestra a una sala entera. Un token
  de un solo uso dejaría fuera a casi todos. La unicidad se impone después (un miembro por
  sesión; un ticket por check-in).

### Ventana de validez

```
slotInicio − 1 s  ≤  ahora(servidor)  <  slotInicio + 10 s + gracia
```

Con la gracia por defecto de 5 s (`QR_GRACE_MS`, rango 0–15 000): el token se **muestra** 10 s y
se **acepta** hasta 16 s. La tolerancia previa de 1 s cubre el desfase de dibujado de la pantalla
del administrador. El QR se valida **al escanear** (al canjearlo), no al enviar el formulario.

### Relojes

| Reloj | Papel |
|---|---|
| Servidor | Única autoridad. Toda decisión de validez usa `now` inyectado desde la hora del servidor |
| Teléfono del administrador | Solo dibuja. La cuenta regresiva se ancla a la hora del servidor recibida (fases 4+) |
| Teléfono del estudiante | Irrelevante: nunca se envía ni se consulta |

Los tests demuestran que la decisión depende únicamente del `now` recibido (`tests/unit/tokens.test.ts`).

### Escenarios

| Escenario | Resultado |
|---|---|
| Captura de pantalla usada 30 s después | Rechazada (expirado) |
| Foto reenviada por mensajería, abierta a los 45 s | Rechazada (expirado) |
| El QR cambia mientras se escanea; la petición llega 3,2 s tarde | Aceptada (gracia) |
| 20 estudiantes canjean el mismo token | Todos aceptados (multiuso) |
| Cómplice presente reenvía el QR en vivo (<16 s) | **Aceptada**: límite conocido del diseño |

## Cómo lo usa la Fase 4 (implementado)

| Pieza | Dónde | Qué hace |
|---|---|---|
| Tokens del QR | `GET /api/admin/sessions/[id]/qr` | Solo administradores (401 JSON si no; el proxy no protege `/api`). Devuelve `serverNow` y el token **actual y el siguiente**, únicamente si la sesión está `active` según la BD |
| Pantalla del QR | `/admin/sessions/[id]/qr` | Solo **dibuja**: ancla la cuenta regresiva a `serverNow` (+RTT/2, reloj monótono), cambia de QR en cada límite de 10 s y pide un par nuevo 2 s después. El reloj del dispositivo no interviene |
| QR obsoleto | `src/lib/qr-display.ts` | Si la hora estimada del servidor sale de ambas ventanas, o pasan 8 s sin respuesta correcta, **no se dibuja ningún QR**. Al volver a la pestaña / recuperar la red se descarta el QR guardado y se pide estado fresco |
| Canje | `/c/[token]` → `redeemQr` (`src/lib/checkin/gate.ts`) | MAC + ventana (10 s + gracia 5 s) → sesión `active` en la BD (con `service_role`, solo servidor) → emite el ticket (3 min). Errores pobres: `invalid` / `expired` / `closed` |
| Validación del ticket | `checkTicket` (`gate.ts`) | MAC + 3 min + sesión `active` en la BD. **No mira el slot del QR**: la siguiente rotación no invalida un ticket ya emitido. `submitCheckin` la llama al recibir ASCE ID + Name |
| Cierre | `closeSessionAction` | `active → closed` (definitivo). Desde ese instante el servidor rechaza QR, tickets y check-ins; además la pantalla lo detecta en ≤ 3 s por el sondeo de asistencia (`status` viaja en cada respuesta) |

**Ticket de 3 minutos, independiente del QR.** Escanear en el segundo 8 y tardar 60–90 s en escribir ASCE ID + Name funciona: el ticket
lleva su propia fecha de emisión firmada y no consulta el slot vigente. Si caduca, hay que volver a escanear.
`tests/unit/checkin-gate.test.ts` lo demuestra (ticket válido tras muchas rotaciones y hasta +179,999 s; caducado a +180 s).

**El estudiante no tiene cookie ambiental ni cliente de Supabase.** El ticket viaja en el CUERPO del POST: `/c/[token]` lo deja en un campo oculto del formulario ASCE ID + Name y la Server Action
`checkInAction` lo recibe con los datos; no existe entrada manual de tickets.

**Ubicación (`sessions.location`):** solo texto informativo (1–120 caracteres, sin controles ni caracteres invisibles). No hay GPS,
mapas, coordenadas, Bluetooth, NFC ni Wi-Fi: una prueba comprueba que la tabla `sessions` no tiene ninguna columna de geolocalización.

**Para probar con un teléfono real:** el QR codifica `<origen de esta página>/c/<token>` (la pantalla ya NO muestra el host ni la IP).
Con `localhost` el teléfono no puede abrirlo: abre la pantalla del QR desde la IP de tu PC en la misma red Wi-Fi
(p. ej. `http://192.168.1.20:3000`, arrancando con `next dev -H 0.0.0.0`) o desde un despliegue.

## Check-in del estudiante: ASCE ID + Name (sin PIN)

El estudiante escribe su **ASCE ID** y su **Name** (solo el nombre, sin apellido; etiqueta «Name»). No hay PIN en su flujo.
El servidor (`submitCheckin`, `src/lib/checkin/submit.ts`) comprueba, en este orden y con la hora del servidor:

1. ticket firmado válido, de 3 min y ligado a una sesión `active` (si no: «scan again», sin más detalle);
2. límites de intentos fallidos: **5 por ticket**, **8 por ASCE ID / 15 min**, **20 por IP / 15 min** (la IP se guarda solo como HMAC
   con la clave derivada `ip`; nunca en claro);
3. el miembro existe, está **activo** y el nombre escrito coincide con el registrado (`src/lib/member-name.ts`: sin acentos ni
   mayúsculas, espacios colapsados; vale el nombre completo o uno o más nombres COMPLETOS del principio: «Max» o «Max Verstappen»,
   nunca «Ma»);
4. inserción con `UNIQUE(session_id, member_id)` y `UNIQUE(session_id, ticket_nonce)` (una asistencia por miembro y un ticket por check-in).

**Anti-enumeración:** ASCE ID inexistente, miembro inactivo y nombre incorrecto devuelven el MISMO mensaje genérico («ASCE ID or name
is incorrect…») y hacen el mismo trabajo; el resultado no revela si un miembro existe. Cada intento (éxito o fallo) queda en
`checkin_attempts` (auditoría + base de los límites).

**Honestidad sobre la fuerza del «Name»:** un nombre de pila NO es un secreto fuerte (mucha gente conoce el nombre de sus
compañeros). El control real contra suplantaciones es la combinación de: QR vigente en el aula, ticket de 3 min, límites de
intentos, una sola asistencia por miembro y sesión, y la revisión del administrador (lista en vivo; puede corregir o eliminar con
rastro en `audit_log`). Es una decisión de producto del equipo: ya no existe ningún PIN que memorizar o repartir.

## Remember me on this device (dispositivo recordado)

Opcional: en el formulario, «Remember me on this device». Si el estudiante lo marca **y el check-in sale bien**, el dispositivo recuerda
a ese miembro; en las siguientes reuniones el flujo es **QR → «Checking in as <nombre>» → Check in**, sin volver a escribir ASCE ID ni Name.
«Not you? Switch member» olvida el dispositivo y vuelve al formulario ASCE ID + Name.

**Qué se guarda y dónde (el dispositivo NO guarda credenciales):**

| Pieza | Detalle |
|---|---|
| Token | 256 bits aleatorios (CSPRNG) con formato `d1.<43 caracteres base64url>`. Identificador opaco: sin ASCE ID, nombre, fechas ni datos de la sesión |
| Cookie `asce_device` | **HttpOnly** (JavaScript no la lee), `SameSite=Lax`, ruta `/c` (solo las páginas del estudiante: nunca el panel ni la API), `Secure` cuando la petición llega por HTTPS (siempre en Vercel; en la prueba por Wi-Fi local con http no se marca porque el navegador la rechazaría). **Nada en localStorage/sessionStorage** |
| Base de datos | Tabla `member_devices` (solo `service_role`; ni anon ni administradores la leen). Guarda únicamente el **HMAC-SHA256 del token** con una clave derivada de `SERVER_SECRET` (`device`, separada de QR/ticket/IP): un volcado de la tabla no permite reconstruir ningún token. Un CHECK impide guardar un valor que no sea un hash de 64 hex |
| Vida | 180 días desde el último uso (se renueva en cada check-in con ese dispositivo), con tope absoluto de 365 días desde la creación |
| Límite | 5 dispositivos vigentes por miembro; al añadir uno nuevo se revocan los más antiguos. Se purgan filas revocadas/caducadas de más de 30 días |

**Revocación:**
- «Not you? Switch member»: revoca ese token en la BD y borra la cookie.
- Recordar a otro miembro en el mismo teléfono revoca el token anterior de esa cookie.
- **Desactivar al miembro** revoca todos sus dispositivos (trigger de la BD, con independencia del código de la app); reactivarlo NO los revive.
- Un token desconocido, revocado o caducado simplemente no se reconoce: se pide ASCE ID + Name otra vez, con un mensaje genérico.
- Rotar `SERVER_SECRET` deja de reconocer todos los dispositivos (nadie pierde nada: se identifican de nuevo).

**Lo que el token NO permite (no es un sustituto del QR):** el flujo sigue siendo
`QR válido → ticket válido → identidad del dispositivo → miembro ACTIVO → sesión ACTIVA → asistencia`.
Sin un ticket auténtico y vigente ni se mira el token; un ticket caducado, de una sesión cerrada o ya usado se rechaza igual; sigue habiendo
UNA asistencia por miembro y sesión y un ticket por check-in (anti-replay); los tokens malos cuentan como fallos en los límites por ticket
e IP; y un miembro inactivo no entra. Quien tenga el teléfono desbloqueado de otra persona puede registrar SU asistencia estando frente al QR
(igual que con cualquier «recordarme»): por eso existe «Switch member» y el administrador ve la lista en vivo y puede corregirla con rastro en `audit_log`.

## PIN: eliminado del sistema

El PIN dejó de existir (no solo del flujo del estudiante): ya no hay `members.pin_hash` (migración `20260919000900_drop_member_pin.sql`), ni «Reset PIN»,
ni diálogo de PIN de un solo uso, ni `PIN_PEPPER`, ni la clave derivada `pin`, ni el helper `pin.ts`. Las variables `PIN_PEPPER` antiguas que aún
estén en `.env.local` o en Vercel se ignoran y se pueden borrar. Una prueba estática (`tests/unit/no-pin-static.test.ts`) impide que reaparezca.
