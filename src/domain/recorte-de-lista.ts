/**
 * Rodapé das listas que o painel lê com `take`: quando a página não é o
 * universo, a tela diz "Exibindo N de T" em vez de fingir que mostrou tudo.
 */

export const FALHAS_DE_JOB_LIMITE = 200;
export const FALHAS_DE_JOB_JANELA_DIAS = 7;
export const PENDENCIAS_SHARP_LIMITE = 30;

/** null quando a lista mostrou tudo (ou o total é desconhecido). */
export function textoDoRecorte(mostradas: number, total: number, sufixo?: string): string | null {
  if (!Number.isFinite(total) || total <= mostradas) return null;
  const texto = `Exibindo ${mostradas} de ${total}`;
  return sufixo ? `${texto} · ${sufixo}` : texto;
}
