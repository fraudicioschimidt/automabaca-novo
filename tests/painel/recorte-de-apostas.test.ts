import { describe, expect, it } from "vitest";
import { testedAnData } from "@/app/_design/lib/tested-analyzer";
import { recorteDaCelula, recorteDaLinha } from "@/app/_design/lib/recorte-de-apostas";
import { resolvidas } from "@/src/domain/analyzer/shared";
import { sumMoneyBy } from "@/src/domain/money";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * A gaveta que abre ao clicar numa linha de tabela do Analyzer tem que listar
 * EXATAMENTE as apostas que produziram aquela linha.
 *
 * O risco é o cabeçalho contar uma base e o detalhe contar outra. A defesa não
 * é vigiar um filtro: é não ter filtro.
 * `agregaGrupo` devolve `membros`, o array que ele mesmo agregou, e a gaveta
 * renderiza esse array. Este portão trava a propriedade que sustenta o desenho:
 * se um dia alguém trocar `membros` por um predicado re-derivado, a conta para
 * de fechar e isto fica vermelho.
 */

let seq = 0;
function bet(over: Partial<BetRowData> = {}): BetRowData {
  seq += 1;
  return {
    id: `bet-${seq}`,
    data: new Date("2026-07-11T19:00:00Z"),
    registradoEm: new Date("2026-07-11T13:00:00Z"),
    settledAt: new Date("2026-07-11T21:00:00Z"),
    evento: `Time ${seq} vs Outro ${seq}`, competicao: "Brasileirão", pais: "Brasil",
    esporte: "futebol", mercado: "Total de gols", selecao: "Over 2.5",
    casaDeAposta: "Pinnacle", tipster: "",
    odds: 1.95, stake: 2, status: "WON", lucro: 1.9,
    
    closingOdd: 1.85, closingMaxBet: 500, openingMaxBet: 300,
    closingMaxBetCurrency: "USD", openingMaxBetCurrency: "USD",
    openingOdd: 2.0, openingRawOdd: 2.0, closingRawOdd: 1.85,
    clv: 5.4, clvReliable: true, closingFetchedAt: new Date("2026-07-11T19:00:00Z"),
    identityStatus: null, noOddsReason: null, closingNoOddsReason: null,
    source: "", sourceExternalId: null, contaTitular: null,
    ...over,
  };
}

/**
 * Amostra espalhada de propósito: esportes/mercados/ligas/países e casas
 * diferentes, antecedências que caem em janelas distintas, liquidez em faixas
 * distintas, Δ de abertura e de fechamento variados, dois meses, e PENDENTES —
 * porque é a pendente que separa "quantas apostas" de "quanto virou dinheiro".
 */
const FB: BetRowData[] = [
  bet(),
  bet({ esporte: "basquete", mercado: "Handicap", competicao: "NBA", pais: "EUA", casaDeAposta: "Betano", status: "LOST", lucro: -2, clv: -3.1, closingMaxBet: 40, openingMaxBet: 25, openingRawOdd: 1.90, closingRawOdd: 2.10 }),
  bet({ esporte: "tênis", mercado: "Vencedor", competicao: "ATP", pais: "Espanha", casaDeAposta: "Bet365", status: "HALF_WON", lucro: 0.8, odds: 2.4, closingMaxBet: 2500, openingMaxBet: 1800, openingRawOdd: 2.6, closingRawOdd: 2.2 }),
  // Pendente: entra na contagem da célula, fica fora de stake/lucro.
  bet({ status: "PENDING", lucro: 0, clv: null, clvReliable: null, closingFetchedAt: null, closingOdd: null, closingRawOdd: null, casaDeAposta: "Superbet" }),
  // Pós-kickoff (registrada depois do jogo começar) — outra janela de timing.
  bet({ registradoEm: new Date("2026-07-11T20:30:00Z"), status: "LOST", lucro: -2, casaDeAposta: "Betano" }),
  // ≥48h de antecedência.
  bet({ registradoEm: new Date("2026-07-08T10:00:00Z"), esporte: "futebol", mercado: "Escanteios", competicao: "Premier League", pais: "Inglaterra", status: "HALF_LOST", lucro: -1 }),
  // Outro mês E outra semana, com liquidação em dia diferente do kickoff.
  bet({ data: new Date("2026-08-01T00:00:00Z"), registradoEm: new Date("2026-07-31T15:00:00Z"), settledAt: new Date("2026-08-01T03:30:00Z"), casaDeAposta: "Bet365", esporte: "basquete", mercado: "Total de pontos", competicao: "NBB", pais: "Brasil" }),
  // Sem dado de liquidez nem de abertura: tem que ficar FORA desses recortes.
  bet({ closingMaxBet: null, openingMaxBet: null, openingOdd: null, openingRawOdd: null, status: "VOID", lucro: 0, casaDeAposta: "Superbet" }),
  // Registro em outra faixa de 4h e outro dia da semana (heatmap).
  bet({ data: new Date("2026-07-15T22:00:00Z"), registradoEm: new Date("2026-07-15T02:00:00Z"), settledAt: new Date("2026-07-16T00:30:00Z"), esporte: "tênis", mercado: "Games", competicao: "WTA", pais: "França", casaDeAposta: "Pinnacle", status: "LOST", lucro: -2 }),
  bet({ esporte: "futebol", mercado: "Total de gols", competicao: "Brasileirão", pais: "Brasil", casaDeAposta: "Betano", status: "CASHOUT", lucro: 0.4, closingMaxBet: 900, openingMaxBet: 700 }),
];

type LinhaAgregada = { l?: string; label?: string; k?: string; n: number; stake: number; lucro: number | null; membros: BetRowData[] };

/**
 * A conferência, isolada como função para poder ser apontada contra uma linha
 * SABIDAMENTE errada no fim deste arquivo. Sem isso o portão só provaria que
 * `membros` existe, não que ele denuncia divergência.
 *
 * Somas pelo helper BigInt-cents do domínio — nunca uma soma paralela
 * escrita no teste, que poderia errar do mesmo jeito que o código.
 */
function divergencias(linha: LinhaAgregada): string[] {
  const nome = linha.l ?? linha.label ?? linha.k ?? "?";
  const fin = resolvidas(linha.membros);
  const erros: string[] = [];
  if (linha.n !== linha.membros.length) {
    erros.push(`${nome}: linha conta ${linha.n}, gaveta lista ${linha.membros.length}`);
  }
  const stake = sumMoneyBy(fin, (b) => b.stake);
  if (linha.stake !== stake) erros.push(`${nome}: stake ${linha.stake} ≠ ${stake} dos membros`);
  const lucro = sumMoneyBy(fin, (b) => b.lucro);
  if (linha.lucro != null && linha.lucro !== lucro) {
    erros.push(`${nome}: lucro ${linha.lucro} ≠ ${lucro} dos membros`);
  }
  return erros;
}

const Z = testedAnData.Z(FB);
const S = testedAnData.S(FB);
const P = testedAnData.P(FB);
const E = testedAnData.E(FB);

const DIMENSOES: Array<[string, LinhaAgregada[]]> = [
  ["CLV · faixa de CLV", E.clvPerf as LinhaAgregada[]],
  ["Segmentos · esporte", testedAnData.segData("esporte", Z, FB) as LinhaAgregada[]],
  ["Segmentos · mercado", testedAnData.segData("mercado", Z, FB) as LinhaAgregada[]],
  ["Segmentos · competição", testedAnData.segData("competicao", Z, FB) as LinhaAgregada[]],
  ["Segmentos · país", testedAnData.segData("pais", Z, FB) as LinhaAgregada[]],
  ["Casas", P.casas as unknown as LinhaAgregada[]],
  ["Timing · antecedência", Z.tRows as LinhaAgregada[]],
  ["Liquidez · abertura", Z.lqOpenRows as LinhaAgregada[]],
  ["Liquidez · fechamento", Z.lqClosingRows as LinhaAgregada[]],
  ["Steam · Δ abertura→entrada", S.perfOE as LinhaAgregada[]],
  ["Steam · Δ entrada→fechamento", S.perfEF as LinhaAgregada[]],
  ["Período · mensal", P.monthly as unknown as LinhaAgregada[]],
  ["Período · semanal", P.weekly as unknown as LinhaAgregada[]],
];

describe("a gaveta conta a mesma base que a linha", () => {
  it("a amostra cobre todas as dimensões (senão o portão passaria vazio)", () => {
    for (const [nome, linhas] of DIMENSOES) {
      expect(linhas.length, `${nome} sem linhas na fixture`).toBeGreaterThan(0);
    }
    expect(Object.keys(Z.heat).length, "heatmap sem células").toBeGreaterThan(1);
  });

  it.each(DIMENSOES)("%s: n, stake e lucro batem com os membros", (_nome, linhas) => {
    const erros = linhas.flatMap(divergencias);
    expect(erros).toEqual([]);
  });

  it.each(DIMENSOES)("%s: os grupos são disjuntos e saem todos de FB", (_nome, linhas) => {
    const vistos = new Set<string>();
    const repetidos: string[] = [];
    const forasteiros: string[] = [];
    const doRecorte = new Set(FB.map((b) => b.id));
    for (const linha of linhas) {
      for (const b of linha.membros) {
        if (vistos.has(b.id)) repetidos.push(b.id);
        vistos.add(b.id);
        if (!doRecorte.has(b.id)) forasteiros.push(b.id);
      }
    }
    // Subconjunto, não igualdade: liquidez só cobre quem tem `closingMaxBet`, steam
    // só quem tem odd de abertura/fechamento. Recorte parcial é legítimo; aposta
    // contada DUAS vezes ou vinda de fora do período nunca é.
    expect({ repetidos, forasteiros }).toEqual({ repetidos: [], forasteiros: [] });
  });

  /**
   * A célula do heatmap é o único lugar onde contagem e soma têm bases
   * diferentes de propósito: `n` conta todas, o ROI só as liquidadas.
   */
  it("célula do heatmap: n conta todas, dinheiro só as liquidadas", () => {
    for (const [chave, celula] of Object.entries(Z.heat)) {
      expect(celula.n, `célula ${chave}`).toBe(celula.membros.length);
      expect(celula.liquidadas.length, `célula ${chave}`).toBe(resolvidas(celula.membros).length);
      expect(celula.stake, `célula ${chave}`).toBe(sumMoneyBy(celula.liquidadas, (b) => b.stake));
      expect(celula.profit, `célula ${chave}`).toBe(sumMoneyBy(celula.liquidadas, (b) => b.lucro));
    }
  });

  it("há uma célula com pendente dentro — senão a distinção acima não é testada", () => {
    const comPendente = Object.values(Z.heat).find((c) => c.membros.length > c.liquidadas.length);
    expect(comPendente, "fixture sem célula mista").toBeDefined();
  });

  it("o recorte entregue à gaveta é o MESMO array, não uma cópia filtrada", () => {
    const linha = testedAnData.segData("esporte", Z, FB)[0] as LinhaAgregada;
    const recorte = recorteDaLinha(linha, { rotulo: "futebol" });
    expect(recorte.apostas).toBe(linha.membros);
    expect(recorte.resumo.find((r) => r.k === "Apostas")?.v).toBe(String(linha.n));
  });

  it("o recorte da célula declara as duas bases, em vez de escolher uma", () => {
    const celula = Object.values(Z.heat).find((c) => c.membros.length > c.liquidadas.length);
    const recorte = recorteDaCelula(celula, { rotulo: "Sáb · 12–15h" });
    expect(recorte.apostas).toBe(celula?.membros);
    expect(recorte.resumo.map((r) => r.k)).toContain("Liquidadas");
  });

  /**
   * O portão tem dente.
   *
   * Reproduz o erro que ele existe para pegar: alguém troca `membros` por um
   * filtro reconstruído na tela e erra a fronteira da faixa — `>= 1 && < 3`
   * virando `> 1 && <= 3`. A linha continua plausível, a gaveta abre uma aposta
   * a menos, e nada mais no sistema reclama.
   */
  it("acusa quando os membros vêm de um predicado re-derivado com fronteira trocada", () => {
    const janela = (Z.tRows as LinhaAgregada[]).find((r) => r.membros.length > 1);
    expect(janela, "fixture sem janela de 2+ apostas").toBeDefined();
    const reDerivado: LinhaAgregada = { ...janela!, membros: janela!.membros.slice(1) };
    expect(divergencias(reDerivado).length).toBeGreaterThan(0);
  });

  it("acusa quando o dinheiro da linha não é o dinheiro dos membros", () => {
    const casa = P.casas[0] as unknown as LinhaAgregada;
    expect(divergencias({ ...casa, stake: casa.stake + 1 }).length).toBeGreaterThan(0);
    expect(divergencias({ ...casa, lucro: (casa.lucro ?? 0) + 1 }).length).toBeGreaterThan(0);
  });
});

describe("tabelas e ClsCard entregam os membros à gaveta", () => {
  it("o recorte das linhas e do ClsCard é o array de membros da linha", () => {
    const faixa = (E.clvPerf as LinhaAgregada[])[0];
    expect(faixa).toBeDefined();
    expect(recorteDaLinha(faixa!).apostas).toBe(faixa!.membros);
    const steam = recorteDaLinha(S.steam as unknown as LinhaAgregada, { rotulo: "Steam (a favor)" });
    expect(steam.apostas).toBe((S.steam as unknown as LinhaAgregada).membros);
    const cresc = recorteDaLinha(Z.cresc as unknown as LinhaAgregada, { rotulo: "Crescendo" });
    expect(cresc.apostas).toBe((Z.cresc as unknown as LinhaAgregada).membros);
  });
});
