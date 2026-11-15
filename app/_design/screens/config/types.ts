import type { getConfigData } from "../../adapters/config";
import type { ConfigActions } from "../../action-contracts";

export type ConfigData = Awaited<ReturnType<typeof getConfigData>>;

type EditBancaInput = Parameters<NonNullable<ConfigActions["onEditBanca"]>>[0];
export type SharpMode = EditBancaInput["sharpMode"];
export type CapturePolicy = EditBancaInput["capturePolicy"];
export type StakePolicy = NonNullable<EditBancaInput["stakePolicy"]>;

type BancaData = ConfigData["bancas"][number];
/** Banca na lista local: a criada na tela ainda não tem política de stake, apostas nem histórico. */
export type Banca = Omit<BancaData, "stakePolicy" | "defaultStakeUnits" | "betCount" | "channelSports" | "capturePaused" | "pausedSince" | "confirmedSports"> & {
  stakePolicy?: StakePolicy;
  defaultStakeUnits?: number | string | null;
  betCount?: number;
  channelSports?: string[];
  capturePaused?: boolean;
  pausedSince?: string | null;
  confirmedSports?: Array<{ sport: string; bets: number }>;
};

/** Campos do modal de edição, como o operador os digita. */
export type BancaForm = {
  name?: string;
  unit?: string;
  channel?: string;
  sharpMode?: SharpMode;
  capturePolicy?: CapturePolicy;
  stakePolicy?: StakePolicy;
  defaultStakeUnits?: string;
  logoUrl?: string | null;
  /** Vazio = "vários/não sei". */
  channelSports?: string[];
  capturePaused?: boolean;
};

export type BancaOverlay = { kind: "editBanca" | "removeBanca"; banca: Banca };

export type Market = ConfigData["markets"][number];

export type TeamCardsPage = ConfigData["teamCards"];
export type TeamCard = TeamCardsPage["cards"][number];
export type TipsterName = TeamCard["tipsterNames"][number];
