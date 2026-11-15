import { describe, expect, it } from "vitest";
import { workerVivo } from "@/src/services/painel/operacoes/saude";

const AGORA = new Date("2026-08-12T12:00:00.000Z");
const SAUDE = { ultimoClosing: null, dbOk: true } as const;
const heartbeatDe = (minAtras: number) => new Date(AGORA.getTime() - minAtras * 60_000);

describe("workerVivo", () => {
  it("vivo com heartbeat recente (0–15 min)", () => {
    for (const min of [0, 5, 10, 15]) {
      expect(workerVivo({ ...SAUDE, ultimoHeartbeat: heartbeatDe(min) }, AGORA)).toBe(true);
    }
  });

  it("parado sem heartbeat ou com idade > 15 min", () => {
    expect(workerVivo({ ...SAUDE, ultimoHeartbeat: null }, AGORA)).toBe(false);
    expect(workerVivo({ ...SAUDE, ultimoHeartbeat: heartbeatDe(16) }, AGORA)).toBe(false);
    expect(workerVivo({ ...SAUDE, ultimoHeartbeat: heartbeatDe(119) }, AGORA)).toBe(false);
  });

  it("heartbeat no futuro (relógio adiantado) conta como agora, nunca como atraso", () => {
    const futuro = new Date(AGORA.getTime() + 119 * 60_000);
    expect(workerVivo({ ...SAUDE, ultimoHeartbeat: futuro }, AGORA)).toBe(true);
  });
});

// `workerVivo` e a tira de frescor leem o MESMO `frescorDaFonte`: com duas
// derivações, a tela poderia mostrar `alive: true` ao lado de `atrasada: true`.
// A formatação da idade está em `tests/painel/frescor-na-tela.test.ts`.
