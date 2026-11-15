import type { AnalyzerQuery } from "@/src/domain/analyzer-query";
import type { getAnalyzerData } from "./adapters/analyzer";
import type { getBankrollData } from "./adapters/bankroll";
import type { getBankrollsData } from "./adapters/bankrolls";
import type { getConfigData } from "./adapters/config";
import type { getDashboardData } from "./adapters/dashboard";
import type { MonitoramentoData } from "./adapters/operacoes";
import type { getToolsData } from "./adapters/tools";
import type {
  ApostaActions,
  ApostaData,
  BankrollActions,
  ConfigActions,
  ContaActions,
  ContasData,
  MonitoramentoActions,
  OperacoesActions,
  OperacoesData,
} from "./action-contracts";
import type { TrilhaDaAposta } from "@/src/services/painel/aposta/trilha";
import type { BetRemovalView, CapturaDaFicha, SettlementCard } from "./adapters/aposta";

export type DashboardScreenProps = {
  data: Awaited<ReturnType<typeof getDashboardData>>;
  /** Avança a última visita depois de o resumo aparecer; ausente no mock. */
  onMarkVisit?: ((readAt: string) => Promise<unknown>) | null;
};
export type BankrollsScreenProps = { data: Awaited<ReturnType<typeof getBankrollsData>> };
export type FerramentasScreenProps = { data: Awaited<ReturnType<typeof getToolsData>> };
export type ApostaScreenProps = ApostaActions & {
  bet: NonNullable<ApostaData>;
  trilha?: TrilhaDaAposta | null;
  /** O post de origem: texto, leitura e link. */
  captura?: CapturaDaFicha | null;
  /** Quem liquidou e com que prova; null na pendente e na removida. */
  settlement?: SettlementCard | null;
  /** Aposta removida: a ficha fica só de leitura, com o "Restaurar". */
  removal?: BetRemovalView | null;
};
type AnalyzerData = NonNullable<Awaited<ReturnType<typeof getAnalyzerData>>>;
/** Sem `query`, a tela filtra o período localmente (fixture de desenvolvimento). */
export type AnalyzerFixtureData = Omit<AnalyzerData, "query" | "largeHistory"> & { query?: undefined; largeHistory?: null };

export type AnalyzerScreenProps = {
  data?: AnalyzerData | AnalyzerFixtureData | null;
  onQueryChange?: ((change: Partial<AnalyzerQuery>) => void) | null;
  queryPending?: boolean;
  slug?: string | null;
  bkId?: string | null;
};
export type BankrollScreenProps = BankrollActions & {
  data?: NonNullable<Awaited<ReturnType<typeof getBankrollData>>> | null;
  canManage?: boolean;
  emptyState?: boolean;
};
export type ConfigScreenProps = ConfigActions & {
  data: Awaited<ReturnType<typeof getConfigData>>;
  canManage?: boolean;
};
export type ContasScreenProps = ContaActions & {
  data: ContasData;
  canManage?: boolean;
  accId?: string | null;
  onRefresh?: (() => void) | null;
};
export type OperacoesScreenProps = OperacoesActions & {
  data: OperacoesData;
  canManage?: boolean;
};
export type MonitoramentoScreenProps = MonitoramentoActions & { data: MonitoramentoData };
