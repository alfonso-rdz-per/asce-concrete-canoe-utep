import type { ComponentProps } from "react";

/**
 * Campos de formulario accesibles: etiqueta visible, ayuda y error enlazados con aria-describedby,
 * aria-invalid, texto >= 16 px (evita el zoom automático de iOS) y altura táctil de 48 px.
 */
const INPUT_CLASSES =
  "block min-h-12 w-full rounded-lg border bg-white px-4 text-base text-ink placeholder:text-muted/70 disabled:bg-mist";

type BaseProps = {
  label: string;
  name: string;
  hint?: string;
  error?: string;
  optional?: boolean;
};

export function TextField({
  label,
  name,
  hint,
  error,
  optional,
  className = "",
  ...input
}: BaseProps & Omit<ComponentProps<"input">, "name" | "id" | "aria-invalid" | "aria-describedby">) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
        {optional ? <span className="ml-1.5 font-normal text-muted">(optional)</span> : null}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${INPUT_CLASSES} ${error ? "border-danger" : "border-line"} ${className}`.trim()}
        {...input}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function TextAreaField({
  label,
  name,
  hint,
  error,
  optional,
  className = "",
  ...area
}: BaseProps & Omit<ComponentProps<"textarea">, "name" | "id" | "aria-invalid" | "aria-describedby">) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
        {optional ? <span className="ml-1.5 font-normal text-muted">(optional)</span> : null}
      </label>
      <textarea
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${INPUT_CLASSES} min-h-28 py-3 ${error ? "border-danger" : "border-line"} ${className}`.trim()}
        {...area}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Casilla con etiqueta y ayuda; el área táctil ocupa toda la fila (>= 48 px). */
/** Casilla simple SIN tarjeta ni contorno: solo la casilla y su texto (alto táctil de 44 px). */
export function CheckboxField({
  label,
  name,
  hint,
  ...input
}: Pick<BaseProps, "label" | "name" | "hint"> & Omit<ComponentProps<"input">, "name" | "id" | "type" | "aria-describedby">) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-base font-semibold text-ink">
        <input id={id} name={name} type="checkbox" aria-describedby={hintId} className="h-5 w-5 shrink-0 accent-blue" {...input} />
        {label}
      </label>
      {hint ? (
        <p id={hintId} className="pl-8 text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Interruptor "Etiqueta [ ●] On/Off" sin tarjeta alrededor. Es una casilla nativa (role="switch"), así que el formulario la envía como
 * cualquier casilla ("on" si está activada) y funciona con teclado y lectores de pantalla. Apagado = gris oscuro, encendido = azul.
 */
export function ToggleField({
  label,
  name,
  hint,
  ...input
}: Pick<BaseProps, "label" | "name" | "hint"> & Omit<ComponentProps<"input">, "name" | "id" | "type" | "role" | "aria-describedby">) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  return (
    <div>
      <label htmlFor={id} className="flex min-h-11 cursor-pointer items-center gap-3 text-base font-semibold text-ink">
        {label}
        <input
          id={id}
          name={name}
          type="checkbox"
          role="switch"
          aria-describedby={hintId}
          className="peer relative h-7 w-12 shrink-0 cursor-pointer appearance-none rounded-full bg-muted transition-colors before:absolute before:left-0.5 before:top-0.5 before:h-6 before:w-6 before:rounded-full before:bg-white before:shadow before:transition-transform before:content-[''] checked:bg-blue checked:before:translate-x-5"
          {...input}
        />
        <span aria-hidden="true" className="text-sm font-medium text-muted peer-checked:hidden">
          Off
        </span>
        <span aria-hidden="true" className="hidden text-sm font-medium text-blue peer-checked:inline">
          On
        </span>
      </label>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Grupo de casillas (se pueden marcar varias) con leyenda visible y SIN tarjeta alrededor. Cada opción es una casilla nativa (teclado,
 * lector de pantalla y envío como cualquier formulario: una pareja `name=value` por casilla marcada); la marcada se resalta en azul.
 */
export function CheckboxGroupField({
  legend,
  name,
  options,
  defaultValues,
  error,
}: {
  legend: string;
  name: string;
  options: ReadonlyArray<{ value: string; label: string }>;
  defaultValues: readonly string[];
  error?: string;
}) {
  const errorId = error ? `field-${name}-error` : undefined;
  return (
    <fieldset aria-describedby={errorId} className="space-y-1.5">
      <legend className="text-sm font-semibold text-ink">{legend}</legend>
      <div className="flex flex-col gap-2 sm:flex-row sm:gap-3">
        {options.map((option) => (
          <label
            key={option.value}
            className="flex min-h-12 flex-1 cursor-pointer items-center gap-3 rounded-lg border border-line bg-white px-4 text-base font-semibold text-ink has-[:checked]:border-blue has-[:checked]:bg-mist has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-blue"
          >
            <input type="checkbox" name={name} value={option.value} defaultChecked={defaultValues.includes(option.value)} className="h-5 w-5 shrink-0 accent-blue" />
            {option.label}
          </label>
        ))}
      </div>
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </fieldset>
  );
}

export function SelectField({
  label,
  name,
  hint,
  error,
  children,
  className = "",
  ...select
}: Omit<BaseProps, "optional"> & Omit<ComponentProps<"select">, "name" | "id" | "aria-invalid" | "aria-describedby">) {
  const id = `field-${name}`;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className="block text-sm font-semibold text-ink">
        {label}
      </label>
      <select
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`${INPUT_CLASSES} ${error ? "border-danger" : "border-line"} ${className}`.trim()}
        {...select}
      >
        {children}
      </select>
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} role="alert" className="text-sm font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}
