/**
 * Comparación del nombre que escribe el estudiante con el nombre REGISTRADO del miembro (`members.name`, que el administrador
 * escribe como nombre completo). El estudiante solo escribe su nombre de pila ("Max"): no se le pide apellido.
 *
 * Regla: se normaliza (sin acentos, sin mayúsculas, espacios colapsados) y el nombre escrito debe ser el nombre registrado
 * COMPLETO o un prefijo de PALABRAS COMPLETAS de él:
 *     registrado "Max Verstappen"   ->  "Max" ✓   "max verstappen" ✓   "MAX" ✓   "Ma" ✗   "Verstappen" ✗
 *     registrado "María José Pérez" ->  "Maria" ✓   "maría josé" ✓   "Jose" ✗
 * Sin dependencias: se usa tanto en el servidor como en las pruebas.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export function nameMatches(entered: string, registered: string): boolean {
  const e = normalizeName(entered);
  const r = normalizeName(registered);
  if (e.length === 0 || r.length === 0) return false;
  return r === e || r.startsWith(`${e} `);
}
