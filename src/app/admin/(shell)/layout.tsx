import { AdminShell } from "@/components/admin/AdminShell";
import { getAuthSettingsProblems } from "@/lib/auth/auth-settings.server";
import { getDisplayName, getInitials } from "@/lib/auth/display-name";
import { requireAdmin } from "@/lib/auth/session";

/** Todo lo que cuelga de aquí exige un administrador válido (y cada acción lo vuelve a comprobar). */
export default async function AdminLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const { user } = await requireAdmin();
  const problems = await getAuthSettingsProblems();

  return (
    <AdminShell
      user={{ name: getDisplayName(user), email: user.email ?? "", initials: getInitials(user) }}
      problems={problems}
    >
      {children}
    </AdminShell>
  );
}
