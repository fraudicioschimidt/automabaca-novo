import { foraDaBaseDeCobertura, missingClvReason, NO_ODDS_REASONS, noOddsReasonLabel } from "@/src/domain/no-odds-reason";
import { sumMoneyBy } from "@/src/domain/money";
import { clvConfiavel } from "./shared";
import type { BetRowData } from "@/src/domain/bet-read-model";

/**
 * A base ALCANÇÁVEL de uma métrica de cobertura.
 *
 * O conjunto inteiro contém apostas que a métrica não pode alcançar: entrada ao
 * vivo não tem CLV por definição, aposta pendente ainda não fechou, a política
 * da banca desligou a métrica. Dividir por ele achata a
 * banca de cobertura total e a de muitas lacunas no mesmo número mediano.
 *
 * Cinco situações, e `sem_explicacao` é categoria própria de propósito:
 * liquidada, sem a métrica e SEM motivo gravado é silêncio, não lacuna. Lacuna
 * o sistema sabe explicar; silêncio ele nem sabe que perdeu.
 */
export type SituacaoDeCobertura =
  /** A métrica existe para esta aposta. */
  | "tem"
  /** Ainda não deu tempo — pendente. Fora da base: não é falha, é relógio. */
  | "cedo"
  /** A métrica não se aplica e nunca vai se aplicar. Fora da base. */
  | "nao_se_aplica"
  /** Poderia existir e não existe, com motivo gravado. NA base. */
  | "lacuna"
  /** Poderia existir, não existe, e ninguém sabe dizer por quê. NA base. */
  | "sem_explicacao";

/** As duas situações que a métrica podia ter alcançado e não alcançou. */
const FALTANDO: readonly SituacaoDeCobertura[] = ["lacuna", "sem_explicacao"];

export type BaseDeCobertura<T> = {
  /** Situação "tem" — o numerador. */
  cobertas: T[];
  /** O denominador: cobertas + faltando. */
  base: T[];
  /** O que a gaveta abre: o buraco, com motivo quando há. */
  faltando: T[];
  /** Fora do denominador porque ainda não deu tempo. Volta a contar sozinha. */
  cedo: T[];
  /** Fora do denominador para sempre. Separada de `cedo` porque a tela as
   *  nomeia diferente: "12 pendentes" é espera, "26 ao vivo" é definição. */
  naoSeAplica: T[];
  /** `cobertas / base` em pontos percentuais. `null` com base vazia — 0% mentiria. */
  pct: number | null;
};

export function baseAlcancavel<T>(
  bets: readonly T[],
  situacao: (b: T) => SituacaoDeCobertura,
): BaseDeCobertura<T> {
  const cobertas: T[] = [];
  const faltando: T[] = [];
  const cedo: T[] = [];
  const naoSeAplica: T[] = [];
  for (const b of bets) {
    const s = situacao(b);
    if (s === "tem") cobertas.push(b);
    else if (FALTANDO.includes(s)) faltando.push(b);
    else if (s === "cedo") cedo.push(b);
    else naoSeAplica.push(b);
  }
  const base = [...cobertas, ...faltando];
  return {
    cobertas,
    base,
    faltando,
    cedo,
    naoSeAplica,
    pct: base.length > 0 ? (cobertas.length / base.length) * 100 : null,
  };
}

type LinhaDeCobertura = Pick<
  BetRowData,
  "status" | "clv" | "clvReliable" | "closingFetchedAt" | "closingNoOddsReason" | "noOddsReason"
>;

/**
 * Situação do CLV. Pendente sem fechamento é `cedo`; depois de congelado,
 * o CLV já pode ser medido mesmo que a liquidação ainda esteja pendente.
 *
 * O motivo é o de `missingClvReason`, o mesmo da coluna "Sem odds": o do
 * fechamento e, sem ele, o da identidade que alcança o fechamento (múltipla,
 * banca só identidade e jogo não casado nunca ganham `bet_closing`).
 *
 * A ordem importa. O motivo fora da base é consultado ANTES do status porque
 * uma entrada ao vivo pendente continua sem CLV possível — `cedo` sugeriria que
 * basta esperar. Sem fechamento, o motivo de identidade de aposta pendente
 * ainda é `cedo`: ela pode casar até o jogo.
 */
export function situacaoDoClv(b: LinhaDeCobertura): SituacaoDeCobertura {
  if (clvConfiavel(b) != null) return "tem";
  if (b.closingNoOddsReason != null) {
    return foraDaBaseDeCobertura(b.closingNoOddsReason) ? "nao_se_aplica" : "lacuna";
  }
  const motivo = missingClvReason(b);
  if (foraDaBaseDeCobertura(motivo)) return "nao_se_aplica";
  if (b.status === "PENDING" && b.closingFetchedAt == null) return "cedo";
  return motivo != null ? "lacuna" : "sem_explicacao";
}

/**
 * Situação da abertura (`bet_opening`, colhida na BridgeOdds depois do jogo).
 *
 * O motivo que conta é o da própria abertura (`noOpeningReason`). O da
 * identidade só tira a aposta da base quando é política que desliga todo
 * preço dela (banca só identidade, múltipla, segmento desligado, mercado sem
 * referência); `clv_only` fala da entrada e não tira. Pendente sem tentativa
 * é `cedo`: a coleta espera o jogo começar.
 */
export function situacaoDaAbertura(
  b: Pick<BetRowData, "status" | "noOddsReason" | "openingNoOddsReason">,
  tem: boolean,
): SituacaoDeCobertura {
  if (tem) return "tem";
  const politica = b.noOddsReason
    ? (NO_ODDS_REASONS as Record<string, { base: string; ausencia: string } | undefined>)[b.noOddsReason]
    : undefined;
  if (politica?.base === "nao_se_aplica" && politica.ausencia === "ambos") return "nao_se_aplica";
  if (b.openingNoOddsReason != null) {
    return foraDaBaseDeCobertura(b.openingNoOddsReason) ? "nao_se_aplica" : "lacuna";
  }
  return b.status === "PENDING" ? "cedo" : "sem_explicacao";
}

/** Rótulo do balde de silêncio — liquidada, sem métrica, sem motivo gravado. */
export const SEM_MOTIVO_GRAVADO = "sem motivo gravado";

export type PerdaDeCobertura<T> = {
  /** Slug do motivo, ou `null` no balde de silêncio. */
  motivo: string | null;
  /** Prosa PT-BR do SSOT de motivos. */
  rotulo: string;
  /** O array EXATO agregado — é ele que a gaveta abre (mesma regra do `agregaGrupo`). */
  membros: T[];
  n: number;
  /** Stake exposto sem a métrica, somado em BigInt-cents. */
  stake: number;
  /** O mercado que mais aparece neste motivo, e quantas vezes. */
  mercadoDominante: string | null;
  nDoMercado: number;
};

/**
 * O buraco da cobertura, quebrado por motivo — "onde o CLV se perde".
 *
 * Uma cobertura de 70% diz que falta algo; ela não diz O QUÊ comprar. Quebrada
 * por motivo e por mercado, a mesma medição vira decisão (um único mercado pode
 * responder pela metade das lacunas).
 *
 * O mercado dominante entra porque é o eixo de DECISÃO: motivo diz de quem é a
 * culpa (provider, matching, relógio), mercado diz onde doer.
 */
export function perdasPorMotivo<T extends { stake: number; mercado: string }>(
  faltando: readonly T[],
  motivoDe: (b: T) => string | null,
): Array<PerdaDeCobertura<T>> {
  const baldes = new Map<string, { motivo: string | null; membros: T[] }>();
  for (const b of faltando) {
    const motivo = motivoDe(b);
    const chave = motivo ?? "";
    const balde = baldes.get(chave) ?? { motivo, membros: [] };
    balde.membros.push(b);
    baldes.set(chave, balde);
  }
  return [...baldes.values()]
    .map(({ motivo, membros }) => {
      const porMercado = new Map<string, number>();
      for (const b of membros) porMercado.set(b.mercado, (porMercado.get(b.mercado) ?? 0) + 1);
      const [dominante] = [...porMercado.entries()].sort((a, b) => b[1] - a[1]);
      return {
        motivo,
        rotulo: motivo == null ? SEM_MOTIVO_GRAVADO : noOddsReasonLabel(motivo),
        membros,
        n: membros.length,
        stake: sumMoneyBy(membros, (b) => b.stake),
        mercadoDominante: dominante?.[0] ?? null,
        nDoMercado: dominante?.[1] ?? 0,
      };
    })
    // Maior buraco primeiro; stake desempata, porque 3 apostas de 5u pesam mais
    // que 3 de 0,5u e a decisão é sobre dinheiro exposto sem medição.
    .sort((a, b) => b.n - a.n || b.stake - a.stake);
}
