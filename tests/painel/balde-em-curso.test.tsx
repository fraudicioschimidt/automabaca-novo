import { renderDesignMarkup } from "../helpers/design-markup";
import { describe, expect, it } from "vitest";
import { DeltaVsAnterior } from "@/app/_design/screens/analyzer/shared";
import {
  aindaSeMove,
  emCursoDoGrupo,
  ressalvaDoComparativo,
  textoDeEmCurso,
  totalmenteEmAberto,
} from "@/app/_design/lib/balde-em-curso";
import { agregaGrupo } from "@/src/domain/analyzer/shared";

/** Pendências reais qualificam os comparativos sem incluir reembolsos encerrados. */

/** Aposta mínima para `agregaGrupo` — só o que o agregado lê. */
function aposta(status: string, lucro = 0) {
  return {
    status,
    stake: 1,
    lucro,
    clv: null,
    clvReliable: false,
    closingFetchedAt: null,
  };
}

describe("a pendência é derivada, não redigitada", () => {
  it("sai do MESMO agregado que a tela já usa", () => {
    // 12 apostas, 9 resolvidas — o exemplo do cabeçalho.
    const grupo = [
      ...Array.from({ length: 9 }, () => aposta("WON", 0.5)),
      ...Array.from({ length: 3 }, () => aposta("PENDING")),
    ];
    const agg = agregaGrupo(grupo);
    expect(agg.bets).toBe(12);
    expect(agg.resolvedBets).toBe(9);

    const e = emCursoDoGrupo(agg);
    expect(e).toEqual({ pendentes: 3, total: 12 });
  });

  it("balde inteiramente resolvido NÃO ganha marca — senão ela vira decoração", () => {
    const e = emCursoDoGrupo({ bets: 12, pendingBets: 0 });
    expect(aindaSeMove(e)).toBe(false);
    expect(textoDeEmCurso(e)).toBe("");
    expect(ressalvaDoComparativo(e)).toBe("");
  });

  it("aindaSeMove é verdadeiro exatamente quando há pendentes", () => {
    for (let total = 0; total <= 20; total++) {
      for (let pendentes = 0; pendentes <= total; pendentes++) {
        const e = emCursoDoGrupo({ bets: total, pendingBets: pendentes });
        expect(aindaSeMove(e), `${pendentes}/${total}`).toBe(pendentes > 0);
      }
    }
  });

  it("entrada torta não vira pendência negativa nem maior que o total", () => {
    expect(emCursoDoGrupo({ bets: 5, pendingBets: 9 })).toEqual({ pendentes: 5, total: 5 });
    expect(emCursoDoGrupo({ bets: -3, pendingBets: -1 })).toEqual({ pendentes: 0, total: 0 });
  });
});

describe("a frase nomeia as DUAS bases", () => {
  /**
   * "3 pendentes" solto repete o erro do `resumo-de-apostas`: 3 é irrelevante em
   * 300 e decisivo em 4. O total tem que estar na frase.
   */
  it("todo texto exibido contém o pendente E o total", () => {
    for (const [pendentes, total] of [[1, 12], [3, 12], [11, 119], [7, 8]] as const) {
      const texto = textoDeEmCurso({ pendentes, total });
      expect(texto, `${pendentes}/${total}`).toContain(String(pendentes));
      expect(texto, `${pendentes}/${total}`).toContain(String(total));
    }
  });

  it("concorda em número (o plural sai do helper, não de ternário à mão)", () => {
    expect(textoDeEmCurso({ pendentes: 1, total: 12 })).toBe("1 de 12 apostas ainda não liquidou");
    expect(textoDeEmCurso({ pendentes: 3, total: 12 })).toBe("3 de 12 apostas ainda não liquidaram");
    expect(ressalvaDoComparativo({ pendentes: 1, total: 119 })).toContain("1 aposta ainda não liquidou");
    expect(ressalvaDoComparativo({ pendentes: 11, total: 119 })).toContain("11 apostas ainda não liquidaram");
  });

  it("balde 100% em aberto se declara como tal, não como '5 de 5'", () => {
    const e = { pendentes: 5, total: 5 };
    expect(totalmenteEmAberto(e)).toBe(true);
    expect(textoDeEmCurso(e)).toBe("5 apostas — nenhuma liquidada ainda");
    expect(textoDeEmCurso({ pendentes: 1, total: 1 })).toBe("1 aposta — nenhuma liquidada ainda");
  });
});

describe("balde sem resolvida não exibe ROI como resultado", () => {
  /**
   * Hoje é `null` porque `stake > 0` é falso (stake soma só resolvidas). Sem
   * prova isso é acidente de implementação, não contrato — e é o que segura a
   * linha de mês futuro de parecer desempenho.
   */
  it("mês inteiramente pendente tem roi null e stake zero", () => {
    const grupo = Array.from({ length: 4 }, () => aposta("PENDING"));
    const agg = agregaGrupo(grupo);
    expect(agg.bets).toBe(4);
    expect(agg.resolvedBets).toBe(0);
    expect(agg.roi).toBeNull();
    expect(agg.stake).toBe(0);
    expect(totalmenteEmAberto(emCursoDoGrupo(agg))).toBe(true);
  });
});

describe("as superfícies declaram — nenhuma nasce muda", () => {
  /**
   * O comparativo lê a pendência da janela ATUAL. A ressalva vive depois de
   * três `return` antecipados, e qualquer um deles a engoliria em silêncio.
   */
  const delta = (emCursoAtual: { pendentes: number; total: number } | null) =>
    renderDesignMarkup(
      <DeltaVsAnterior
        atual={8}
        anterior={5}
        // Bases folgadas dos dois lados: aqui o assunto é a pendência, e uma
        // base curta faria a guarda de amostra engolir o delta antes.
        base={{ atual: 60, anterior: 25 }}
        rotuloAnterior="os 7 dias anteriores"
        emCursoAtual={emCursoAtual}
      />,
    );

  it("com pendente na janela atual, a ressalva chega ao DOM junto do delta", () => {
    const html = delta({ pendentes: 11, total: 119 });
    expect(html).toContain("vs os 7 dias anteriores");
    expect(html).toContain("11 apostas ainda não liquidaram");
  });

  it("sem pendente, o delta sai sozinho — a marca não vira decoração", () => {
    const html = delta({ pendentes: 0, total: 119 });
    expect(html).toContain("vs os 7 dias anteriores");
    expect(html).not.toContain("ainda não liquid");
    expect(delta(null)).not.toContain("ainda não liquid");
  });
});


describe("reembolsos encerrados não são pendências", () => {
  it.each(["VOID", "CANCELED"])("%s não deixa o período em curso", (status) => {
    const agg = agregaGrupo([aposta("WON", 1), aposta(status)]);
    expect(agg.roi).toBe(100);
    expect(emCursoDoGrupo(agg)).toEqual({ pendentes: 0, total: 2 });
    expect(ressalvaDoComparativo(emCursoDoGrupo(agg))).toBe("");
  });

  it("conta só a pendente num grupo com ganhos, perdas e reembolsos", () => {
    const agg = agregaGrupo([aposta("WON", 1), aposta("LOST", -1), aposta("VOID"), aposta("CANCELED"), aposta("PENDING")]);
    expect(emCursoDoGrupo(agg)).toEqual({ pendentes: 1, total: 5 });
    expect(agg).toMatchObject({ stake: 2, lucro: 0, roi: 0 });
  });
});
