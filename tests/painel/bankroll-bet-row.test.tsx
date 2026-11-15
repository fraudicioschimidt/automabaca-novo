import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DesignProvider } from "@/app/_design/kit/context";
import { BetRow } from "@/app/_design/screens/bankroll/bet-detail";
import type { LocalBet } from "@/app/_design/screens/bankroll/types";
import type { StatusDeTela } from "@/src/domain/status-de-aposta";

const baseBet: Omit<LocalBet, "status" | "profit"> = {
  id: "bet-1",
  day: "2026-06-10",
  esporte: "",
  time: "16:00",
  home: "Antofagasta",
  away: "Rangers",
  region: "Chile",
  league: "Liga de Ascenso",
  market: "Handicap - Match",
  line: "Rangers +1.25",
  odds: 1.825,
  clv: null,
  stake: 1,
  allowsHalfResult: true,
  d: {
    open: 1.825, close: null, liqOpen: null, liqClose: null, eventAt: "10/06 16:00", casa: null,
    capturedAt: "10/06 15:00", before: "1h antes", origin: "Manual", msg: null, moveType: null,
  },
};

/** As duas cabeças (compacta e de tabela) saem no mesmo HTML; o CSS mostra uma. */
function renderRow(
  status: StatusDeTela,
  profit: number | null,
  mode: "light" | "dark" = "light",
  canManage = true,
) {
  return renderToStaticMarkup(
    <DesignProvider mode={mode}>
      <BetRow
        b={{ ...baseBet, status, profit }}
        open={{}}
        setOpen={() => undefined}
        setResultMenu={() => undefined}
        settling={null}
        canManage={canManage}
      />
    </DesignProvider>,
  );
}

describe("linha da aposta", () => {
  it.each(["light", "dark"] as const)(
    "mostra VOID como Reembolso em vez de lucro zero (%s)",
    (mode) => {
      const html = renderRow("void", 0, mode);
      // Uma vez em cada cabeça.
      expect(html.match(/Reembolso/g)).toHaveLength(2);
      expect(html).not.toContain("+0.00u");
      expect(html).toContain("Situação");
    },
  );

  it("mantém lucro financeiro para resultados ganhos", () => {
    const html = renderRow("won", 0.9);
    expect(html).toContain("+0.90u");
    expect(html).toContain("Lucro");
    expect(html).not.toContain("Reembolso");
  });

  it("não oferece alteração de resultado sem canManage, em nenhuma das cabeças", () => {
    const html = renderRow("pending", null, "light", false);
    expect(html).toContain("Pendente");
    expect(html).not.toContain("Alterar resultado");
  });
});
