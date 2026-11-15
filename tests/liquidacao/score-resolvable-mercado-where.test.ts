import { describe, expect, it } from "vitest";
import { isDoubleChanceMarket, isDrawNoBetMarket, OUTRIGHT_SCOPE_NOUNS, HALF_PERIOD_PHRASES } from "@/src/domain/mercados/classify";
import {
  DOUBLE_CHANCE_VOCABULARY,
  DRAW_NO_BET_VOCABULARY,
} from "@/src/domain/mercados/draw-vocabulary";
import { NON_SCORE_STAT_TERMS } from "@/src/domain/mercados/stat-qualifier";
import { accentVariants } from "@/src/domain/mercados/accents";
import { MATCH_SCOPE_NOUNS } from "@/src/domain/mercados/match-scope";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { scoreResolvableMercadoWhere } from "@/src/services/settlement/score-resolvable-query";

type MarketStringFilter = {
  contains?: string;
  startsWith?: string;
  endsWith?: string;
  equals?: string;
};

type PositiveClause = { mercado?: MarketStringFilter; AND?: Array<{ mercado?: MarketStringFilter }> };

function positiveClauses(): PositiveClause[] {
  const where = scoreResolvableMercadoWhere();
  const allowlist = (where.AND as Array<Record<string, unknown>>).find(
    (clause) => clause && typeof clause === "object" && "OR" in clause,
  ) as { OR: PositiveClause[] } | undefined;
  return allowlist?.OR ?? [];
}

function positiveMarketFilters(): MarketStringFilter[] {
  return positiveClauses().flatMap((clause) => (clause.mercado ? [clause.mercado] : []));
}

function filterMatches(filter: MarketStringFilter, value: string): boolean {
  if (filter.equals !== undefined) return value === filter.equals.toLowerCase();
  if (filter.startsWith !== undefined) return value.startsWith(filter.startsWith.toLowerCase());
  if (filter.endsWith !== undefined) return value.endsWith(filter.endsWith.toLowerCase());
  if (filter.contains !== undefined) return value.includes(filter.contains.toLowerCase());
  return false;
}

function positiveMarketMatches(market: string): boolean {
  const value = market.toLowerCase();
  return positiveClauses().some((clause) => {
    if (clause.mercado) return filterMatches(clause.mercado, value);
    // Cláusula composta (substantivo E "empate"): todas precisam casar.
    if (clause.AND) {
      return clause.AND.every((inner) => inner.mercado && filterMatches(inner.mercado, value));
    }
    return false;
  });
}

/**
 * Avalia o filtro INTEIRO (allowlist + denylist + esporte), como o Postgres
 * faria. Sem o campo `esporte` o avaliador dava resposta errada justamente nas
 * regras sport-aware — a fronteira que o revisor apontou como o meu ponto cego.
 */
function whereMatches(market: string, sport = ""): boolean {
  const mercado = market.toLowerCase();
  const esporte = sport.toLowerCase();
  const evaluate = (node: unknown): boolean => {
    if (!node || typeof node !== "object") return true;
    const clause = node as Record<string, unknown>;
    if (clause.NOT !== undefined) return !evaluate(clause.NOT);
    if (Array.isArray(clause.AND)) return clause.AND.every(evaluate);
    if (Array.isArray(clause.OR)) return clause.OR.some(evaluate);
    if (clause.mercado) return filterMatches(clause.mercado as MarketStringFilter, mercado);
    if (clause.esporte) return filterMatches(clause.esporte as MarketStringFilter, esporte);
    return true;
  };
  return evaluate(scoreResolvableMercadoWhere());
}

/**
 * O filtro Prisma é aproximado — estes casos documentam a intenção
 * (exclusões + allowlist) sem subir Postgres.
 */
describe("scoreResolvableMercadoWhere (forma do filtro)", () => {
  it("exclui props, estatísticas e períodos; inclui game-line + BTTS/team total", () => {
    const w = scoreResolvableMercadoWhere();
    expect(w.AND).toBeDefined();
    const and = w.AND as unknown[];
    expect(and.length).toBeGreaterThan(5);
    const serialized = JSON.stringify(w);
    expect(serialized).toContain("btts");
    expect(serialized).toContain("team total");
    expect(serialized).toContain("moneyline");
    expect(serialized).toContain('"contains":"para vencer"');
    expect(serialized).toContain('"contains":"para ganhar"');
    expect(serialized).toContain("asian handicap");
    expect(serialized).toContain('"contains":"handicap"');
    expect(serialized).toContain("1st half");
    expect(serialized).toContain("corner");
    for (const blocked of [
      "quarter",
      "H1 ",
      "1T ",
      "2T ",
      "F5 ",
      "ET ",
      "quarto",
      "period",
      "inning",
      "1Q",
      "I1",
      "1P",
      "S1",
      "R1",
      "game 1",
      "game handicap",
      "game total",
      "3-way",
      "regulation",
      "half time",
      "halftime",
      "90 min",
      " round",
      " frame",
      " leg",
      " set",
      "outright",
      "future",
      "to lift",
      "to win the",
      "campeão",
      "vencedor final",
      "resultado exato",
      "placar exato",
      "correct score",
      "handicap result",
      "extra time",
      "overtime",
      "rebound",
      "rebote",
      "aces",
      "bases",
      "steal",
      "turnover",
      "block",
      "hit",
      "strikeout",
      "fault",
      "pointer",
      "triple",
      "offside",
      "pass",
      "touch",
      "interception",
      "cross",
      "strike",
      "takedown",
      "submission",
      "dragon",
      "baron",
      "inhibitor",
    ]) {
      expect(serialized).toContain(blocked);
    }
    expect(serialized).toContain('"contains":"0:1"');
    expect(serialized).toContain('"contains":"1:0"');
  });

  it("Handicap – Match (label canônico) passa na allowlist aproximada", () => {
    const w = scoreResolvableMercadoWhere();
    const or = (w.AND as Array<Record<string, unknown>>).find(
      (c) => c && typeof c === "object" && "OR" in c,
    ) as { OR: Array<Record<string, unknown>> };
    const hasHandicap = or.OR.some((clause) => {
      const m = clause.mercado as { contains?: string } | undefined;
      return m?.contains === "handicap";
    });
    expect(hasHandicap).toBe(true);
  });

  it("preserva variantes que declaram incluir prorrogação", () => {
    const serialized = JSON.stringify(scoreResolvableMercadoWhere());
    expect(serialized).toContain("including");
    expect(serialized).toContain('"contains":"incl"');
    expect(serialized).toContain("prolongamento");
  });

  it("não aplica deny amplo de stats ao nome isolado da seleção", () => {
    const serialized = JSON.stringify(scoreResolvableMercadoWhere());
    expect(serialized).not.toContain('"selecao":{"contains":"aces"');
    expect(serialized).not.toContain('"selecao":{"contains":"bases"');
  });

  it("mantém pré-filtro SQL alinhado ao gate fino para labels legados FT", () => {
    const cases = [
      ["Empate Devolve", "Flamengo"],
      ["DNB", "Flamengo"],
      ["DNB Match", "Flamengo"],
      ["DC", "1X"],
      ["DC 1X", "1X"],
      ["AH -0.5", "Flamengo -0.5"],
      ["ML", "Flamengo"],
      ["ML Match", "Flamengo"],
      ["Over 2.5", "Over 2.5"],
      ["Under 3.5", "Under 3.5"],
      ["Totais de Pontos", "Over 210.5"],
      ["Asian Total", "Over 2.5"],
      ["Match Total Goals", "Over 2.5"],
      ["Resultado do Jogo", "Flamengo"],
      ["Resultado da Partida", "Flamengo"],
      ["Winner", "Flamengo"],
      ["Game Winner", "Flamengo"],
      ["Mais que 2.5", "Mais que 2.5"],
      ["Menos que 3.5", "Menos que 3.5"],
      ["Empate não tem aposta", "Flamengo"],
      ["Empate sem aposta", "Flamengo"],
      ["Aposta Sem Empate", "Flamengo"],
      ["Sem Empate", "Flamengo"],
      ["Tie No Bet", "Flamengo"],
      ["Chance Dupla", "1X"],
      ["Dupla Hipótese", "1X"],
      ["Total-Match", "Over 2.5"],
      ["Total – Match", "Over 2.5"],
      ["Puckline", "Flamengo -1.5"],
      ["Runline", "Flamengo -1.5"],
      ["Gol/Gol", "Gol/Gol"],
      ["Ambas Equipes Marcam", "Sim"],
      ["Both Score", "Yes"],
      // Vocabulário aceito pelo domínio que a allowlist também precisa cobrir —
      // senão a aposta é classificada e nunca entra no lote de liquidação.
      ["Empate Cancela", "Flamengo"],
      ["Empate Nulo", "Flamengo"],
      ["Empate Reembolsa", "Flamengo"],
      ["Empate Estorna", "Flamengo"],
      ["Reembolso no Empate", "Flamengo"],
      ["Devolução no Empate", "Flamengo"],
      ["Dupla Oportunidade", "1X"],
      ["Dupla Possibilidade", "X2"],
      ["Linha de Gols", "Over 2.5"],
      ["Linha de Pontos", "Over 210.5"],
      ["Linha de Runs", "Over 8.5"],
      ["Linha de Corridas", "Over 8.5"],
      ["Goal Line", "Over 2.5"],
    ] as const;

    for (const [mercado, selecao] of cases) {
      expect(positiveMarketMatches(mercado), `SQL: ${mercado}`).toBe(true);
      expect(
        isScoreResolvableMarket({ mercado, selecao }),
        `domínio: ${mercado}`,
      ).toBe(true);
    }
  });

  /**
   * As amostras vêm do PRÓPRIO vocabulário do domínio, não de uma cópia
   * declarada aqui: um teste que redeclara a lista só prova o que ele mesmo
   * lembrou de escrever, e foi assim que "Empate não conta" ficou fora do
   * lote por três rodadas.
   */
  function comAcento(label: string): string {
    return label
      .replace(/\bnao\b/g, "não")
      .replace(/\bdevolucao\b/g, "devolução")
      .replace(/\bhipotese\b/g, "hipótese");
  }

  function amostrasDrawNoBet(): string[] {
    const v = DRAW_NO_BET_VOCABULARY;
    const amostras: string[] = [...v.standalone];
    for (const verbo of v.verbs) {
      amostras.push(`Empate ${verbo}`);
      for (const objeto of v.objects) amostras.push(`Empate ${verbo} ${objeto}`);
    }
    for (const estado of v.states) amostras.push(`Empate ${estado}`);
    for (const substantivo of v.nouns) {
      for (const conector of v.connectors) {
        amostras.push(`${substantivo} ${conector} empate`);
        for (const qualificador of v.nounQualifiers) {
          amostras.push(`${substantivo} do ${qualificador} ${conector} empate`);
        }
      }
    }
    return amostras.flatMap((label) => [label, comAcento(label)]);
  }

  function amostrasDuplaChance(): string[] {
    const v = DOUBLE_CHANCE_VOCABULARY;
    const amostras: string[] = [...v.standalone];
    for (const termo of v.terms) {
      amostras.push(`Dupla ${termo}`, `${termo} Dupla`);
    }
    return amostras.flatMap((label) => [label, comAcento(label)]);
  }

  it("todo rótulo de empate aceito pelo domínio entra no lote SQL", () => {
    for (const mercado of amostrasDrawNoBet()) {
      expect(isDrawNoBetMarket(mercado), `domínio: ${mercado}`).toBe(true);
      expect(positiveMarketMatches(mercado), `SQL: ${mercado}`).toBe(true);
    }
    for (const mercado of amostrasDuplaChance()) {
      expect(isDoubleChanceMarket(mercado), `domínio: ${mercado}`).toBe(true);
      expect(positiveMarketMatches(mercado), `SQL: ${mercado}`).toBe(true);
    }
    // Amostra mínima real: sem ela um vocabulário vazio passaria calado.
    expect(amostrasDrawNoBet().length).toBeGreaterThan(40);
    expect(amostrasDuplaChance().length).toBeGreaterThan(8);
  });

  it("domínio e SQL concordam na fronteira: outright, unidade por esporte e famílias", () => {
    // O IA-Judge seleciona por `NOT scoreResolvableMercadoWhere()`: SQL mais
    // largo que o domínio tira a aposta dele; mais estreito prende a aposta em
    // PENDING. As duas direções são silenciosas, então a fronteira é testada
    // como TABELA — mercado × seleção × esporte.
    const casos: readonly (readonly [string, string, string, boolean])[] = [
      // Vencer a PARTIDA resolve por placar; vencer o CAMPEONATO não.
      ["Quem Vencerá o Jogo", "Flamengo", "Soccer", true],
      ["Quem Vencerá o Campeonato", "Flamengo", "Soccer", false],
      ["Quem Vence a Liga", "Flamengo", "Soccer", false],
      ["Quem Ganhará a Série", "Flamengo", "Soccer", false],
      ["Vencedor do Grupo", "Flamengo", "Soccer", false],
      ["Para Vencer o Torneio", "Flamengo", "Soccer", false],
      // Corrida é o placar em beisebol; em futebol/basquete é estatística.
      ["Linha de Runs", "Over 8.5", "Baseball", true],
      ["Total Runs", "Over 8.5", "Baseball", true],
      ["Linha de Runs", "Over 8.5", "Soccer", false],
      ["Linha de Corridas", "Over 8.5", "Basketball", false],
      ["Total de Corridas", "Over 8.5", "Soccer", false],
      // Ponto é o placar em basquete; em vôlei/handebol o placar é set/gol.
      ["Total de Pontos", "Over 210.5", "Basketball", true],
      ["Total de Pontos", "Over 210.5", "Volleyball", false],
      ["Total Points", "Over 210.5", "Handball", false],
      // Famílias que precisam continuar entrando.
      ["Moneyline", "Flamengo", "Soccer", true],
      ["Total de Gols", "Over 2.5", "Soccer", true],
      ["Total de Gols", "Over 2.5", "Basketball", false],
      ["Total Goals", "Over 2.5", "American Football", false],
      ["Total de Gols", "Over 2.5", "Futebol americano", false],
      ["Total de Gols", "Over 2.5", "Handball", true],
      ["Handicap – Match", "Flamengo -0.5", "Soccer", true],
      ["Draw No Bet", "Flamengo", "Soccer", true],
      ["Dupla Escolha", "1X", "Soccer", true],
      ["Empate não conta", "Flamengo", "Soccer", true],
      // Estatística continua fora dos dois lados.
      ["Total de Assistências", "Over 4.5", "Soccer", false],
      ["Total de Remates", "Under 21.5", "Soccer", false],
      ["Total de Xyzzy", "Under 21.5", "Soccer", false],
      ["Total (Plurbs) – Match", "Under 21.5", "Soccer", false],
      ["Handicap de Quux", "Flamengo -1.5", "Soccer", false],
      ["Linha de Escanteios", "Over 9.5", "Soccer", false],
      // "Ganhador" precisa estar no domínio E na allowlist.
      ["Ganhador da Partida", "Flamengo", "Soccer", true],
      ["Ganhador do Duelo", "Flamengo", "MMA", true],
      ["Ganhador do Campeonato", "Flamengo", "Soccer", false],
      ["Ganhador do Grupo", "Flamengo", "Soccer", false],
      ["Empate sem risco", "Flamengo", "Soccer", true],
      ["Devolução da bet no empate", "Flamengo", "Soccer", true],
      ["Dupla Alternativa", "1X", "Soccer", true],
      ["Dupla Seleção", "1X", "Soccer", true],
      // Tempo com ordinal colado (º ou sinal de grau) e janela de minutos.
      ["Gols 1ºT", "Over 0.5", "Soccer", false],
      ["Gols 1°T", "Over 0.5", "Soccer", false],
      ["Total de Gols 2°T", "Over 0.5", "Soccer", false],
      ["Gols primeira metade", "Over 0.5", "Soccer", false],
      ["Total de Gols 0-10 min", "Over 0.5", "Soccer", false],
      ["Gols nos primeiros 10 minutos", "Over 0.5", "Soccer", false],
      ["Total de Gols 0-10min", "Over 0.5", "Soccer", false],
      ["Gols 1ª metade", "Over 0.5", "Soccer", false],
      ["Total de Gols 1ª Metade", "Over 0.5", "Soccer", false],
      ["Gols 1ª Parte", "Over 0.5", "Soccer", false],
      ["Total de Gols 2ª Etapa", "Over 0.5", "Soccer", false],
    ];
    for (const [mercado, selecao, esporte, esperado] of casos) {
      const rotulo = `${mercado} | ${selecao} | ${esporte}`;
      expect(isScoreResolvableMarket({ mercado, selecao, esporte }), `domínio: ${rotulo}`).toBe(esperado);
      expect(whereMatches(mercado, esporte), `SQL: ${rotulo}`).toBe(esperado);
    }
  });

  it("nenhum termo de estatística do domínio escapa pela allowlist ampla de Total", () => {
    // As amostras saem das ALTERNATIVAS da regex do domínio: se alguém
    // acrescentar uma estatística lá e esquecer o espelho SQL, este teste cai.
    // O `startsWith: "Total"` admitia "Total de Assistências" — o domínio
    // recusava, e a aposta saía do IA-Judge para um lote que nunca a liquidaria.
    const amostras = NON_SCORE_STAT_TERMS.split("|")
      .map((alternativa) => alternativa.replace(/s\?$/, "s").replace(/\[\\s-\]\*/g, "-"))
      .filter((termo) => !/[[\]()?*+{}\\]/.test(termo));
    expect(amostras.length).toBeGreaterThan(50);
    for (const termo of amostras) {
      const mercado = `Total de ${termo}`;
      expect(
        isScoreResolvableMarket({ mercado, selecao: "Over 4.5" }),
        `domínio: ${mercado}`,
      ).toBe(false);
      expect(whereMatches(mercado), `SQL: ${mercado}`).toBe(false);
    }
    // O total legítimo continua entrando.
    expect(whereMatches("Total de Gols")).toBe(true);
    expect(isScoreResolvableMarket({ mercado: "Total de Gols", selecao: "Over 2.5" })).toBe(true);
  });

  it("qualificador nomeado desconhecido concorda no domínio e no espelho SQL", () => {
    for (const mercado of [
      "Total de Xyzzy",
      "Total (Plurbs) – Match",
      "Handicap de Quux",
    ]) {
      expect(isScoreResolvableMarket({
        mercado,
        selecao: mercado.includes("Handicap") ? "Flamengo -1.5" : "Under 4.5",
        esporte: "Soccer",
      }), `domínio: ${mercado}`).toBe(false);
      expect(whereMatches(mercado, "Soccer"), `SQL: ${mercado}`).toBe(false);
    }
    for (const mercado of ["Total de Gols", "Total do Time", "Handicap de Gols"]) {
      expect(whereMatches(mercado, "Soccer"), `SQL: ${mercado}`).toBe(true);
    }
  });

  it("rótulo 'Linha de …' entra por vocabulário nomeado, nunca por prefixo amplo", () => {
    // O IA-Judge seleciona por `NOT scoreResolvableMercadoWhere()`: admitir uma
    // prop aqui a remove do único liquidador automático que ela tem.
    for (const mercado of [
      "Linha de Assistências",
      "Linha de Faltas",
      "Linha de Chutes",
      "Linha de Abates",
      "Linha de Desarmes",
    ]) {
      expect(positiveMarketMatches(mercado), `SQL: ${mercado}`).toBe(false);
      expect(
        isScoreResolvableMarket({ mercado, selecao: "Over 4.5" }),
        `domínio: ${mercado}`,
      ).toBe(false);
    }
  });

  it("siglas usam limites de token em vez de contains amplo", () => {
    const filters = positiveMarketFilters();
    for (const token of ["AH", "DNB", "DC", "ML"] as const) {
      expect(filters).not.toContainEqual(expect.objectContaining({ contains: token }));
      expect(positiveMarketMatches(token)).toBe(true);
      expect(positiveMarketMatches(`${token} Match`)).toBe(true);
    }
    expect(positiveMarketMatches("AHA")).toBe(false);
    expect(positiveMarketMatches("DNBX")).toBe(false);
  });

  it("siglas de meio-tempo do domínio saem do lote como token", () => {
    for (const mercado of ["HT Over 0.5", "Over 0.5 HT", "1T Total de Gols", "Total SH"]) {
      expect(isScoreResolvableMarket({ mercado, selecao: "Over 0.5" }), `domínio: ${mercado}`).toBe(false);
      expect(whereMatches(mercado), `SQL: ${mercado}`).toBe(false);
    }
    expect(whereMatches("Total de Gols")).toBe(true);
  });

  it("escopo de outright é excluído nas DUAS grafias, acentuada e sem acento", () => {
    // O `contains` do Postgres compara caixa, não diacrítico: um escopo novo
    // sem variante acentuada deixa "Vencedor do Título" passar no SQL enquanto
    // o domínio o recusa — e o IA-Judge, que seleciona por `NOT` deste filtro,
    // perde a aposta. O teste percorre a fonte exportada e as variantes geradas
    // por `accents.ts`, nunca uma cópia declarada aqui.
    for (const escopo of OUTRIGHT_SCOPE_NOUNS) {
      for (const grafia of accentVariants(escopo)) {
        for (const mercado of [`Vencedor do ${grafia}`, `Quem Vencerá a ${grafia}`]) {
          expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), `domínio: ${mercado}`).toBe(false);
          expect(whereMatches(mercado), `SQL: ${mercado}`).toBe(false);
        }
      }
    }
    // O par (verbo, escopo) continua exigido: o substantivo sozinho não tira o
    // mercado da partida do lote.
    for (const [mercado, selecao] of [
      ["Moneyline – Copa", "Flamengo"],
      ["Total de Gols – Copa", "Over 2.5"],
    ] as const) {
      expect(whereMatches(mercado), `SQL: ${mercado}`).toBe(true);
      expect(isScoreResolvableMarket({ mercado, selecao }), `domínio: ${mercado}`).toBe(true);
    }
  });

  it("escopo da vitória na partida entra no lote em todas as grafias", () => {
    for (const escopo of MATCH_SCOPE_NOUNS) {
      for (const mercado of [`Para Ganhar o ${escopo}`, `Ganhador do ${escopo}`]) {
        expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), `domínio: ${mercado}`).toBe(true);
        expect(whereMatches(mercado), `SQL: ${mercado}`).toBe(true);
      }
    }
  });

  it("ordem EN do outright (escopo antes de winner) sai nas duas bordas", () => {
    for (const escopo of OUTRIGHT_SCOPE_NOUNS) {
      const mercado = `${escopo} Winner`;
      expect(isScoreResolvableMarket({ mercado, selecao: "Flamengo" }), `domínio: ${mercado}`).toBe(false);
      expect(whereMatches(mercado), `SQL: ${mercado}`).toBe(false);
    }
  });

  it("frases de meio-tempo saem do lote nas duas bordas", () => {
    // Um espelho escrito à mão com "segundo tempo" e sem "2 tempo" puxaria a
    // aposta para o lote (que a recusa) e, como o IA-Judge seleciona pelo
    // `NOT` deste filtro, ela ficaria sem NENHUM liquidador automático.
    for (const frase of [...HALF_PERIOD_PHRASES.first, ...HALF_PERIOD_PHRASES.second]) {
      const mercado = `Total ${frase}`;
      expect(isScoreResolvableMarket({ mercado, selecao: "Over 1.5" }), `domínio: ${mercado}`).toBe(false);
      expect(whereMatches(mercado), `SQL: ${mercado}`).toBe(false);
    }
  });

  it("unidade ponto x esporte espelha o domínio, inclusive sem esporte", () => {
    for (const [esporte, esperado] of [
      ["Basketball", true], ["American Football", true], ["Rugby", true],
      ["Hockey", false], ["Soccer", false], ["Volleyball", false], ["", true],
    ] as const) {
      const dominio = isScoreResolvableMarket({
        mercado: "Total de Pontos", selecao: "Over 5.5", esporte,
      });
      expect(dominio, `domínio: ${esporte || "(vazio)"}`).toBe(esperado);
      expect(whereMatches("Total de Pontos", esporte), `SQL: ${esporte || "(vazio)"}`).toBe(esperado);
    }
  });
});
