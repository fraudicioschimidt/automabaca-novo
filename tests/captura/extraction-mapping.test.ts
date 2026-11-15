import { describe, expect, it } from "vitest";
import type { OcrReading } from "@/src/domain/capture-ocr-evidence";
import { llmBetSchema } from "@/src/services/capture/reading/extraction-contract";
import {
  extractionEvidence, extractionSourceFields, isUsableBetExtraction, mapLlmBetToParsed, mapLlmBetToParsedList,
} from "@/src/services/capture/reading/extraction-mapping";
import { extractionContentProblem, missingExtractionNumbers } from "@/src/services/capture/reading/extraction-quality";

const NOW = new Date("2026-06-10T12:00:00Z");

const base = {
  isBet: true as const,
  evento: "A vs B",
  mercado: "Total",
  selecao: "Over 2.5",
  odds: 1.9,
  stake: 1,
};

describe("mapLlmBetToParsed (saída de LLM é input hostil)", () => {
  it("converte resposta válida, com data em fuso SP", () => {
    const bet = mapLlmBetToParsed(
      {
        isBet: true,
        evento: "Flamengo vs Palmeiras",
        esporte: "Soccer",
        mercado: "Total",
        selecao: "Over 2.5",
        odds: 1.91,
        stake: 0.5,
        dataTexto: "15/06 16:00",
      },
      NOW,
    );
    expect(bet).not.toBeNull();
    expect(bet!.data?.toISOString()).toBe("2026-06-15T19:00:00.000Z");
    expect(bet!.stake).toBe(0.5);
  });

  it("isBet=false e campos essenciais ausentes viram null", () => {
    expect(mapLlmBetToParsed({ isBet: false }, NOW)).toBeNull();
    expect(mapLlmBetToParsed({ isBet: true, evento: "A vs B", odds: 1.9 }, NOW)).toBeNull();
    expect(mapLlmBetToParsed({ ...base, mercado: "" }, NOW)).toBeNull();
    expect(mapLlmBetToParsed({ ...base, mercado: undefined }, NOW)).toBeNull();
  });

  it("alucinações: odds absurda, stake gigante e stake ausente são rejeitadas", () => {
    expect(mapLlmBetToParsed({ ...base, odds: 99999 }, NOW)).toBeNull();

    const longshot = mapLlmBetToParsed({ ...base, odds: 150 }, NOW);
    expect(longshot).not.toBeNull();
    expect(longshot!.odds).toBe(150);

    // Stake acima do teto: rejeita (não capar em silêncio).
    expect(mapLlmBetToParsed({ ...base, stake: 5000 }, NOW)).toBeNull();

    const { stake: _stake, ...withoutStake } = base;
    expect(mapLlmBetToParsed(withoutStake, NOW)).toBeNull();
  });

  it("JSON fora do schema (tipos errados) vira null, nunca exceção", () => {
    expect(mapLlmBetToParsed({ isBet: "sim" }, NOW)).toBeNull();
    expect(mapLlmBetToParsed("lixo", NOW)).toBeNull();
    expect(mapLlmBetToParsed(null, NOW)).toBeNull();
  });

  it("odds como string (ex.: \"2.000\" do bilhete) são coeridas", () => {
    const bet = mapLlmBetToParsed(
      {
        isBet: true,
        evento: "França vs Marrocos",
        mercado: "Asian Handicap",
        selecao: "França -1.0",
        odds: "2.000",
        stake: "1",
      },
      NOW,
    );
    expect(bet).not.toBeNull();
    expect(bet!.odds).toBe(2);
    expect(bet!.stake).toBe(1);
  });

  it("usa o parser decimal canônico para formatos brasileiro e misto", () => {
    const bet = mapLlmBetToParsed(
      { ...base, odds: "1,850", stake: "1,25" },
      NOW,
    );
    expect(bet?.odds).toBe(1.85);
    expect(bet?.stake).toBe(1.25);
    expect(mapLlmBetToParsed({ ...base, stake: "1.234,56" }, NOW)).toBeNull();
  });

  it("preserva placar live estruturado da visão e rejeita par inconsistente", () => {
    const bet = mapLlmBetToParsed({
      ...base,
      mercado: "Asian Handicap",
      selecao: "TPS +0.25",
      liveScoreHome: 1,
      liveScoreAway: 0,
    }, NOW);
    expect(bet).toMatchObject({ liveScoreHome: 1, liveScoreAway: 0 });
    expect(mapLlmBetToParsed({
      ...base,
      mercado: "Asian Handicap",
      selecao: "TPS +0.25",
      liveScoreHome: 1,
    }, NOW)).toBeNull();
  });
});

describe("isUsableBetExtraction (filtro da cascata)", () => {
  it("aceita isBet=false", () => {
    expect(isUsableBetExtraction({ isBet: false })).toBe(true);
  });

  it("rejeita aposta sem odd ou mercado; aceita stake ausente para rascunho", () => {
    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "França vs Marrocos",
        selecao: "França -1.0",
        stake: 1,
      }),
    ).toBe(false);
    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "França vs Marrocos",
        selecao: "França -1.0",
        odds: 2,
        stake: 1,
      }),
    ).toBe(false);
    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "França vs Marrocos",
        mercado: "Asian Handicap",
        selecao: "França -1.0",
        odds: 2,
      }),
    ).toBe(true);
  });

  it("aceita aposta completa", () => {
    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "França vs Marrocos",
        mercado: "Asian Handicap",
        selecao: "França -1.0",
        odds: 2,
        stake: 1,
      }),
    ).toBe(true);
  });

  it("rejeita resposta com placar live pela metade ou conflitante", () => {
    expect(isUsableBetExtraction({
      ...base,
      liveScoreHome: 1,
    })).toBe(false);
    expect(isUsableBetExtraction({
      ...base,
      mercado: "Asian Handicap",
      selecao: "(1-0) B +0.25",
      liveScoreHome: 2,
      liveScoreAway: 0,
    })).toBe(false);
  });
});

describe("stake e placar ausentes não viram números inventados", () => {
  const CAP_NOW = new Date("2026-06-15T19:00:00Z");

  it("placar null significa ausência, preservando zero verdadeiro e recusando par incompleto", () => {
    const raw = { isBet: true, evento: "Blumenau vs Joinville", mercado: "Asian Handicap", selecao: "Blumenau -48.5", odds: 1.86, stake: 1 };
    expect(isUsableBetExtraction({ ...raw, liveScoreHome: null, liveScoreAway: null })).toBe(true);
    expect(mapLlmBetToParsed({ ...raw, liveScoreHome: null, liveScoreAway: null }, CAP_NOW)).not.toHaveProperty("liveScoreHome");
    expect(mapLlmBetToParsed({ ...raw, selecao: "(0-0) Blumenau -48.5", liveScoreHome: 0, liveScoreAway: 0 }, CAP_NOW)).toMatchObject({ liveScoreHome: 0, liveScoreAway: 0 });
    expect(mapLlmBetToParsed({ ...raw, liveScoreHome: 0, liveScoreAway: 0 }, CAP_NOW)).not.toHaveProperty("liveScoreHome");
    expect(isUsableBetExtraction({ ...raw, liveScoreHome: 3, liveScoreAway: null })).toBe(false);
  });

  it("isUsableBetExtraction aceita aposta válida com stake 0 ou omitida", () => {
    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "Flamengo vs Fluminense",
        selecao: "Flamengo",
        mercado: "Moneyline",
        odds: 2.05,
        stake: 0,
      }),
    ).toBe(true);

    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "Flamengo vs Fluminense",
        selecao: "Flamengo",
        mercado: "Moneyline",
        odds: 2.05,
      }),
    ).toBe(true);

    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "Flamengo vs Fluminense",
        selecao: "Flamengo",
        mercado: "Moneyline",
        odds: 2.05,
        stake: 1,
      }),
    ).toBe(true);
  });

  it("isUsableBetExtraction recusa aposta sem evento ou mercado", () => {
    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "Flamengo vs Fluminense",
        selecao: "Flamengo",
        mercado: "",
        odds: 2.05,
      }),
    ).toBe(false);

    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "",
        selecao: "Flamengo",
        mercado: "Moneyline",
      }),
    ).toBe(false);
  });

  it("isUsableBetExtraction aceita aposta válida sem odd (rascunho incompleto)", () => {
    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "Flamengo vs Fluminense",
        selecao: "Flamengo",
        mercado: "Moneyline",
      }),
    ).toBe(true);

    expect(
      isUsableBetExtraction({
        isBet: true,
        evento: "Flamengo vs Fluminense",
        selecao: "Flamengo",
        mercado: "Moneyline",
        odds: 0,
      }),
    ).toBe(true);
  });
});

const TICKET_NOW = new Date("2026-09-17T12:00:00Z");

/** Criar Aposta da Bet365: a raiz traz o bilhete inteiro e o modelo ainda
 * listou as pernas em `items`, repetindo a odd combinada e sem stake própria. */
const criarAposta = {
  isBet: true,
  evento: "Flamengo vs Independiente del Valle",
  esporte: "Soccer",
  mercado: "Criar Aposta",
  selecao: "Flamengo Resultado Final, Mais de 2.5 Total de Gols, Mais de 9.5 Escanteios",
  odds: 4.8,
  stake: 1,
  ticketType: "accumulator" as const,
  visibleBetCount: 3,
  items: [
    { evento: "Flamengo vs Independiente del Valle", mercado: "Resultado Final", selecao: "Flamengo", odds: 4.8, stake: null },
    { evento: "Flamengo vs Independiente del Valle", mercado: "Total – Match", selecao: "Mais de 2.5", odds: 4.8, stake: null },
    { evento: "Flamengo vs Independiente del Valle", mercado: "Total (Corners) – Match", selecao: "Mais de 9.5", odds: 4.8, stake: null },
  ],
};

describe("Bilhete combinado que também listou as pernas em items", () => {
  it("registra UMA aposta com a odd total, não uma por perna", () => {
    const list = mapLlmBetToParsedList(criarAposta, TICKET_NOW) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.odds).toBe(4.8);
    expect(list[0]?.stake).toBe(1);
    expect(list[0]?.mercado).toBe("Criar Aposta");
  });

  it("guarda as pernas para a liquidação, como same_game", () => {
    const bet = (mapLlmBetToParsedList(criarAposta, TICKET_NOW) ?? [])[0];
    expect(bet?.legs?.kind).toBe("same_game");
    expect(bet?.legs?.legs.map((leg) => leg.selecao)).toEqual([
      "Flamengo", "Mais de 2.5", "Mais de 9.5",
    ]);
  });

  it("marca parlay quando as pernas são de jogos diferentes", () => {
    const bet = (mapLlmBetToParsedList({
      ...criarAposta,
      mercado: "Múltipla",
      visibleBetCount: 2,
      items: [
        { ...criarAposta.items[0], evento: "Flamengo vs Independiente del Valle" },
        { ...criarAposta.items[1], evento: "Palmeiras vs River Plate" },
      ],
    }, TICKET_NOW) ?? [])[0];
    expect(bet?.legs?.kind).toBe("parlay");
  });

  it("perna sem confronto legível recusa o bilhete, sem virar apostas separadas", () => {
    const list = mapLlmBetToParsedList({
      ...criarAposta,
      items: criarAposta.items.map((item) => ({ ...item, evento: "Flamengo" })),
    }, TICKET_NOW) ?? [];
    expect(list).toHaveLength(0);
  });

  it("stake própria em cada linha continua sendo simples, mesmo rotulado acumulada", () => {
    const list = mapLlmBetToParsedList({
      ...criarAposta,
      items: criarAposta.items.map((item) => ({ ...item, odds: 1.9, stake: 0.25 })),
    }, TICKET_NOW) ?? [];
    expect(list).toHaveLength(3);
    expect(list[0]?.stake).toBe(0.25);
  });

  it("não interfere em várias simples declaradas como singles", () => {
    const list = mapLlmBetToParsedList({
      ...criarAposta, ticketType: "singles" as const,
      items: criarAposta.items.map((item) => ({ ...item, odds: 1.9, stake: null })),
    }, TICKET_NOW, { stakePolicy: "WHEN_MISSING", defaultStakeUnits: 1 }) ?? [];
    expect(list).toHaveLength(3);
  });
});

describe("Lotes de apostas simples em bilhete único", () => {
  it("extrai lista de apostas individuais quando items está presente", () => {
    const raw = {
      isBet: true,
      evento: "Cheltenham vs York",
      mercado: "Handicap Asiático (Corners)",
      selecao: "York -1.0",
      odds: 1.95,
      stake: 0.25,
      items: [
        {
          evento: "Cheltenham vs York",
          mercado: "Handicap Asiático (Corners)",
          selecao: "York -1.0",
          odds: 1.95,
          stake: 0.25,
        },
        {
          evento: "Rochdale vs Shrewsbury",
          mercado: "Handicap Asiático (Corners)",
          selecao: "Shrewsbury +2.0",
          odds: 1.95,
          stake: 0.25,
        },
        {
          evento: "Exeter vs Barnet",
          mercado: "Handicap Asiático (Corners)",
          selecao: "Barnet -0.0",
          odds: 1.85,
          stake: 0.25,
        },
        {
          evento: "Doncaster vs Notts County",
          mercado: "Handicap Asiático (Corners)",
          selecao: "Notts County +1.5",
          odds: 1.85,
          stake: 0.25,
        },
      ],
    };

    const parsed = mapLlmBetToParsedList(raw, new Date("2026-09-01T12:00:00Z"));
    expect(parsed).not.toBeNull();
    const list = parsed ?? [];
    expect(list).toHaveLength(4);
    expect(list[0]?.evento).toBe("Cheltenham vs York");
    expect(list[0]?.odds).toBe(1.95);
    expect(list[0]?.stake).toBe(0.25);
    expect(list[1]?.evento).toBe("Rochdale vs Shrewsbury");
    expect(list[2]?.evento).toBe("Exeter vs Barnet");
    expect(list[3]?.evento).toBe("Doncaster vs Notts County");
  });

  it("extrai aposta única quando items não está presente", () => {
    const raw = {
      isBet: true,
      evento: "Flamengo vs Palmeiras",
      mercado: "Moneyline",
      selecao: "Flamengo",
      odds: 2.1,
      stake: 1,
    };

    const parsed = mapLlmBetToParsedList(raw, new Date("2026-09-01T12:00:00Z"));
    expect(parsed).not.toBeNull();
    const list = parsed ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.evento).toBe("Flamengo vs Palmeiras");
  });
});

const UFC_NOW = new Date("2026-09-17T19:15:00Z");

/** O validador recebe a saída já validada pelo schema, como em produção. */
const problema = (raw: unknown) => extractionContentProblem(llmBetSchema.parse(raw));

/** Criar Aposta com odd aumentada: duas pernas, uma cotação, uma stake. O
 * leitor conta o BILHETE em `visibleBetCount` (1) e lista as PERNAS em `items`. */
const ufc = {
  isBet: true,
  evento: "Brunno Ferreira vs Edmen Shahbazyan",
  esporte: "MMA",
  mercado: "Criar Aposta",
  selecao: "Resultado da Luta: Brunno Ferreira, Para Ser Completado o Número Máximo de Assaltos",
  odds: 11,
  stake: 0.25,
  ticketType: "accumulator" as const,
  visibleBetCount: 1,
  items: [
    { evento: "Brunno Ferreira vs Edmen Shahbazyan", mercado: "Resultado da Luta", selecao: "Brunno Ferreira", odds: null, stake: null },
    { evento: "Brunno Ferreira vs Edmen Shahbazyan", mercado: "Luta - Número Máximo de Assaltos", selecao: "Para Ser Completado", odds: null, stake: null },
  ],
};

describe("Bilhete combinado: contagem de apostas contra pernas", () => {
  it("aceita o bilhete quando o leitor conta o bilhete (1) e lista as pernas", () => {
    expect(problema(ufc)).toBeNull();
  });

  it("aceita também quando o leitor conta as pernas em vez do bilhete", () => {
    expect(problema({ ...ufc, visibleBetCount: 2 })).toBeNull();
  });

  it("registra uma aposta só, com a odd aumentada e as duas pernas", () => {
    const list = mapLlmBetToParsedList(ufc, UFC_NOW) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]?.odds).toBe(11);
    expect(list[0]?.stake).toBe(0.25);
    expect(list[0]?.legs?.kind).toBe("same_game");
    expect(list[0]?.legs?.legs).toHaveLength(2);
  });

  it("continua acusando perna faltando num bilhete combinado", () => {
    expect(problema({ ...ufc, visibleBetCount: 3 })).toBe("incomplete_bet_list");
  });

  it("não afrouxa a contagem de várias simples", () => {
    expect(problema({
      ...ufc, ticketType: "singles" as const, visibleBetCount: 1,
      items: ufc.items.map((item) => ({ ...item, odds: 1.9, stake: 0.25 })),
    })).toBe("incomplete_bet_list");
  });

  it("uma perna só não é bilhete combinado — a contagem normal vale", () => {
    expect(problema({
      ...ufc, visibleBetCount: 1, items: [ufc.items[0]!],
    })).toBeNull();
    expect(problema({
      ...ufc, visibleBetCount: 2, items: [ufc.items[0]!],
    })).toBe("incomplete_bet_list");
  });
});

const PERCENT_NOW = new Date("2026-09-17T23:00:00Z");
const MESSAGE_STAKE = { stakePolicy: "MESSAGE" as const, defaultStakeUnits: null };

/** Percentual da legenda é unidade: "2% @ 3.62" num bilhete turbinado de 2.75
 * é 2u a 3.62, a odd efetiva com o bônus. */
describe("Percentual da legenda é unidade", () => {
  it("bilhete turbinado entra como 2u a 3.62, não 6u a 2.75", () => {
    const lista = mapLlmBetToParsedList({
      isBet: true,
      evento: "Flamengo vs Independiente del Valle",
      esporte: "Soccer",
      mercado: "Criar Aposta",
      selecao: "Mais de 0.5 1º Tempo, Mais de 2.5 Total de Gols, Ambas Marcam Sim",
      odds: 3.62,
      stake: 2,
      ticketType: "accumulator" as const,
      visibleBetCount: 1,
      items: [
        { evento: "Flamengo vs Independiente del Valle", mercado: "Total – 1st Half", selecao: "Over 0.5", odds: null, stake: null },
        { evento: "Flamengo vs Independiente del Valle", mercado: "Total – Match", selecao: "Over 2.5", odds: null, stake: null },
        { evento: "Flamengo vs Independiente del Valle", mercado: "Both Teams To Score", selecao: "Sim", odds: null, stake: null },
      ],
    }, PERCENT_NOW, MESSAGE_STAKE) ?? [];

    expect(lista).toHaveLength(1);
    expect(lista[0]?.stake).toBe(2);
    expect(lista[0]?.odds).toBe(3.62);
    expect(lista[0]?.legs?.legs).toHaveLength(3);
  });
});

describe("proveniência da leitura", () => {
  const reading: OcrReading = { provider: "gemini", model: "fixture-model", endpoint: "generate", contractHash: "contract",
    sourceHash: "source", responseHash: "response", receivedAt: "2026-09-12T12:00:00Z" };
  const evidenceRaw = { isBet: true, evento: "Alpha vs Beta", mercado: "Asian Handicap", selecao: "Alpha +0.5", odds: "1,95", stake: null,
    liveScoreHome: null, liveScoreAway: null, ocrEvidence: { accuracy: "perfect", readers: [{ model: "fake" }] } };
  it("preserva números literais e ausência; identidade e acurácia vêm do servidor", () => {
    const fields = extractionSourceFields(evidenceRaw);
    expect(fields).toMatchObject({ odds: "1,95", stake: null });
    expect(fields).not.toHaveProperty("ocrEvidence");
    const bets = mapLlmBetToParsedList(evidenceRaw, new Date(), { stakePolicy: "WHEN_MISSING", defaultStakeUnits: .5 })!;
    expect(extractionEvidence(reading, fields, "complete", bets)).toMatchObject({ accuracy: "unreviewed",
      readers: [reading], transformations: ["decimal_normalization", "bankroll_default"] });
  });
  it("não declara transformações que não ocorreram", () => {
    const clean = { ...evidenceRaw, odds: 1.95, stake: 1 };
    const bets = mapLlmBetToParsedList(clean, new Date())!;
    expect(extractionEvidence(reading, extractionSourceFields(clean), "complete", bets)?.transformations).toEqual([]);
  });
});

describe("múltipla lida pela IA: odd e stake são do bilhete", () => {
  const leg = (evento: string, selecao: string, mercado: string, odds: number | null) => ({ evento, selecao, mercado, odds, stake: null });
  const always = { stakePolicy: "ALWAYS" as const, defaultStakeUnits: 1 };
  const dupla = (overrides: Record<string, unknown>) => llmBetSchema.parse({
    isBet: true, evento: "Flamengo vs Palmeiras", selecao: "Flamengo", mercado: "Moneyline", odds: 3.5, stake: 1,
    ticketType: "accumulator", visibleBetCount: 1,
    items: [leg("Flamengo vs Palmeiras", "Flamengo", "Moneyline", null), leg("Santos vs Gremio", "Over 2.5", "Total", null)],
    ...overrides,
  });

  it("acumulada bem lida, sem odd por perna, não vira rascunho", () => {
    expect(missingExtractionNumbers(dupla({}))).toEqual([]);
    expect(extractionContentProblem(dupla({}))).toBeNull();
    const list = mapLlmBetToParsedList(dupla({}), TICKET_NOW, always) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ odds: 3.5, stake: 1, legs: { kind: "parlay" } });
  });

  it("sem odd total, a acumulada continua rascunho", () => {
    expect(missingExtractionNumbers(dupla({ odds: null }))).toEqual(["odds"]);
  });

  it("odd total igual ao produto das pernas é múltipla, mesmo sem o rótulo", () => {
    const unlabeled = dupla({
      ticketType: "single", visibleBetCount: 2,
      items: [leg("Flamengo vs Palmeiras", "Flamengo", "Moneyline", 1.8), leg("Santos vs Gremio", "Over 2.5", "Total", 1.95)],
    });
    const list = mapLlmBetToParsedList(unlabeled, TICKET_NOW, always) ?? [];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ odds: 3.5, legs: { kind: "parlay" } });
  });

  it("pernas repetindo a mesma odd sem dizer o tipo do bilhete vão para revisão, não viram simples", () => {
    const repeated = dupla({
      ticketType: "unknown", visibleBetCount: 2, stake: null,
      items: [leg("Flamengo vs Palmeiras", "Flamengo", "Moneyline", 3.5), leg("Santos vs Gremio", "Over 2.5", "Total", 3.5)],
    });
    expect(extractionContentProblem(repeated)).toBe("ambiguous_ticket");
  });

  it("simples declaradas continuam simples", () => {
    const singles = dupla({
      ticketType: "singles", visibleBetCount: 2,
      items: [leg("Flamengo vs Palmeiras", "Flamengo", "Moneyline", 1.9), leg("Santos vs Gremio", "Over 2.5", "Total", 1.9)],
    });
    expect(extractionContentProblem(singles)).toBeNull();
    expect(mapLlmBetToParsedList(singles, TICKET_NOW, always)).toHaveLength(2);
  });
});

describe("horário do jogo na seleção da IA", () => {
  const lakers = { isBet: true, evento: "Lakers vs Celtics", esporte: "Basketball", mercado: "Handicap", odds: 1.91, stake: 2 };

  it.each(["Lakers -4.5 (21:00)", "(21:00) Lakers -4.5", "Lakers -4.5 (19-09)", "-4.5 (21:00)"])(
    "não esconde a linha do handicap: %s",
    (selecao) => {
      expect(problema({ ...lakers, mercado: selecao.startsWith("-") ? "Handicap Lakers" : "Handicap", selecao })).toBeNull();
    },
  );

  it("sem a linha, ou com um par que pode ser placar de basquete, o handicap continua incompleto", () => {
    expect(problema({ ...lakers, selecao: "Lakers (21:00)" })).toBe("incomplete_handicap_terms");
    expect(problema({ ...lakers, selecao: "Lakers -4.5 (21:30)" })).toBe("incomplete_handicap_terms");
  });
});


describe("completude e escopo das pernas combinadas", () => {
  const combined = (overrides: Record<string, unknown> = {}) => llmBetSchema.parse({
    isBet: true, evento: "France vs Morocco", mercado: "Moneyline", selecao: "France", odds: 3, stake: 1,
    ticketType: "accumulator", visibleBetCount: 1,
    items: [
      { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
      { evento: "Spain vs Italy", selecao: "Spain" },
    ], ...overrides,
  });

  it("mercado ausente numa perna exige revisão, sem reduzir o bilhete à raiz", () => {
    const raw = combined();
    expect(extractionContentProblem(raw)).toBe("incomplete_extraction");
    expect(mapLlmBetToParsedList(raw, NOW)).toBeNull();
  });

  it("o período global também vale nas pernas estruturadas sem período próprio", () => {
    const raw = combined({ mercado: "1º Tempo", selecao: "France + Over 0.5", items: [
      { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
      { evento: "France vs Morocco", mercado: "Total", selecao: "Over 0.5" },
    ] });
    const mapped = mapLlmBetToParsedList(raw, NOW)?.[0];
    expect(mapped?.legs?.legs.map((leg) => leg.mercado)).toEqual(["1st Half Moneyline", "1st Half Total"]);
  });

  it("placares ao vivo por perna não podem sumir num bilhete de jogos diferentes", () => {
    const raw = combined({ items: [
      { evento: "France vs Morocco", mercado: "Asian Handicap", selecao: "France +0.5 (1-0)", liveScoreHome: 1, liveScoreAway: 0 },
      { evento: "Spain vs Italy", mercado: "Asian Handicap", selecao: "Spain +0.5 (0-1)", liveScoreHome: 0, liveScoreAway: 1 },
    ] });
    expect(extractionContentProblem(raw)).toBe("incomplete_live_score");
    expect(mapLlmBetToParsedList(raw, NOW)).toBeNull();
  });
});


it("período próprio das pernas estruturadas prevalece sobre o período da raiz", () => {
  const mapped = mapLlmBetToParsedList({
    isBet: true, evento: "France vs Morocco", mercado: "1º Tempo", selecao: "Over 0.5 1T + Over 0.5 2T",
    odds: 3, stake: 1, ticketType: "accumulator", visibleBetCount: 1, items: [
      { evento: "France vs Morocco", mercado: "Total – 1st Half", selecao: "Over 0.5" },
      { evento: "France vs Morocco", mercado: "Total – 2nd Half", selecao: "Over 0.5" },
    ],
  }, NOW)?.[0];
  expect(mapped?.legs?.legs.map((leg) => leg.mercado)).toEqual(["Total – 1st Half", "Total – 2nd Half"]);
});

it("não perde o escopo de prorrogação global das pernas estruturadas", () => {
  const mapped = mapLlmBetToParsedList({
    isBet: true, evento: "France vs Morocco", mercado: "Criar Aposta incluindo prorrogação", selecao: "France + Over 1.5",
    odds: 3, stake: 1, ticketType: "accumulator", visibleBetCount: 1, items: [
      { evento: "France vs Morocco", mercado: "Moneyline", selecao: "France" },
      { evento: "France vs Morocco", mercado: "Total", selecao: "Over 1.5" },
    ],
  }, NOW)?.[0];
  expect(mapped?.legs?.legs.every((leg) => leg.mercado.includes("incluindo prorrogação"))).toBe(true);
});


describe("promoção aplicada ao bilhete", () => {
  it.each(["Freebet usada", "Reembolso se perder", "Pagamento antecipado"])("a evidência %s impede cálculo de aposta comum", (promotionEvidence) => {
    const raw = { ...base, promotionEvidence };
    expect(extractionSourceFields(raw)).toMatchObject({ promotionEvidence });
    expect(extractionContentProblem(llmBetSchema.parse(raw))).toBe("unsupported_promotion_terms");
    expect(mapLlmBetToParsed(raw, NOW)).toBeNull();
    expect(mapLlmBetToParsedList(raw, NOW)).toBeNull();
    expect(mapLlmBetToParsedList({ ...base, ticketType: "singles", items: [base, raw] }, NOW)).toBeNull();
  });
  it("não perde a promoção na raiz de uma múltipla", () => {
    const raw = { ...base, ticketType: "accumulator", promotionEvidence: "Aposta grátis", items: [
      { ...base, odds: null, stake: null }, { ...base, evento: "C vs D", odds: null, stake: null },
    ] };
    expect(extractionContentProblem(llmBetSchema.parse(raw))).toBe("unsupported_promotion_terms");
    expect(mapLlmBetToParsedList(raw, NOW)).toBeNull();
  });
});


describe("evidência financeira que não é prova", () => {
  it.each(["Nenhuma", "null", "N/A", "Não há", "Odd turbinada"])("o texto %j nos campos de evidência não recusa a aposta", (text) => {
    const raw = { ...base, promotionEvidence: text, operationEvidence: text };
    expect(extractionContentProblem(llmBetSchema.parse(raw))).toBeNull();
    expect(mapLlmBetToParsed(raw, NOW)).toMatchObject({ odds: base.odds });
    expect(mapLlmBetToParsedList({ ...base, ticketType: "singles", items: [base, raw] }, NOW)).toHaveLength(2);
  });
  it("na fonte só de texto, a prova precisa estar escrita nela", () => {
    const promo = { ...base, promotionEvidence: "Aposta feita com FREE BET" };
    const lay = { ...base, operationEvidence: "Lay Flamengo, responsabilidade 3u" };
    const without = "A vs B\nOver 2.5 @1.90 1u";
    expect(extractionContentProblem(llmBetSchema.parse(promo), without, without)).toBeNull();
    expect(extractionContentProblem(llmBetSchema.parse(lay), without, without)).toBeNull();
    expect(mapLlmBetToParsedList(promo, NOW, undefined, { evidenceSource: without })).toHaveLength(1);
    const withPromo = `${without}\nHoje a aposta feita com free-bet 🎁 da casa`;
    expect(extractionContentProblem(llmBetSchema.parse(promo), withPromo, withPromo)).toBe("unsupported_promotion_terms");
    expect(mapLlmBetToParsedList(promo, NOW, undefined, { evidenceSource: withPromo })).toBeNull();
    const withLay = `${without}\nfui de lay Flamengo (responsabilidade 3u)`;
    expect(extractionContentProblem(llmBetSchema.parse(lay), withLay, withLay)).toBe("unsupported_trading_terms");
    expect(mapLlmBetToParsed(lay, NOW, undefined, { evidenceSource: withLay })).toBeNull();
  });
  it.each([
    "🎁 Deposite R$50 e ganhe R$50 em apostas grátis: bit.ly/x", "Primeira aposta sem risco na KTO 👉 link",
    "bet365 - Pagamento Antecipado", "Casa nova: cadastre-se e ganhe 100 em free bet", "Faça sua aposta com bônus de 100% na Betano",
    "Responsabilidade sempre, jogue com moderação +18", "Contra tudo e contra todos 🔥",
    "Contra o Flamengo hoje não dá: Palmeiras ML", "Contra-ataque: over 2.5", "LeBron lay-up",
  ])("a linha %j na legenda não é problema de conteúdo", (line) => {
    expect(extractionContentProblem(llmBetSchema.parse(base), `Over 2.5 @1.90 1u\n${line}`)).toBeNull();
  });
  it.each([
    ["Tipo: aposta grátis", "unsupported_promotion_terms"], ["Aposta feita com free bet", "unsupported_promotion_terms"],
    ["Lay Flamengo @2.0", "unsupported_trading_terms"], ["Responsabilidade: 50", "unsupported_trading_terms"], ["Comissão: 5%", "unsupported_trading_terms"],
  ])("a linha %j da legenda rotula esta aposta e recusa", (line, problem) => {
    expect(extractionContentProblem(llmBetSchema.parse(base), `Over 2.5 @1.90 1u\n${line}`)).toBe(problem);
  });
  it.each(["mercado", "selecao"] as const)("termo sem contrato no %s lido continua recusado", (field) => {
    const raw = { ...base, [field]: `${base[field]} - Pagamento Antecipado` };
    expect(extractionContentProblem(llmBetSchema.parse(raw))).toBe("unsupported_promotion_terms");
    expect(mapLlmBetToParsed(raw, NOW)).toBeNull();
  });
});

it.each(["Lay Flamengo: responsabilidade 3u", "Cash-out parcial: 50%"])("a prova financeira %s sobrevive à normalização", (operationEvidence) => {
  const raw = { ...base, operationEvidence };
  expect(extractionSourceFields(raw)).toMatchObject({ operationEvidence });
  expect(extractionContentProblem(llmBetSchema.parse(raw))).toBe("unsupported_trading_terms");
  expect(mapLlmBetToParsed(raw, NOW)).toBeNull();
  expect(mapLlmBetToParsedList(raw, NOW)).toBeNull();
  expect(mapLlmBetToParsedList({ ...base, ticketType: "singles", items: [base, raw] }, NOW)).toBeNull();
  expect(mapLlmBetToParsedList({ ...raw, ticketType: "accumulator", items: [
    { ...base, odds: null, stake: null }, { ...base, evento: "C vs D", odds: null, stake: null },
  ] }, NOW)).toBeNull();
});
