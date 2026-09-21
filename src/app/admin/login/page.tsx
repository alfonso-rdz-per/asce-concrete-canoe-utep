import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginForm } from "@/app/admin/login/LoginForm";
import { BrandMark } from "@/components/brand/BrandMark";
import { SiteFooter } from "@/components/brand/SiteFooter";
import { WaveDivider } from "@/components/brand/Shapes";
import { Card } from "@/components/ui/Display";
import { getAdmin } from "@/lib/auth/session";
import { safeAdminRedirect } from "@/lib/auth/safe-redirect";

export const metadata: Metadata = { title: "Admin sign in" };

const NOTICES: Record<string, string> = {
  signin: "Please sign in to continue.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const nextParam = typeof params.next === "string" ? params.next : undefined;
  const next = safeAdminRedirect(nextParam);

  // Ya con sesión de administrador válida: directo al panel (sin bucles: aquí no se redirige al login).
  if (await getAdmin()) redirect(next);

  const reason = typeof params.reason === "string" ? params.reason : undefined;

  return (
    <div className="flex min-h-dvh flex-col">
      <section className="on-dark flex flex-1 flex-col bg-navy text-white">
        <main id="main" tabIndex={-1} className="mx-auto flex w-full max-w-md flex-1 flex-col items-center px-4 pt-10 sm:pt-16">
          <BrandMark tone="onDark" size="lg" />
          <p className="mt-4 text-sm font-semibold uppercase tracking-[0.18em] text-sky">Concrete Canoe Team</p>

          <Card className="mt-8 w-full p-6 text-ink sm:p-8">
            <h1 className="text-2xl font-bold text-navy">Admin sign in</h1>
            <p className="mb-6 mt-1 text-muted">Sign in with your team admin account.</p>
            <LoginForm next={next} notice={reason ? NOTICES[reason] : undefined} />
          </Card>
        </main>
        <WaveDivider className="mt-10" />
      </section>
      <SiteFooter />
    </div>
  );
}
