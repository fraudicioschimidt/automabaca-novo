import { instanteDaEntrada } from "./instante-da-entrada";

/**
 * Aposta que entrou com a bola rolando não tem CLV.
 *
 * CLV compara a odd cravada com a linha que FECHOU — e o fechamento acontece no
 * apito. Uma entrada ao vivo é posterior a esse instante, então a comparação
 * mede o que o jogo fez (gol, expulsão, tempo correndo), não a vantagem de
 * quem apostou. O número resultante não é ruído neutro: é enviesado, porque a
 * linha ao vivo já absorveu o placar. Misturar as duas populações puxa a
 * média de CLV do canal para baixo.
 *
 * Usa o horário original do post. Aposta digitada no painel não tem esse
 * horário: ali vale o de gravação, com a janela de jogo abaixo.
 */

export type EntradaAoVivoParams = {
  /** Quando o sistema gravou a aposta (`Bet.registradoEm`). */
  registradoEm: Date;
  /** Timestamp original da mensagem, independente do atraso de OCR/fila; null na aposta manual. */
  sourcePostedAt?: Date | null;
  /** Kickoff do evento (`Bet.data`), sempre UTC. */
  kickoff: Date;
  /** `true` = kickoff é placeholder (meia-noite SP), não um horário real. */
  kickoffInferido?: boolean | null;
  /** Placar na tip é evidência positiva de bola rolando, mesmo em backfill/edit. */
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
};

/**
 * Teto para a bola AINDA estar rolando, usado só quando não há horário da
 * origem (aposta digitada no painel). Depois disto o jogo acabou, então o
 * registro tardio é uma tip pré-jogo lançada à mão depois, não entrada ao vivo
 * — e ela tem CLV legítimo.
 *
 * Sem este teto, apostas pré-jogo lançadas depois do jogo perderiam o CLV, e o
 * gargalo do sistema é justamente o tamanho da amostra de CLV.
 *
 * 3h cobre futebol com prorrogação e pênaltis (~2h30) com folga. LIMITE
 * CONHECIDO: modalidade que passe disso — tênis de 5 sets, série Bo5 longa —
 * pode ter uma entrada ao vivo classificada como captura atrasada e manter CLV.
 * Aceito: o erro oposto (descartar amostra boa) é o mais frequente.
 *
 * Única fonte da janela; a borda é testada em `tests/identidade/entrada-ao-vivo.test.ts`.
 */
export const JANELA_DE_JOGO_MS = 3 * 60 * 60_000;

/**
 * `true` quando a aposta foi registrada com o jogo EM ANDAMENTO — depois do
 * kickoff e dentro de `JANELA_DE_JOGO_MS`.
 *
 * `kickoffInferido` derruba a resposta para `false`: ali o kickoff é um
 * placeholder de meia-noite, e comparar contra ele classificaria como "ao vivo"
 * qualquer aposta registrada durante o dia. Sem horário real não há pergunta a
 * responder — e o viés seguro é NÃO acusar.
 *
 * `sourcePostedAt` é o horário publicado pela origem, preservado em retries.
 * OCR e fila podem terminar depois do apito sem transformar a tip em ao vivo.
 * A janela de 3h vale somente para a aposta manual, que não tem esse timestamp.
 */
export function entrouAoVivo(params: EntradaAoVivoParams): boolean {
  if (params.liveScoreHome != null && params.liveScoreAway != null) return true;
  if (params.kickoffInferido) return false;
  const registro = instanteDaEntrada(params).getTime();
  const inicio = params.kickoff.getTime();
  if (!Number.isFinite(registro) || !Number.isFinite(inicio)) return false;
  // Com evidência da origem, não inferir pré-jogo pelo tempo de processamento.
  if (params.sourcePostedAt != null) return registro >= inicio;
  return registro > inicio && registro <= inicio + JANELA_DE_JOGO_MS;
}
