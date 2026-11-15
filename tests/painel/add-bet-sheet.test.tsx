// @vitest-environment jsdom
import { act, type Dispatch, type SetStateAction } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AddBetSheet } from "@/app/_design/screens/bankroll/add-bet-sheet";
import { useAddBet } from "@/app/_design/screens/bankroll/use-add-bet";
import type { LocalBet } from "@/app/_design/screens/bankroll/types";
import type { BankrollActions } from "@/app/_design/action-contracts";
import { renderClickable } from "../helpers/click-render";

vi.mock("@/app/_design/toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/_design/toast")>();
  return { ...real, toast: vi.fn() };
});

let view: ReturnType<typeof renderClickable> | undefined;
const setExtraBets = vi.fn<Dispatch<SetStateAction<LocalBet[]>>>();
afterEach(() => { view?.unmount(); view = undefined; setExtraBets.mockReset(); });

/** A aposta otimista que o formulário pôs na lista. */
function added(): LocalBet | undefined {
  const update = setExtraBets.mock.calls.at(-1)?.[0];
  return typeof update === "function" ? update([])[0] : update?.[0];
}

function Harness({ onRegisterBet }: { onRegisterBet: BankrollActions["onRegisterBet"] }) {
  const form = useAddBet({ slug: "banca", todayKey: "2026-09-24", overlay: "adicionar", setOverlay: () => {}, setExtraBets, onRegisterBet });
  return <AddBetSheet todayKey="2026-09-24" {...form} onClose={() => {}} />;
}

function field(name: string) {
  const node = view?.container.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`);
  if (!node) throw new Error(`Campo ausente: ${name}`);
  return node;
}

function fill(name: string, value: string) {
  const node = field(name);
  const proto = node instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  act(() => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(node, value);
    node.dispatchEvent(new Event(node instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

async function adicionar(fields: Record<string, string>) {
  const onRegisterBet = vi.fn<NonNullable<BankrollActions["onRegisterBet"]>>().mockResolvedValue({ ok: true, betId: "b1", created: true });
  view = renderClickable(<Harness onRegisterBet={onRegisterBet} />);
  for (const [name, value] of Object.entries({ home: "Santos", away: "Grêmio", odds: "1,95", ...fields })) fill(name, value);
  await act(async () => { view!.click("Adicionar aposta"); });
  return onRegisterBet;
}

describe("Adicionar aposta", () => {
  it("hora em branco segue como horário a confirmar, não como meia-noite", async () => {
    const onRegisterBet = await adicionar({ line: "Under 2.5" });
    expect(onRegisterBet).toHaveBeenCalledWith("banca", expect.objectContaining({ date: "2026-09-24", time: "" }));
    expect(added()).toMatchObject({ time: "—", d: { eventAt: "24/09 · horário a confirmar" } });
  });

  it("a seleção é a que o dono escreve, de qualquer mercado", async () => {
    const over = await adicionar({ market: "Total", line: "Over 2.5" });
    expect(over).toHaveBeenCalledWith("banca", expect.objectContaining({ market: "Total", line: "Over 2.5" }));
    view!.unmount();
    const casa = await adicionar({ market: "1X2", line: "Casa" });
    expect(casa).toHaveBeenCalledWith("banca", expect.objectContaining({ market: "1X2", line: "Casa" }));
  });

  it("as sugestões de seleção seguem o mercado, e trocar o mercado limpa a seleção", async () => {
    view = renderClickable(<Harness onRegisterBet={vi.fn()} />);
    const sugestoes = () => [...(field("line") as HTMLInputElement).list!.querySelectorAll("option")].map((option) => option.value);
    expect(sugestoes()).toContain("Over 2.5");
    fill("line", "Over 2.5");
    fill("market", "1X2");
    expect(sugestoes()).toEqual(["Casa", "Empate", "Fora"]);
    expect(field("line").value).toBe("");
    fill("market", "Ambas marcam");
    expect(sugestoes()).toEqual(["Sim", "Não"]);
  });

  it("sem seleção não cadastra", async () => {
    const onRegisterBet = await adicionar({ market: "1X2" });
    expect(onRegisterBet).not.toHaveBeenCalled();
    expect(view!.container.textContent).toContain("Preencha mandante, visitante, seleção");
  });

  it("dia que já passou pede a hora", async () => {
    const onRegisterBet = await adicionar({ line: "Under 2.5", date: "2026-09-23" });
    expect(onRegisterBet).not.toHaveBeenCalled();
    expect(view!.container.textContent).toContain("Jogo de dia que já passou: informe a hora.");
    view!.unmount();
    const comHora = await adicionar({ line: "Under 2.5", date: "2026-09-23", time: "20:00" });
    expect(comHora).toHaveBeenCalledWith("banca", expect.objectContaining({ date: "2026-09-23", time: "20:00" }));
  });

  // A aposta otimista já é liquidável: o ½ só aparece onde o servidor o aceita.
  it("a aposta recém-cadastrada só oferece ½ em linha asiática fracionária", async () => {
    await adicionar({ market: "1X2", line: "Casa" });
    expect(added()).toMatchObject({ allowsHalfResult: false });
    view!.unmount();
    await adicionar({ market: "Total", line: "Over 2.25" });
    expect(added()).toMatchObject({ allowsHalfResult: true });
  });

  it("a hora digitada vai como está", async () => {
    const onRegisterBet = await adicionar({ line: "Under 2.5", time: "20:00" });
    expect(onRegisterBet).toHaveBeenCalledWith("banca", expect.objectContaining({ time: "20:00" }));
  });
});

it("nova tentativa de aposta manual mantém o identificador após perder a resposta", async () => {
  const register = vi.fn<NonNullable<BankrollActions["onRegisterBet"]>>()
    .mockRejectedValueOnce(new Error("resposta perdida")).mockResolvedValue({ ok: true, created: false, betId: "b1" });
  view = renderClickable(<Harness onRegisterBet={register} />);
  for (const [name, value] of Object.entries({ home: "Santos", away: "Grêmio", odds: "1,95", line: "Under 2.5" })) fill(name, value);
  await act(async () => { view!.click("Adicionar aposta"); });
  await act(async () => { view!.click("Adicionar aposta"); });
  expect(register).toHaveBeenCalledTimes(2);
  expect(register.mock.calls[0]?.[1]).toMatchObject({ requestId: expect.any(String) });
  expect(register.mock.calls[1]?.[1]).toEqual(register.mock.calls[0]?.[1]);
});
