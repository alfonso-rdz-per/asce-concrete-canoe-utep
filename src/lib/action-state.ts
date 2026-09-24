/**
 * Estado que devuelven las Server Actions al formulario (todo texto visible, en inglés).
 * En los errores se devuelven los valores escritos (`values`) porque React 19 reinicia el formulario
 * tras cada acción: así el usuario no pierde lo que había tecleado. Nunca incluyen secretos ni contraseñas.
 * Los campos se identifican por nombre (formularios de miembros y de sesiones).
 */
export type FieldMessages = Partial<Record<string, string>>;

export type ActionState =
  | { status: "idle" }
  | { status: "error"; message: string; fieldErrors?: FieldMessages; values?: FieldMessages }
  | { status: "success"; message?: string };

export const IDLE: ActionState = { status: "idle" };
