import { describe, expect, it } from "vitest";
import {
  statisticFamilyOf,
  type StatisticFamily,
} from "@/src/domain/settlement/statistics";
import { hasNonScoreStatQualifier } from "@/src/domain/mercados/stat-qualifier";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { resolveResultFromScore } from "@/src/domain/settlement/score-resolution";
import { marketNeedsFlashscoreStats } from "@/src/providers/flashscore/stats";

/**
 * Contrato entre os TRÊS vocabulários de estatística do sistema.
 *
 * Eles respondem perguntas diferentes e podem divergir em silêncio:
 *
 * | função                       | pergunta                                  |
 * |------------------------------|-------------------------------------------|
 * | `statisticFamilyOf`          | qual linha do feed responde?              |
 * | `hasNonScoreStatQualifier`   | o PLACAR pode responder? (guarda de $)    |
 * | `marketNeedsFlashscoreStats` | vale gastar a chamada de estatística?     |
 *
 * Uma divergência custa as duas pontas ao mesmo tempo: família nova no
 * resolvedor que o portão do provider não conhece nunca chama o endpoint, e
 * termo que o guarda de placar não conhece ("triplas", "tocos", "cortes",
 * "perdas") liquida PELO PLACAR, que é dinheiro invertido.
 *
 * A invariante é de mão única e é a que protege dinheiro: **se o resolvedor
 * reconhece o termo, o placar NÃO pode ser aceito como resposta e a chamada de
 * estatística TEM de ser roteada.** O contrário é livre — "chutes" solto roteia
 * sem resolver, de propósito.
 */

const TERMOS: ReadonlyArray<readonly [string, StatisticFamily]> = [
  ["Escanteios", "corners"],
  ["Corners", "corners"],
  ["Cantos", "corners"],
  ["Cartões", "booking_points"],
  ["Cards", "booking_points"],
  ["Bookings", "booking_points"],
  ["Faltas", "fouls"],
  ["Fouls", "fouls"],
  ["Duplas Faltas", "double_faults"],
  ["Double Faults", "double_faults"],
  ["Impedimentos", "offsides"],
  ["Offsides", "offsides"],
  ["Defesas", "saves"],
  ["Saves", "saves"],
  ["Chutes", "shots_total"],
  ["Finalizações", "shots_total"],
  // Famílias que o portão do provider também precisa conhecer.
  ["Interceptações", "interceptions"],
  ["Interceptação", "interceptions"],
  ["Interceptions", "interceptions"],
  ["Cortes", "clearances"],
  ["Corte", "clearances"],
  ["Afastamentos", "clearances"],
  ["Clearances", "clearances"],
  ["Assistências", "assists"],
  ["Assists", "assists"],
  ["Bloqueios", "blocks"],
  ["Tocos", "blocks"],
  ["Blocks", "blocks"],
  ["Roubos", "steals"],
  ["Roubadas", "steals"],
  ["Steals", "steals"],
  ["Turnovers", "turnovers"],
  ["Perdas", "turnovers"],
  ["Rebotes", "rebounds"],
  ["Rebounds", "rebounds"],
  ["Aces", "aces"],
  ["Triplas", "three_pointers"],
  ["Triples", "three_pointers"],
  ["Three Point", "three_pointers"],
  ["Three Pointers", "three_pointers"],
  ["3 Point", "three_pointers"],
  ["3-Pointers", "three_pointers"],
];

describe("vocabulário de estatística — contrato entre as três listas", () => {
  it.each(TERMOS)('"Total de %s" resolve como %s, bloqueia o placar e roteia estatística', (termo, familia) => {
    const mercado = `Total de ${termo}`;
    expect(statisticFamilyOf(mercado, "Over 5.5")).toBe(familia);
    expect(hasNonScoreStatQualifier(mercado, "Over 5.5")).toBe(true);
    expect(marketNeedsFlashscoreStats(mercado, "Over 5.5")).toBe(true);
  });

  it("roteia o que não resolve, de propósito", () => {
    // "Chutes" sem dizer se é total ou no gol: o resolvedor recusa (são LINHAS
    // diferentes do feed), mas o roteamento leva mesmo assim — lá vira
    // `unsupported_market` e chama o operador, em vez de virar gol.
    expect(statisticFamilyOf("Chutes", "Time A")).toBeNull();
    expect(marketNeedsFlashscoreStats("Chutes", "Time A")).toBe(true);
    expect(hasNonScoreStatQualifier("Chutes", "Time A")).toBe(true);
  });

  it("mercado de placar continua fora do caminho de estatística", () => {
    for (const mercado of ["Moneyline", "Total de Gols", "Handicap Asiático"]) {
      expect(statisticFamilyOf(mercado, "Over 2.5")).toBeNull();
      expect(marketNeedsFlashscoreStats(mercado, "Over 2.5")).toBe(false);
      expect(hasNonScoreStatQualifier(mercado, "Over 2.5")).toBe(false);
    }
  });

  describe("seleção específica refina o rótulo genérico do mercado", () => {
    it.each([
      ["Total de Cartões", "Cartões Amarelos Over 1.5", "yellow_cards"],
      ["Total de Cartões", "Amarelos Over 1.5", "yellow_cards"],
      ["Total de Cartões", "Over 1.5 Cartões Vermelhos", "red_cards"],
      ["Total de Chutes", "Chutes no Gol Over 3.5", "shots_on_target"],
      ["Faltas", "Duplas Faltas Over 2.5", "double_faults"],
    ] as const)("%s / %s usa %s", (mercado, selecao, familia) => {
      expect(statisticFamilyOf(mercado, selecao)).toBe(familia);
      expect(hasNonScoreStatQualifier(mercado, selecao)).toBe(true);
      expect(marketNeedsFlashscoreStats(mercado, selecao)).toBe(true);
    });

    it("mantém o mercado específico diante da repetição genérica", () => {
      expect(statisticFamilyOf("Total Yellow Cards", "Over 1.5 Cards")).toBe(
        "yellow_cards",
      );
    });

    it("contradição entre famílias independentes falha fechado", () => {
      expect(statisticFamilyOf("Total de Cartões", "Over 1.5 Escanteios")).toBeNull();
    });
  });

  /**
   * NOME DE TIME NÃO É MERCADO.
   *
   * Unificar o vocabulário promoveu `statisticFamilyOf` a roteadora, e ela lia
   * mercado e seleção como um texto só. "Las Vegas Aces" é time de verdade da
   * WNBA: no moneyline virava família `aces`, a aposta saía do caminho de
   * placar, não achava linha de aces num feed de basquete e morria em manual 6h
   * depois — com `missing_stat` como diagnóstico, que é mentira.
   *
   * A função guardada já existia e dizia isso no próprio comentário; a
   * desguardada foi a promovida. Estes casos são o que impede a troca de novo.
   */
  describe("nome de time que colide com o vocabulário", () => {
    const TIMES: Array<[string, string]> = [
      ["Moneyline", "Las Vegas Aces"],
      ["Vencedor", "Las Vegas Aces"],
      ["Handicap Asiático", "Las Vegas Aces -3.5"],
      ["Moneyline", "Aces United"],
      ["Resultado Final", "Corinthians"],
    ];

    it.each(TIMES)('"%s / %s" não vira mercado de estatística', (mercado, selecao) => {
      expect(statisticFamilyOf(mercado, selecao)).toBeNull();
      expect(marketNeedsFlashscoreStats(mercado, selecao)).toBe(false);
      expect(hasNonScoreStatQualifier(mercado, selecao)).toBe(false);
    });

    it("mas a linha declarada na SELEÇÃO continua sendo reconhecida", () => {
      // O outro lado do mesmo guarda: acoplado a uma linha, o termo vale.
      expect(statisticFamilyOf("Total", "Over 9.5 Aces")).toBe("aces");
      expect(statisticFamilyOf("Total", "Aces Over 9.5")).toBe("aces");
      expect(marketNeedsFlashscoreStats("Total", "Over 9.5 Aces")).toBe(true);
    });

    it("handicap ESTATÍSTICO segue reconhecido — quem o nomeia é o mercado", () => {
      expect(statisticFamilyOf("Escanteios Handicap", "Casa +2.5")).toBe("corners");
      expect(statisticFamilyOf("Handicap de Cartões", "Fora -1.5")).toBe("booking_points");
    });
  });

  /**
   * O rótulo que o FlashScore publica é `3-point field goals made`; a grafia
   * mais próxima dele e a forma natural em PT têm de ser reconhecidas.
   * Reconhecer "Triplas" e não "Three-Point Field Goals" é ter a família certa
   * pela porta errada.
   */
  describe("grafias da cesta de três que o feed e as casas usam", () => {
    it.each([
      "Three-Point Field Goals",
      "Three-Pointers",
      "3-Point Field Goals Made",
      "Total de Cestas de 3",
      "Total de Cestas de Três",
      "Arremessos de 3 Pontos",
    ])('"%s" resolve como three_pointers', (mercado) => {
      expect(statisticFamilyOf(mercado, "Over 10.5")).toBe("three_pointers");
      expect(marketNeedsFlashscoreStats(mercado, "Over 10.5")).toBe(true);
    });

    /**
     * "Triple Double" é PROP DE JOGADOR, não linha de cesta de três. Caindo em
     * `three_pointers`, seria recusado por `missing_line` — recusa certa,
     * diagnóstico mentiroso, e um número na seleção bastaria para liquidar pela
     * linha errada.
     */
    it.each(["Triple Double", "Duplo-Duplo", "Triplo-Duplo"])(
      '"%s" não é linha de cesta de três',
      (mercado) => {
        expect(statisticFamilyOf(mercado, "Sim")).toBeNull();
      },
    );
  });

  /**
   * `N+` é como a casa escreve "no mínimo N". Sem o conector entre o número e
   * a estatística, a seleção não declara linha nenhuma e o mercado segue
   * liquidável por PLACAR: como a seleção carrega o nome do time, o resolver de
   * lado casa, e "Gremio 2+ cards" num 2×1 do Grêmio sairia WON sem consultar
   * cartão. O espelho SQL segue o domínio, então a aposta também sairia do
   * IA-Judge — liquidada errado e sem revisor.
   */
  describe("linha declarada com N+ / por extenso", () => {
    const FORMAS = [
      "Gremio 2+ cards",
      "Gremio 2+ cartoes",
      "Gremio 3+ escanteios",
      "Gremio 2+ corners",
      "Gremio 1+ chutes",
      "Gremio 5+ desarmes",
      "Gremio 2 or more cards",
      "Gremio 2 ou mais cartoes",
      "Gremio 2 no minimo faltas",
      "Ambas 2+ cards",
    ];

    it.each(FORMAS)('"%s" declara estatística e não liquida pelo placar da partida', (selecao) => {
      expect(hasNonScoreStatQualifier("Moneyline", selecao)).toBe(true);
      expect(
        isScoreResolvableMarket({ mercado: "Moneyline", selecao, esporte: "Soccer" }),
      ).toBe(false);
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
    });
    // Os quatro contraexemplos de handicap/nome de time ficam no bloco
    // "nome de time com palavra de estatística NÃO é linha" do teste de formas,
    // com os mesmos argumentos e a classificação de placar adicional.
  });
});
