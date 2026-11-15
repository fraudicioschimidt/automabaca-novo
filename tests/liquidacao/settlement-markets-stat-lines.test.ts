import { describe, expect, it } from "vitest";
import {
  hasNonScoreStatQualifier,
  NON_SCORE_STAT_TERMS,
} from "@/src/domain/mercados/stat-qualifier";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";

/**
 * A seleção pode declarar estatística mesmo num mercado chamado Moneyline:
 * "Gremio 2+ cards" não pode liquidar pelo placar 2x1.
 *
 * O vocabulário é inserido nas duas expressões de linha sem regras por termo;
 * classificação e liquidação delegam à mesma guarda. Testamos separadamente
 * os termos, a gramática e o bloqueio da liquidação, sem o produto cartesiano.
 * As regressões reais com time e N+ ficam em settlement-statistics-vocabulary.test.ts.
 *
 * A lista derivada verifica coerência, mas NÃO detecta um termo removido da
 * fonte. Os aliases explícitos do contrato irmão continuam sendo necessários.
 */

/** Alternativas com sintaxe de regex além do plural opcional têm caso próprio. */
function termosLiterais(): string[] {
  const saida = new Set<string>();
  for (const alternativa of NON_SCORE_STAT_TERMS.split("|")) {
    const semPlural = alternativa.replace(/s\?$/, "");
    if (/[[\]()?*+{}\\]/.test(semPlural)) continue;
    saida.add(semPlural);
    if (alternativa.endsWith("s?")) saida.add(`${semPlural}s`);
  }
  return [...saida];
}

/**
 * Como a casa liga o NÚMERO à estatística. Cada linha aqui é uma forma vista em
 * captura real ou no catálogo dos providers — não é criatividade.
 */
const FORMAS: ReadonlyArray<(termo: string) => string> = [
  (t) => `Over 2.5 ${t}`,
  (t) => `Under 2.5 ${t}`,
  (t) => `${t} Over 2.5`,
  (t) => `Mais de 2 ${t}`,
  (t) => `Menos de 2 ${t}`,
  (t) => `2 ${t}`,
  // As quatro abaixo são "no mínimo N": sem reconhecê-las, a seleção não
  // declara linha nenhuma e o mercado fica liquidável pelo PLACAR.
  (t) => `2+ ${t}`,
  (t) => `2 or more ${t}`,
  (t) => `2 ou mais ${t}`,
  // Com nome de time na frente — a forma que inverte dinheiro, porque o
  // resolvedor de lado casa o time e ignora a estatística.
  (t) => `Gremio 2+ ${t}`,
];

const TERMOS = termosLiterais();

describe("vocabulário na seleção", () => {
  it("a fonte exportada rende termos suficientes para o portão valer", () => {
    // Guarda contra o portão virar teatro: se alguém esvaziar o vocabulário ou
    // quebrar o expansor, os `it.each` abaixo passariam por vacuidade.
    expect(TERMOS.length).toBeGreaterThan(60);
    expect(TERMOS).toContain("cards");
    expect(TERMOS).toContain("cartoes");
    expect(TERMOS).toContain("escanteios");
  });

  it.each(TERMOS)('"%s" declara estatística depois da linha', (termo) => {
    expect(hasNonScoreStatQualifier("Moneyline", `Over 2.5 ${termo}`)).toBe(true);
  });
});

/**
 * O contra-peso, e ele é obrigatório.
 *
 * Um portão que só cobra "reconheça mais" empurra a implementação para o
 * reconhecimento amplo, e aí "Las Vegas Aces" no moneyline vira mercado de
 * aces — o que custa a liquidação automática de todo um esporte. Alargar o
 * conector sem estes casos reabriria a fresta que `STAT_THEN_LINE_RE` fecha.
 */
describe("portão: nome de time com palavra de estatística NÃO é linha", () => {
  const NOMES_REAIS: ReadonlyArray<readonly [string, string]> = [
    ["Moneyline", "Las Vegas Aces"],
    ["Vencedor", "Las Vegas Aces"],
    ["Handicap Asiático", "Las Vegas Aces -3.5"],
    // O `+` do handicap vem DEPOIS do nome; o da linha vem ANTES do termo.
    ["Handicap Asiático", "Las Vegas Aces +3.5"],
    ["Moneyline", "Aces United"],
    ["Point Spread", "Sao Jose -3.5"],
    ["Moneyline", "Corinthians"],
  ];

  it.each(NOMES_REAIS)('"%s / %s" continua liquidando por placar', (mercado, selecao) => {
    expect(hasNonScoreStatQualifier(mercado, selecao)).toBe(false);
    expect(
      isScoreResolvableMarket({ mercado, selecao, esporte: "Basketball" }),
    ).toBe(true);
  });
});

/**
 * A ponta que fecha o circuito: não basta classificar certo, o dinheiro não pode
 * sair. Este bloco roda o resolvedor de PLACAR contra as formas e exige recusa.
 */
describe("portão: nenhuma forma de linha é liquidada pelo placar da partida", () => {
  it.each(FORMAS.map((forma) => forma("cards")))(
    '"%s" é recusada por declarar estatística',
    (selecao) => {
      expect(hasNonScoreStatQualifier("Moneyline", selecao)).toBe(true);
      expect(isScoreResolvableMarket({ mercado: "Moneyline", selecao, esporte: "Soccer" })).toBe(false);
      const resolucao = resolveResultFromScore({
        mercado: "Moneyline",
        selecao,
        evento: "Gremio vs Mirassol",
        odds: 2,
        stake: 10,
        homeScore: 2,
        awayScore: 1,
      });
      expect(resolucao).toEqual({ ok: false, reason: "stat_qualifier" });
    },
  );
});

describe("gramática: limites e conectores além das formas básicas", () => {
  it.each([
    "2 at least cards",
    "2 no mínimo cartões",
    "2 + cards",
    "2cards",
    "cards Under 2.5",
    "cards Mais de 2",
    "cards Menos de 2",
    "cards Acima de 2",
    "cards Abaixo de 2",
    "cards 2",
    "chutes no gol Over 2.5",
    "2+ chutes no gol",
    "three pointers Over 2.5",
    "2+ three pointers",
    "3-pointers Over 2.5",
    "2+ 3-pointers",
    "cartões Over 2,5",
  ])('"%s" declara estatística', (selecao) => {
    expect(hasNonScoreStatQualifier("Moneyline", selecao)).toBe(true);
  });

  it.each(["2 cardsharp", "discard Over 2.5", "2 estrelas", "cards", "Aces United 2"])(
    '"%s" não declara uma linha de estatística', (selecao) => {
      expect(hasNonScoreStatQualifier("Moneyline", selecao)).toBe(false);
    },
  );
});

describe("portão: sofre/comete falta cola o número na estatística", () => {
  const CASOS = [
    "willian jose over 0,5 sofre falta",
    "Over 0.5 sofre falta",
    "Over 0.5 fouls suffered",
    "emmanuel martinez over 1,5 faltas",
  ];

  it.each(CASOS)('"%s" declara linha de estatística e sai do placar', (selecao) => {
    expect(hasNonScoreStatQualifier("Moneyline", selecao)).toBe(true);
    expect(
      isScoreResolvableMarket({ mercado: "Moneyline", selecao, esporte: "Soccer" }),
    ).toBe(false);
    const resolucao = resolveResultFromScore({
      mercado: "Moneyline",
      selecao,
      evento: "Bahia vs Vasco da Gama",
      odds: 2,
      stake: 10,
      homeScore: 0,
      awayScore: 0,
    });
    expect(resolucao).toEqual({ ok: false, reason: "stat_qualifier" });
  });
});
