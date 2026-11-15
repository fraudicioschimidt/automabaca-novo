import {
  MATCH_STATISTIC_KEYS,
  resolveResultFromStatistics,
  type MatchStatisticPair,
  type MatchStatistics,
  type StatisticResolution,
} from "@/src/domain/settlement/statistics";
import { normalizeStr } from "@/src/domain/text";
import { prisma } from "@/src/infra/prisma";
import { flashscoreSportPerfil } from "@/src/providers/flashscore/sports";
import { interruptedFinishOf } from "@/src/providers/flashscore/terminal";
import {
  isNonRegulationFlashscoreSnapshot,
  jsonObject,
  regulationScoreFromSnapshot,
} from "../flashscore/observation-store";

/**
 * O que o snapshot FlashScore (`resultSnapshot`) já responde antes de gastar
 * cota de LLM: estatística resolvida deterministicamente, partida não
 * disputada e a evidência estruturada para julgar sem busca na web.
 */

export async function loadFlashscoreSnapshot(betId: string): Promise<unknown | null> {
  const result = await prisma.betResult.findUnique({
    where: { betId },
    select: { resultProvider: true, resultSnapshot: true },
  });
  return result?.resultProvider === "flashscore" ? result.resultSnapshot : null;
}

/**
 * Os dois lados na ORDEM DO EVENTO DA APOSTA, que é a ordem em que o snapshot
 * grava placar, placar regulamentar e estatísticas (`home` = 1º time da aposta,
 * mesmo quando o FlashScore o lista como visitante). Os nomes vêm do
 * `providerTeams`, na ordem do FlashScore, desvirados por `swapped`; sem o
 * `swapped` gravado não há como pôr nome no lado, e o rótulo fica genérico.
 */
export type FlashscoreBetSides = {
  first: string;
  second: string;
  /** Mandante real no FlashScore; null quando os nomes não são conhecidos. */
  providerHome: string | null;
};

export function flashscoreBetSides(resultSnapshot: unknown): FlashscoreBetSides {
  const teams = jsonObject(jsonObject(resultSnapshot)?.providerTeams);
  if (
    !teams ||
    typeof teams.home !== "string" ||
    typeof teams.away !== "string" ||
    typeof teams.swapped !== "boolean"
  ) {
    return { first: "1º time da aposta", second: "2º time da aposta", providerHome: null };
  }
  return teams.swapped
    ? { first: teams.away, second: teams.home, providerHome: teams.home }
    : { first: teams.home, second: teams.away, providerHome: teams.home };
}

function pairText(label: string, value: unknown, sides: FlashscoreBetSides): string | null {
  const pair = jsonObject(value);
  if (!pair) return null;
  const first = pair.home;
  const second = pair.away;
  if (
    (typeof first !== "number" && typeof first !== "string") ||
    (typeof second !== "number" && typeof second !== "string")
  ) {
    return null;
  }
  return `${label}: ${sides.first}=${first}, ${sides.second}=${second}`;
}

export type FlashscoreJudgeEvidence = {
  /** Texto para o prompt (sem search). */
  evidenceText: string;
  sourceUrl: string | null;
  /** O provider diz que a partida foi decidida na prorrogação ou nos pênaltis. */
  decidedAfterRegulation: boolean;
};

/**
 * Partida que NÃO foi disputada, segundo o snapshot. É um fato estruturado do
 * provider e vira VOID sem LLM: o modelo poderia devolver WON/LOST para um jogo
 * que nunca aconteceu. Também economiza a cota gratuita do Gemini, que é
 * restrição de projeto.
 */
export function flashscoreMatchNotPlayed(
  resultSnapshot: unknown,
): "cancelled" | "postponed" | null {
  const snapshot = jsonObject(resultSnapshot);
  if (!snapshot || snapshot.outcome !== "matched") return null;
  if (snapshot.cancelled === true) return "cancelled";
  if (snapshot.postponed === true) return "postponed";
  return null;
}

/**
 * O placar listado passou do tempo normal: prorrogação ou pênaltis (futebol,
 * inclusive o snapshot já recusado como `manual_extra_time`) e "After
 * Overtime" (basquete, hóquei). Fica fora de `isNonRegulationFlashscoreSnapshot`
 * porque lá ele barraria a liquidação da Money Line de basquete, que é paga
 * pelo placar com prorrogação.
 */
export function wentBeyondRegulation(snapshot: Record<string, unknown>): boolean {
  if (isNonRegulationFlashscoreSnapshot(snapshot)) return true;
  if (regulationScoreFromSnapshot(snapshot)) return true;
  return typeof snapshot.stage === "string" && /overtime/i.test(snapshot.stage);
}

/**
 * Só nos esportes em que o FlashScore afirma o fim (`modo: "flag"`) o
 * `finished: false` quer dizer "ainda não acabou"; nos inferidos ele é sempre
 * false. Snapshot sem `sportId` não diz qual é o caso.
 */
function sportFlagsFinish(snapshot: Record<string, unknown>): boolean {
  return typeof snapshot.sportId === "number" && flashscoreSportPerfil(snapshot.sportId)?.modo === "flag";
}

function positiveCount(value: unknown): boolean {
  return typeof value === "number" && value > 0;
}

/**
 * Por que o snapshot proíbe o IA-Judge de liquidar SOZINHO: o FlashScore viu
 * prorrogação, jogo interrompido ou jogo que ainda não terminou (atrasado,
 * adiado dentro da graça), e é exatamente aí que o placar da busca na web
 * (quase sempre o final com prorrogação, ou o de outro jogo) paga a aposta
 * errada. A sugestão continua sendo criada, para homologação.
 */
export function flashscoreAutoSettleBlocker(
  resultSnapshot: unknown,
): "extra_time" | "interrupted" | "not_finished" | null {
  const snapshot = jsonObject(resultSnapshot);
  if (!snapshot) return null;
  if (snapshot.ticket === true) {
    if (positiveCount(snapshot.interrupted)) return "interrupted";
    if (positiveCount(snapshot.extraTimeBlocked)) return "extra_time";
    // Perna que o FlashScore nem casou (`unfinished` sem `live`) é o caso do
    // fallback: o juiz liquida.
    if (positiveCount(snapshot.postponedWaiting)) return "not_finished";
    if (positiveCount(snapshot.live) && sportFlagsFinish(snapshot)) return "not_finished";
    return null;
  }
  if (snapshot.outcome !== "matched") return null;
  if (typeof snapshot.stage === "string" && interruptedFinishOf(snapshot.stage)) return "interrupted";
  if (wentBeyondRegulation(snapshot)) return "extra_time";
  const notPlayed = snapshot.cancelled === true || snapshot.postponed === true;
  return !notPlayed && snapshot.finished !== true && sportFlagsFinish(snapshot) ? "not_finished" : null;
}

/** Placar com o nome de cada lado junto do número: "Time A 2 x 1 Time B". */
function scoreText(value: unknown, sides: FlashscoreBetSides): string | null {
  const pair = jsonObject(value);
  return pair && Number.isInteger(pair.home) && Number.isInteger(pair.away)
    ? `${sides.first} ${pair.home} x ${pair.away} ${sides.second}`
    : null;
}

/**
 * Fatos do FlashScore que o juiz precisa saber em QUALQUER caminho, inclusive
 * na busca na web: sem eles, o modelo lê o placar final da página e liquida um
 * mercado de tempo normal (escanteios de 90', 1X2) pelo jogo com prorrogação.
 */
const TICKET_FACTS: Record<NonNullable<ReturnType<typeof flashscoreAutoSettleBlocker>>, string> = {
  interrupted: "Fato do FlashScore: ao menos um jogo desta múltipla não foi jogado até o fim (abandono, W.O. ou resultado decidido fora de campo).",
  extra_time: "Fato do FlashScore: ao menos um jogo desta múltipla foi à prorrogação ou aos pênaltis; o placar final não é o do tempo regulamentar.",
  not_finished: "Fato do FlashScore: ao menos um jogo desta múltipla ainda não terminou ou está adiado.",
};

export function flashscoreJudgeFacts(resultSnapshot: unknown): string[] {
  const snapshot = jsonObject(resultSnapshot);
  const blocker = flashscoreAutoSettleBlocker(resultSnapshot);
  if (!snapshot || !blocker) return [];
  if (snapshot.ticket === true) return [TICKET_FACTS[blocker]];
  const stage = typeof snapshot.stage === "string" ? ` (estágio "${snapshot.stage}")` : "";
  const sides = flashscoreBetSides(snapshot);
  const listed = scoreText(snapshot.score, sides);
  if (blocker === "not_finished") {
    const details = [
      ...(typeof snapshot.stage === "string" ? [`estágio "${snapshot.stage}"`] : []),
      ...(typeof snapshot.providerKickoff === "string" ? [`início no FlashScore: ${snapshot.providerKickoff}`] : []),
    ];
    return [
      `Fato do FlashScore: a partida ainda não terminou${details.length > 0 ? ` (${details.join("; ")})` : ""}.` +
        (listed ? ` Placar listado até agora: ${listed}.` : ""),
    ];
  }
  if (blocker === "interrupted") {
    return [
      `Fato do FlashScore: a partida não foi jogada até o fim${stage}.` +
        (listed ? ` Placar no momento da interrupção: ${listed}.` : ""),
    ];
  }
  const regulation = regulationScoreFromSnapshot(snapshot);
  return [
    `Fato do FlashScore: houve prorrogação${stage}.` +
      (listed ? ` Placar listado, com prorrogação: ${listed}.` : "") +
      ` Placar do tempo regulamentar: ${scoreText(regulation, sides) ?? "não disponível no FlashScore"}.`,
  ];
}

/**
 * Extrai placar/stats utilizáveis do snapshot FlashScore. Null se não houver
 * evidência estruturada suficiente para julgar o mercado sem web.
 */
export function extractFlashscoreJudgeEvidence(
  resultSnapshot: unknown,
): FlashscoreJudgeEvidence | null {
  const snapshot = jsonObject(resultSnapshot);
  if (!snapshot || snapshot.outcome !== "matched") return null;
  const notPlayed = flashscoreMatchNotPlayed(resultSnapshot);
  // Fato do provider, sem conclusão: adiada ainda pode ser remarcada dentro da
  // graça, e a regra do juiz decide o que cada estado significa.
  if (notPlayed) {
    return {
      evidenceText: notPlayed === "cancelled"
        ? "FlashScore: partida cancelada (cancelled)."
        : "FlashScore: partida adiada (postponed); pode ser remarcada.",
      sourceUrl: null,
      decidedAfterRegulation: false,
    };
  }

  const lines: string[] = ["Evidência estruturada FlashScore (sem busca web):"];
  let usable = false;

  // Times, placar e estatísticas saem todos na ordem do evento da aposta; o
  // mandante real só aparece como informação, para não inverter os lados.
  const sides = flashscoreBetSides(snapshot);
  if (sides.providerHome !== null) {
    lines.push(`Times, na ordem do evento da aposta: ${sides.first} x ${sides.second} (mandante no FlashScore: ${sides.providerHome})`);
  }
  if (typeof snapshot.providerKickoff === "string") {
    lines.push(`Kickoff provider: ${snapshot.providerKickoff}`);
  }
  // Prorrogação e jogo interrompido: o placar e as estatísticas listados não
  // são os do tempo regulamentar completo; só entram rotulados, pelos fatos.
  const blocker = flashscoreAutoSettleBlocker(snapshot);
  const nonRegulation = blocker !== null;
  if (snapshot.finished === true) {
    lines.push(blocker === "extra_time" ? "Status: partida finalizada depois do tempo regulamentar (prorrogação ou pênaltis)" : "Status: partida finalizada");
  }
  lines.push(...flashscoreJudgeFacts(snapshot));

  const regulationScore = regulationScoreFromSnapshot(snapshot);
  const score = nonRegulation ? null : jsonObject(snapshot.score);
  const regulationText = scoreText(regulationScore, sides);
  const scoreLine = scoreText(score, sides);
  if (regulationText) {
    lines.push(`Placar regulamentar: ${regulationText}`);
    usable = true;
  } else if (scoreLine) {
    lines.push(`Placar: ${scoreLine}`);
    usable = true;
  }

  // O provider não separa as estatísticas dos 90 minutos quando a partida vai
  // à prorrogação. Mesmo com o placar regulamentar reconstruído, esses totais
  // continuam ambíguos e não podem alimentar uma decisão financeira.
  const stats = nonRegulation ? null : jsonObject(snapshot.stats);
  if (stats) {
    for (const [key, label] of [
      ["corners", "Escanteios"],
      ["yellowCards", "Cartões amarelos"],
      ["redCards", "Cartões vermelhos"],
    ] as const) {
      const text = pairText(label, stats[key], sides);
      if (text) {
        lines.push(text);
        usable = true;
      }
    }
    // Contagem asiática interna: amarelo=1, vermelho=2 (não booking POINTS).
    const yellow = jsonObject(stats.yellowCards);
    const red = jsonObject(stats.redCards);
    if (
      yellow &&
      typeof yellow.home === "number" &&
      typeof yellow.away === "number"
    ) {
      const rh = typeof red?.home === "number" ? red.home : 0;
      const ra = typeof red?.away === "number" ? red.away : 0;
      lines.push(
        `Pontos de cartões (amarelo=1, vermelho=2): ${sides.first}=${yellow.home + 2 * rh}, ${sides.second}=${yellow.away + 2 * ra}`,
      );
      usable = true;
    }
  }

  if (!usable) return null;
  return { evidenceText: lines.join("\n"), sourceUrl: null, decidedAfterRegulation: blocker === "extra_time" };
}

function numericStat(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value)) return value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return null;
    const parsed = Number(trimmed.replaceAll(",", "."));
    return Number.isFinite(parsed) && parsed >= 0 && Number.isInteger(parsed) ? parsed : null;
  }
  return null;
}

function pair(value: unknown): MatchStatisticPair | null {
  const o = jsonObject(value);
  if (!o) return null;
  const home = numericStat(o.home);
  const away = numericStat(o.away);
  if (home == null || away == null) return null;
  return { home, away };
}

/**
 * Período do bloco de estatísticas GRAVADO no snapshot. `null` quando a linha é
 * anterior ao campo — e aí ninguém adivinha.
 */
function periodoDoSnapshot(resultSnapshot: unknown): "FT" | "HT" | "SECOND_HALF" | null {
  const snapshot = jsonObject(resultSnapshot);
  const valor = snapshot?.statsPeriod;
  return valor === "FT" || valor === "HT" || valor === "SECOND_HALF" ? valor : null;
}

/** Extrai stats do snapshot FlashScore matched; null se incompleto/ausente. */
export function matchStatisticsFromFlashscoreSnapshot(
  resultSnapshot: unknown,
): MatchStatistics | null {
  const snapshot = jsonObject(resultSnapshot);
  if (!snapshot || snapshot.outcome !== "matched") return null;
  if (snapshot.cancelled === true || snapshot.postponed === true) return null;
  // O bloco geral de estatísticas pode incluir a prorrogação, ou parar na
  // interrupção. Sem separação por período, não há base segura para 90'.
  if (flashscoreAutoSettleBlocker(snapshot)) return null;
  const stats = jsonObject(snapshot.stats);
  if (!stats) return null;
  // Lê por CHAVE conhecida: snapshot antigo simplesmente não traz as famílias
  // novas, e chave ausente continua sendo `null` (nunca zero).
  const lidas: MatchStatistics = {};
  let algumaPresente = false;
  for (const chave of MATCH_STATISTIC_KEYS) {
    const valor = pair(stats[chave]);
    lidas[chave] = valor;
    if (valor) algumaPresente = true;
  }
  return algumaPresente ? lidas : null;
}

export function tryResolveFromFlashscoreStats(params: {
  mercado: string;
  selecao: string;
  evento: string;
  odds: number;
  stake: number;
  resultSnapshot: unknown;
}): StatisticResolution | null {
  const snapshotStats = matchStatisticsFromFlashscoreSnapshot(params.resultSnapshot);
  if (!snapshotStats) return null;
  const explicitlyRedCards = /\b(?:red\s+cards?|cart(?:ao|oes)\s+vermelhos?)\b/.test(
    normalizeStr(`${params.mercado} ${params.selecao}`),
  );
  // Ausência de amarelos não equivale a zero num total genérico de bookings.
  // A exceção segura é o mercado que declara cartões vermelhos: nele a linha
  // vermelha do snapshot é a própria evidência pedida e amarelos não participam.
  const stats = explicitlyRedCards && !snapshotStats.yellowCards && snapshotStats.redCards
    ? { ...snapshotStats, yellowCards: { home: 0, away: 0 } }
    : snapshotStats;
  // O período vem do SNAPSHOT, nunca do mercado da aposta: derivá-lo de
  // `marketPeriodOf(mercado)` liquidaria, num snapshot sem `statsPeriod`, uma
  // linha de HT contra escanteios do jogo inteiro. Sem o campo vale o default
  // "FT": mercado parcial é recusado com `wrong_period` e cai para o
  // LLM/operador, que é o lado seguro.
  const statsPeriod = periodoDoSnapshot(params.resultSnapshot);
  return resolveResultFromStatistics({
    mercado: params.mercado,
    selecao: params.selecao,
    evento: params.evento,
    odds: params.odds,
    stake: params.stake,
    stats,
    ...(statsPeriod ? { statsPeriod } : {}),
  });
}
