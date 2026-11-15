// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { ResultMenu } from "@/app/_design/screens/bankroll/result-menu";
import { makeResults } from "@/app/_design/screens/bankroll/settle";
import { getTheme } from "@/app/_design/theme";
import type { BankrollBet } from "@/app/_design/screens/bankroll/types";
import { renderClickable } from "../helpers/click-render";

let view: ReturnType<typeof renderClickable> | undefined;
afterEach(() => { view?.unmount(); view = undefined; });

const opcoes = (b: Partial<BankrollBet>) => {
  view = renderClickable(
    <ResultMenu menu={{ b: { id: "b1", stake: 1, odds: 2, status: "pending", ...b } as BankrollBet, x: 0, y: 0 }}
      results={makeResults(getTheme("light"))} onPick={() => {}} onDelete={() => {}} />,
  );
  return [...view.container.querySelectorAll("button")].map((button) => button.textContent);
};

describe("menu Alterar resultado", () => {
  it("só oferece ½ ganha e ½ perdida onde o mercado admite meio resultado", () => {
    expect(opcoes({ allowsHalfResult: true })).toEqual(expect.arrayContaining(["½ Ganha", "½ Perdida"]));
    view!.unmount();
    expect(opcoes({ allowsHalfResult: false })).not.toEqual(expect.arrayContaining(["½ Ganha"]));
    view!.unmount();
    expect(opcoes({ allowsHalfResult: false })).not.toEqual(expect.arrayContaining(["½ Perdida"]));
  });

  it("o resultado vigente continua no menu mesmo quando o mercado já não admite o ½", () => {
    expect(opcoes({ allowsHalfResult: false, status: "halfwon" })).toContain("½ Ganha");
  });
});
