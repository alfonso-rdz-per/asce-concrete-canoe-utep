/**
 * Cargos (positions) del equipo. Módulo SIN dependencias: lo usan el formulario (cliente) y la
 * validación (servidor). Lo que se guarda en la base de datos es el cargo final como texto: uno de
 * los predefinidos o, si se eligió "Other", el texto personalizado.
 */
export const OTHER_POSITION = "Other";
export const DEFAULT_POSITION = "Member";
export const POSITION_MAX = 60;

export const POSITION_OPTIONS = [
  "Member",
  "Project Manager",
  "Project Engineer",
  "Construction/Foreman Officer",
  "Safety Officer",
  "Aesthetics & QA/QC Officer",
  "Structural Analysis Engineer",
  "Mix Design Engineer",
  "Testing Engineer",
  OTHER_POSITION,
] as const;

const PRESETS: readonly string[] = POSITION_OPTIONS.filter((p) => p !== OTHER_POSITION);

/** Cargo predefinido con la grafía canónica, o undefined si no es uno de la lista (sin distinguir mayúsculas). */
export function canonicalPreset(value: string): string | undefined {
  const wanted = value.trim().toLowerCase();
  return PRESETS.find((p) => p.toLowerCase() === wanted);
}

/** Convierte el cargo guardado en lo que muestra el formulario: opción del desplegable + texto libre. */
export function splitPosition(stored: string | null | undefined): { preset: string; custom: string } {
  const value = (stored ?? "").trim();
  if (value === "") return { preset: DEFAULT_POSITION, custom: "" };
  const preset = canonicalPreset(value);
  return preset ? { preset, custom: "" } : { preset: OTHER_POSITION, custom: value };
}
