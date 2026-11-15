import { describe, expect, it } from "vitest";
import {
  betIdDoPayload,
  classificaCausa,
  providerDoCircuito,
  proximaEtapaDaCausa,
  replayResolveAgora,
} from "@/src/domain/falha-de-job";

/**
 * Falha não pode ser exibida sem causa, sem proveniência e sem próxima etapa,
 * nem com botão de Replay que o próprio sistema já sabe que vai falhar.
 *
 * O pg-boss guarda na MESMA linha o `output` (o erro), o `data` (payload com o
 * `betId`) e o `retry_count`; é daí que saem causa, aposta e etapa. Falhas
 * parecidas têm diagnósticos com ações opostas, e várias falhas de um circuito
 * aberto são um incidente só, não uma lista de botões que falhariam na hora.
 *
 * As fixtures abaixo usam o FORMATO REAL do `output` medido no banco, que não é
 * uniforme: às vezes `{name, stack}`, às vezes `{value: "..."}`, às vezes
 * `{value: {message: "..."}}`. Um teste com o formato idealizado passaria e a
 * produção continuaria cinza.
 */

/** Cópias verbatim de `pgboss.job.output` como o banco real grava. */
const SAIDAS_REAIS = {
  circuito: {
    name: "CircuitOpenError",
    stack: 'CircuitOpenError: Circuit breaker aberto para "bridgeodds"\n    at withBreaker (/srv/automabaca/releases/3702/...)',
    message: 'Circuit breaker aberto para "bridgeodds"',
  },
  tempo: { value: { message: "job timed out" } },
  provider: {
    name: "ProviderRequestError",
    stack: "ProviderRequestError: BridgeOdds query falhou: fetch failed\n    at <anonymous> (/srv/automabaca/releases/1...)",
    message: "BridgeOdds query falhou: fetch failed",
  },
  deploy: { value: "pg-boss shut down while active" },
} as const;

describe("1. as quatro grafias medidas na produção classificam certo", () => {
  it("cada saída real cai na causa com a ação certa", () => {
    expect(classificaCausa(SAIDAS_REAIS.circuito)).toBe("circuito_aberto");
    expect(classificaCausa(SAIDAS_REAIS.tempo)).toBe("tempo_esgotado");
    expect(classificaCausa(SAIDAS_REAIS.provider)).toBe("provider_fora");
    expect(classificaCausa(SAIDAS_REAIS.deploy)).toBe("worker_saiu");
  });

  it("o circuito não é confundido com provider fora do ar", () => {
    // A mensagem do `CircuitOpenError` fala em "aberto para X", e um matcher
    // ingênuo de rede a levaria para `provider_fora` — que tem a ação OPOSTA
    // ("replay depois" vs "espere o circuito fechar").
    expect(classificaCausa(SAIDAS_REAIS.circuito)).not.toBe("provider_fora");
    expect(replayResolveAgora("circuito_aberto")).toBe(false);
  });

  it("o timer do worker reprovando o handler é tempo esgotado, com replay que resolve", () => {
    const saida = { name: "Error", message: "handler execution exceeded 120s", stack: "Error: handler execution exceeded 120s" };
    expect(classificaCausa(saida)).toBe("tempo_esgotado");
    expect(replayResolveAgora("tempo_esgotado")).toBe(true);
  });

  it("'job timed out' e 'shut down while active' não colapsam na mesma causa", () => {
    // O vocabulário de abandono do pg-boss (portão irmão:
    // `vocabulario-de-abandono-pgboss`). São os dois jeitos de o worker sumir,
    // mas "estourou o tempo" pode ser bug e "saiu no deploy" nunca é.
    expect(classificaCausa(SAIDAS_REAIS.tempo)).not.toBe(
      classificaCausa(SAIDAS_REAIS.deploy),
    );
  });

  it("regra de negócio não vira transitória", () => {
    expect(classificaCausa({ name: "ZodError", message: "validation failed" }))
      .toBe("regra_de_negocio");
    expect(replayResolveAgora("regra_de_negocio")).toBe(false);
  });
});

describe("2. saída fora do catálogo vira linha, nunca silêncio", () => {
  it("erro desconhecido cai em `desconhecida` com etapa acionável", () => {
    for (const saida of [null, undefined, "", {}, { value: "algo que ninguém previu" }, 42]) {
      const causa = classificaCausa(saida);
      expect(causa).toBe("desconhecida");
      expect(proximaEtapaDaCausa(causa)).toContain("erro bruto");
    }
  });

  it("`desconhecida` não habilita replay — na dúvida, não prometa", () => {
    expect(replayResolveAgora("desconhecida")).toBe(false);
  });
});

describe("3. a linha carrega a proveniência", () => {
  it("o betId sai do payload quando o job carregava um", () => {
    expect(betIdDoPayload({ betId: "6b284db2-6c70-41d3-a71f-0ea549e7059b", origem: "revive" }))
      .toBe("6b284db2-6c70-41d3-a71f-0ea549e7059b");
    for (const vazio of [null, undefined, {}, { betId: "" }, { betId: 7 }, "texto"]) {
      expect(betIdDoPayload(vazio)).toBeNull();
    }
  });

  it("o provider do circuito é extraído para conferir o estado ao vivo", () => {
    expect(providerDoCircuito(SAIDAS_REAIS.circuito)).toBe("bridgeodds");
    // Sem provider identificável o chamador cai no critério grosso; o que não
    // pode é inventar um nome e liberar o botão por engano.
    expect(providerDoCircuito(SAIDAS_REAIS.provider)).toBeNull();
    expect(providerDoCircuito(null)).toBeNull();
  });
});
