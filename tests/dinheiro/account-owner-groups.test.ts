import { describe, expect, it } from "vitest";
import { groupAccountsByOwner } from "@/app/_design/lib/account-owner-groups";
import { sumMoneyBy } from "@/src/domain/money";

describe("groupAccountsByOwner", () => {
  it("agrupa por titular e calcula os quatro subtotais da prestação de contas", () => {
    const groups = groupAccountsByOwner([
      { id: "1", titular: "Ana", balance: 120, deposited: 100, withdrawn: 10, profit: 30 },
      { id: "2", titular: "Ana", balance: 80, deposited: 50, withdrawn: 5, profit: 35 },
      { id: "3", titular: "Bia", balance: 20, deposited: 25, withdrawn: 0, profit: -5 },
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toMatchObject({
      owner: "Ana",
      balance: 200,
      deposited: 150,
      withdrawn: 15,
      profit: 65,
    });
    expect(groups[0]?.accounts.map((account) => account.id)).toEqual(["1", "2"]);
    expect(groups[1]).toMatchObject({ owner: "Bia", balance: 20, profit: -5 });
  });

  it("soma 0.1+0.2 e 33.33+33.33 pelo helper canônico, não por IEEE-754", () => {
    const ieee = groupAccountsByOwner([
      { id: "1", titular: "Ana", balance: 0.1, deposited: 33.33, withdrawn: 0, profit: 0.1, betProfit: 0.1 },
      { id: "2", titular: "Ana", balance: 0.2, deposited: 33.33, withdrawn: 0, profit: 0.2, betProfit: 0.2 },
    ]);
    expect(ieee[0]?.balance).toBe(sumMoneyBy([0.1, 0.2], (value) => value, 2));
    expect(ieee[0]?.balance).toBe(0.3);
    expect(ieee[0]?.balance).not.toBe(0.1 + 0.2);
    expect(ieee[0]?.deposited).toBe(sumMoneyBy([33.33, 33.33], (value) => value, 2));
    expect(ieee[0]?.deposited).toBe(66.66);
    expect(ieee[0]?.profit).toBe(0.3);
    expect(ieee[0]?.betProfit).toBe(0.3);
  });

  it("consolida titular vazio no fallback explícito", () => {
    expect(groupAccountsByOwner([
      { id: "1", titular: " ", balance: 1, deposited: 1, withdrawn: 0, profit: 0 },
    ], "Sem titular")[0]?.owner).toBe("Sem titular");
  });
});
