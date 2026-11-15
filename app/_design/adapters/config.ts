import "server-only";
import { formatSpDateTime, formatSpTime, spDayKey } from "@/src/domain/dates";
import { listTeamCards } from "@/src/services/painel/team-cards";
import { getConfigPageData } from "@/src/services/painel/config";
import { fmtBrlPerUnit } from "@/src/domain/formato-de-resultado";
import { listActiveDeviceSessions } from "@/src/services/auth/device-sessions";
import { getCatalogPairingStatus, type RecordedStop } from "@/src/services/painel/catalog-pairing";

/**
 * Tela Config: bancas, taxonomia de mercados e fichas de times. Mutações via
 * server actions. Mock: app/_design/mock/config.ts.
 */

const PAIRING_STOP_LABELS = {
  breaker: "circuito do fornecedor aberto",
  budget: "gasto do dia acima de 60% do teto",
  failure: "falha do fornecedor",
  locked: "outra rodada já rodava",
} as const satisfies Record<RecordedStop, string>;

/** A linha de situação do pareamento dos catálogos, no card de times. */
export async function getConfigCatalogPairing(now: Date = new Date()) {
  const status = await getCatalogPairingStatus(now);
  const last = status.lastRound;
  return {
    /** Hora de São Paulo; com a data quando a rodada não é de hoje. */
    lastRound: last ? (spDayKey(last.at) === spDayKey(now) ? formatSpTime(last.at) : formatSpDateTime(last.at)) : null,
    stoppedBy: last?.stoppedBy ? PAIRING_STOP_LABELS[last.stoppedBy] : null,
    linkedToday: status.linkedToday,
    teamCards: status.teamCards,
    /** null: a fila não pôde ser lida. */
    inProgress: status.inProgress,
  };
}

export async function getConfigData(username?: string, currentSessionId?: string | null) {
  const [{ bankrolls, mercados }, teamCards, catalogPairing, sessions] = await Promise.all([
    getConfigPageData(),
    listTeamCards(),
    getConfigCatalogPairing(),
    username
      ? listActiveDeviceSessions(username, currentSessionId)
      : Promise.resolve({ sessions: [], total: 0 }),
  ]);
  return {
    bancas: bankrolls.map((b) => ({
      id: b.id,
      slug: b.slug, // imutável — chave da logo (upload/remover) e da navegação
      name: b.nome,
      sharpMode: b.sharpMode, // o selo do modo e o pré-selecionado no editar
      capturePolicy: b.capturePolicy, // idem: de onde vem a odd autoritativa
      stakePolicy: b.stakePolicy ?? "MESSAGE",
      defaultStakeUnits: b.defaultStakeUnits ?? null,
      unit: fmtBrlPerUnit(b.valorUnidade),
      unitValue: b.valorUnidade, // valor numérico p/ o form de edição
      channel: b.telegramChannelId ?? "—",
      channelRaw: b.telegramChannelId ?? "", // vazio quando sem canal (input controlado)
      logoUrl: b.logoUrl, // imagem real (ou null) — a tela mostra <img> quando existe
      betCount: b.betCount,
      channelSports: b.channelSports, // vazio = "vários/não sei"
      capturePaused: b.capturePausedAt !== null,
      pausedSince: b.capturePausedAt ? formatSpDateTime(b.capturePausedAt) : null,
      confirmedSports: b.confirmedSports.slice(0, 3),
    })),
    // dedupe por texto: a tela usa o alias como key (Chip key={a}); duas linhas
    // de MercadoAlias com o mesmo texto colidiriam.
    markets: mercados.map((m) => ({
      canon: m.nome,
      aliases: [...new Set(m.aliases.map((a) => a.alias))],
    })),
    marketCount: mercados.length,
    /** A primeira página das fichas, sem busca; as outras vêm pela action. */
    teamCards,
    catalogPairing,
    security: {
      username: username ?? "operador",
      sessionsTotal: sessions.total,
      sessions: sessions.sessions.map((session) => ({
        id: session.id,
        deviceName: session.deviceName,
        createdAt: formatSpDateTime(session.createdAt),
        lastSeenAt: formatSpDateTime(session.lastSeenAt),
        current: session.current,
      })),
    },
  };
}
