import {
  JANELA_DE_RENDIMENTO_DIAS,
  TIPOS_DE_TRABALHO,
  totalEntregue,
  type PeriodoDeCusto,
  type RendimentoDeProvider,
  type TipoDeTrabalho,
} from "@/src/domain/rendimento-de-provider";
import { contagem } from "./plural";

/**
 * Como o card de budgets escreve as DUAS janelas do provider.
 *
 * O domínio (`src/domain/rendimento-de-provider`) diz quais trabalhos existem e
 * onde a autoria mora; aqui mora só a frase em PT, com concordância. O
 * `Record<TipoDeTrabalho, …>` obriga todo trabalho do domínio a ter rótulo.
 */

const ROTULO_DE_TRABALHO: Readonly<Record<TipoDeTrabalho, { singular: string; plural: string }>> = {
  identidade: { singular: "identidade", plural: "identidades" },
  fechamento: { singular: "fechamento", plural: "fechamentos" },
  resultado: { singular: "resultado", plural: "resultados" },
};

/** A janela do CUSTO, dita em palavras — a chave crua ("2026-08-19T00") não é frase. */
const ROTULO_DO_CUSTO: Readonly<Record<PeriodoDeCusto, string>> = {
  hour: "nesta hora",
  day: "hoje",
  month: "neste mês",
};

export function textoDoCusto(periodo: string): string {
  return ROTULO_DO_CUSTO[periodo as PeriodoDeCusto] ?? "no período";
}

/**
 * "7 dias: 116 identidades · 66 fechamentos": cada parcela nomeia o que é.
 * Sem entrega nenhuma a frase DIZ isso, em vez de omitir a linha: provider que
 * gasta a cota e não entrega é justamente o que precisa ficar visível.
 */
export function textoDeRendimento(
  rendimento: RendimentoDeProvider,
  dias: number = JANELA_DE_RENDIMENTO_DIAS,
): string {
  const prefixo = `${contagem(dias, "dia")}: `;
  if (totalEntregue(rendimento) === 0) return `${prefixo}nada atribuído`;
  const partes = TIPOS_DE_TRABALHO.filter((tipo) => (rendimento[tipo] ?? 0) > 0).map((tipo) => {
    const rotulo = ROTULO_DE_TRABALHO[tipo];
    return contagem(rendimento[tipo] ?? 0, rotulo.singular, rotulo.plural);
  });
  return prefixo + partes.join(" · ");
}
