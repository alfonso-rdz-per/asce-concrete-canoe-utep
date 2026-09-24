import { signOutAction } from "@/app/admin/(shell)/actions";
import { AuthSettingsWarning } from "@/components/admin/AuthSettingsWarning";
import { MobileNav, type ShellUser } from "@/components/admin/MobileNav";
import { NavLinks } from "@/components/admin/NavLinks";
import { BrandMark } from "@/components/brand/BrandMark";
import { SiteFooter } from "@/components/brand/SiteFooter";
import { Avatar } from "@/components/ui/Display";
import type { AuthSettingsProblem } from "@/lib/auth/auth-settings";

/**
 * Estructura del panel: barra lateral navy (escritorio), cabecera con menú (móvil), barra superior con
 * el usuario, contenido sobre superficie clara y footer. Inspirada en la referencia de diseño.
 */
export function AdminShell({
  user,
  problems,
  children,
}: {
  user: ShellUser;
  problems: AuthSettingsProblem[] | null;
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-dvh lg:flex">
      {/* Escritorio: barra lateral */}
      <aside className="on-dark hidden w-64 shrink-0 flex-col gap-8 bg-navy px-4 py-6 text-white lg:sticky lg:top-0 lg:flex lg:h-dvh">
        <BrandMark tone="onDark" size="md" className="px-2" />
        <div className="px-2 text-xs font-semibold uppercase tracking-[0.18em] text-sky">Concrete Canoe Team</div>
        <NavLinks />
      </aside>

      <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
        {/* Móvil: cabecera con menú */}
        <header className="on-dark relative flex items-center justify-between bg-navy px-4 py-2 text-white lg:hidden">
          <BrandMark tone="onDark" size="sm" />
          <MobileNav user={user} signOut={signOutAction} />
        </header>

        {/* Escritorio: barra superior con el usuario */}
        <header className="hidden items-center justify-end gap-4 border-b border-line bg-white px-8 py-3 lg:flex">
          <div className="flex items-center gap-3">
            <Avatar initials={user.initials} tone="onLight" />
            <div className="leading-tight">
              <p className="text-sm font-semibold text-ink">{user.name}</p>
              <p className="text-xs text-muted">{user.email}</p>
            </div>
          </div>
          <form action={signOutAction}>
            <button
              type="submit"
              className="inline-flex min-h-11 items-center rounded-lg border border-line bg-white px-4 text-sm font-semibold text-navy hover:bg-mist"
            >
              Sign out
            </button>
          </form>
        </header>

        <main id="main" tabIndex={-1} className="mx-auto w-full max-w-6xl flex-1 space-y-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <AuthSettingsWarning problems={problems} />
          {children}
        </main>

        <SiteFooter />
      </div>
    </div>
  );
}
