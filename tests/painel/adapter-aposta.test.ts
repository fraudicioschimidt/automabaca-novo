import { describe, expect, it } from "vitest";
import { capturaDaFicha, settlementCardOf, toBet } from "@/app/_design/adapters/aposta";
import { splitEvento } from "@/app/_design/adapters/_evento";
import { betRowToExportInput } from "@/src/services/painel/bet-export-map";
import type { BetRowData } from "@/src/domain/bet-read-model";
import type { BetSettlementEvidence } from "@/src/services/painel/aposta/liquidacao";

/**
 * toBet é a cola pura BetRowData → forma das telas: o mapa de status (cada
 * BetStatus no seu rótulo; VOID = reembolso, HALF_WON ≠ WON) e os derivados
 * (moveType, leadBefore, profit). splitEvento separa mandante e
 * visitante para as mesmas telas.
 */
function makeBet(over: Partial<BetRowData> = {}): BetRowData {
  return {
    id: "bet-1",
    data: new Date("2026-06-15T19:00:00Z"), // 16:00 SP
    evento: "Flamengo vs Palmeiras",
    competicao: "Brasileirão",
    pais: "Brasil",
    esporte: "futebol",
    mercado: "Total de gols",
    selecao: "Mais de 2.5",
    casaDeAposta: "Bet365",
    tipster: "Canal X",
    odds: 1.95,
    stake: 2,
    status: "WON",
    lucro: 1.9,
    closingOdd: 1.85,
    openingMaxBet: 300,
    closingMaxBet: 800,
    openingOdd: 2.0,
    openingRawOdd: 2.0,
    closingRawOdd: 1.85,
    registradoEm: new Date("2026-06-15T15:00:00Z"), // 12:00 SP, 4h antes do kickoff
    clv: 5.4,
    clvReliable: true,
    closingFetchedAt: new Date("2026-06-15T19:00:00Z"), // congelado no kickoff (default = resolvida)
    identityStatus: "MATCHED",
    noOddsReason: null,
    closingNoOddsReason: null,
    source: "telegram-channel:-100123",
    sourceExternalId: "123",
    contaTitular: "Fabricio",
    ...over,
  };
}

describe("toBet", () => {
  it("separa mandante/visitante e formata data/hora em SP", () => {
    const b = toBet(makeBet());
    expect(b.home).toBe("Flamengo");
    expect(b.away).toBe("Palmeiras");
    expect(b.day).toBe("2026-06-15");
    expect(b.time).toBe("16:00");
  });

  it("diz se o mercado admite meio resultado, para o menu não oferecer o ½ que a liquidação recusa", () => {
    expect(toBet(makeBet({ selecao: "Mais de 2.25" })).allowsHalfResult).toBe(true);
    expect(toBet(makeBet()).allowsHalfResult).toBe(false);
    expect(toBet(makeBet({ mercado: "Ambas marcam", selecao: "Sim" })).allowsHalfResult).toBe(false);
  });

  it("repassa o esporte (a tela escolhe o ícone via sportIconSrc)", () => {
    expect(toBet(makeBet({ esporte: "Basketball" })).esporte).toBe("Basketball");
  });

  describe("mapStatus → vocabulário completo (cada BetStatus no SEU rótulo)", () => {
    const map = (status: string) => toBet(makeBet({ status })).status;
    it("estados diretos", () => {
      expect(map("PENDING")).toBe("pending");
      expect(map("WON")).toBe("won");
      expect(map("LOST")).toBe("lost");
    });
    it("meio-ganho e meio-perda são DISTINTOS (HALF_WON não vira 'won' pleno)", () => {
      expect(map("HALF_WON")).toBe("halfwon");
      expect(map("HALF_LOST")).toBe("half");
    });
    it("VOID/CANCELED viram 'void' (reembolso) — NUNCA 'half'/'½ perdida'", () => {
      expect(map("VOID")).toBe("void");
      expect(map("CANCELED")).toBe("void");
    });
    it("CASHOUT tem rótulo próprio; status desconhecido cai em 'void' (neutro)", () => {
      expect(map("CASHOUT")).toBe("cashout");
      expect(map("XYZ")).toBe("void");
    });
  });

  it("profit: null enquanto PENDING; o lucro quando resolvida (VOID = 0, reembolso)", () => {
    expect(toBet(makeBet({ status: "PENDING" })).profit).toBeNull();
    expect(toBet(makeBet({ status: "WON", lucro: 1.9 })).profit).toBe(1.9);
    expect(toBet(makeBet({ status: "VOID", lucro: 0 })).profit).toBe(0); // resolvida, não pendente
  });

  it("transporta o placar da tip", () => {
    const mapped = toBet(makeBet({ liveScoreHome: 1, liveScoreAway: 0 }));
    expect(mapped.liveScoreAtTip).toBe("1-0");
    expect(mapped.d.liveScoreAtTip).toBe("1-0");
  });

  it("movimento da linha: abertura justa → fechamento justo, só com os dois", () => {
    expect(toBet(makeBet({ openingOdd: 2, closingOdd: 1.9, clvReliable: true, closingFetchedAt: new Date() })).movimento)
      .toBeCloseTo(-5, 6);
    expect(toBet(makeBet({ openingOdd: 2, closingOdd: null })).movimento).toBeNull();
    expect(toBet(makeBet({ openingOdd: null, closingOdd: 1.9, clvReliable: true, closingFetchedAt: new Date() })).movimento).toBeNull();
    // Abertura zerada não é movimento infinito: a ficha e o export ficam sem ele.
    const zeroOpening = makeBet({ openingOdd: 0, closingOdd: 1.9, clvReliable: true, closingFetchedAt: new Date() });
    expect(toBet(zeroOpening).movimento).toBeNull();
    expect(betRowToExportInput(zeroOpening).movimento).toBeNull();
  });

  it("moveType sai do movimento da linha (abertura → fechamento), não do CLV", () => {
    // Linha caiu 7,5%: steam, mesmo com CLV negativo.
    expect(toBet(makeBet({ openingOdd: 2, closingOdd: 1.85, clv: -3 })).d.moveType).toBe("steam");
    // Linha subiu 5%: drift, mesmo com CLV alto.
    expect(toBet(makeBet({ openingOdd: 2, closingOdd: 2.1, clv: 8 })).d.moveType).toBe("drift");
    expect(toBet(makeBet({ openingOdd: 2, closingOdd: 1.98, clv: 8 })).d.moveType).toBe("estavel");
    // Sem abertura não há movimento medido: não vira "estável".
    expect(toBet(makeBet({ openingOdd: null, clv: 8 })).d.moveType).toBeNull();
  });

  it("CLV/close só aparecem com fechamento CONGELADO (fetchedAt) — provisório não vaza", () => {
    // Provisório: snapshot pré-kickoff, linha ainda se movendo (fetchedAt null).
    // Mostrá-lo exibiria um CLV que ainda vai mudar até o kickoff.
    const prov = toBet(makeBet({ closingFetchedAt: null, clv: -10.6, closingOdd: 2.1 }));
    expect(prov.clv).toBeNull();
    expect(prov.d.close).toBeNull();
    expect(prov.d.moveType).toBeNull();
    // Congelado + confiável: aparece.
    const fin = toBet(
      makeBet({ closingFetchedAt: new Date("2026-06-16T19:00:00Z"), clv: -10.6, clvReliable: true, closingOdd: 2.1 }),
    );
    expect(fin.clv).toBeCloseTo(-10.6, 6);
    expect(fin.d.close).toBe(2.1);
    // Congelado mas NÃO confiável (kickoff sem captura): CLV não aparece.
    expect(toBet(makeBet({ closingFetchedAt: new Date(), clvReliable: false, clv: -10.6 })).clv).toBeNull();
    const semProva = toBet(makeBet({ closingFetchedAt: new Date(), clvReliable: null, clv: -10.6 }));
    expect(semProva.clv).toBeNull();
    expect(semProva.d.clvOrigem.clv).toBeNull();
    // O movimento é da linha (abertura → fechamento exibido), não do CLV.
    expect(semProva.d.moveType).toBe("steam");
  });

  it("a ficha não expõe preço nem liquidez de entrada", () => {
    const d = toBet(makeBet()).d as Record<string, unknown>;
    expect(d).not.toHaveProperty("entry");
    expect(d).not.toHaveProperty("rawEntry");
    expect(d).not.toHaveProperty("liqEntry");
  });

  it("leadBefore: captura antes do kickoff vira rótulo, depois vira null", () => {
    // Mesma escrita de duração das outras telas (formatDurationMinutes).
    expect(toBet(makeBet()).d.before).toBe("4.0 h antes");
    expect(toBet(makeBet({ registradoEm: new Date("2026-06-13T19:00:00Z") })).d.before).toBe("2 dias antes");
    expect(toBet(makeBet({ registradoEm: new Date("2026-06-15T20:00:00Z") })).d.before).toBeNull();
  });

  it("traduz o motivo de ausência de sharp para a ficha", () => {
    const semClv = { clv: null, clvReliable: false, closingOdd: null, closingRawOdd: null };
    expect(toBet(makeBet({ ...semClv, noOddsReason: "unsupported_market" })).d.noOdds)
      .toBe("modalidade ou mercado sem cobertura sharp");
    expect(toBet(makeBet({ ...semClv, noOddsReason: null, closingNoOddsReason: "kickoff_sem_captura" })).d.noOdds)
      .toBe("kickoff sem captura de closing");
  });

  it("\"Sem odds\" lê o motivo do fechamento e fica vazio com CLV confiável", () => {
    // O motivo gravado na identidade antes do fechamento não desmente o CLV.
    expect(toBet(makeBet({ noOddsReason: "no_prices" })).d.noOdds).toBeNull();
    // O do fechamento vence o da identidade.
    expect(toBet(makeBet({ clv: null, clvReliable: false, noOddsReason: "no_prices", closingNoOddsReason: "aposta_ao_vivo" })).d.noOdds)
      .toBe("entrada ao vivo — CLV não se aplica");
    // `clv_only` fala da entrada: não é motivo de faltar odd.
    expect(toBet(makeBet({ clv: null, clvReliable: null, closingFetchedAt: null, status: "PENDING", noOddsReason: "clv_only" })).d.noOdds)
      .toBeNull();
  });

  /**
   * Procedência do CLV. O adapter entrega provider, mecanismo, fetchedAt e a
   * odd bruta, não só o número: sem a cadeia, um CLV de +22,1% numa aposta
   * registrada 51min depois do apito passa batido.
   */
  describe("clvOrigem — a cadeia por trás do número", () => {
    it("entrega a conta inteira quando o fechamento está congelado", () => {
      const o = toBet(makeBet({
        odds: 2.0,
        closingRawOdd: 1.588,
        closingOdd: 1.637687,
        clv: 22.1,
        closingProvider: "bridgeodds",
        closingSource: "CRON",
      })).d.clvOrigem;
      expect(o.cravada).toBe(2.0);
      expect(o.fechamentoBruto).toBe(1.588);
      expect(o.fechamentoFair).toBeCloseTo(1.637687, 6);
      expect(o.clv).toBeCloseTo(22.1, 6);
      expect(o.provider).toBe("bridgeodds");
      // O enum é técnico; a ficha nunca mostra CRON cru.
      expect(o.mecanismo).toBe("captura automática");
      expect(o.congeladoEm).not.toBeNull();
    });

    it("mecanismo desconhecido volta como veio, sem esconder a linha", () => {
      expect(toBet(makeBet({ closingSource: "MODO_DE_OUTRA_VERSAO" })).d.clvOrigem.mecanismo)
        .toBe("MODO_DE_OUTRA_VERSAO");
      expect(toBet(makeBet({ closingSource: null })).d.clvOrigem.mecanismo).toBeNull();
    });

    it("fechamento provisório não vaza odd nenhuma para a procedência", () => {
      // Mesma regra do `clv`/`d.close`: sem `fetchedAt` a linha ainda se move.
      const o = toBet(makeBet({ closingFetchedAt: null, clv: 9, closingOdd: 2.1, closingRawOdd: 2.0 })).d.clvOrigem;
      expect(o.fechamentoBruto).toBeNull();
      expect(o.fechamentoFair).toBeNull();
      expect(o.clv).toBeNull();
    });

    it("entrada ao vivo: motivo em PT e minutos depois do apito", () => {
      const b = toBet(makeBet({
        // kickoff 19:00Z; registro 19:51Z = 51 min com a bola rolando.
        registradoEm: new Date("2026-06-15T19:51:00Z"),
        clv: null,
        clvReliable: false,
        closingNoOddsReason: "aposta_ao_vivo",
      }));
      expect(b.d.aposApito).toBe(51);
      expect(b.d.clvOrigem.motivo).toBe("entrada ao vivo — CLV não se aplica");
      expect(b.d.clvOrigem.confiavel).toBe(false);
      // pré-jogo continua sem o número, para a ficha não inventar um "0 min".
      expect(toBet(makeBet()).d.aposApito).toBeNull();
    });

    it("kickoff inferido não vira pós-apito nem antecedência", () => {
      const b = toBet(makeBet({
        kickoffInferido: true,
        data: new Date("2026-06-16T03:00:00Z"),
        registradoEm: new Date("2026-06-15T15:00:00Z"),
      }));
      expect(b.kickoffInferido).toBe(true);
      expect(b.time).toBe("—");
      expect(b.d.eventAt).toContain("horário a confirmar");
      expect(b.d.aposApito).toBeNull();
      expect(b.d.before).toBeNull();
    });

    it("lucro realizado carrega o dia da liquidação", () => {
      const b = toBet(makeBet({
        settledAt: new Date("2026-06-16T18:00:00Z"),
      }));
      expect(b.day).toBe("2026-06-15");
      expect(b.resultDay).toBe("2026-06-16");
    });
  });
});

describe("splitEvento — mandante/visitante", () => {
  it("reconhece os separadores comuns sem perder o visitante", () => {
    expect(splitEvento("Flamengo vs Palmeiras")).toEqual({ home: "Flamengo", away: "Palmeiras" });
    expect(splitEvento("Santos x Grêmio")).toEqual({ home: "Santos", away: "Grêmio" });
    expect(splitEvento("Lakers - Celtics")).toEqual({ home: "Lakers", away: "Celtics" });
    expect(splitEvento("Inter – Milan")).toEqual({ home: "Inter", away: "Milan" });
  });

  it("sem confronto reconhecível, o todo vira home e away fica vazio (contrato não-nulo)", () => {
    expect(splitEvento("Maratona de São Paulo")).toEqual({ home: "Maratona de São Paulo", away: "" });
    expect(splitEvento("Red Bull Salzburg")).toEqual({ home: "Red Bull Salzburg", away: "" });
    expect(splitEvento("")).toEqual({ home: "", away: "" });
  });
});

describe("capturaDaFicha", () => {
  it("mostra o post como chegou, como foi lido e o link que abre a mensagem", () => {
    expect(capturaDaFicha({ source: "telegram-channel:-1001234567890", sourceExternalId: "812:2", evidence: { caption: "  Flamengo x Palmeiras\nover 2.5 @1.9  ", parser: "universal" } }))
      .toEqual({ texto: "Flamengo x Palmeiras\nover 2.5 @1.9", leitura: "Lida por regra", link: "https://t.me/c/1234567890/812" });
    expect(capturaDaFicha({ source: "telegram-channel:-1001234567890", sourceExternalId: "813", evidence: { caption: null, parser: "gemini-vision" } }))
      .toEqual({ texto: null, leitura: "Lida por IA, da imagem", link: "https://t.me/c/1234567890/813" });
    expect(capturaDaFicha({ source: "telegram-channel:-1001234567890", sourceExternalId: "814", evidence: { caption: "tip", parser: "groq" } }))
      .toMatchObject({ leitura: "Lida por IA, do texto" });
    // O post não disse a unidade do total: a ficha conta que ela veio da linha.
    expect(capturaDaFicha({ source: "telegram-channel:-1001234567890", sourceExternalId: "816", evidence: { caption: "Brackley x Scarborough Over 8.5", parser: "universal", totalUnitFromLine: true } }))
      .toMatchObject({ leitura: "Lida por regra · unidade do total deduzida pela linha (escanteios)" });
  });

  it("evidência expirada deixa o link; DM não tem link; aposta manual não tem post", () => {
    expect(capturaDaFicha({ source: "telegram-channel:-1001234567890", sourceExternalId: "815", evidence: null }))
      .toEqual({ texto: null, leitura: null, link: "https://t.me/c/1234567890/815" });
    expect(capturaDaFicha({ source: "telegram-dm:123:bank", sourceExternalId: "77", evidence: { caption: "tip", parser: "telegram-dm" } }))
      .toEqual({ texto: "tip", leitura: "Enviada na conversa com o bot", link: null });
    expect(capturaDaFicha({ source: "web", sourceExternalId: null, evidence: null })).toBeNull();
  });
});

describe("settlementCardOf", () => {
  const changedAt = new Date("2026-06-15T21:05:00Z"); // 18:05 SP
  const evidence = (over: Partial<BetSettlementEvidence> = {}): BetSettlementEvidence => ({
    source: "flashscore", changedAt, status: "WON",
    terms: { mercado: "Total de gols", selecao: "Mais de 2.5", esporte: "Soccer" },
    result: null, judge: null, playerPropEvidence: null, ...over,
  });
  const result = (snapshot: Record<string, unknown>, over: Partial<NonNullable<BetSettlementEvidence["result"]>> = {}) => ({
    scoreHome: null, scoreAway: null, matchConfidence: null, final: true, snapshot, ...over,
  });

  it("liquidada pelo FlashScore: o placar que decidiu, o jogo na ordem da aposta e como ele chegou lá", () => {
    const card = settlementCardOf(evidence({
      result: result({
        settlementOutcome: "settled_from_score",
        score: { home: 2, away: 1 },
        // O feed lista o visitante da aposta como mandante.
        providerTeams: { home: "Palmeiras", away: "Flamengo", swapped: true },
      }, { scoreHome: 2, scoreAway: 1, matchConfidence: 0.95 }),
    }));
    expect(card).toEqual({
      source: "liquidação automática pelo FlashScore",
      at: "15/06 18:05",
      score: { value: "2-1", kind: "decided", detail: null },
      fixture: "Flamengo vs Palmeiras · casamento 95%",
      outcome: "pelo placar final",
      player: null,
      crossCheck: null,
      judge: null,
    });
  });

  it("fim deduzido e rechecado, tempo regulamentar e 1º tempo aparecem junto do placar", () => {
    const inferred = settlementCardOf(evidence({
      result: result({ settlementOutcome: "settled_from_score_inferido", recheck: { resultado: "confere", placar: "88x80" } },
        { scoreHome: 88, scoreAway: 80 }),
    }));
    expect(inferred.outcome).toBe("pelo placar final; o fim do jogo foi deduzido, não marcado pelo FlashScore");
    expect(inferred.crossCheck).toBe("a rechecagem horas depois confirmou o placar");

    const regulation = settlementCardOf(evidence({
      result: result({ settlementOutcome: "settled_from_regulation_score", score: { home: 2, away: 1 }, regulationScore: { home: 1, away: 1 } },
        { scoreHome: 1, scoreAway: 1 }),
    }));
    expect(regulation.score).toEqual({ value: "1-1", kind: "decided", detail: "listado 2-1, com a prorrogação" });
    expect(regulation.outcome).toBe("pelo placar do tempo regulamentar");

    const firstHalf = settlementCardOf(evidence({
      result: result({ settlementOutcome: "settled_from_basketball_first_half", score: { home: 90, away: 85 },
        basketballFirstHalf: { score: { home: 45, away: 40 } } }),
    }));
    expect(firstHalf.score).toEqual({ value: "45-40", kind: "decided", period: "HT", detail: null });
  });

  it("o placar HT observado não é a prova de uma decisão manual", () => {
    const manual = settlementCardOf(evidence({ source: "manual:dono",
      result: result({ basketballFirstHalf: { score: { home: 45, away: 40 } } }),
    }));
    expect(manual.score).toEqual({ value: "45-40", kind: "seen", period: "HT", detail: null });
    expect(manual.outcome).toBeNull();
  });

  it.each([
    ["1º tempo", "pelo placar do 1º tempo"],
    ["2º tempo", "pelo placar do 2º tempo"],
  ])("o placar FT não recebe o selo de prova de uma aposta do %s", (period, outcome) => {
    const card = settlementCardOf(evidence({
      terms: { mercado: `Total de gols — ${period}`, selecao: "Mais de 0.5", esporte: "Soccer" },
      result: result({ settlementOutcome: "settled_from_score", score: { home: 2, away: 1 } },
        { scoreHome: 2, scoreAway: 1 }),
    }));
    expect(card.score).toEqual({ value: "2-1", kind: "seen", detail: null });
    expect(card.outcome).toBe(outcome);
  });

  it("rechecagem da inferência: o placar que ela leu, na ordem da aposta, e a que não tinha base", () => {
    const recheck = (mark: Record<string, unknown>) => settlementCardOf(evidence({
      result: result({ settlementOutcome: "settled_from_score_inferido", recheck: mark,
        providerTeams: { home: "Visitante", away: "Mandante", swapped: true } }, { scoreHome: 80, scoreAway: 88 }),
    })).crossCheck;
    // O feed lista "91x80" com os times ao contrário da aposta.
    expect(recheck({ resultado: "divergente", placarAgora: "91x80" }))
      .toBe("a rechecagem horas depois leu outro placar, 80-91; a divergência foi avisada");
    expect(recheck({ resultado: "divergente", placarAgora: null }))
      .toBe("a rechecagem horas depois achou o jogo sem placar; a divergência foi avisada");
    expect(recheck({ resultado: "sem_base" })).toBe("a rechecagem não teve o placar liquidado para comparar");
    expect(recheck({ resultado: "partida_ausente" })).toBe("a rechecagem não achou mais o jogo no FlashScore");
  });

  it("placar de uma leitura com o jogo em andamento não passa por final", () => {
    // Liquidada à mão aos 75': a observação não fechou e a aposta sai da fila, com o 1-0 congelado.
    const manual = settlementCardOf(evidence({
      source: "manual:fabricio",
      result: result({ settlementOutcome: "not_attempted", score: { home: 1, away: 0 }, stage: "2nd Half", finished: false }, { final: false }),
    }));
    expect(manual.score).toEqual({ value: "1-0", kind: "partial", detail: 'fim do jogo não confirmado · FlashScore: "2nd Half"' });

    // O IA-Judge liquidou antes de a conferência fechar (esporte de fim deduzido).
    const judged = settlementCardOf(evidence({
      source: "ia-judge:ia_judge_auto",
      result: result({ settlementOutcome: "not_attempted", score: { home: 20, away: 18 }, finished: false }, { final: false }),
    }));
    expect(judged.score).toEqual({ value: "20-18", kind: "partial", detail: "fim do jogo não confirmado" });

    // A flag de fim do fornecedor basta, mesmo com a observação esperando outro dado.
    const finished = settlementCardOf(evidence({
      source: "manual:fabricio",
      result: result({ settlementOutcome: "player_prop_pending", score: { home: 3, away: 1 }, stage: "Finished", finished: true }, { final: false }),
    }));
    expect(finished.score).toEqual({ value: "3-1", kind: "seen", detail: null });
  });

  it("placar listado de jogo que passou do tempo normal leva o aviso e o estágio", () => {
    const card = settlementCardOf(evidence({
      source: "manual:fabricio",
      result: result({ settlementOutcome: "manual_extra_time", score: { home: 2, away: 1 }, stage: "After Extra Time", finished: true }),
    }));
    expect(card.score).toEqual({ value: "2-1", kind: "seen", detail: 'o jogo passou do tempo normal · FlashScore: "After Extra Time"' });

    // Os pênaltis pelo estágio, sem a recusa: a flag do feed pode faltar.
    const penalties = settlementCardOf(evidence({
      source: "manual:fabricio",
      result: result({ settlementOutcome: "already_settled", score: { home: 1, away: 1 }, stage: "After Penalties", finished: true }),
    }));
    expect(penalties.score?.detail).toBe('o jogo passou do tempo normal · FlashScore: "After Penalties"');
  });

  it("placar de jogo que não chegou ao fim: W.O., resultado fora de campo e abandono", () => {
    for (const [settlementOutcome, stage] of [
      ["manual_walkover", "Walkover"],
      ["manual_awarded", "Awarded"],
      ["manual_retired", "Finished / retired"],
      ["crosscheck_interrupted", "Abandoned"],
    ]) {
      const card = settlementCardOf(evidence({
        source: "manual:fabricio",
        result: result({ settlementOutcome, score: { home: 1, away: 0 }, stage, finished: true }),
      }));
      expect(card.score).toEqual({ value: "1-0", kind: "seen", detail: `jogo não concluído · FlashScore: "${stage}"` });
    }
  });

  it("desfecho sem rótulo aparece cru, em vez de sumir", () => {
    expect(settlementCardOf(evidence({ result: result({ settlementOutcome: "settled_from_novidade" }) })).outcome)
      .toBe("settled_from_novidade");
  });

  it("múltipla: nada de placar do primeiro jogo, e só os jogos que decidiram", () => {
    const ticket = (counts: Record<string, number>) => settlementCardOf(evidence({
      result: result({ ticket: true, ...counts }, { scoreHome: 1, scoreAway: 0 }),
    }));
    const all = ticket({ fixtures: 2, scored: 2, cancelled: 0 });
    expect(all.score).toBeNull();
    expect(all.outcome).toBe("pelos placares dos 2 jogos da múltipla");
    // Uma perna perdida decide a múltipla antes de os outros jogos acabarem.
    expect(ticket({ fixtures: 3, scored: 1, cancelled: 0 }).outcome).toBe("pelo placar de 1 dos 3 jogos da múltipla");
    expect(ticket({ fixtures: 3, scored: 2, cancelled: 1 }).outcome)
      .toBe("pelos placares de 2 dos 3 jogos da múltipla; 1 jogo cancelado ou adiado");
    expect(ticket({ fixtures: 2, scored: 0, cancelled: 2 }).outcome).toBe("jogos cancelados ou adiados, reembolso");
  });

  describe("prop de jogador", () => {
    const settledProof = { playerName: "Raphinha", family: "shots_on_target", decision: { ok: true, status: "WON", value: 3 } };
    const propCard = (details: Record<string, unknown>, current: Record<string, unknown> | null = null) => settlementCardOf(evidence({
      result: result({ settlementOutcome: "settled_from_player_prop", score: { home: 0, away: 0 },
        playerProp: { version: 1, resolvido: true, motivo: "comprovado", details } }),
      playerPropEvidence: current,
    }));

    it("a estatística vem da prova da liquidação, não da rechecagem que regravou a prop", () => {
      const recheck = { ...settledProof, checked24h: true, decision: { ok: true, status: "LOST", value: 2 },
        previousProposal: "WON", correctionReview: true };
      const card = propCard(settledProof, recheck);
      expect(card.player).toBe("Raphinha · 3 chutes no gol");
      expect(card.crossCheck).toBe(
        "a rechecagem 24h depois leu Raphinha · 2 chutes no gol (Perdida); a divergência está para conferir em Config › Jogadores",
      );
    });

    it("a rechecagem que confirma, a que muda só o valor, a conferida e a que não leu", () => {
      expect(propCard(settledProof, { ...settledProof, checked24h: false }).crossCheck).toBeNull();
      expect(propCard(settledProof, { ...settledProof, checked24h: true }).crossCheck)
        .toBe("a rechecagem 24h depois confirmou a estatística");
      expect(propCard(settledProof, { ...settledProof, checked24h: true, decision: { ok: true, status: "WON", value: 4 } }).crossCheck)
        .toBe("a rechecagem 24h depois leu Raphinha · 4 chutes no gol, sem mudar o resultado");
      expect(propCard(settledProof, { ...settledProof, checked24h: true, decision: { ok: true, status: "LOST", value: 1 },
        correctionReview: false, divergenceExplanation: "A casa pagou pelos 3 chutes do bilhete." }).crossCheck)
        .toBe("a rechecagem 24h depois leu Raphinha · 1 chute no gol (Perdida); conferida: A casa pagou pelos 3 chutes do bilhete.");
      const unread = propCard(settledProof, { ...settledProof, checked24h: true, correctionReview: true,
        decision: { ok: false, reason: "stat_ausente" } });
      expect(unread.player).toBe("Raphinha · 3 chutes no gol");
      expect(unread.crossCheck).toBe(
        "a rechecagem 24h depois não confirmou a estatística (stat ausente); a divergência está para conferir em Config › Jogadores",
      );
    });

    it("titular ausente e família que faltou no JSON", () => {
      expect(propCard({ ...settledProof, decision: { ok: true, status: "VOID", value: null } }).player).toBe("Raphinha não foi titular");
      expect(propCard({ playerName: "Raphinha", decision: { ok: true, status: "WON", value: 3 } }).player).toBe("Raphinha · 3");
    });
  });

  it("artilheiro: gols, reembolso de quem não entrou, período e ordem do gol", () => {
    const player = (snapshot: Record<string, unknown>, over: Partial<BetSettlementEvidence> = {}) =>
      settlementCardOf(evidence({ result: result(snapshot), ...over })).player;
    expect(player({ playerProp: { resolvido: true, jogador: "Pedro", family: "fouls_committed", valor: 2 } })).toBe("Pedro · 2 faltas");
    expect(player({ goalscorer: { resolvido: true, jogador: "Pedro", gols: 1 } })).toBe("Pedro · 1 gol");
    expect(player({ goalscorer: { resolvido: true, jogador: "Pedro", gols: 0 } }, { status: "VOID" })).toBe("Pedro não entrou em campo");
    expect(player({ settlementOutcome: "settled_from_goalscorer_period", goalscorer: { resolvido: true, jogador: "Pedro", gols: 1 } },
      { terms: { mercado: "Goalscorer - 1st Half", selecao: "Pedro", esporte: "Soccer" } })).toBe("Pedro · 1 gol no 1º tempo");
    // Esporte de fim deduzido: o desfecho chega com a marca de inferência, e o tempo continua.
    expect(player({ settlementOutcome: "settled_from_goalscorer_period_inferido", goalscorer: { resolvido: true, jogador: "Pedro", gols: 2 } },
      { terms: { mercado: "Goalscorer - 2nd Half", selecao: "Pedro", esporte: "Futsal" } })).toBe("Pedro · 2 gols no 2º tempo");
    const ordered = { resolvido: true, ordem: "last", jogadorSelecionado: "Hulk", jogadorDoGol: "Hulk", minuto: "88" };
    expect(player({ orderedGoalscorer: ordered })).toBe("último gol: Hulk aos 88'");
    expect(player({ orderedGoalscorer: { ...ordered, ordem: "first", jogadorDoGol: "Pedro", minuto: "23" } }, { status: "LOST" }))
      .toBe("primeiro gol: Pedro aos 23'");
    expect(player({ orderedGoalscorer: ordered }, { status: "VOID" })).toBe("Hulk não entrou em campo");
    expect(player({ goalscorer: { resolvido: false, motivo: "jogador_ambiguo" } })).toBeNull();
  });

  it("IA-Judge: o que achou, a certeza, a fonte confiável e a conferência do FlashScore", () => {
    const judge = { valueFound: "Palmeiras 1-2 Flamengo", confidence: 0.972, reason: "Placar final no Sofascore.",
      provider: "gemini", sourceUrl: "https://www.sofascore.com/football/match/x#id:1", evidenceKind: "GROUNDED_WEB" as const };
    const card = settlementCardOf(evidence({
      source: "ia-judge:ia_judge_auto",
      judge,
      result: result({ settlementOutcome: "crosscheck_agrees", score: { home: 2, away: 1 } }),
    }));
    expect(card.source).toBe("IA-Judge automático");
    expect(card.score).toEqual({ value: "2-1", kind: "seen", detail: null });
    expect(card.outcome).toBeNull();
    expect(card.crossCheck).toBe("o FlashScore confirmou o resultado da IA");
    expect(card.judge).toEqual({
      found: "Palmeiras 1-2 Flamengo", confidence: "97%", link: "https://www.sofascore.com/football/match/x",
      site: "sofascore.com", fromFlashscore: false, reason: "Placar final no Sofascore.", model: "gemini",
    });

    // Link fora das fontes esportivas conhecidas não vira clique; sem observação, sem conferência.
    const untrusted = settlementCardOf(evidence({ source: "ia-judge:fabricio", judge: { ...judge, sourceUrl: "https://blog.qualquer.com/p" } }));
    expect(untrusted.source).toBe("IA-Judge (fabricio)");
    expect(untrusted.judge).toMatchObject({ link: null, site: null, fromFlashscore: false });
    expect(untrusted.crossCheck).toBe("sem conferência do FlashScore");
  });

  it("IA-Judge pelos dados do FlashScore: a fonte é ele, e o jogo não disputado sai em português", () => {
    const card = settlementCardOf(evidence({
      source: "ia-judge:fabricio",
      status: "VOID",
      judge: { valueFound: "cancelled", confidence: 1, reason: "Snapshot FlashScore marca a partida como CANCELADA.",
        provider: "flashscore-status", sourceUrl: null, evidenceKind: "FLASHSCORE_STRUCTURED" },
    }));
    // A regra sobre o snapshot decidiu antes do LLM: não há modelo a citar.
    expect(card.judge).toMatchObject({ found: "jogo cancelado", link: null, fromFlashscore: true, model: null });

    const judgedWithData = settlementCardOf(evidence({
      source: "ia-judge:fabricio",
      judge: { valueFound: "Palmeiras 1-2 Flamengo", confidence: 0.96, reason: "O resumo do FlashScore dá 1-2.",
        provider: "gemini", sourceUrl: null, evidenceKind: "FLASHSCORE_STRUCTURED" },
    }));
    expect(judgedWithData.judge).toMatchObject({ fromFlashscore: true, model: "gemini" });
  });

  it("liquidada à mão: o placar gravado é o que o FlashScore viu, não a causa", () => {
    const card = settlementCardOf(evidence({
      source: "manual:fabricio",
      result: result({ settlementOutcome: "settled_from_score", score: { home: 1, away: 1 } }, { scoreHome: 1, scoreAway: 1 }),
    }));
    expect(card).toMatchObject({
      source: "ação manual (fabricio)",
      score: { value: "1-1", kind: "seen", detail: null },
      outcome: null,
      player: null,
      crossCheck: null,
      judge: null,
    });
  });
});
