import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveKey } from "@/lib/crypto/keys";
import { redeemQr } from "@/lib/checkin/gate";
import { verifyTicket } from "@/lib/tickets";
import { issueQrToken, slotAt } from "@/lib/tokens";
import { CHECKIN_MESSAGES } from "@/lib/checkin/state";

const runtime = vi.hoisted(() => ({
  now: 1_800_000_000_000,
  inserted: 0,
  refresh: null as null | (() => Promise<void>),
}));
const start = 1_800_000_000_000;
const sessionId = "3f2c9a4e-7b1d-4c6a-9e5f-0a1b2c3d4e5f";
const qrKey = deriveKey("checkin-regression-secret-at-least-32", "qr");
const ticketKey = deriveKey("checkin-regression-secret-at-least-32", "ticket");

vi.mock("@/components/brand/BrandMark", () => ({ BrandMark: () => null }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ TICKET_TTL_SECONDS: 180 }) }));
vi.mock("@/lib/checkin/server", () => ({
  lookupRememberedMember: async () => null,
  redeemQrOnServer: (token: string) => redeemQr({
    token, now: runtime.now, qrKey, ticketKey, graceMs: 5000, ticketTtlMs: 180_000,
    loadSession: async () => ({ id: sessionId, title: "Practice", location: null, status: "active" }),
  }),
}));
vi.mock("@/app/(public)/c/[token]/actions", () => ({
  switchMemberAction: async () => { await runtime.refresh?.(); },
  checkInAction: async (_prev: unknown, formData: FormData) => {
    const ticket = verifyTicket({ key: ticketKey, ticket: formData.get("ticket"), now: runtime.now, ttlMs: 180_000 });
    if (!ticket.ok) return { status: "error", ...CHECKIN_MESSAGES.ticket_expired };
    runtime.inserted += 1;
    // Simula el re-render de Next en la misma respuesta al escribir la cookie Remember me.
    await runtime.refresh?.();
    return { status: "success", name: "Max", sessionTitle: "Practice", checkedInAt: new Date(runtime.now).toISOString(), remembered: true };
  },
}));

import CheckInLandingPage from "@/app/(public)/c/[token]/page";

const tokenAt = (now: number) => issueQrToken({ key: qrKey, sessionId, slot: slotAt(now) });
const page = (token: string) => CheckInLandingPage({ params: Promise.resolve({ token }) });

beforeEach(() => {
  runtime.now = start;
  runtime.inserted = 0;
  runtime.refresh = null;
});

describe("check-in durante el re-render de cookies", () => {
  it("Remember me conserva el éxito aunque el QR expire antes del envío", async () => {
    const user = userEvent.setup();
    const token = tokenAt(start);
    const view = render(await page(token));
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Max");
    await user.click(screen.getByRole("checkbox", { name: "Remember me" }));
    runtime.now = start + 20_000; // QR vencido; ticket aún dentro de sus 3 minutos.
    runtime.refresh = async () => { view.rerender(await page(token)); };
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByRole("heading", { name: "Check-in successful!" })).toBeInTheDocument();
    expect(screen.queryByText("This QR code has expired")).toBeNull();
    expect(runtime.inserted).toBe(1);
    expect(screen.getByText("This device will remember you next time.")).toBeInTheDocument();
  });

  it("un re-render no renueva el ticket: a los 3 minutos el envío se rechaza", async () => {
    const user = userEvent.setup();
    const token = tokenAt(start);
    const view = render(await page(token));
    const originalTicket = view.container.querySelector<HTMLInputElement>('input[name="ticket"]')!.value;
    runtime.now = start + 1000; // Aún válido: el servidor emitiría otro ticket en el re-render.
    view.rerender(await page(token));
    expect(view.container.querySelector<HTMLInputElement>('input[name="ticket"]')!.value).toBe(originalTicket);
    runtime.now = start + 180_000;
    await user.type(screen.getByLabelText("ASCE ID"), "12345678");
    await user.type(screen.getByLabelText("Name"), "Max");
    await user.click(screen.getByRole("button", { name: "Check in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(CHECKIN_MESSAGES.ticket_expired.message);
    expect(runtime.inserted).toBe(0);
  });

  it("abrir un QR vencido por primera vez sigue mostrando el error", async () => {
    const token = tokenAt(start);
    runtime.now = start + 20_000;
    render(await page(token));
    expect(screen.getByRole("heading", { name: "This QR code has expired" })).toBeInTheDocument();
    expect(screen.queryByLabelText("ASCE ID")).toBeNull();
  });

  it("otro QR inicia un flujo nuevo con su propio ticket", async () => {
    const view = render(await page(tokenAt(start)));
    const originalTicket = view.container.querySelector<HTMLInputElement>('input[name="ticket"]')!.value;
    runtime.now = start + 20_000;
    view.rerender(await page(tokenAt(runtime.now)));
    expect(screen.getByRole("heading", { name: "QR code accepted" })).toBeInTheDocument();
    const newTicket = view.container.querySelector<HTMLInputElement>('input[name="ticket"]')!.value;
    expect(newTicket).not.toBe(originalTicket);
    expect(verifyTicket({ key: ticketKey, ticket: newTicket, now: runtime.now, ttlMs: 180_000 })).toMatchObject({ ok: true, expiresAtMs: runtime.now + 180_000 });
  });
});
