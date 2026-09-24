import { Alert } from "@/components/ui/Display";
import type { AuthSettingsProblem } from "@/lib/auth/auth-settings";

/**
 * Aviso de seguridad: aparece SOLO si Supabase Auth quedó mal configurado (registro público, inicio
 * anónimo o un proveedor OAuth no autorizado). Como todo usuario de Auth es administrador, esa
 * configuración abriría la puerta al panel.
 */
export function AuthSettingsWarning({ problems }: { problems: AuthSettingsProblem[] | null }) {
  if (!problems || problems.length === 0) return null;
  return (
    <Alert variant="danger" title="Security warning: check your Supabase Auth settings">
      <ul className="list-disc space-y-1 pl-5">
        {problems.map((p) => (
          <li key={`${p.code}-${p.provider ?? ""}`}>{p.message}</li>
        ))}
      </ul>
      <p className="mt-2">
        Every Supabase Auth user is an administrator of this app. In Supabase, open Authentication → Sign In / Providers and turn off
        public sign-ups, anonymous sign-ins and any unused provider.
      </p>
    </Alert>
  );
}
