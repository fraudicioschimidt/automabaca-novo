import type { LiveScoreAtTip } from "@/src/domain/live-score-at-tip";
import type { CanonicalSport } from "@/src/domain/sports/registry";
import type { SportResolutionSource } from "@/src/domain/sports/detect";

export type SportCandidate = {
  sport: CanonicalSport;
  confidence: number;
  source: SportResolutionSource;
  provider?:
    | "bridgeodds"
    | "flashscore"
    | "pinnacle17"
    | "web"
    | "team_identity";
  matchId?: string;
  home?: string;
  away?: string;
  homeTeamId?: string | null;
  awayTeamId?: string | null;
  swapped?: boolean;
  kickoffIso?: string;
  competition?: string | null;
  country?: string | null;
  strategy?: string;
};

/** Um esporte que a leitura do post apontou (texto, emoji, competição, IA). */
export type SportSignal = { sport: CanonicalSport; confidence: number; source: string };

/** A evidência de outro esporte que segurou a confirmação. */
export type SportDissent = {
  sport: CanonicalSport;
  confidence: number;
  source: string;
  provider?: SportCandidate["provider"];
  strategy?: string;
  /** Veio da leitura do post, e não de um candidato. */
  fromPost: boolean;
};

/** O que a confirmação do esporte grava na aposta junto com ele. */
export type SportConfirmationIdentity = { data: Date; kickoffInferido: boolean; competicao: string; pais: string };

export type SportResolutionRun = {
  betId: string;
  status: "resolved" | "pending" | "conflict" | "ignored" | "evaluated";
  candidate: SportCandidate | null;
  candidates: SportCandidate[];
  reason: string;
  /** Quem discordou, quando foi isso que segurou a confirmação. */
  dissent?: SportDissent;
  /** Na execução forçada, a discordância da leitura do post que não segurou. */
  overriddenPostDissent?: SportDissent;
  /** Na simulação que confirmaria: a revisão lida e o que seria gravado. */
  expectedVersion?: number;
  identity?: SportConfirmationIdentity;
  retryAt?: Date;
  /** Quando abre a próxima vez da busca web, contada do kickoff. */
  nextWebSearchAt?: Date;
  bridgeCursor?: SportBridgeCursor;
};

export type SportBridgeCursor = { sport: CanonicalSport; searchAt: number };
export type SportSearchOptions = {
  now?: Date;
  /** Esportes que a leitura do post apontou; desmentem a identidade local. */
  postSports?: readonly CanonicalSport[];
  /** Placares do jogo lidos do post (`postScores`); fora da escala, desmentem a identidade local. */
  postScores?: readonly LiveScoreAtTip[];
  /**
   * Mercado e seleção como a leitura do post os escreveu: o registro
   * normaliza "Handicap de Pontos" para "Asian Handicap", e a unidade só fica aqui.
   */
  readTerms?: { mercado: string; selecao: string };
  bridgeCursor?: SportBridgeCursor;
  onBridgeDeferred?: (cursor: SportBridgeCursor, retryAt: Date) => void;
};
