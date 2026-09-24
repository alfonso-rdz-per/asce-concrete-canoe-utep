import Link from "next/link";
import type { ComponentProps } from "react";

export type ButtonVariant = "primary" | "secondary" | "danger" | "ghost" | "onDark";
export type ButtonSize = "md" | "sm";

const BASE =
  "inline-flex select-none items-center justify-center gap-2 rounded-lg font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 aria-disabled:cursor-not-allowed aria-disabled:opacity-60";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-navy text-white hover:bg-navy-deep",
  secondary: "border border-line bg-white text-navy hover:bg-mist",
  danger: "bg-danger text-white hover:bg-danger-strong",
  ghost: "text-navy hover:bg-mist",
  onDark: "bg-white text-navy hover:bg-mist",
};

// Objetivos táctiles >= 44 px (md = 48 px) y texto >= 16 px en móvil.
const SIZES: Record<ButtonSize, string> = {
  md: "min-h-12 px-5 text-base",
  sm: "min-h-11 px-4 text-sm",
};

export function buttonClasses({
  variant = "primary",
  size = "md",
  fullWidth = false,
}: { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean } = {}): string {
  return `${BASE} ${VARIANTS[variant]} ${SIZES[size]} ${fullWidth ? "w-full" : ""}`.trim();
}

type ButtonOwnProps = { variant?: ButtonVariant; size?: ButtonSize; fullWidth?: boolean };

export function Button({ variant, size, fullWidth, className = "", type = "button", ...props }: ComponentProps<"button"> & ButtonOwnProps) {
  return <button type={type} className={`${buttonClasses({ variant, size, fullWidth })} ${className}`.trim()} {...props} />;
}

export function ButtonLink({ variant, size, fullWidth, className = "", ...props }: ComponentProps<typeof Link> & ButtonOwnProps) {
  return <Link className={`${buttonClasses({ variant, size, fullWidth })} ${className}`.trim()} {...props} />;
}
