"use client";

import { Menu, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { NavLinks } from "@/components/admin/NavLinks";
import { Avatar } from "@/components/ui/Display";

export interface ShellUser {
  name: string;
  email: string;
  initials: string;
}

/** Menú desplegable para móvil (patrón de divulgación accesible: botón + región, Escape cierra). */
export function MobileNav({ user, signOut }: { user: ShellUser; signOut: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <div>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls="mobile-nav-panel"
        aria-label={open ? "Close menu" : "Open menu"}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-12 w-12 items-center justify-center rounded-lg text-white hover:bg-white/10"
      >
        {open ? <X aria-hidden="true" className="h-6 w-6" /> : <Menu aria-hidden="true" className="h-6 w-6" />}
      </button>

      {open ? (
        <div id="mobile-nav-panel" className="absolute inset-x-0 top-full z-40 space-y-4 border-t border-white/15 bg-navy p-4 shadow-card">
          <NavLinks onNavigate={() => setOpen(false)} />
          <div className="flex items-center gap-3 border-t border-white/15 pt-4">
            <Avatar initials={user.initials} />
            <div className="min-w-0">
              <p className="truncate font-semibold text-white">{user.name}</p>
              <p className="truncate text-sm text-white/75">{user.email}</p>
            </div>
          </div>
          <form action={signOut}>
            <button
              type="submit"
              className="inline-flex min-h-12 w-full items-center justify-center rounded-lg bg-white px-5 text-base font-semibold text-navy hover:bg-mist"
            >
              Sign out
            </button>
          </form>
        </div>
      ) : null}
    </div>
  );
}
