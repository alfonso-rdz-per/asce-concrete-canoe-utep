"use server";

import { redirect } from "next/navigation";
import { INVALID_LOGIN, type LoginState } from "@/app/admin/login/login-state";
import { isAdminUser, type AdminCandidate } from "@/lib/auth/is-admin";
import { safeAdminRedirect } from "@/lib/auth/safe-redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

function field(formData: FormData, key: string): string {
  const v = formData.get(key);
  return typeof v === "string" ? v : "";
}

export async function signInAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  const email = field(formData, "email").trim();
  const password = field(formData, "password");

  if (email.length === 0 || password.length === 0) {
    return { status: "error", message: "Enter your email and password.", email: email.slice(0, 254) };
  }
  if (email.length > 254 || password.length > 256) {
    return { status: "error", message: INVALID_LOGIN, email: email.slice(0, 254) };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });

  // Cualquier usuario válido de Auth es administrador; se re-comprueba por si acaso (falla cerrado).
  if (error || !data.user || !isAdminUser(data.user as unknown as AdminCandidate, Date.now())) {
    if (data?.session) await supabase.auth.signOut();
    return { status: "error", message: INVALID_LOGIN, email };
  }

  redirect(safeAdminRedirect(formData.get("next")));
}
