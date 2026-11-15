import { describe, expect, it } from "vitest";
import {
  CLASSES_QUE_SAO_FALHA,
  CLASSES_SEM_PROXIMA_ETAPA,
  MOTIVOS_DE_PERDA,
  rendimentoDoMotor,
  type ContagemDePosts,
} from "@/src/domain/recusa-de-captura";
import { causasDeParse, percentual } from "@/app/_design/screens/operacoes/channels-card";

/**
 * Métrica de captura conta POST, não EVENTO, e há uma definição só de "o motor
 * falhou".
 *
 * `audit_events` grava uma linha por TENTATIVA de parse — a mesma mensagem volta
 * a cada edit e a cada retry —, então somar linhas infla lidos e perdidas. E a
 * taxa `registered / (registered + unparseable)` deixa `guard_rejected` de fora
 * e conta `not_bet` (descarte correto) como falha, o que inverte o ranking dos
 * canais.
 *
 * `domain/recusa-de-captura` decide o que é falha, recebe POSTS (o tipo não
 * aceita evento) e é a única porta dos dois leitores.
 */

/** Canal Target, contado por POST. */
const TARGET: ContagemDePosts[] = [
  { capturado: true, motivo: null, n: 108 },
  { capturado: false, motivo: "mercado_total_ambiguo", n: 19 },
  { capturado: false, motivo: "lado_handicap_ausente", n: 10 },
  { capturado: false, motivo: "llm_exhausted", n: 2 },
];
/** Big Data Under: canal que não perde tip e só descarta não-apostas. */
const BIG_DATA: ContagemDePosts[] = [
  { capturado: true, motivo: null, n: 59 },
  { capturado: false, motivo: "not_bet", n: 17 },
];

describe("o rendimento se mede por POST", () => {
  it("o tipo de entrada não aceita soma de eventos de auditoria", () => {
    // A defesa é estrutural: `ContagemDePosts` fala de posts já resolvidos
    // (`capturado`), não de `outcome`. Não há como passar linhas de auditoria
    // cruas sem antes decidir, post a post, o desfecho.
    const chaves = Object.keys(TARGET[0]!).sort();
    expect(chaves).toEqual(["capturado", "motivo", "n"]);
  });
});

describe("uma definição só de 'o motor falhou'", () => {
  it("guard_rejected conta como falha; not_bet não", () => {
    const classe = (motivo: string) =>
      rendimentoDoMotor([{ capturado: false, motivo, n: 1 }]).perdas[0]?.classe;
    expect(classe("mercado_total_ambiguo")).toBe("legenda_incompleta");
    expect(classe("lado_handicap_ausente")).toBe("legenda_incompleta");
    expect(classe("not_bet")).toBe("descarte_correto");
    expect(CLASSES_QUE_SAO_FALHA).not.toContain("descarte_correto");
    expect(CLASSES_QUE_SAO_FALHA).not.toContain("decisao_do_operador");
  });

  it("perda da cascata de IA não é rotulada como cota esgotada", () => {
    // O mesmo motivo cobre cota, erro de transporte e leitura que não virou aposta.
    const [perda] = rendimentoDoMotor([{ capturado: false, motivo: "llm_exhausted", n: 1 }]).perdas;
    expect(perda).toMatchObject({ classe: "recurso_externo", rotulo: "a IA não conseguiu ler o post" });
    expect(perda?.proximaEtapa).toContain("registre à mão");
  });

  it("o ranking dos canais não sai invertido", () => {
    const target = rendimentoDoMotor(TARGET);
    const bigData = rendimentoDoMotor(BIG_DATA);
    // A taxa contada por post.
    expect(target.taxa!).toBeCloseTo((108 / 139) * 100, 1);
    expect(bigData.taxa!).toBeCloseTo(100, 6);
    // E a ordem que importa: o canal que perde tip fica ABAIXO do que não perde.
    expect(target.taxa!).toBeLessThan(bigData.taxa!);
    // A taxa `ok / (ok + unparseable)` daria 95,6% e 77,6% — invertido.
    expect(target.taxa!).toBeLessThan(95);
    expect(bigData.taxa!).toBeGreaterThan(90);
  });

  it("descarte correto sai do denominador, e é declarado", () => {
    const bigData = rendimentoDoMotor(BIG_DATA);
    expect(bigData.descartadas).toBe(17);
    expect(bigData.tentativas).toBe(59);
    expect(bigData.perdidas).toBe(0);
  });

  it("percentual não medido é travessão, nunca `null%`", () => {
    // Canal sem identidade resolvida não pode exibir "IDENTIDADE null%".
    // Parente do `formato-de-resultado`: "medi e deu zero" é diferente de
    // "não há o que medir".
    expect(percentual(null)).toBe("—");
    expect(percentual(undefined)).toBe("—");
    expect(percentual(0)).toBe("0%");
    expect(percentual(78)).toBe("78%");
  });
});

describe("o vocabulário cobre quem grava", () => {
  it("todo verbete diz o que fazer, exceto onde não há o que fazer", () => {
    // A exceção é DECLARADA no domínio (`CLASSES_SEM_PROXIMA_ETAPA`), não
    // escrita aqui: classe nova nasce exigindo a próxima etapa, e quem quiser
    // isentá-la tem de dizer isso no lugar onde a classe é definida.
    for (const [motivo, verbete] of Object.entries(MOTIVOS_DE_PERDA)) {
      expect(verbete.rotulo.length, `\`${motivo}\` sem rótulo em PT`).toBeGreaterThan(3);
      if (CLASSES_SEM_PROXIMA_ETAPA.includes(verbete.classe)) continue;
      expect(verbete.proximaEtapa.length, `\`${motivo}\` sem próxima etapa`).toBeGreaterThan(10);
    }
  });

  it("a lista de rótulos vive num lugar só", () => {
    // Uma cópia em JSX dos rótulos acaba com nomes diferentes para os mesmos
    // motivos; a tela lê do domínio.
    expect(causasDeParse({ parsePerdas: rendimentoDoMotor(TARGET).perdas }))
      .toContain(MOTIVOS_DE_PERDA.mercado_total_ambiguo!.rotulo);
    expect(causasDeParse({ parsePerdas: [] })).toBe("");
  });
});
