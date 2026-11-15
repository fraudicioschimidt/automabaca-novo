/**
 * A janela da tip — quanto tempo depois do post ainda se pode abrir uma
 * intenção de arquivo de preço para aquela aposta.
 *
 * O arquivo de resposta só guarda prova de uma aposta que acabou de chegar.
 * Intenção criada horas depois arquivaria a resposta de um jogo que já andou, e
 * o replay do fechamento a trataria como prova da aposta.
 *
 * Puro, sem I/O: quem tem o relógio e a linha do banco é quem chama.
 */

/**
 * Folga entre registrar a aposta e o enrich conseguir rodar (fila + retry).
 *
 * Não é "quanto tempo a linha demora a abrir" — é quanto tempo NOSSO pipeline
 * demora a olhar. Aumentar isto não melhora cobertura: só passa a tratar como
 * prova da aposta uma resposta cada vez mais tardia.
 */
export const LISTING_ENTRY_WINDOW_MINUTES = 15;

const JANELA_MS = LISTING_ENTRY_WINDOW_MINUTES * 60_000;

/**
 * `true` = a resposta de agora ainda pertence ao instante da entrada.
 *
 * `registradoEm` ausente ou inválido devolve `false`: sem saber quando a tip
 * chegou, não dá para afirmar que a linha existia. O viés é o mesmo do resto do
 * contrato de cobertura — na dúvida, NÃO inventar prova.
 */
export function dentroDaJanelaDeEntrada(
  registradoEm: Date | null | undefined,
  agora: Date,
): boolean {
  const t = registradoEm?.getTime();
  const agoraMs = agora.getTime();
  if (t == null || !Number.isFinite(t) || !Number.isFinite(agoraMs)) return false;
  const idadeMs = agoraMs - t;
  // Relógio invertido não é “muito recente”: sem ordem temporal válida não há
  // como afirmar que o preço observado pertence ao instante da entrada.
  return idadeMs >= 0 && idadeMs <= JANELA_MS;
}
