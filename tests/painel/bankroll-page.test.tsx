import { beforeEach, describe, expect, it, vi } from "vitest";
import { BANKROLL_MOCK_DATA } from "@/app/_design/mock/bankroll-data";

const mocks = vi.hoisted(() => ({ data: vi.fn() }));
vi.mock("@/app/_lib/theme-mode", () => ({ themeMode: async () => "light" }));
vi.mock("@/app/(painel)/_mock", () => ({ mockFixture: async () => null }));
vi.mock("@/app/(painel)/_auth", () => ({ canManage: async () => true }));
vi.mock("@/app/_design/adapters/bankroll", () => ({ getBankrollData: mocks.data }));
vi.mock("@/app/(painel)/tipsters/[slug]/actions", () => ({
  buscarFechamentoAction: vi.fn(), exportBankrollCsvAction: vi.fn(), settleBetAction: vi.fn(), updateBankrollSharpModeAction: vi.fn(),
}));
vi.mock("@/app/(painel)/tipsters/[slug]/manual-actions", () => ({
  deleteBetAction: vi.fn(), previewBetRemovalAction: vi.fn(), registerManualBetAction: vi.fn(), removeBetsAction: vi.fn(), restoreBetsAction: vi.fn(),
}));
vi.mock("@/app/(painel)/tipsters/[slug]/BankrollClient", () => ({ BankrollClient: () => null }));
import BankrollDetailPage from "@/app/(painel)/tipsters/[slug]/page";

async function renderPage() {
  const element = await BankrollDetailPage({ params: Promise.resolve({ slug: "main" }), searchParams: Promise.resolve({}) });
  return element.props as { emptyState: boolean };
}

beforeEach(() => vi.resetAllMocks());

describe("página da banca", () => {
  it("banca sem aposta nenhuma mostra o estado de banca nova", async () => {
    mocks.data.mockResolvedValue({ ...BANKROLL_MOCK_DATA, BETS: [], historyTotal: 0, removed: { total: 0, bets: [] } });
    expect((await renderPage()).emptyState).toBe(true);
  });

  it("banca que só tem removidas mostra a lista, onde fica a aba Removidas com o Restaurar", async () => {
    mocks.data.mockResolvedValue({ ...BANKROLL_MOCK_DATA, BETS: [], historyTotal: 0 });
    expect((await renderPage()).emptyState).toBe(false);
  });
});
