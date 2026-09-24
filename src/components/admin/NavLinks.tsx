"use client";

import { CalendarDays, ClipboardCheck, LayoutDashboard, Users } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const ITEMS = [
  { href: "/admin", label: "Dashboard", icon: LayoutDashboard, exact: true },
  { href: "/admin/sessions", label: "Sessions", icon: CalendarDays, exact: false },
  { href: "/admin/members", label: "Members", icon: Users, exact: false },
  { href: "/admin/attendance", label: "Attendance", icon: ClipboardCheck, exact: false },
] as const;

export function NavLinks({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <nav aria-label="Main">
      <ul className="space-y-1">
        {ITEMS.map(({ href, label, icon: Icon, exact }) => {
          const active = exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
          return (
            <li key={href}>
              <Link
                href={href}
                onClick={onNavigate}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-12 items-center gap-3 rounded-lg px-4 text-base font-semibold transition-colors ${
                  active ? "bg-blue text-white" : "text-white/85 hover:bg-white/10 hover:text-white"
                }`}
              >
                <Icon aria-hidden="true" className="h-5 w-5 shrink-0" />
                {label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
