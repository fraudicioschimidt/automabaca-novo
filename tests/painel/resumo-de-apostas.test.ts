import { describe, expect, it } from "vitest";
import { decidirBaseDaTira, resumirApostas } from "@/app/_design/lib/resumo-de-apostas";
import type { SituacaoDeCobertura } from "@/src/domain/analyzer/cobertura";

/**
 * Cabeçalho e lista contam a MESMA base.
 *
 * Ex.: a aba "Positivas" da tira de KPI da banca não pode mostrar 17 apostas,
 * todas ganhas, com o ROI calculado sobre outras 37.
 *
 * O sintoma dessa classe é o pior possível: o número não quebra, não
 * avisa, e responde a OUTRA pergunta com cara de resposta. O operador decide em
 * cima dele.
 */

type Aposta = {
  stake: number;
  profit: number | null;
  status: string;
  clv?: number | null;
  clvSituacao?: SituacaoDeCobertura;
};

const aposta = (p: Partial<Aposta>): Aposta =>
  ({ stake: 1, profit: null, status: "pending", clv: null, ...p });

describe("resumo de um recorte de apostas", () => {
  it("o recorte responde pelo recorte, não pelo conjunto de onde saiu", () => {
    const todas = [
      aposta({ stake: 1, profit: 1, status: "won" }),
      aposta({ stake: 1, profit: 1, status: "won" }),
      aposta({ stake: 1, profit: -1, status: "lost" }),
      aposta({ stake: 1, profit: -1, status: "lost" }),
    ];
    const soPositivas = todas.filter((b) => (b.profit ?? 0) > 0);

    // As duas bases dão ROI diferente: a tela não pode mostrar o de uma enquanto
    // lista a outra.
    expect(resumirApostas(todas).roi).toBe(0);
    expect(resumirApostas(soPositivas).roi).toBe(100);
  });

  it("separa ganhas de perdidas — o líquido esconde o tamanho da operação", () => {
    const magra = [aposta({ profit: 8, status: "won" }), aposta({ profit: -1, status: "lost" })];
    const gorda = [aposta({ profit: 12, status: "won" }), aposta({ profit: -5, status: "lost" })];

    expect(resumirApostas(magra).lucro).toBe(7);
    expect(resumirApostas(gorda).lucro).toBe(7);
    // Mesmo líquido, operações diferentes — é isso que o par revela.
    expect(resumirApostas(magra).ganhas).toBe(8);
    expect(resumirApostas(gorda).ganhas).toBe(12);
    expect(resumirApostas(magra).perdidas).toBe(-1);
    expect(resumirApostas(gorda).perdidas).toBe(-5);
  });

  it("recusa o ROI quando não há stake liquidada, em vez de afirmar 0%", () => {
    const soPendentes = [aposta({ stake: 2 }), aposta({ stake: 3 })];
    const r = resumirApostas(soPendentes);
    expect(r.roi, "0% afirmaria um desempenho que ninguém mediu").toBeNull();
    expect(r.stakePendente).toBe(5);
    expect(r.pendentes).toBe(2);
  });

  it("recorte vazio não vira NaN nem Infinity", () => {
    const r = resumirApostas([]);
    expect(r.total).toBe(0);
    expect(r.lucro).toBe(0);
    expect(r.roi).toBeNull();
    expect(r.clvMean).toBeNull();
    expect(r.clvShare).toBeNull();
  });

  it("pendente não entra em lucro nem em ROI", () => {
    const r = resumirApostas([
      aposta({ stake: 1, profit: 1, status: "won" }),
      aposta({ stake: 9, status: "pending" }),
    ]);
    expect(r.lucro).toBe(1);
    expect(r.stakeLiquidada, "a stake pendente ficaria no denominador e afundaria o ROI").toBe(1);
    expect(r.roi).toBe(100);
    expect(r.turnover, "turnover é tudo que está em risco, inclusive pendente").toBe(10);
  });

  it("VOID/CANCELED ficam visíveis, mas não diluem stake finalizada nem ROI", () => {
    const r = resumirApostas([
      aposta({ stake: 1, profit: 1, status: "won" }),
      aposta({ stake: 1, profit: -1, status: "lost" }),
      aposta({ stake: 20, profit: 0, status: "void" }),
    ]);
    expect(r.total).toBe(3);
    expect(r.liquidadas).toBe(2);
    expect(r.stakeLiquidada).toBe(2);
    expect(r.roi).toBe(0);
  });

  it("média de CLV usa só quem tem o dado; a cobertura divide pela base alcançável", () => {
    const r = resumirApostas([
      aposta({ clv: 4, profit: 0, status: "void" }),
      aposta({ profit: 0, status: "void" }),
      aposta({ stake: 1, status: "pending" }),
      aposta({ stake: 1, status: "pending" }),
    ]);
    expect(r.clvMean).toBe(4);
    expect(r.clvShare, "pendente ainda não fechou: 1 de 2 alcançáveis").toBe(50);
  });

  it("a situação calculada no servidor decide: entrada ao vivo sai da base, lacuna fica", () => {
    const r = resumirApostas([
      aposta({ clv: 2, profit: 1, status: "won", clvSituacao: "tem" }),
      aposta({ profit: -1, status: "lost", clvSituacao: "nao_se_aplica" }),
      aposta({ profit: -1, status: "lost", clvSituacao: "nao_se_aplica" }),
      aposta({ profit: 1, status: "won", clvSituacao: "lacuna" }),
    ]);
    expect(r.clvShare).toBe(50);
  });

  it("sem base alcançável, a cobertura é ausência e não 0%", () => {
    expect(resumirApostas([aposta({ status: "pending" })]).clvShare).toBeNull();
  });
});

describe("quando a tira PODE trocar de base", () => {
  const ctx = (p: Partial<Parameters<typeof decidirBaseDaTira>[0]>) =>
    decidirBaseDaTira({ filtroAtivo: true, historyTotal: 37, carregadas: 37, ...p });

  it("com filtro e histórico inteiro em mão, conta o recorte", () => {
    expect(ctx({}).base).toBe("recorte");
  });

  it("sem filtro, fica na banca — não há recorte para contar", () => {
    expect(ctx({ filtroAtivo: false }).base).toBe("banca");
  });

  it("histórico TRUNCADO recusa a troca", () => {
    // Caso difícil de ver na tela (banca com mais de 300 apostas): sem teste
    // puro, a regra só existiria no comentário.
    const d = ctx({ historyTotal: 1200, carregadas: 300 });
    expect(d.base, "somar 300 de 1200 como se fosse a banca é o defeito de volta").toBe("banca");
    expect(d.motivo).toBe("histórico truncado");
  });

  it("exatamente no limite, com tudo carregado, ainda pode trocar", () => {
    expect(ctx({ historyTotal: 300, carregadas: 300 }).base).toBe("recorte");
  });

  it("sem historyTotal, assume que o que está em mão é tudo", () => {
    expect(ctx({ historyTotal: undefined, carregadas: 12 }).base).toBe("recorte");
  });
});
