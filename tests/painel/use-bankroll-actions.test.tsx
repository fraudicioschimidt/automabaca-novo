// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useBankrollActions } from "@/app/_design/screens/bankroll/use-bankroll-actions";
import { BANKROLL_MOCK_DATA } from "@/app/_design/mock/bankroll-data";
import type { BankrollActions } from "@/app/_design/action-contracts";
import { toast } from "@/app/_design/toast";
import { renderClickable } from "../helpers/click-render";

vi.mock("@/app/_design/toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/_design/toast")>();
  return { ...real, toast: vi.fn() };
});

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; vi.clearAllMocks(); });

type ClosingResult = Awaited<ReturnType<NonNullable<BankrollActions["onFetchClosing"]>>>;

async function buscarFechamento(result: ClosingResult) {
  let state!: ReturnType<typeof useBankrollActions>;
  const noop = () => {};
  function Harness() {
    state = useBankrollActions({
      AB: BANKROLL_MOCK_DATA, todayKey: "2026-06-14", allBets: [], filtered: [], overlay: null,
      setOverlay: noop, setExtraBets: noop, setResultMenu: noop, setResultOverrides: noop, setDeletedBetIds: noop,
      resultLabel: {}, onFetchClosing: vi.fn().mockResolvedValue(result),
    });
    return null;
  }
  view = renderClickable(<Harness />);
  await act(async () => { await state.handleFetchClosing(); });
  return vi.mocked(toast).mock.calls.at(-1);
}

describe("Odds fechamento da banca", () => {
  it("apostas adiadas pelo teto de espera não saem como sucesso", async () => {
    expect(await buscarFechamento({ ok: true, processed: 3, closed: 0, failures: 0, adiadas: 3 }))
      .toEqual(["Fechamento de 3 apostas: 0 fechadas · 3 ficaram para o ciclo automático", "info"]);
  });

  it("tudo fechado é sucesso; falha pede atenção", async () => {
    expect(await buscarFechamento({ ok: true, processed: 1, closed: 1, failures: 0, adiadas: 0 }))
      .toEqual(["Fechamento de 1 aposta: 1 fechada", "ok"]);
    view!.unmount();
    expect(await buscarFechamento({ ok: true, processed: 4, closed: 2, failures: 1, adiadas: 1 }))
      .toEqual(["Fechamento de 4 apostas: 2 fechadas · 1 ficou para o ciclo automático · 1 falha", "warn"]);
  });
});
