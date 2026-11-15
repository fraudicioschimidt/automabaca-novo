import { describe, expect, it } from "vitest";
import { cadenciaDaFila } from "../helpers/cadencia";
import { QUEUES } from "@/src/infra/queue-contract";
import {
  FLASHSCORE_CONTRACTED_REQUESTS_PER_MINUTE,
  FLASHSCORE_DAILY_CONTRACTED_REQUESTS,
  FLASHSCORE_DAILY_OPERATIONAL_CAP,
  FLASHSCORE_OPERATIONAL_REQUESTS_PER_MINUTE,
  FLASHSCORE_PLAN_NAME,
  FLASHSCORE_REQUEST_COOLDOWN_MS,
} from "@/src/providers/flashscore/limits";

describe("contrato operacional do FlashScore Ultra", () => {
  it("declara o plano contratado e preserva margem diária", () => {
    expect(FLASHSCORE_PLAN_NAME).toBe("Ultra");
    expect(FLASHSCORE_DAILY_CONTRACTED_REQUESTS).toBe(10_000);
    expect(FLASHSCORE_DAILY_OPERATIONAL_CAP).toBe(9_500);
  });

  it("o gate global fica abaixo de 240 requests por minuto", () => {
    expect(FLASHSCORE_CONTRACTED_REQUESTS_PER_MINUTE).toBe(240);
    expect(FLASHSCORE_OPERATIONAL_REQUESTS_PER_MINUTE).toBe(220);
    const maximoEmSessentaSegundos =
      Math.floor(60_000 / FLASHSCORE_REQUEST_COOLDOWN_MS) + 1;
    expect(maximoEmSessentaSegundos)
      .toBeLessThanOrEqual(FLASHSCORE_OPERATIONAL_REQUESTS_PER_MINUTE);
  });

  it("observa resultados a cada 10 minutos", () => {
    expect(cadenciaDaFila(QUEUES.flashscoreResults)).toBe(10);
  });
});
