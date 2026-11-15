import { formatSpDateTime } from "./dates";

/** A evidência de outro esporte que segurou a confirmação automática. */
export type DiscordanciaDeEsporte = {
  sport: string;
  confidence: number;
  source: string;
  provider?: string;
  strategy?: string;
};

const FONTE_POR_PROVEDOR: Partial<Record<string, string>> = {
  flashscore: "o FlashScore",
  pinnacle17: "a Pinnacle17",
  bridgeodds: "a BridgeOdds",
  web: "a busca na web",
  team_identity: "a identidade dos times",
};

/** Por origem gravada (`SportResolutionSource`): o candidato sem provedor e o esporte da aposta. */
const FONTE_POR_ORIGEM: Partial<Record<string, string>> = {
  TEXT: "o texto do post",
  EMOJI: "o emoji do post",
  COMPETITION: "a competição do post",
  LLM: "a leitura da IA",
  CHANNEL: "os esportes do canal",
  TEAM_ID: "a identidade dos times",
  PROVIDER: "um fornecedor",
  WEB: "a busca na web",
  MANUAL: "você",
};

/**
 * Quem apontou o esporte, em prosa: a fonte do candidato, a leitura do post
 * ou quem decidiu o esporte da aposta. Null quando a origem não diz.
 */
export function fonteDoEsporte(item: { source?: string | null; provider?: string; strategy?: string }): string | null {
  return FONTE_POR_PROVEDOR[item.provider ?? ""] ?? FONTE_POR_ORIGEM[item.source ?? ""] ?? null;
}

function discordancia(evidence: object): DiscordanciaDeEsporte | null {
  const dissent = "dissent" in evidence ? evidence.dissent : null;
  if (!dissent || typeof dissent !== "object") return null;
  const { sport, confidence, source, provider, strategy } = dissent as Record<string, unknown>;
  if (typeof sport !== "string" || typeof confidence !== "number" || typeof source !== "string") return null;
  return {
    sport, confidence, source,
    ...(typeof provider === "string" ? { provider } : {}),
    ...(typeof strategy === "string" ? { strategy } : {}),
  };
}

const SEM_DETALHE_DA_WEB = "a busca na web não acrescentou competição, país nem horário ao que a aposta já dizia";

/**
 * Por que o automático não confirmou, para a caixa de ações: a espera do
 * fornecedor, quem discordou ou a web sem detalhe. Null quando a evidência
 * não diz.
 */
export function sportPendingMessage(evidence: unknown): string | null {
  if (!evidence || typeof evidence !== "object" || !("reason" in evidence)) return null;
  const { reason } = evidence;
  if (reason === "outside_provider_window" || reason === "provider_capacity") {
    const retryAt = "retryAt" in evidence && typeof evidence.retryAt === "string" ? new Date(evidence.retryAt) : null;
    const next = retryAt && Number.isFinite(retryAt.getTime()) ? ` Nova tentativa em ${formatSpDateTime(retryAt)}.` : "";
    return (reason === "outside_provider_window"
      ? "Aguardando a abertura da agenda do fornecedor."
      : "Aguardando capacidade do fornecedor.") + next;
  }
  if (reason === "web_without_detail") return `A busca achou o jogo, mas ${SEM_DETALHE_DA_WEB}.`;
  if (reason === "outside_channel_sports") return "A busca achou o jogo num esporte fora dos marcados no canal.";
  const dissent = discordancia(evidence);
  if (!dissent) return null;
  const aponta = `${fonteDoEsporte(dissent) ?? "outra fonte"} aponta ${dissent.sport} (${dissent.confidence}%)`;
  if (reason === "candidate_dissent") return `A busca achou o jogo, mas ${aponta}: o automático espera mais evidência.`;
  if (reason === "post_dissent") return `A busca achou o jogo, mas ${aponta}.`;
  if (reason === "strong_candidates_disagree") return `As fontes discordam: ${aponta}.`;
  return null;
}

/** O que a busca achou, para o dono decidir sem abrir o painel para investigar. */
export type EsporteCandidatoResumo = {
  sport: string;
  confidence: number;
  source: string;
  competition?: string | null;
  country?: string | null;
  kickoffIso?: string;
};

/** "Basketball · Chile · LNB · início 24/07 21:30": o melhor candidato, sem inventar detalhe. */
function oQueAchou(melhor: EsporteCandidatoResumo): string {
  const detalhes = [melhor.sport, melhor.country, melhor.competition]
    .filter((parte): parte is string => typeof parte === "string" && parte.trim() !== "")
    .join(" · ");
  const inicio = melhor.kickoffIso && Number.isFinite(new Date(melhor.kickoffIso).getTime())
    ? ` · início ${formatSpDateTime(new Date(melhor.kickoffIso))}`
    : "";
  return `${detalhes}${inicio}`;
}

function maisConfiante(candidates: readonly EsporteCandidatoResumo[]): EsporteCandidatoResumo | undefined {
  return [...candidates].sort((a, b) => b.confidence - a.confidence)[0];
}

/**
 * Aviso de conflito do resolvedor, na hora: ele não se resolve sozinho, e o
 * CLV depende de o dono decidir antes do jogo. Diz o que a busca achou e quem
 * discorda.
 */
export function mensagemConflitoDeEsporte(params: {
  evento: string;
  /** Os candidatos que votam: sem os desmentidos. */
  candidates: readonly EsporteCandidatoResumo[];
  reason?: string;
  dissent?: DiscordanciaDeEsporte;
}): string {
  const melhor = maisConfiante(params.candidates);
  const motivo = params.dissent
    ? `Mas ${fonteDoEsporte(params.dissent) ?? "outra fonte"} aponta ${params.dissent.sport} (${params.dissent.confidence}%).`
    : params.reason === "outside_channel_sports"
      ? "Mas o esporte está fora dos marcados no canal."
      : "As fontes discordam.";
  return [
    `⚠️ Esporte em conflito · ${params.evento}`,
    melhor ? `A busca achou: ${oQueAchou(melhor)}` : null,
    motivo,
    "👉 Confirme o esporte na caixa de ações do painel.",
  ].filter(Boolean).join("\n");
}

/**
 * Aviso de esporte não confirmado, quando as tentativas automáticas acabam.
 * Abaixo do limiar, com outro esporte na evidência ou com a web sem detalhe,
 * a aposta ficaria esperando em silêncio na caixa de ações. A trava continua
 * (esporte errado contamina CLV e liquidação); o aviso faz o dono saber na
 * hora, com a evidência e o motivo junto.
 */
export function mensagemEsportePendente(params: {
  evento: string;
  /** Os candidatos que votam: sem os desmentidos. */
  candidates: readonly EsporteCandidatoResumo[];
  limiar: number;
  reason?: string;
  dissent?: DiscordanciaDeEsporte;
}): string {
  const melhor = maisConfiante(params.candidates);
  const cabecalho = `❓ Esporte a confirmar · ${params.evento}`;
  if (!melhor) {
    return `${cabecalho}\nNenhuma fonte achou este jogo.\n👉 Confirme o esporte na caixa de ações do painel.`;
  }
  const motivo = params.dissent
    ? `mas ${fonteDoEsporte(params.dissent) ?? "outra fonte"} aponta ${params.dissent.sport} (${params.dissent.confidence}%)`
    : params.reason === "web_without_detail"
      ? `mas ${SEM_DETALHE_DA_WEB}`
      : `e o automático só confirma a partir de ${params.limiar}%`;
  return `${cabecalho}\nA busca achou: ${oQueAchou(melhor)}\n`
    + `Certeza de ${melhor.confidence}%, ${motivo}.\n`
    + "👉 Confirme o esporte na caixa de ações do painel.";
}
