"use client";

import { useActionState } from "react";
import { signInAction } from "@/app/admin/login/actions";
import { LOGIN_IDLE } from "@/app/admin/login/login-state";
import { Alert } from "@/components/ui/Display";
import { TextField } from "@/components/ui/Fields";
import { SubmitButton } from "@/components/ui/SubmitButton";

export function LoginForm({ next, notice }: { next: string; notice?: string }) {
  const [state, formAction] = useActionState(signInAction, LOGIN_IDLE);

  return (
    <form action={formAction} className="space-y-5" noValidate>
      <input type="hidden" name="next" value={next} />

      {notice && state.status !== "error" ? <Alert variant="info">{notice}</Alert> : null}
      {state.status === "error" ? <Alert variant="danger">{state.message}</Alert> : null}

      <TextField
        label="Email"
        name="email"
        type="email"
        required
        defaultValue={state.status === "error" ? (state.email ?? "") : ""}
        autoComplete="username"
        inputMode="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        maxLength={254}
      />
      <TextField label="Password" name="password" type="password" required autoComplete="current-password" maxLength={256} />

      <SubmitButton fullWidth pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
