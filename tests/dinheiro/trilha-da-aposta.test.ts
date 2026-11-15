import { describe, expect, it } from "vitest";
import {
  ACOES_DE_AUDITORIA_DA_TRILHA,
  CHAVES_DE_EVENTO,
  EVENTOS_DA_TRILHA,
  type ChaveDeEvento,
  type EventoBruto,
  classificarEventoDeAuditoria,
  narrar,
  rotuloDaFonteDeLiquidacao,
} from "@/src/domain/trilha-da-aposta";
import { ACOES_COM_RETENCAO_ESTENDIDA } from "@/src/services/ops/audit-purge";

/** Só o texto da narração, sem a marcação. */
const fraseSimples = (evento: EventoBruto): string =>
  narrar(evento).frase.map((t) => t.texto).join("");

/**
 * Todo evento gravado precisa de narração na ficha da aposta, e a técnica do
 * negrito não pode morrer por prosa variável. Sem narração, a ficha não mostra,
 * por exemplo, um resultado já liquidado trocado depois do fato (`VOID → LOST`).
 *
 * Como na Vercel: frase uniforme, negrito só na parte variável. Se o CONECTIVO
 * variar entre dois eventos do mesmo tipo, a coluna deixa de ser escaneável e o
 * negrito vira decoração — e ninguém percebe lendo o código, porque cada
 * `narrar` isolado parece certo. Por isso a narração devolve `Trecho[]` em vez
 * de string: é o que torna a propriedade PROVÁVEL (caso 2).
 *
 * A outra ponta é a purga: tudo o que a trilha exibe precisa da retenção da
 * aposta (365 dias), não da comum de 30. Caso 3.
 */

/** Dois payloads por tipo, no formato que a produção grava. */
const AMOSTRAS: Record<ChaveDeEvento, [EventoBruto, EventoBruto]> = {
  captura: [
    evento("captura", "telegram-channel:gemini-vision", {
      odds: 1.95, stake: 1, evento: "Magallanes vs Cobreloa", mercado: "Asian Handicap",
      selecao: "Cobreloa +0.5", source: "telegram-channel:-1003760086340",
    }),
    evento("captura", "telegram-channel:universal", {
      odds: 1.61, stake: 2, evento: "Bage vs APAFUT", mercado: "Total",
      selecao: "Under 2.5", source: "telegram-channel:-1004403068924",
    }),
  ],
  captura_repetida: [
    evento("captura_repetida", "telegram-channel:gemini", {
      source: "telegram-channel:-1003760086340", sourceExternalId: "43:2", odds: 1.95, stake: 1,
    }),
    evento("captura_repetida", "telegram-dm", {
      source: "telegram-dm:77:bankroll-1", sourceExternalId: "812", odds: 2.1, stake: 0.5,
    }),
  ],
  edicao: [
    evento("edicao", "sport-resolver", {
      antes: { esporte: "Unknown", mercado: "Asian Handicap", odds: 1.95 },
      depois: { esporte: "Soccer", mercado: "Handicap – Match", odds: 1.95 },
    }),
    // Muda um campo só, e outro: se o diff estivesse embutido na frase, o
    // conectivo divergiria aqui — é exatamente o que o caso 2 impede.
    evento("edicao", "fabricio", {
      antes: { stake: 1 },
      depois: { stake: 3 },
    }),
  ],
  nao_peguei: [
    evento("nao_peguei", "fabricio", {
      motivo: "Exclusão manual pelo painel", previousLucro: -1, previousStatus: "LOST",
    }),
    evento("nao_peguei", "telegram-reaction", {
      motivo: "Reação 👎 no canal", previousLucro: 0, previousStatus: "PENDING",
    }),
  ],
  nao_peguei_desfeito: [
    evento("nao_peguei_desfeito", "fabricio", { restoredStatus: "PENDING", motivo: "👍 no canal" }),
    evento("nao_peguei_desfeito", "telegram-reaction", { restoredStatus: "WON", motivo: "desfazer 👎" }),
  ],
  peguei: [
    evento("peguei", "telegram-user:123", { via: "👍 no post do canal", takenAt: "2026-09-24T17:02:00.000Z", messageId: 42 }),
    evento("peguei", "telegram-user:456", { via: "👍 no post do canal", takenAt: "2026-09-23T23:40:00.000Z", messageId: 7 }),
  ],
  peguei_desfeito: [
    evento("peguei_desfeito", "telegram-user:123", { via: "👍 retirado do post do canal", previousTakenAt: "2026-09-24T17:02:00.000Z" }),
    evento("peguei_desfeito", "telegram-user:456", { via: "👍 retirado do post do canal", previousTakenAt: null }),
  ],
  mercado_corrigido: [
    evento("mercado_corrigido", "codex:logs-48h", {
      antes: { mercado: "Moneyline", selecao: "Ambas 2+ cartões" },
      depois: { mercado: "Both Teams Cards – Match", selecao: "Ambas 2+ cartões" },
      motivo: "forma compacta classificada incorretamente na captura",
    }),
    evento("mercado_corrigido", "fabricio", {
      antes: { mercado: "Total" },
      depois: { mercado: "Total – Match" },
      motivo: "correção manual",
    }),
  ],
  identidade_auto: [
    evento("identidade_auto", "system", {
      via: "AUTO", match: "Bage vs APAFUT", confidence: 100, providerMatchId: "1633447577",
    }),
    evento("identidade_auto", "system", {
      via: "AUTO", match: "Magallanes vs Cobreloa", confidence: 92, providerMatchId: "1633447999",
    }),
  ],
  identidade_llm: [
    evento("identidade_llm", "system", {
      via: "LLM", match: "Deportes Recoleta vs CSD Rangers", confidence: 71,
      providerMatchId: "1633454167",
    }),
    evento("identidade_llm", "system", {
      via: "LLM", match: "Bage vs APAFUT", confidence: 64, providerMatchId: "1633454168",
    }),
  ],
  identidade_vinculada: [
    evento("identidade_vinculada", "agent:gemini:por:fabricio", {
      match: "Alianza Valledupar vs Junior de Barranquilla", providerMatchId: "1633454170",
      antes: { evento: "Alianza FC vs Junior de Barranquilla", selecao: "Alianza FC +0.5", pais: "", competicao: "",
        data: "2026-09-12T23:00:00.000Z", kickoffInferido: true },
      depois: { evento: "Alianza Valledupar vs Junior de Barranquilla", selecao: "Alianza Valledupar +0.5",
        pais: "Colombia", competicao: "Primera A", data: "2026-09-13T00:30:00.000Z", kickoffInferido: false },
    }),
    evento("identidade_vinculada", "operador", {
      match: "Deportivo Moquegua vs Sporting Cristal", providerMatchId: "1633454171",
      antes: { evento: "UCV Moquegua vs Sporting Cristal", selecao: "Sporting Cristal", pais: "Peru", competicao: "Liga 1",
        data: "2026-09-14T20:00:00.000Z", kickoffInferido: false },
      depois: { evento: "Deportivo Moquegua vs Sporting Cristal", selecao: "Sporting Cristal", pais: "Peru", competicao: "Liga 1",
        data: "2026-09-14T20:00:00.000Z", kickoffInferido: false },
    }),
  ],
  kickoff_corrigido: [
    evento("kickoff_corrigido", "system", {
      source: "bridge", aplicado: true,
      anterior: "2026-08-12T17:23:40.000Z", resolvido: "2026-08-12T19:00:00.000Z",
    }),
    evento("kickoff_corrigido", "system", {
      source: "flashscore", aplicado: true,
      anterior: "2026-08-10T12:00:00.000Z", resolvido: "2026-08-10T14:30:00.000Z",
    }),
  ],
  kickoff_tentativa: [
    evento("kickoff_tentativa", "system", {
      source: "web", aplicado: false, anterior: "2026-08-12T17:23:40.000Z",
    }),
    evento("kickoff_tentativa", "system", {
      source: "pinnacle17", aplicado: false, anterior: "2026-08-11T09:00:00.000Z",
    }),
  ],
  kickoff_outro_esporte: [
    evento("kickoff_outro_esporte", "system", {
      source: "web", aplicado: false, anterior: "2026-09-24T12:00:00.000Z", resolvido: null,
      esporteAnterior: "Basketball", esporteResolvido: "Volleyball", missReason: "other_sport",
    }),
    evento("kickoff_outro_esporte", "system", {
      source: "flashscore", aplicado: false, anterior: "2026-09-20T18:30:00.000Z", resolvido: null,
      esporteAnterior: "Futsal", esporteResolvido: "Soccer", missReason: "other_sport",
    }),
  ],
  kickoff_remarcado: [
    evento("kickoff_remarcado", "system:closing-series", {
      provider: "pinnacle17", anterior: "2026-08-12T19:00:00.000Z", novo: "2026-08-12T21:00:00.000Z",
    }),
    evento("kickoff_remarcado", "system:closing-series", {
      provider: "pinnacle17", anterior: "2026-08-10T15:00:00.000Z", novo: "2026-08-10T14:30:00.000Z",
    }),
  ],
  reabertura: [
    evento("reabertura", "fabricio", { from: "WON", to: "PENDING", source: "manual:fabricio" }),
    evento("reabertura", "operador", { from: "LOST", to: "PENDING", source: "manual:operador" }),
  ],
  liquidacao: [
    evento("liquidacao", "system", {
      from: "PENDING", to: "WON", lucro: 1.066667, source: "flashscore",
    }),
    evento("liquidacao", "system", {
      from: "PENDING", to: "LOST", lucro: -1, source: "telegram-edit",
    }),
  ],
  reliquidacao: [
    evento("reliquidacao", "system", {
      from: "VOID", to: "LOST", lucro: -2, source: "manual:new-bot:recalc-ah-live",
    }),
    evento("reliquidacao", "system", {
      from: "VOID", to: "HALF_WON", lucro: 0.62, source: "manual:new-bot:caixa-acoes",
    }),
  ],
  liquidacao_delegada: [
    evento("liquidacao_delegada", "agent:antigravity:por:operador", {
      agent: "antigravity", approvedBy: "operador",
      evidence: "Placar final 2-1 conferido na súmula do campeonato.",
    }),
    evento("liquidacao_delegada", "agent:claude:por:fabricio", {
      agent: "claude", approvedBy: "fabricio",
      evidence: "Estatística oficial de cartões no site da federação.",
    }),
  ],
  esporte_por_operador: [
    evento("esporte_por_operador", "🤖 Gemini (por Fabricio)", {
      status: "resolved", sport: "Basketball", evidence: "FlashScore lista o jogo na liga chilena de basquete",
    }),
    evento("esporte_por_operador", "agent:claude:por:fabricio", {
      status: "pending", sport: "Soccer", reason: "candidate_dissent",
    }),
  ],
};

function evento(
  chave: ChaveDeEvento,
  ator: string,
  dados: Record<string, unknown>,
): EventoBruto {
  return { chave, ator, outcome: "success", em: new Date("2026-08-12T17:00:00Z"), dados };
}

/** O texto que NÃO é negrito — a moldura da frase. */
function conectivo(e: EventoBruto): string {
  return narrar(e)
    .frase.filter((t) => !t.forte)
    .map((t) => t.texto)
    .join("");
}

describe("registro da trilha", () => {
  it("todo tipo narra, sem trecho vazio, e a frase fecha com ponto", () => {
    for (const chave of CHAVES_DE_EVENTO) {
      const [primeiro] = AMOSTRAS[chave];
      const { frase } = narrar(primeiro);
      expect(frase.length, `${chave} não narra`).toBeGreaterThan(0);
      for (const t of frase) {
        expect(t.texto, `${chave} tem trecho vazio`).not.toBe("");
      }
      expect(frase.some((t) => t.forte), `${chave} não tem parte variável`).toBe(true);
      expect(fraseSimples(primeiro).endsWith("."), `${chave}: ${fraseSimples(primeiro)}`).toBe(true);
      expect(EVENTOS_DA_TRILHA[chave].rotulo.length).toBeGreaterThan(0);
    }
  });

  it("toda chave do tipo está no registro, e vice-versa", () => {
    expect(new Set(CHAVES_DE_EVENTO).size).toBe(CHAVES_DE_EVENTO.length);
    expect(CHAVES_DE_EVENTO.sort()).toEqual(Object.keys(EVENTOS_DA_TRILHA).sort());
  });
});

/**
 * O caso que justifica `Trecho[]`. Se a narração devolvesse string, esta
 * propriedade seria indemonstrável e a técnica apodreceria em silêncio.
 */
describe("a moldura da frase é a MESMA entre eventos do mesmo tipo", () => {
  it("dois eventos do mesmo tipo diferem só nos trechos em negrito", () => {
    for (const chave of CHAVES_DE_EVENTO) {
      const [a, b] = AMOSTRAS[chave];
      expect(
        conectivo(a),
        `"${chave}": o conectivo muda entre dois eventos, então o negrito deixa `
        + `de marcar o que difere.\n  A: ${fraseSimples(a)}\n  B: ${fraseSimples(b)}`,
      ).toBe(conectivo(b));
    }
  });

  it("a edição do horário aparece no diff, no fuso de São Paulo", () => {
    const edicao = evento("edicao", "fabricio", {
      antes: { data: "2026-08-12T17:23:40.000Z", kickoffInferido: true, odds: 1.9 },
      depois: { data: "2026-08-12T22:00:00.000Z", kickoffInferido: false, odds: 1.9 },
    });
    expect(narrar(edicao).mudancas).toEqual([
      { campo: "início do jogo", de: "12/08 14:23", para: "12/08 19:00" },
      { campo: "horário a confirmar", de: "sim", para: "não" },
    ]);
  });

  it("o diff sai FORA da frase — é o que mantém a moldura fixa", () => {
    const [umCampo, outroCampo] = AMOSTRAS.edicao;
    expect(narrar(umCampo).mudancas?.length).toBeGreaterThan(1);
    expect(narrar(outroCampo).mudancas).toEqual([{ campo: "stake", de: "1", para: "3" }]);
    // Contagens diferentes de mudanças, mesma frase.
    expect(fraseSimples(umCampo)).toBe("Aposta editada por sport-resolver.");
    expect(fraseSimples(outroCampo)).toBe("Aposta editada por fabricio.");
  });
});

describe("classificação", () => {
  it("uma action pode virar DUAS chaves — kickoff aplicado vs tentativa", () => {
    expect(classificarEventoDeAuditoria("kickoff.resolve_attempt", { aplicado: true }))
      .toBe("kickoff_corrigido");
    expect(classificarEventoDeAuditoria("kickoff.resolve_attempt", { aplicado: false }))
      .toBe("kickoff_tentativa");
    // Ausente é tentativa: o viés pessimista não afirma correção que não houve.
    expect(classificarEventoDeAuditoria("kickoff.resolve_attempt", {}))
      .toBe("kickoff_tentativa");
  });

  it("a fonte que achou o jogo em outro esporte não vira 'não encontrou o evento'", () => {
    expect(classificarEventoDeAuditoria("kickoff.resolve_attempt", { aplicado: false, missReason: "other_sport" }))
      .toBe("kickoff_outro_esporte");
    expect(classificarEventoDeAuditoria("kickoff.resolve_attempt", { aplicado: false, missReason: "catalogs_and_web_miss" }))
      .toBe("kickoff_tentativa");
    const frase = fraseSimples(AMOSTRAS.kickoff_outro_esporte[0]);
    expect(frase).toContain("achou o jogo em Volleyball");
    expect(frase).toContain("a aposta está em Basketball");
    expect(frase).not.toContain("não encontrou");
  });

  it("a aposta repetida diz de onde chegou: a origem, a mensagem e o item do lote", () => {
    expect(classificarEventoDeAuditoria("bet.duplicate_absorbed", {})).toBe("captura_repetida");
    expect(fraseSimples(AMOSTRAS.captura_repetida[0]))
      .toBe("A mesma aposta chegou de novo por Canal Telegram, mensagem 43, item 2 e ficou nesta, sem virar outra.");
    expect(fraseSimples(AMOSTRAS.captura_repetida[1])).toContain("por Telegram (DM), mensagem 812 e ficou");
  });

  it("action fora do vocabulário devolve null — quem chama DESCARTA", () => {
    expect(classificarEventoDeAuditoria("telegram.parse", {})).toBe(null);
    expect(classificarEventoDeAuditoria("bet.settle", {})).toBe(null);
    expect(classificarEventoDeAuditoria("bet.settle_delegated", {})).toBe("liquidacao_delegada");
    expect(classificarEventoDeAuditoria("bet.sport_resolve.operator", {})).toBe("esporte_por_operador");
    expect(fraseSimples(AMOSTRAS.esporte_por_operador[0]))
      .toBe("Esporte confirmado por 🤖 Gemini (por Fabricio): Basketball — FlashScore lista o jogo na liga chilena de basquete.");
    expect(classificarEventoDeAuditoria("bet.kickoff_moved_by_provider", {})).toBe("kickoff_remarcado");
  });
});

describe("dado torto não quebra nem some", () => {
  it("details vazio narra com marca de ausência, nunca undefined", () => {
    for (const chave of CHAVES_DE_EVENTO) {
      const frase = fraseSimples({ ...AMOSTRAS[chave][0], dados: {} });
      expect(frase, `${chave} vazou undefined`).not.toContain("undefined");
      expect(frase, `${chave} vazou [object Object]`).not.toContain("[object Object]");
      expect(frase.length).toBeGreaterThan(0);
    }
  });

  it("status fora do enum se DECLARA em vez de virar reembolso", () => {
    // `rotuloDeStatus` manda desconhecido para "reembolso" — certo para cor,
    // mentira em prosa: afirmaria um resultado que ninguém apurou.
    const frase = fraseSimples({
      ...AMOSTRAS.liquidacao[0],
      dados: { from: "PENDING", to: "BANANA", lucro: 1, source: "flashscore" },
    });
    expect(frase).toContain("status desconhecido (BANANA)");
    expect(frase).not.toContain("reembolso");
  });

  it("fonte de liquidação desconhecida vira rótulo explícito, nunca string crua solta", () => {
    expect(rotuloDaFonteDeLiquidacao("flashscore")).toBe("liquidação automática pelo FlashScore");
    expect(rotuloDaFonteDeLiquidacao("ia-judge:ia_judge_auto")).toBe("IA-Judge automático");
    expect(rotuloDaFonteDeLiquidacao("ia-judge:fabricio")).toBe("IA-Judge (fabricio)");
    expect(rotuloDaFonteDeLiquidacao("ia-judge:agent:gemini:por:fabricio")).toBe("IA-Judge (🤖 Gemini (por Fabricio))");
    expect(rotuloDaFonteDeLiquidacao("manual:new-bot:recalc-ah-live"))
      .toBe("ação manual (new-bot:recalc-ah-live)");
    expect(rotuloDaFonteDeLiquidacao("provider-x")).toBe("fonte desconhecida (provider-x)");
    expect(rotuloDaFonteDeLiquidacao(null)).toBe("fonte não registrada");
    expect(rotuloDaFonteDeLiquidacao("")).toBe("fonte não registrada");
  });
});

/**
 * A outra ponta: de nada adianta narrar bonito se a purga apaga o material
 * antes da aposta morrer.
 */
describe("o que a trilha exibe, a purga não apaga antes", () => {
  it("toda action do registro tem retenção estendida", () => {
    for (const acao of ACOES_DE_AUDITORIA_DA_TRILHA) {
      expect(
        ACOES_COM_RETENCAO_ESTENDIDA.includes(acao),
        `"${acao}" aparece na trilha e seria purgada aos 30 dias — a ficha ficaria `
        + `furada no 31º dia, sem erro e sem aviso.`,
      ).toBe(true);
    }
  });
});


describe("alterações completas na trilha", () => {
  it.each([
    ["contaId", "conta", "conta-antiga", "conta-nova"],
    ["sportResolutionStatus", "confirmação do esporte", "PENDING", "CONFIRMED"],
  ])("exibe alteração isolada de %s", (key, label, before, after) => {
    const changes = narrar(evento("edicao", "operador", { antes: { [key]: before }, depois: { [key]: after } })).mudancas;
    expect(changes).toHaveLength(1);
    expect(changes![0]!.campo).toBe(label);
    expect(changes![0]!.de).not.toBe(changes![0]!.para);
  });

  it("exibe a perna da múltipla que mudou, com seus termos", () => {
    const leg = { evento: "A vs B", mercado: "Total", selecao: "Over 2.5" };
    const before = { kind: "same_game", legs: [leg, { ...leg, mercado: "Money Line", selecao: "A" }] };
    const after = { ...before, legs: [{ ...leg, selecao: "Over 3.5" }, before.legs[1]] };
    const changes = narrar(evento("edicao", "operador", { antes: { legsJson: before }, depois: { legsJson: after } })).mudancas;
    expect(changes).toHaveLength(1);
    expect(changes![0]!.de).toContain("A vs B — Total — Over 2.5");
    expect(changes![0]!.para).toContain("A vs B — Total — Over 3.5");
    expect(changes![0]!.para).not.toContain("[object Object]");
  });
});


describe("histórico da identidade automática", () => {
  it.each(["identidade_auto", "identidade_llm"] as const)("exibe os campos alterados por %s", (key) => {
    const changes = narrar(evento(key, "system", { antes: { pais: "", competicao: "" },
      depois: { pais: "Brasil", competicao: "Serie A" } })).mudancas;
    expect(changes).toEqual([{ campo: "país", de: "—", para: "Brasil" },
      { campo: "campeonato", de: "—", para: "Serie A" }]);
  });
});
