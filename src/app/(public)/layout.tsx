import { SiteFooter } from "@/components/brand/SiteFooter";

/** Páginas de estudiantes: el contenido ocupa el alto disponible y el footer queda SIEMPRE al final. */
export default function PublicLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col">{children}</div>
      <SiteFooter />
    </div>
  );
}
