/**
 * Validación de las Fases 0–2 contra Supabase REAL (Auth + PostgREST + Postgres + RLS).
 *
 * Se ejecuta con `npm run test:supabase`. Requiere haber ejecutado antes
 * scripts/supabase-validation/prepare.mjs y tests/supabase/promote-admin.sql.
 * Todos los datos de negocio llevan el prefijo ZZVAL- / "[VALIDACIÓN]" y se limpian con
 * tests/supabase/cleanup.sql. Nada de esto imprime claves ni contraseñas.
 *
 * "Ensayo de check-in": `redeemQr` + `submitCheckin` ensamblan el flujo (token QR -> ticket -> ASCE ID + Name ->
 * inserción) con las librerías de src/lib y la base real. El envío REAL (con límites, auditoría y dispositivos recordados)
 * se prueba a fondo en student-checkin.test.ts.
 */
import { randomBytes } from "node:crypto";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { beforeAll, describe, expect, it } from "vitest";
import { evaluateAuthSettings } from "@/lib/auth/auth-settings";
import { appKeys } from "@/lib/crypto/server-keys";
import { parseServerEnv, serverEnv } from "@/lib/env";
import { nameMatches } from "@/lib/member-name";
import { createServiceRoleClient } from "@/lib/supabase/admin";
import { issueTicket, verifyTicket } from "@/lib/tickets";
import { issueQrTokens, slotAt, verifyQrToken } from "@/lib/tokens";
import { loadState, type ValidationState } from "./state";

const PERMISSION_DENIED = "42501";
const UNIQUE_VIOLATION = "23505";

const URL_ = process.env.NEXT_PUBLIC_SUPABASE_URL as string;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY as string;
const CLIENT_OPTS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

const zzId = () => `ZZVAL-${randomBytes(4).toString("hex").toUpperCase()}`;
const title = (s: string) => `[VALIDACIÓN] ${s}`;
const nonce = () => randomBytes(16).toString("base64url");
const roleOf = (jwt: string): string => JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString()).role;

/** API de administración de Supabase Auth (con la clave de servicio; nunca se imprime). */
const authAdmin = (method: "POST" | "PUT" | "DELETE", path: string, body?: unknown) =>
  fetch(`${URL_}/auth/v1/admin${path}`, {
    method,
    headers: {
      apikey: process.env.SUPABASE_SERVICE_ROLE_KEY as string,
      Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

type Client = SupabaseClient;

describe("Supabase REAL: Fases 0–2", () => {
  let state: ValidationState;
  let anon: Client;
  let admin: Client;
  let outsider: Client;
  let noname: Client;
  let svc: Client;

  const newMember = async (over: Record<string, unknown> = {}) => {
    const r = await admin
      .from("members")
      .insert({ asce_id: zzId(), name: title("Miembro"), ...over })
      .select("id, asce_id, name")
      .single();
    expect(r.error, "crear miembro").toBeNull();
    return r.data as { id: string; asce_id: string; name: string };
  };

  const newSession = async (name: string, open = true) => {
    const r = await admin
      .from("sessions")
      .insert({ title: title(name), scheduled_at: new Date().toISOString() })
      .select("id, status, created_by")
      .single();
    expect(r.error, "crear sesión").toBeNull();
    const s = r.data as { id: string; status: string; created_by: string };
    if (open) {
      const o = await admin.from("sessions").update({ status: "active" }).eq("id", s.id).select("id, status").single();
      expect(o.error, "abrir sesión").toBeNull();
    }
    return s;
  };

  const closeSession = async (id: string) => {
    const r = await admin.from("sessions").update({ status: "closed" }).eq("id", id).select("id, status").single();
    expect(r.error, "cerrar sesión").toBeNull();
  };

  // --- Ensayo del flujo de check-in (usa las librerías reales) -------------------------------
  const env = () => serverEnv();

  async function redeemQr(qrToken: string, now = Date.now()) {
    const v = verifyQrToken({ key: appKeys().qr, token: qrToken, now, graceMs: env().QR_GRACE_MS });
    if (!v.ok) return { ok: false as const, reason: v.reason };
    const s = await svc.from("sessions").select("id, status").eq("id", v.sessionId).maybeSingle();
    if (s.error) throw new Error(`lectura de sesión: ${s.error.message}`);
    if (!s.data || s.data.status !== "active") return { ok: false as const, reason: "session_not_active" };
    const t = issueTicket({
      key: appKeys().ticket,
      sessionId: v.sessionId,
      tokenSlot: v.slot,
      now,
      ttlMs: env().TICKET_TTL_SECONDS * 1000,
    });
    return { ok: true as const, ticket: t.ticket, sessionId: v.sessionId, slot: v.slot };
  }

  async function submitCheckin(ticket: string, asceId: string, name: string, now = Date.now()) {
    const t = verifyTicket({ key: appKeys().ticket, ticket, now, ttlMs: env().TICKET_TTL_SECONDS * 1000 });
    if (!t.ok) return { ok: false as const, reason: `ticket_${t.reason}` };

    const s = await svc.from("sessions").select("status").eq("id", t.sessionId).maybeSingle();
    if (!s.data || s.data.status !== "active") return { ok: false as const, reason: "session_not_active" };

    const m = await svc.from("members").select("id, name, active").eq("asce_id", asceId).maybeSingle();
    const usable = m.data && m.data.active ? m.data : null;
    if (!usable || !nameMatches(name, usable.name)) return { ok: false as const, reason: "bad_credentials" };

    const ins = await svc
      .from("checkins")
      .insert({ session_id: t.sessionId, member_id: usable.id, token_slot: t.tokenSlot, ticket_nonce: t.nonce });
    if (!ins.error) return { ok: true as const, nonce: t.nonce, slot: t.tokenSlot, memberId: usable.id as string };
    if (ins.error.code === UNIQUE_VIOLATION) {
      return { ok: false as const, reason: ins.error.message.includes("checkins_ticket_single_use") ? "ticket_reused" : "already_checked_in" };
    }
    if (ins.error.message.includes("asce:session_not_active")) return { ok: false as const, reason: "session_not_active" };
    return { ok: false as const, reason: `db_error:${ins.error.code}:${ins.error.message}` };
  }

  const qrFor = (sessionId: string, now = Date.now()) => issueQrTokens({ key: appKeys().qr, sessionId, now }).current.token;

  // -------------------------------------------------------------------------------------------
  beforeAll(async () => {
    state = loadState();
    anon = createClient(URL_, ANON_KEY, CLIENT_OPTS);
    svc = createServiceRoleClient();
    admin = createClient(URL_, ANON_KEY, CLIENT_OPTS);
    outsider = createClient(URL_, ANON_KEY, CLIENT_OPTS);
    noname = createClient(URL_, ANON_KEY, CLIENT_OPTS);

    const a = await admin.auth.signInWithPassword({ email: state.admin.email, password: state.admin.password });
    expect(a.error, "login del administrador temporal").toBeNull();
    const n = await noname.auth.signInWithPassword({ email: state.noname.email, password: state.noname.password });
    expect(n.error, "login del segundo administrador (sin display_name)").toBeNull();
    const o = await outsider.auth.signInWithPassword({ email: state.outsider.email, password: state.outsider.password });
    expect(o.error, "login del usuario temporal antes de revocarlo").toBeNull();

    // Con el modelo de la migración 3 TODO usuario confirmado es administrador. Para tener un usuario
    // autenticado que NO lo sea, se REVOCA (baneo) después de iniciar sesión: conserva un JWT vigente.
    const ban = await authAdmin("PUT", `/users/${state.outsider.id}`, { ban_duration: "1h" });
    expect(ban.ok, "baneo del usuario revocado").toBe(true);
  });

  // ===========================================================================================
  describe("A. Conexión y entorno", () => {
    it("las variables reales pasan la validación de src/lib/env.ts (sin imprimirlas)", () => {
      expect(() => parseServerEnv(process.env)).not.toThrow();
      expect(roleOf(ANON_KEY)).toBe("anon");
      expect(roleOf(process.env.SUPABASE_SERVICE_ROLE_KEY as string)).toBe("service_role");
    });

    it("Auth responde y el reloj del servidor de Supabase es coherente con el local (informativo)", async () => {
      const r = await fetch(`${URL_}/auth/v1/health`, { headers: { apikey: ANON_KEY } });
      expect(r.status).toBe(200);
      const serverDate = Date.parse(r.headers.get("date") ?? "");
      const skewMs = Date.now() - serverDate;
      console.log(`Desfase reloj local vs servidor Supabase: ${skewMs} ms`);
      expect(Number.isFinite(skewMs)).toBe(true);
    });
  });

  // ===========================================================================================
  describe("B. Auth real", () => {
    it("los dos administradores temporales iniciaron sesión con JWT reales; el revocado (baneado) ya no valida", async () => {
      expect((await admin.auth.getUser()).data.user?.id).toBe(state.admin.id);
      expect((await noname.auth.getUser()).data.user?.id).toBe(state.noname.id);
      // Auth mismo rechaza al baneado, aunque su token siga sin caducar.
      const o = await outsider.auth.getUser();
      expect(o.data.user).toBeNull();
      expect(o.error).not.toBeNull();
    });

    it("contraseña incorrecta -> rechazo", async () => {
      const c = createClient(URL_, ANON_KEY, CLIENT_OPTS);
      const r = await c.auth.signInWithPassword({ email: state.admin.email, password: "contraseña-incorrecta-123" });
      expect(r.error?.code).toBe("invalid_credentials");
      expect(r.data.session).toBeNull();
    });

    it("los registros públicos están CERRADOS (signup y anónimo)", async () => {
      const c = createClient(URL_, ANON_KEY, CLIENT_OPTS);
      const up = await c.auth.signUp({ email: `zz-validation-signup-${Date.now()}@example.com`, password: randomBytes(18).toString("base64url") });
      expect(up.error?.code).toBe("signup_disabled");
      const anonSignIn = await c.auth.signInAnonymously();
      expect(anonSignIn.error).not.toBeNull();
    });
  });

  // ===========================================================================================
  describe("C. RLS real: anon", () => {
    const tables = ["members", "sessions", "checkins", "checkin_attempts", "audit_log"] as const;

    for (const t of tables) {
      it(`anon no puede leer ni escribir en ${t}`, async () => {
        const sel = await anon.from(t).select("*");
        expect(sel.error?.code).toBe(PERMISSION_DENIED);
        expect(sel.data).toBeNull();
        const del = await anon.from(t).delete().not("created_at", "is", null);
        expect(del.error).not.toBeNull();
        const ins = await anon.from(t).insert({});
        expect(ins.error).not.toBeNull();
      });
    }

    it("anon no puede llamar a private.is_admin (esquema no expuesto) ni a un RPC público", async () => {
      const priv = await (anon as unknown as { schema: (s: string) => Client }).schema("private").rpc("is_admin");
      expect(priv.error).not.toBeNull();
      const pub = await anon.rpc("is_admin");
      expect(pub.error).not.toBeNull();
    });
  });

  // ===========================================================================================
  describe("D. RLS real: usuario con JWT vigente pero que ya NO es administrador (revocado)", () => {
    let seededSession: string;
    let seededMember: string;

    beforeAll(async () => {
      seededSession = (await newSession("Sesión sembrada para RLS", false)).id;
      seededMember = (await newMember()).id;
    });

    it("no ve ninguna fila de ninguna tabla administrativa", async () => {
      for (const [t, cols] of [
        ["members", "id, asce_id, name"],
        ["sessions", "id, title"],
        ["checkins", "id"],
        ["checkin_attempts", "id"],
        ["audit_log", "id"],
      ] as const) {
        const r = await outsider.from(t).select(cols);
        expect(r.error, t).toBeNull();
        expect(r.data, t).toEqual([]);
      }
    });

    it("no puede insertar (RLS)", async () => {
      const m = await outsider.from("members").insert({ asce_id: zzId(), name: title("intruso") });
      expect(m.error?.code).toBe(PERMISSION_DENIED);
      const s = await outsider.from("sessions").insert({ title: title("intrusa"), scheduled_at: new Date().toISOString() });
      expect(s.error?.code).toBe(PERMISSION_DENIED);
    });

    it("no puede modificar ni borrar (0 filas afectadas) y nada queda alterado", async () => {
      const u = await outsider.from("members").update({ name: "hackeado" }).eq("id", seededMember).select("id");
      expect(u.error).toBeNull();
      expect(u.data).toEqual([]);
      const us = await outsider.from("sessions").update({ title: "hackeada" }).eq("id", seededSession).select("id");
      expect(us.data).toEqual([]);
      const d = await outsider.from("checkins").delete().eq("session_id", seededSession).select("id");
      expect(d.data).toEqual([]);

      const check = await svc.from("members").select("name").eq("id", seededMember).single();
      expect(check.data?.name).toBe(title("Miembro"));
    });
  });

  // ===========================================================================================
  describe("E. RLS real y CRUD: administrador", () => {
    it("lee miembros; la columna pin_hash YA NO EXISTE (ni select específico ni select * la traen)", async () => {
      const ok = await admin.from("members").select("id, asce_id, name, email, active, joined_on, deactivated_on, created_at, updated_at").limit(5);
      expect(ok.error).toBeNull();
      expect((ok.data ?? []).length).toBeGreaterThan(0);
      expect(Object.keys((ok.data ?? [])[0])).not.toContain("pin_hash");

      const all = await admin.from("members").select("*").limit(1);
      expect(all.error).toBeNull();
      expect(Object.keys((all.data ?? [])[0]).filter((k) => /pin/i.test(k))).toEqual([]);
      const gone = await admin.from("members").select("pin_hash").limit(1);
      expect(gone.error, "select pin_hash debe fallar: la columna se eliminó").not.toBeNull();
    });

    it("crear miembro (solo identidad, sin PIN); RETURNING devuelve lo insertado", async () => {
      const m = await newMember({ email: "validacion@example.com" });
      const stored = await svc.from("members").select("id, asce_id, name, joined_on").eq("id", m.id).single();
      expect(stored.data).toMatchObject({ id: m.id, asce_id: m.asce_id });
      expect(Object.keys(stored.data ?? {})).not.toContain("pin_hash");
    });

    it("restricciones de datos: ASCE ID duplicado y formato", async () => {
      const m = await newMember();
      const dup = await admin.from("members").insert({ asce_id: m.asce_id, name: title("dup") });
      expect(dup.error?.code).toBe(UNIQUE_VIOLATION);
      const badId = await admin.from("members").insert({ asce_id: "abc def", name: title("x") });
      expect(badId.error?.code).toBe("23514");
    });

    it("actualizar; no puede fijar id ni borrar miembros", async () => {
      const m = await newMember();
      const upd = await admin.from("members").update({ name: title("Renombrado") }).eq("id", m.id).select("id, name").single();
      expect(upd.error).toBeNull();
      expect(upd.data?.name).toBe(title("Renombrado"));

      expect((await admin.from("members").update({ id: crypto.randomUUID() }).eq("id", m.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("members").delete().eq("id", m.id)).error?.code).toBe(PERMISSION_DENIED);
    });

    it("desactivar miembro (active=false exige deactivated_on)", async () => {
      const m = await newMember();
      const bad = await admin.from("members").update({ active: false }).eq("id", m.id);
      expect(bad.error?.code).toBe("23514");
      const today = new Date().toISOString().slice(0, 10);
      const ok = await admin.from("members").update({ active: false, deactivated_on: today }).eq("id", m.id).select("active, deactivated_on").single();
      expect(ok.error).toBeNull();
      expect(ok.data?.active).toBe(false);
    });

    it("sesiones: crear (draft, created_by = admin), editar, abrir, una sola activa, cerrar, no reabrir", async () => {
      const s = await newSession("Ciclo de vida", false);
      expect(s.status).toBe("draft");
      expect(s.created_by).toBe(state.admin.id);

      const ed = await admin.from("sessions").update({ title: title("Ciclo de vida (editada)") }).eq("id", s.id).select("title").single();
      expect(ed.data?.title).toBe(title("Ciclo de vida (editada)"));

      // Marcas de tiempo controladas por la BD: el cliente no puede fijarlas ni crear en otro estado.
      expect((await admin.from("sessions").update({ opened_at: new Date().toISOString() }).eq("id", s.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("sessions").insert({ title: title("x"), scheduled_at: new Date().toISOString(), opened_at: new Date().toISOString() })).error?.code).toBe(PERMISSION_DENIED);
      // Nacer cerrada sigue prohibido (nacer ACTIVA sí se permite desde la migración 9: ver phase4.test.ts, sección F).
      expect((await admin.from("sessions").insert({ title: title("x"), scheduled_at: new Date().toISOString(), status: "closed" })).error?.message ?? "").toContain("asce:session_must_start_as_draft");
      expect((await admin.from("sessions").update({ status: "closed" }).eq("id", s.id)).error?.message).toContain("asce:session_invalid_transition");

      const opened = await admin.from("sessions").update({ status: "active" }).eq("id", s.id).select("status, opened_at, opened_by, closed_at").single();
      expect(opened.error).toBeNull();
      expect(opened.data?.status).toBe("active");
      expect(opened.data?.opened_by).toBe(state.admin.id);
      expect(opened.data?.closed_at).toBeNull();
      expect(Math.abs(Date.now() - Date.parse(opened.data?.opened_at))).toBeLessThan(5 * 60_000);

      const second = await newSession("Segunda", false);
      const clash = await admin.from("sessions").update({ status: "active" }).eq("id", second.id);
      expect(clash.error?.code).toBe(UNIQUE_VIOLATION);
      expect(clash.error?.message).toContain("sessions_single_active");

      await closeSession(s.id);
      const reopen = await admin.from("sessions").update({ status: "active" }).eq("id", s.id);
      expect(reopen.error?.message).toContain("asce:session_closed_is_final");
      const back = await admin.from("sessions").update({ status: "draft" }).eq("id", s.id);
      expect(back.error?.message).toContain("asce:session_closed_is_final");

      // Un administrador SÍ puede eliminar una sesión (migración 9; el detalle del borrado está en phase4.test.ts, sección F).
      expect((await admin.from("sessions").delete().eq("id", s.id)).error).toBeNull();
      expect((await svc.from("sessions").select("id").eq("id", s.id)).data).toEqual([]);
    });

    it("no puede fabricar check-ins, intentos ni auditoría", async () => {
      const s = (await admin.from("sessions").select("id").limit(1).single()).data as { id: string };
      const m = await newMember();
      expect((await admin.from("checkins").insert({ session_id: s.id, member_id: m.id, token_slot: 1, ticket_nonce: nonce() })).error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("checkin_attempts").insert({ outcome: "success" })).error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("audit_log").insert({ action: "zzval.x", entity_type: "x" })).error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("audit_log").update({ action: "zzval.y" }).eq("action", "zzval.x")).error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("audit_log").delete().eq("action", "zzval.x")).error?.code).toBe(PERMISSION_DENIED);
    });
  });

  // ===========================================================================================
  describe("F. QR y tickets con las claves reales", () => {
    it("el QR se genera, valida y expira con la hora del servidor; un token falso no pasa", () => {
      const sid = crypto.randomUUID();
      const now = Date.now();
      const { current, next } = issueQrTokens({ key: appKeys().qr, sessionId: sid, now });
      expect(current.slot).toBe(slotAt(now));
      expect(verifyQrToken({ key: appKeys().qr, token: current.token, now, graceMs: env().QR_GRACE_MS })).toMatchObject({ ok: true, sessionId: sid });
      expect(verifyQrToken({ key: appKeys().qr, token: current.token, now: current.endsAtMs + env().QR_GRACE_MS, graceMs: env().QR_GRACE_MS })).toEqual({ ok: false, reason: "expired" });
      expect(verifyQrToken({ key: appKeys().qr, token: next.token, now, graceMs: env().QR_GRACE_MS }).ok).toBe(slotAt(now) + 1 === next.slot && now >= next.startsAtMs - 1000);
      const forged = current.token.slice(0, -1) + (current.token.endsWith("A") ? "B" : "A");
      expect(verifyQrToken({ key: appKeys().qr, token: forged, now, graceMs: env().QR_GRACE_MS }).ok).toBe(false);
    });

    it("las claves de QR y de ticket están separadas (un ticket no valida como QR y viceversa)", () => {
      const sid = crypto.randomUUID();
      const now = Date.now();
      const qr = issueQrTokens({ key: appKeys().qr, sessionId: sid, now }).current.token;
      const t = issueTicket({ key: appKeys().ticket, sessionId: sid, tokenSlot: slotAt(now), now });
      expect(verifyTicket({ key: appKeys().ticket, ticket: qr, now }).ok).toBe(false);
      expect(verifyQrToken({ key: appKeys().qr, token: t.ticket, now, graceMs: 5000 }).ok).toBe(false);
      expect(verifyTicket({ key: appKeys().qr, ticket: t.ticket, now })).toEqual({ ok: false, reason: "bad_mac" });
    });
  });

  // ===========================================================================================
  describe("G. Check-in real (ensayo del flujo completo)", () => {
    let session: { id: string };
    let m1: { id: string; asce_id: string; name: string };
    let m2: { id: string; asce_id: string; name: string };
    let inactive: { id: string; asce_id: string; name: string };
    let firstNonce = "";

    beforeAll(async () => {
      session = await newSession("Flujo de check-in");
      m1 = await newMember();
      m2 = await newMember();
      inactive = await newMember();
      await admin.from("members").update({ active: false, deactivated_on: new Date().toISOString().slice(0, 10) }).eq("id", inactive.id);
    });

    it("QR válido -> ticket -> ASCE ID + Name -> check-in registrado, con slot y nonce del ticket", async () => {
      const r = await redeemQr(qrFor(session.id));
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const c = await submitCheckin(r.ticket, m1.asce_id, m1.name);
      expect(c.ok).toBe(true);
      if (!c.ok) return;
      firstNonce = c.nonce;

      const row = await admin.from("checkins").select("session_id, member_id, token_slot, ticket_nonce, checked_in_at").eq("member_id", m1.id).single();
      expect(row.error).toBeNull();
      expect(row.data).toMatchObject({ session_id: session.id, member_id: m1.id, token_slot: r.slot, ticket_nonce: c.nonce });
      expect(Math.abs(Date.now() - Date.parse(row.data?.checked_in_at))).toBeLessThan(5 * 60_000);
    });

    it("el MISMO ticket no sirve para un segundo check-in (UNIQUE session_id + ticket_nonce)", async () => {
      const r = await redeemQr(qrFor(session.id));
      if (!r.ok) throw new Error("no se pudo canjear el QR");
      const first = await submitCheckin(r.ticket, m2.asce_id, m2.name);
      expect(first.ok).toBe(true);
      // Otro miembro intenta reutilizar exactamente el mismo ticket.
      const third = await newMember();
      const reuse = await submitCheckin(r.ticket, third.asce_id, third.name);
      expect(reuse).toEqual({ ok: false, reason: "ticket_reused" });
      const rows = await admin.from("checkins").select("id").eq("member_id", third.id);
      expect(rows.data).toEqual([]);
    });

    it("segundo check-in del mismo miembro con un ticket NUEVO -> rechazado (UNIQUE session_id + member_id)", async () => {
      const r = await redeemQr(qrFor(session.id));
      if (!r.ok) throw new Error("no se pudo canjear el QR");
      expect(await submitCheckin(r.ticket, m1.asce_id, m1.name)).toEqual({ ok: false, reason: "already_checked_in" });
      const n = await admin.from("checkins").select("id").eq("member_id", m1.id);
      expect(n.data).toHaveLength(1);
    });

    it("el mismo token QR lo pueden canjear varios miembros a la vez (multiuso en su ventana)", async () => {
      const qr = qrFor(session.id);
      const members = await Promise.all([newMember(), newMember(), newMember(), newMember()]);
      const results = await Promise.all(
        members.map(async (m) => {
          const r = await redeemQr(qr);
          if (!r.ok) return r;
          return submitCheckin(r.ticket, m.asce_id, m.name);
        }),
      );
      expect(results.every((x) => x.ok)).toBe(true);
    });

    it("QR caducado, alterado o de otra sesión -> rechazado; sin registrar nada", async () => {
      const now = Date.now();
      const old = qrFor(session.id, now - 60_000);
      expect(await redeemQr(old, now)).toEqual({ ok: false, reason: "expired" });

      const tampered = qrFor(session.id).replace(/.$/, (c) => (c === "A" ? "B" : "A"));
      // Según el carácter original, cambiar el último de la MAC da 'bad_mac' o una forma no canónica
      // ('malformed'): en ambos casos el token se rechaza. Lo importante es que NUNCA se acepte.
      const forged = await redeemQr(tampered);
      expect(forged.ok).toBe(false);
      expect(["bad_mac", "malformed"]).toContain(forged.ok ? "" : forged.reason);

      // Firmado correctamente pero de una sesión que no existe/no está activa.
      expect(await redeemQr(qrFor(crypto.randomUUID()))).toEqual({ ok: false, reason: "session_not_active" });
    });

    it("nombre incorrecto, ASCE ID inexistente y miembro inactivo dan el MISMO resultado genérico", async () => {
      const r = await redeemQr(qrFor(session.id));
      if (!r.ok) throw new Error("no se pudo canjear el QR");
      const fresh = await newMember();
      const wrongName = await submitCheckin(r.ticket, fresh.asce_id, "Lewis Hamilton");
      const unknown = await submitCheckin(r.ticket, "ZZVAL-NOEXISTE", fresh.name);
      const inactiveRes = await submitCheckin(r.ticket, inactive.asce_id, inactive.name);
      expect(wrongName).toEqual({ ok: false, reason: "bad_credentials" });
      expect(unknown).toEqual(wrongName);
      expect(inactiveRes).toEqual(wrongName);
      // El ticket no se "gastó" con los intentos fallidos: aún permite un check-in correcto.
      expect((await submitCheckin(r.ticket, fresh.asce_id, fresh.name)).ok).toBe(true);
    });

    it("la BASE DE DATOS también rechaza miembros inactivos y borradores (defensa en profundidad, sin pasar por la app)", async () => {
      const draft = await newSession("Borrador", false);
      const direct = (sessionId: string, memberId: string) =>
        svc.from("checkins").insert({ session_id: sessionId, member_id: memberId, token_slot: 1, ticket_nonce: nonce() });
      expect((await direct(session.id, inactive.id)).error?.message).toContain("asce:member_not_active");
      expect((await direct(draft.id, m1.id)).error?.message).toContain("asce:session_not_active");
    });

    it("la hora del check-in la fija la BD (la que envíe el cliente se ignora)", async () => {
      const m = await newMember();
      const ins = await svc
        .from("checkins")
        .insert({ session_id: session.id, member_id: m.id, token_slot: 1, ticket_nonce: nonce(), checked_in_at: "2001-01-01T00:00:00Z" })
        .select("checked_in_at")
        .single();
      expect(ins.error).toBeNull();
      expect(new Date(ins.data?.checked_in_at).getFullYear()).toBeGreaterThan(2020);
    });

    it("check-ins inmutables e inserción-solo en auditoría desde la API (service_role y admin)", async () => {
      expect((await svc.from("checkins").update({ token_slot: 99 }).eq("member_id", m1.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await admin.from("checkins").update({ token_slot: 99 }).eq("member_id", m1.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("checkins").delete().eq("member_id", m1.id)).error?.code).toBe(PERMISSION_DENIED);

      expect((await svc.from("audit_log").insert({ action: "zzval.test", entity_type: "validacion" })).error).toBeNull();
      expect((await svc.from("audit_log").update({ action: "zzval.editado" }).eq("action", "zzval.test")).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("audit_log").delete().eq("action", "zzval.test")).error?.code).toBe(PERMISSION_DENIED);
    });

    it("service_role solo tiene el acceso mínimo (no modifica miembros ni sesiones)", async () => {
      expect((await svc.from("members").update({ name: "x" }).eq("id", m1.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("members").delete().eq("id", m1.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("sessions").update({ title: "x" }).eq("id", session.id)).error?.code).toBe(PERMISSION_DENIED);
      expect((await svc.from("checkin_attempts").insert({ outcome: "bad_credentials", asce_id_tried: "ZZVAL-INTENTO" })).error).toBeNull();
      expect((await svc.from("checkin_attempts").insert({ outcome: "inventado" })).error).not.toBeNull();
    });

    it("eliminar un check-in (admin) queda en audit_log con el administrador como actor; un usuario normal no ve la auditoría", async () => {
      const target = await admin.from("checkins").select("id, member_id").eq("member_id", m2.id).single();
      const del = await admin.from("checkins").delete().eq("id", target.data?.id).select("id");
      expect(del.error).toBeNull();
      expect(del.data).toHaveLength(1);

      const audit = await admin.from("audit_log").select("actor_id, action, entity_type, entity_id, detail").eq("entity_id", target.data?.id);
      expect(audit.data).toHaveLength(1);
      expect(audit.data?.[0]).toMatchObject({ actor_id: state.admin.id, action: "checkin.delete", entity_type: "checkin" });
      expect(audit.data?.[0].detail).toMatchObject({ session_id: session.id, member_id: m2.id });

      expect((await outsider.from("audit_log").select("id")).data).toEqual([]);
      expect((await anon.from("audit_log").select("id")).error?.code).toBe(PERMISSION_DENIED);
    });

    it("tras cerrar la sesión: un ticket ya emitido y la inserción directa son rechazados", async () => {
      const r = await redeemQr(qrFor(session.id));
      if (!r.ok) throw new Error("no se pudo canjear el QR");
      const late = await newMember();
      await closeSession(session.id);

      expect(await submitCheckin(r.ticket, late.asce_id, late.name)).toEqual({ ok: false, reason: "session_not_active" });
      expect(await redeemQr(qrFor(session.id))).toEqual({ ok: false, reason: "session_not_active" });
      const direct = await svc.from("checkins").insert({ session_id: session.id, member_id: late.id, token_slot: 1, ticket_nonce: nonce() });
      expect(direct.error?.message).toContain("asce:session_not_active");
      expect((await admin.from("checkins").select("id").eq("member_id", late.id)).data).toEqual([]);
      expect(firstNonce).toMatch(/^[A-Za-z0-9_-]{22}$/);
    });
  });

  // ===========================================================================================
  describe("H. Concurrencia real (peticiones HTTP simultáneas)", () => {
    it("25 peticiones simultáneas del mismo miembro producen EXACTAMENTE 1 asistencia", async () => {
      const s = await newSession("Carrera mismo miembro");
      const m = await newMember();
      const results = await Promise.all(
        Array.from({ length: 25 }, () => svc.from("checkins").insert({ session_id: s.id, member_id: m.id, token_slot: 1, ticket_nonce: nonce() })),
      );
      expect(results.filter((r) => !r.error)).toHaveLength(1);
      const failures = results.filter((r) => r.error);
      expect(failures).toHaveLength(24);
      for (const f of failures) expect(f.error?.code).toBe(UNIQUE_VIOLATION);
      expect((await admin.from("checkins").select("id").eq("session_id", s.id)).data).toHaveLength(1);
      await closeSession(s.id);
    });

    it("un mismo ticket usado a la vez por 10 miembros distintos produce EXACTAMENTE 1 asistencia", async () => {
      const s = await newSession("Carrera mismo ticket");
      const members = await Promise.all(Array.from({ length: 10 }, () => newMember()));
      const shared = nonce();
      const results = await Promise.all(
        members.map((m) => svc.from("checkins").insert({ session_id: s.id, member_id: m.id, token_slot: 1, ticket_nonce: shared })),
      );
      expect(results.filter((r) => !r.error)).toHaveLength(1);
      for (const f of results.filter((r) => r.error)) expect(f.error?.code).toBe(UNIQUE_VIOLATION);
      await closeSession(s.id);
    });

    it("cerrar la sesión mientras entran check-ins: ninguno queda registrado después del cierre (3 rondas)", async () => {
      for (let round = 0; round < 3; round++) {
        const s = await newSession(`Carrera cierre ${round}`);
        const batch = await admin
          .from("members")
          .insert(Array.from({ length: 15 }, () => ({ asce_id: zzId(), name: title("Carrera") })))
          .select("id");
        expect(batch.error).toBeNull();
        const ids = (batch.data ?? []).map((x: { id: string }) => x.id);

        // OJO: los constructores de supabase-js son perezosos (no envían nada hasta `await`/`then`),
        // así que cada petición se lanza dentro de su propio temporizador. Los check-ins salen
        // escalonados (0..280 ms) y el cierre cae en mitad, para que haya aceptados Y rechazados.
        const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
        const closeAfterMs = 80 + round * 70;
        const inserts = ids.map((id: string, i: number) =>
          sleep(i * 20).then(() =>
            svc.from("checkins").insert({ session_id: s.id, member_id: id, token_slot: 1, ticket_nonce: nonce() }),
          ),
        );
        const closing = sleep(closeAfterMs).then(() =>
          admin.from("sessions").update({ status: "closed" }).eq("id", s.id).select("closed_at").single(),
        );
        const [results, closed] = await Promise.all([Promise.all(inserts), closing]);
        expect(closed.error).toBeNull();

        for (const r of results) {
          if (r.error) expect(r.error.message).toContain("asce:session_not_active");
        }
        const closedAt = Date.parse(closed.data?.closed_at);
        const rows = await admin.from("checkins").select("checked_in_at").eq("session_id", s.id);
        expect(rows.data?.length, `ronda ${round}: aceptados`).toBe(results.filter((r) => !r.error).length);
        for (const row of rows.data ?? []) {
          expect(Date.parse(row.checked_in_at), `ronda ${round}: check-in posterior al cierre`).toBeLessThanOrEqual(closedAt);
        }
        console.log(`Ronda ${round}: ${rows.data?.length} aceptados, ${results.length - (rows.data?.length ?? 0)} rechazados por cierre`);
      }
    });
  });

  // ===========================================================================================
  describe("I. Regla de administrador (migración 3): cualquier usuario VÁLIDO de Supabase Auth", () => {
    it("varios usuarios confirmados son administradores a la vez: los dos temporales operan con RLS", async () => {
      for (const [label, client] of [["admin", admin], ["noname", noname]] as const) {
        const r = await client
          .from("members")
          .insert({ asce_id: zzId(), name: title(`Creado por ${label}`) })
          .select("id")
          .single();
        expect(r.error, label).toBeNull();
      }
      const list = await noname.from("members").select("id").limit(1);
      expect(list.error).toBeNull();
      expect((list.data ?? []).length).toBeGreaterThan(0);
    });

    it("un usuario SIN confirmar el correo no puede iniciar sesión (no llega a ser administrador)", async () => {
      const email = `zz-validation-unconfirmed-${randomBytes(4).toString("hex")}@example.com`;
      const password = randomBytes(18).toString("base64url");
      const res = await authAdmin("POST", "/users", { email, password, email_confirm: false });
      expect(res.ok).toBe(true);
      const { id } = (await res.json()) as { id: string };
      try {
        const c = createClient(URL_, ANON_KEY, CLIENT_OPTS);
        const r = await c.auth.signInWithPassword({ email, password });
        expect(r.data.session).toBeNull();
        expect(r.error).not.toBeNull();
      } finally {
        await authAdmin("DELETE", `/users/${id}`);
      }
    });

    it("un administrador BORRADO pierde el acceso al instante, aunque su JWT siga vigente", async () => {
      const email = `zz-validation-deleted-${randomBytes(4).toString("hex")}@example.com`;
      const password = randomBytes(18).toString("base64url");
      const res = await authAdmin("POST", "/users", { email, password, email_confirm: true });
      const { id } = (await res.json()) as { id: string };
      // try/finally: si una aserción falla ANTES del borrado, el usuario temporal (un administrador real de Auth) no se queda en Supabase.
      try {
        const c = createClient(URL_, ANON_KEY, CLIENT_OPTS);
        expect((await c.auth.signInWithPassword({ email, password })).error).toBeNull();

        const before = await c.from("members").insert({ asce_id: zzId(), name: title("antes del borrado") });
        expect(before.error).toBeNull();

        expect((await authAdmin("DELETE", `/users/${id}`)).ok).toBe(true);

        const after = await c.from("members").insert({ asce_id: zzId(), name: title("después del borrado") });
        expect(after.error?.code).toBe(PERMISSION_DENIED);
        expect((await c.from("members").select("id").limit(1)).data).toEqual([]);
      } finally {
        await authAdmin("DELETE", `/users/${id}`); // idempotente: si el test ya lo borró, responde 404 y no pasa nada
      }
    });

    it("REGRESIÓN: se puede BORRAR a un administrador que ya abrió sesiones (revocar = borrar); el historial se conserva", async () => {
      const email = `zz-validation-opener-${randomBytes(4).toString("hex")}@example.com`;
      const password = randomBytes(18).toString("base64url");
      const res = await authAdmin("POST", "/users", { email, password, email_confirm: true });
      const { id } = (await res.json()) as { id: string };
      // try/finally: si una aserción falla ANTES del borrado, el usuario temporal (un administrador real de Auth) no se queda en Supabase.
      try {
        const c = createClient(URL_, ANON_KEY, CLIENT_OPTS);
        expect((await c.auth.signInWithPassword({ email, password })).error).toBeNull();

        const created = await c.from("sessions").insert({ title: title("Abierta por un admin que luego se borra"), scheduled_at: new Date().toISOString() }).select("id").single();
        expect(created.error).toBeNull();
        const sid = created.data?.id as string;
        expect((await c.from("sessions").update({ status: "active" }).eq("id", sid)).error).toBeNull();
        expect((await c.from("sessions").update({ status: "closed" }).eq("id", sid)).error).toBeNull();
        const before = await svc.from("sessions").select("opened_by, created_by, status, opened_at, closed_at").eq("id", sid).single();
        expect(before.data?.opened_by).toBe(id);
        expect(before.data?.created_by).toBe(id);

        const del = await authAdmin("DELETE", `/users/${id}`);
        expect(del.status, "borrar al administrador que abrió sesiones").toBe(200);

        const after = await svc.from("sessions").select("opened_by, created_by, status, opened_at, closed_at").eq("id", sid).single();
        expect(after.data).toEqual({ ...before.data, opened_by: null, created_by: null });
      } finally {
        await authAdmin("DELETE", `/users/${id}`); // idempotente: si el test ya lo borró, responde 404 y no pasa nada
      }
    });

    it("el usuario revocado (baneado con JWT vigente) no puede volver a iniciar sesión", async () => {
      const c = createClient(URL_, ANON_KEY, CLIENT_OPTS);
      const r = await c.auth.signInWithPassword({ email: state.outsider.email, password: state.outsider.password });
      expect(r.data.session).toBeNull();
      expect(r.error).not.toBeNull();
    });

    it("la tabla public.admins ya no existe", async () => {
      const r = await svc.from("admins").select("user_id");
      expect(r.error?.code).toBe("PGRST205");
    });
  });

  // ===========================================================================================
  describe("J. Guardián de la configuración de Supabase Auth (FALLA si se abre la puerta de administrador)", () => {
    const fetchSettings = async () => {
      const r = await fetch(`${URL_}/auth/v1/settings`, { headers: { apikey: ANON_KEY } });
      expect(r.status).toBe(200);
      return (await r.json()) as Parameters<typeof evaluateAuthSettings>[0];
    };

    it("el registro público está DESHABILITADO, el inicio anónimo también y no hay proveedores OAuth", async () => {
      const settings = await fetchSettings();
      const verdict = evaluateAuthSettings(settings);
      expect(verdict.problems.map((p) => p.message)).toEqual([]);
      expect(verdict.ok).toBe(true);
      // Los tres controles explícitos, para que el motivo del fallo sea obvio:
      expect(settings.disable_signup, "public signup debe estar deshabilitado").toBe(true);
      expect(settings.external?.anonymous_users, "anonymous sign-in debe estar deshabilitado").toBe(false);
      const oauth = Object.entries(settings.external ?? {}).filter(([k, v]) => v === true && !["email", "phone", "anonymous_users"].includes(k));
      expect(oauth, "ningún proveedor OAuth no autorizado").toEqual([]);
    });

    it("un intento REAL de registro público y de sesión anónima es rechazado", async () => {
      const c = createClient(URL_, ANON_KEY, CLIENT_OPTS);
      const up = await c.auth.signUp({ email: `zz-validation-signup-${randomBytes(4).toString("hex")}@example.com`, password: randomBytes(18).toString("base64url") });
      expect(up.error?.code).toBe("signup_disabled");
      expect(up.data.user).toBeNull();
      const anonymous = await c.auth.signInAnonymously();
      expect(anonymous.error).not.toBeNull();
      expect(anonymous.data.session).toBeNull();
    });

    it("el guardián SÍ detectaría una configuración insegura (la prueba no es vacía)", () => {
      expect(evaluateAuthSettings({ disable_signup: false, external: { email: true } }).ok).toBe(false);
      expect(evaluateAuthSettings({ disable_signup: true, external: { anonymous_users: true } }).ok).toBe(false);
      expect(evaluateAuthSettings({ disable_signup: true, external: { google: true } }).ok).toBe(false);
    });
  });
});
