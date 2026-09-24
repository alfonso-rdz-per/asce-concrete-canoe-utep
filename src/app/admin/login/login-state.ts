/** Tipos y textos del login (fuera del archivo "use server", que solo puede exportar funciones asíncronas). */
export type LoginState = { status: "idle" } | { status: "error"; message: string; email?: string };

export const LOGIN_IDLE: LoginState = { status: "idle" };

/** Mensaje único ante cualquier fallo: no revela si el correo existe, si está sin confirmar o baneado. */
export const INVALID_LOGIN = "Invalid email or password.";
