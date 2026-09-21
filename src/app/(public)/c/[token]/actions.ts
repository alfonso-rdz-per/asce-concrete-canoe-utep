"use server";

import { cookies, headers } from "next/headers";
import { CHECKIN_MESSAGES, type CheckInState } from "@/lib/checkin/state";
import { rememberDeviceOnServer, revokeDeviceOnServer, submitCheckInOnServer } from "@/lib/checkin/server";
import { DEVICE_COOKIE, DEVICE_COOKIE_PATH, isDeviceTokenFormat } from "@/lib/device-token";
import { parseCheckinForm } from "@/lib/validation/checkin";

/**
 * Check-in del estudiante. PÚBLICO POR DISEÑO (el estudiante no tiene cuenta): por eso NO llama a `requireAdmin` y la lista revisada
 * de seguridad lo exime expresamente. Sus defensas son otras:
 *   - el ticket viaja en el CUERPO (campo oculto del formulario): firmado con HMAC, de 3 min, ligado a una sesión ACTIVA;
 *   - la identidad es ASCE ID + Name o el dispositivo recordado ("Remember me"); en ambos casos se validan el ticket, la sesión
 *     activa, el miembro activo y una asistencia por miembro y sesión. El token del dispositivo NUNCA sustituye al QR;
 *   - límites de fallos por ticket, por ASCE ID y por IP; errores genéricos que no revelan si un miembro existe;
 *   - Next comprueba el origen de la petición (protección CSRF de las Server Actions).
 * La cookie del dispositivo es HttpOnly, solo viaja a /c, y solo se crea si el estudiante marcó "Remember me" Y el check-in salió bien.
 * No devuelve el ticket, el token ni datos del miembro más allá de lo que él escribió o su nombre registrado.
 */
function clientIp(h: Headers): string | null {
  // Detrás del proxy de la plataforma (Vercel) el primer valor de X-Forwarded-For es la IP real del cliente.
  const forwarded = h.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || h.get("x-real-ip")?.trim() || null;
}

/** `Secure` solo cuando la petición llegó por HTTPS (en Vercel siempre); así también funciona la prueba en la red local por http. */
function isHttps(h: Headers): boolean {
  return h.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function setDeviceCookie(store: Awaited<ReturnType<typeof cookies>>, token: string, maxAgeSeconds: number, secure: boolean) {
  store.set(DEVICE_COOKIE, token, { httpOnly: true, sameSite: "lax", secure, path: DEVICE_COOKIE_PATH, maxAge: Math.max(1, maxAgeSeconds) });
}

function clearDeviceCookie(store: Awaited<ReturnType<typeof cookies>>, secure: boolean) {
  store.set(DEVICE_COOKIE, "", { httpOnly: true, sameSite: "lax", secure, path: DEVICE_COOKIE_PATH, maxAge: 0 });
}

export async function checkInAction(_prev: CheckInState, formData: FormData): Promise<CheckInState> {
  const cookieStore = await cookies();
  const h = await headers();
  const secure = isHttps(h);
  const ip = clientIp(h);
  const cookieToken = cookieStore.get(DEVICE_COOKIE)?.value ?? null;

  // --- Con el dispositivo recordado: solo "Check in" (ticket + cookie). Sin campos de identidad.
  if (formData.get("mode") === "remembered") {
    if (!isDeviceTokenFormat(cookieToken)) {
      return { status: "error", ...CHECKIN_MESSAGES.device_unrecognized, forgetDevice: true };
    }
    let result;
    try {
      result = await submitCheckInOnServer({ ticket: formData.get("ticket"), credential: { kind: "device", token: cookieToken }, ip });
    } catch {
      return { status: "error", ...CHECKIN_MESSAGES.unavailable };
    }
    if (result.ok) {
      return { status: "success", name: result.member.name, sessionTitle: result.session.title, checkedInAt: result.checkedInAt, remembered: true };
    }
    if (result.reason === "device_unrecognized") {
      clearDeviceCookie(cookieStore, secure); // ya no vale: se olvida y se vuelve a pedir ASCE ID + Name
      return { status: "error", ...CHECKIN_MESSAGES.device_unrecognized, forgetDevice: true };
    }
    return { status: "error", ...CHECKIN_MESSAGES[result.reason] };
  }

  // --- ASCE ID + Name (y, si lo pidió, recordar este dispositivo tras un check-in correcto).
  const parsed = parseCheckinForm(formData);
  const typed = {
    asceId: typeof formData.get("asceId") === "string" ? (formData.get("asceId") as string).slice(0, 64) : "",
    name: typeof formData.get("name") === "string" ? (formData.get("name") as string).slice(0, 120) : "",
    remember: formData.get("remember") === "on",
  };
  if (!parsed.ok) {
    return { status: "error", message: "Please fix the highlighted fields.", fieldErrors: parsed.fieldErrors, values: typed, canRetry: true };
  }

  let result;
  try {
    result = await submitCheckInOnServer({
      ticket: formData.get("ticket"),
      credential: { kind: "identity", asceId: parsed.data.asceId, name: parsed.data.name },
      ip,
    });
  } catch {
    // Base de datos o configuración caídas: sin detalles hacia el estudiante.
    return { status: "error", ...CHECKIN_MESSAGES.unavailable, values: typed };
  }

  if (result.ok) {
    let remembered = false;
    if (parsed.data.remember) {
      try {
        const device = await rememberDeviceOnServer(result.member.id, cookieToken);
        setDeviceCookie(cookieStore, device.token, device.maxAgeSeconds, secure);
        remembered = true;
      } catch {
        // La asistencia YA está registrada; no recordar el dispositivo no debe convertirse en un error.
      }
    }
    return { status: "success", name: parsed.data.name, sessionTitle: result.session.title, checkedInAt: result.checkedInAt, remembered };
  }
  return { status: "error", ...CHECKIN_MESSAGES[result.reason], values: result.reason === "bad_credentials" ? typed : undefined };
}

/**
 * "Not you? Switch member": olvida este dispositivo (revoca su token en la base de datos y borra la cookie) para poder identificarse
 * como otro miembro. Público por diseño: solo actúa sobre el token de SU PROPIA cookie y no revela nada.
 */
export async function switchMemberAction(): Promise<void> {
  const cookieStore = await cookies();
  const secure = isHttps(await headers());
  const token = cookieStore.get(DEVICE_COOKIE)?.value ?? null;
  clearDeviceCookie(cookieStore, secure);
  try {
    await revokeDeviceOnServer(token);
  } catch {
    // La cookie ya se borró; una revocación fallida solo deja un token inalcanzable que caduca solo.
  }
}
