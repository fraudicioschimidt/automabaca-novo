/**
 * Como a caixa de ações escolhe as linhas que mostra — e por qual critério.
 *
 * A caixa carrega no máximo `ACOES_POR_ABA` por aba, então o que a consulta
 * ORDENA é o que o operador vê. Aberta e encerrada se leem por chaves
 * diferentes: triagem pergunta "o que é mais grave", histórico pergunta "o que
 * acabou de acontecer" (ordenar encerradas por prioridade esconde o que foi
 * encerrado agora atrás de alertas antigos). O critério mora aqui uma vez
 * porque quem ORDENA (o serviço) e quem ANUNCIA (o cartão) precisam dizer a
 * mesma coisa.
 */

/** Teto de linhas por aba: vale para a consulta e para o texto que a declara. */
export const ACOES_POR_ABA = 25;

export type AbaDaCaixa = "OPEN" | "ACKED" | "RESOLVED";
export type CriterioDeRecorte = "prioridade" | "recencia";

export const CRITERIO_DA_ABA: Readonly<Record<AbaDaCaixa, CriterioDeRecorte>> = {
  OPEN: "prioridade",
  ACKED: "prioridade",
  RESOLVED: "recencia",
};

/** Como o critério se anuncia na tela. Uma grafia só, nos dois lados. */
export const ORDEM_NA_TELA: Readonly<Record<CriterioDeRecorte, string>> = {
  prioridade: "maior prioridade primeiro",
  recencia: "mais recentes primeiro",
};

export function criterioDaAba(aba: string): CriterioDeRecorte {
  return CRITERIO_DA_ABA[aba as AbaDaCaixa] ?? "prioridade";
}

/**
 * A ordem de cada critério, em dados puros — o serviço só a entrega ao Prisma
 * (e prova ali que ela é um `orderBy` válido). Mora aqui para que a ordem REAL
 * possa ser conferida por teste sem subir banco: era exatamente o que faltava
 * quando a consulta ordenava por prioridade e a tela anunciava recência.
 */
export const ORDEM_POR_CRITERIO = {
  prioridade: [{ priority: "desc" }, { lastSeenAt: "desc" }],
  recencia: [{ lastSeenAt: "desc" }, { priority: "desc" }],
} as const satisfies Record<CriterioDeRecorte, ReadonlyArray<Record<string, "asc" | "desc">>>;

export function ordemDaAba(aba: AbaDaCaixa) {
  return ORDEM_POR_CRITERIO[CRITERIO_DA_ABA[aba]];
}
