import { beforeEach, describe, expect, it, vi } from "vitest";
import { RecusaDeNegocioError } from "@/src/services/shared/recusa";

const mocks = vi.hoisted(() => ({ remove: vi.fn(), revalidate: vi.fn() }));
vi.mock("@/app/(painel)/_auth", () => ({
  actor: async () => "tester",
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-correlation-id": "http_account" }) }));
vi.mock("@/src/services/contas/manage", () => ({ removerConta: mocks.remove }));
vi.mock("@/src/services/ops/telemetry", () => ({
  observeAction: (_name: string, run: () => Promise<unknown>) => run(),
}));
import { removerContaAction } from "@/app/(painel)/contas/actions";

const CONTA_ID = "8f7d2c1e-4b3a-4c5d-9e8f-1a2b3c4d5e6f";
beforeEach(() => vi.clearAllMocks());

describe("mensagens públicas das ações de contas", () => {
  it("devolve a recusa de negócio sem invalidar as telas", async () => {
    mocks.remove.mockRejectedValue(new RecusaDeNegocioError("Zere o saldo da conta antes de removê-la."));
    await expect(removerContaAction(CONTA_ID)).resolves.toEqual({
      ok: false, erro: "Zere o saldo da conta antes de removê-la.",
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("propaga falhas técnicas sem expor seu texto como recusa de negócio", async () => {
    const failure = new Error("connection refused at private-database:5432");
    mocks.remove.mockRejectedValue(failure);
    await expect(removerContaAction(CONTA_ID)).rejects.toBe(failure);
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
