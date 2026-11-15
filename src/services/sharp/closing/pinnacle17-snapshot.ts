import { writeClosingOnce } from "@/src/services/sharp/closing-guard";
import { entrouAoVivo } from "@/src/domain/entrada-ao-vivo";
import type { NoOddsReason } from "@/src/domain/no-odds-reason";
import { ticketFixtureEventos } from "@/src/domain/settlement/ticket-resolution";
import { createLogger } from "@/src/infra/logger";
import { marketHasNoSharpReference, oddsProviders } from "@/src/providers/coverage";
import { closeSeriesAfterKickoff } from "./series";

const log = createLogger("closing-snapshot");

export type SnapshotBet = {
  id: string;
  evento: string;
  esporte: string;
  mercado: string;
  selecao: string;
  /** Pernas da múltipla, quando a aposta é uma. */
  legsJson?: unknown;
  odds: unknown;
  data: Date;
  /** Entrada pós-kickoff não tem CLV (`entrouAoVivo`). */
  registradoEm: Date;
  sourcePostedAt?: Date | null;
  /** Horário provisório (meia-noite SP): ainda não congela o fechamento. */
  kickoffInferido?: boolean;
  liveScoreHome?: number | null;
  liveScoreAway?: number | null;
  sharp: {
    provider: string | null;
    providerMatchId: string | null;
    priceReference?: string | null;
  } | null;
  closing: {
    fetchedAt: Date | null;
    closingOdd: unknown;
  } | null;
};

/**
 * Por que a aposta que a série não mede congela sem preço: a múltipla não tem
 * um fechamento só, o mercado sem referência sharp não tem CLV, e o mercado
 * que a Pinnacle17 não precifica é falta do fornecedor. O que sobra (fixture
 * sem id, provider que não é a Pinnacle17) é captura que não aconteceu.
 */
function unmeasuredReason(bet: SnapshotBet): NoOddsReason {
  if (bet.legsJson != null || bet.evento.includes(" | ") || ticketFixtureEventos(bet).length > 0) return "multipla";
  if (marketHasNoSharpReference(bet)) return "sem_referencia_sharp";
  if (!oddsProviders(bet).includes("pinnacle17")) return "unsupported_market";
  return "kickoff_sem_captura";
}

/**
 * Fechamento fora da Bridge, depois do kickoff. O preço da Pinnacle17 vem só
 * da série de fechamento (`series.ts`), que aqui congela; ficam aqui as saídas
 * sem preço: entrada ao vivo, e aposta que a série não mede (múltipla, prop,
 * mercado sem cobertura, fixture sem id), que congela no kickoff sem CLV
 * confiável e com o motivo dela.
 */
export async function snapshotClosingForBet(
  bet: SnapshotBet,
  now: Date,
): Promise<{ closed: boolean }> {
  // Kickoff ainda provisório (meia-noite SP): a hora real pode estar horas à
  // frente e congelar agora mataria a janela.
  if (bet.kickoffInferido) {
    log.debug({ betId: bet.id }, "kickoffInferido — snapshot adiado");
    return { closed: false };
  }

  // Entrada ao vivo não tem CLV: a "linha atual" ali já é in-play.
  if (entrouAoVivo({
    registradoEm: bet.registradoEm,
    sourcePostedAt: bet.sourcePostedAt,
    kickoff: bet.data,
    kickoffInferido: bet.kickoffInferido,
    liveScoreHome: bet.liveScoreHome,
    liveScoreAway: bet.liveScoreAway,
  })) {
    const won = await writeClosingOnce(bet, "fetchedAt", {
      fetchedAt: now,
      clvReliable: false,
      noOddsReason: "aposta_ao_vivo",
    });
    if (won) log.info({ betId: bet.id }, "entrada ao vivo — sem CLV");
    return { closed: won };
  }

  if (bet.sharp?.provider === "pinnacle17") {
    const series = await closeSeriesAfterKickoff(bet, now);
    if (series) return series;
  }

  if (now < bet.data) return { closed: false };
  // Race-guard cron × manual: só congela quem encontrar `fetchedAt` null. Um
  // preço gravado antes de a aposta sair da série fica como estava.
  const hasPrice = bet.closing?.closingOdd != null;
  const reason = hasPrice ? null : unmeasuredReason(bet);
  const won = await writeClosingOnce(bet, "fetchedAt", {
    fetchedAt: now,
    ...(reason ? { clvReliable: false, noOddsReason: reason } : {}),
  });
  if (won && reason) log.info({ betId: bet.id, provider: bet.sharp?.provider ?? null, reason }, "kickoff passou sem preço — clvReliable=false");
  return { closed: won };
}
