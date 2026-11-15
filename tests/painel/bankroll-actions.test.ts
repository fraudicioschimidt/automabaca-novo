import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireSession: vi.fn(), bankroll: vi.fn(), exportRows: vi.fn(), closing: vi.fn(), edit: vi.fn(), revalidate: vi.fn(),
}));
// `actor()`/`requireSession()` lançam sem sessão, como os reais.
vi.mock("@/app/(painel)/_auth", () => ({ actor: mocks.session, requireSession: mocks.requireSession }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-correlation-id": "http_banca" }) }));
vi.mock("@/src/services/painel/queries/bankrolls", () => ({
  getBankrollBySlug: mocks.bankroll,
  fetchAllBankrollBetsForExport: mocks.exportRows,
}));
vi.mock("@/src/services/sharp/closing/sync", () => ({ runClosingSyncOnce: mocks.closing }));
vi.mock("@/src/services/bankrolls/manage", () => ({ editarBankroll: mocks.edit }));
vi.mock("@/src/services/ops/telemetry", () => ({ observeAction: (_name: string, run: () => Promise<unknown>) => run() }));

import {
  buscarFechamentoAction,
  exportBankrollCsvAction,
  updateBankrollSharpModeAction,
} from "@/app/(painel)/tipsters/[slug]/actions";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue("operador");
  mocks.requireSession.mockResolvedValue(undefined);
  mocks.bankroll.mockResolvedValue({ id: "bankroll", nome: "Canal", slug: "canal", sharpMode: "CLV_ONLY" });
  mocks.exportRows.mockResolvedValue([]);
  mocks.closing.mockResolvedValue({ processed: 2, closed: 1, failures: 0, adiadas: 1 });
});

describe("ações da banca devolvem a recusa como resultado", () => {
  it("fechamento, exportação e modo sharp de banca que sumiu voltam com a mensagem, sem efeito", async () => {
    mocks.bankroll.mockResolvedValue(null);
    const recusa = { ok: false, erro: 'Tipster "canal" não encontrado.' };
    await expect(buscarFechamentoAction("canal")).resolves.toEqual(recusa);
    await expect(exportBankrollCsvAction("canal")).resolves.toEqual(recusa);
    await expect(updateBankrollSharpModeAction("canal", "OFF")).resolves.toEqual(recusa);
    expect(mocks.closing).not.toHaveBeenCalled();
    expect(mocks.exportRows).not.toHaveBeenCalled();
    expect(mocks.edit).not.toHaveBeenCalled();
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("o que a ação devolve vai junto do ok", async () => {
    await expect(buscarFechamentoAction("canal")).resolves.toEqual({ ok: true, processed: 2, closed: 1, failures: 0, adiadas: 1 });
    await expect(updateBankrollSharpModeAction("canal", "OFF")).resolves.toEqual({ ok: true });
    expect(mocks.edit).toHaveBeenCalledWith("bankroll", { sharpMode: "OFF" }, "operador");
    await expect(exportBankrollCsvAction("canal")).resolves.toMatchObject({ ok: true, count: 0, filename: "canal-apostas.csv" });
  });

  it("export acima do teto chega com o motivo", async () => {
    mocks.exportRows.mockRejectedValueOnce(new RecusaDeNegocioError("Export excede o limite de 50.000 apostas. Filtre por período no analyzer antes de exportar."));
    await expect(exportBankrollCsvAction("canal")).resolves.toEqual({
      ok: false, erro: "Export excede o limite de 50.000 apostas. Filtre por período no analyzer antes de exportar.",
    });
  });

  it("slug ou modo forjado é defeito do cliente: erro, antes de consultar", async () => {
    await expect(buscarFechamentoAction("")).rejects.toThrow("Tipster inválido.");
    await expect(exportBankrollCsvAction(" ")).rejects.toThrow("Tipster inválido.");
    await expect(updateBankrollSharpModeAction("canal", "TUDO" as never)).rejects.toThrow("Modo sharp inválido");
    expect(mocks.bankroll).not.toHaveBeenCalled();
  });

  it("sem sessão não consulta nem grava", async () => {
    mocks.session.mockRejectedValue(new Error("Sessão inválida — faça login novamente."));
    mocks.requireSession.mockRejectedValue(new Error("Sessão inválida — faça login novamente."));
    await expect(buscarFechamentoAction("canal")).rejects.toThrow("Sessão inválida");
    await expect(exportBankrollCsvAction("canal")).rejects.toThrow("Sessão inválida");
    await expect(updateBankrollSharpModeAction("canal", "OFF")).rejects.toThrow("Sessão inválida");
    expect(mocks.bankroll).not.toHaveBeenCalled();
  });
});
