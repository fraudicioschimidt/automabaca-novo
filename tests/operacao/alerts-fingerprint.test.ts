import { describe, expect, it } from "vitest";
import {
  getMessageFingerprint,
  getOperationalAlertFingerprint,
} from "@/src/services/ops/alerts";

describe("getMessageFingerprint", () => {
  it("normaliza UUID e dígitos", () => {
    const a = getMessageFingerprint(
      "Job esgotou retries na fila sharp.enrich (id a6edea58-18e4-4080-8f92-b2c86ef52487). Erro: HTTP 429",
    );
    const b = getMessageFingerprint(
      "Job esgotou retries na fila sharp.enrich (id 00000000-0000-0000-0000-000000000001). Erro: HTTP 429",
    );
    expect(a).toBe(b);
    expect(a).toContain("[UUID]");
    expect(a).toContain("[HTTP_TOO_MANY_REQUESTS]");
    expect(getMessageFingerprint("HTTP 500")).not.toBe(getMessageFingerprint("HTTP 429"));
  });

  it("normaliza campos variáveis antes de limitar o tamanho", () => {
    const prefix = "A".repeat(120);
    const uuid = "a6edea58-18e4-4080-8f92-b2c86ef52487";
    expect(getMessageFingerprint(`${prefix}${uuid} HTTP 500`)).not.toBe(
      getMessageFingerprint(`${prefix}${uuid} HTTP 429`),
    );
  });

  it("preserva canais Telegram distintos sem expor o ID bruto", () => {
    const first = getMessageFingerprint("falha chat_id=-100123 tentativa 1");
    const second = getMessageFingerprint("falha chat_id=-100456 tentativa 2");
    expect(first).not.toBe(second);
    expect(first).not.toContain("100123");
    expect(second).not.toContain("100456");
  });
});

describe("getOperationalAlertFingerprint", () => {
  it("deduplica pelo incidente e preserva recursos numéricos distintos", () => {
    const first = getOperationalAlertFingerprint({ source: "sharp.enrich", key: "bet_10001" });
    const second = getOperationalAlertFingerprint({ source: "sharp.enrich", key: "bet_10002" });
    expect(first).not.toBe(second);
    expect(first).toBe(
      getOperationalAlertFingerprint({ source: "sharp.enrich", key: "bet_10001" }),
    );
  });
});
