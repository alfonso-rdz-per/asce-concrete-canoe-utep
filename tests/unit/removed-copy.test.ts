/**
 * Textos de ayuda que se quitaron a petición del equipo (dashboard, Members y Attendance). Comprobación estática del código fuente:
 * las pantallas son componentes de servidor que dependen de Supabase, así que aquí solo se verifica que el texto ya no exista.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("textos eliminados", () => {
  it("dashboard: sin el párrafo de Start Check-In ni las ayudas «Active on the team» y «Closed meetings»", () => {
    const card = read("src/components/admin/StartCheckInCard.tsx");
    const dashboard = read("src/app/admin/(shell)/page.tsx");
    expect(card).not.toContain("Name the session, start a check-in");
    expect(dashboard).not.toContain("Active on the team");
    expect(dashboard).not.toContain("Closed meetings");
    // Las tarjetas siguen ahí, solo sin ayuda.
    expect(dashboard).toContain('label="Total Members"');
    expect(dashboard).toContain('label="Total Meetings"');
  });

  it("Members: sin «Everyone on the team. Add, edit or deactivate members here.»", () => {
    const page = read("src/app/admin/(shell)/members/page.tsx");
    expect(page).not.toContain("Everyone on the team");
    expect(page).not.toContain("deactivate members here");
    expect(page).toContain('title="Members"');
  });

  it("Attendance: sin «Closed meetings: how many of the expected members came.»", () => {
    const page = read("src/app/admin/(shell)/attendance/page.tsx");
    expect(page).not.toContain("how many of the expected members came");
    expect(page).toContain('title="Attendance"');
  });
});
