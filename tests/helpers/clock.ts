import type { Clock } from "@/lib/time";

/** Reloj controlable para pruebas: el tiempo solo avanza cuando la prueba lo dice. */
export class ManualClock implements Clock {
  constructor(private ms: number) {}
  now(): number {
    return this.ms;
  }
  set(ms: number): void {
    this.ms = ms;
  }
  advance(deltaMs: number): void {
    this.ms += deltaMs;
  }
}

/** Instante base de las pruebas: múltiplo exacto de 10 s, así que es el inicio de un slot. */
export const T0 = 1_800_000_000_000;
export const SESSION_A = "3f2c9a4e-7b1d-4c6a-9e5f-0a1b2c3d4e5f";
export const SESSION_B = "9c1d7e22-5a4b-4f03-8d6c-1e2f3a4b5c6d";
