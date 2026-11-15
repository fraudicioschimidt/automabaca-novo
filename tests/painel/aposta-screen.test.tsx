// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
  usePathname: () => "/aposta",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/app/_design/AppSidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/app/_design/toast", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/app/_design/toast")>();
  return { ...real, toast: vi.fn() };
});

import { ApostaScreen } from "@/app/_design/screens/ApostaScreen";
import { BETS, CAPTURA, SETTLEMENT_CARDS } from "@/app/_design/mock/bet";
import { toast } from "@/app/_design/toast";
import { renderDesignMarkup } from "../helpers/design-markup";
import { renderClickable } from "../helpers/click-render";

const SETTLEMENT_CARD = SETTLEMENT_CARDS.b11!;

/** A aposta como a ficha real a recebe: com a revisão que a edição confere. */
function withVersion(version: number) {
  const bet = BETS[0]!;
  return { ...bet, settlementView: {
    version, event: `${bet.home} vs ${bet.away}`, sport: bet.esporte, competition: bet.league ?? "", country: bet.region,
    market: bet.market, selection: bet.line, date: "2026-06-02T18:00:00.000Z", bookmaker: "", odds: bet.odds, stake: bet.stake,
    unitValue: 50, status: "PENDING", profit: 0, kickoffInferred: false, settledAt: null, sportState: "CONFIRMED",
    liveScoreHome: null, liveScoreAway: null,
  } };
}

describe("ficha da aposta", () => {
  it("mostra o post original, como foi lido e o link que abre a mensagem", () => {
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[0]!} captura={CAPTURA} />);
    expect(html).toContain("Post original");
    expect(html).toContain("Entrada: Northern Tigers +0.25");
    expect(html).toContain("Lida por regra");
    expect(html).toContain('href="https://t.me/c/4262961788/5120"');
  });

  it("mostra como foi liquidada: quem decidiu, o que a IA achou com a fonte e a conferência do FlashScore", () => {
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[10]!} settlement={SETTLEMENT_CARD} />);
    expect(html).toContain("Como foi liquidada");
    expect(html).toContain("IA-Judge automático");
    expect(html).toContain("O FlashScore viu");
    expect(html).toContain("Gerasdorf 3-2 Wienerberg");
    expect(html).toContain('href="https://www.sofascore.com/football/match/gerasdorf-wienerberg/abc"');
    expect(html).toContain("o FlashScore confirmou o resultado da IA");
    expect(html).toContain("Motivo da IA");
  });

  it("liquidada pelo FlashScore: o placar é o final, com o desfecho, e sem bloco da IA", () => {
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[10]!} settlement={{
      ...SETTLEMENT_CARD, source: "liquidação automática pelo FlashScore", score: { value: "3-2", kind: "decided", detail: null },
      outcome: "pelo placar final", crossCheck: null, judge: null,
    }} />);
    expect(html).toContain("Placar final");
    expect(html).toContain("pelo placar final");
    expect(html).not.toContain("O FlashScore viu");
    expect(html).not.toContain("A IA achou");
  });

  it("a prova do 1º tempo identifica o período sem anunciar o placar final", () => {
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[10]!} settlement={{
      ...SETTLEMENT_CARD, source: "liquidação automática pelo FlashScore",
      score: { value: "47-39", kind: "decided", period: "HT", detail: null },
      outcome: "pelo placar do 1º tempo", crossCheck: null, judge: null,
    }} />);
    expect(html).toContain("Placar do 1º tempo");
    expect(html).toContain("47-39");
    expect(html).not.toContain("Placar final");
  });

  it("leitura sem o fim do jogo e IA pelos dados do FlashScore: cada rótulo diz o que é", () => {
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[10]!} settlement={{
      ...SETTLEMENT_CARD,
      score: { value: "1-0", kind: "partial", detail: "fim do jogo não confirmado" },
      judge: { ...SETTLEMENT_CARD.judge!, link: null, site: null, fromFlashscore: true },
    }} />);
    expect(html).toContain("Última leitura do FlashScore");
    expect(html).toContain("fim do jogo não confirmado");
    expect(html).not.toContain("O FlashScore viu");
    expect(html).toContain("dados do FlashScore");
    expect(html).not.toContain("sem link de fonte confiável");
  });

  it("resolução pela regra sobre o snapshot, sem modelo: nada de IA nem de certeza", () => {
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[10]!} settlement={{
      ...SETTLEMENT_CARD,
      judge: { found: "Escanteios 7-4", confidence: "100%", link: null, site: null, fromFlashscore: true,
        reason: "Resolvido deterministicamente pelo snapshot FlashScore.", model: null },
    }} />);
    expect(html).toContain("O FlashScore mostrou");
    expect(html).toContain("Escanteios 7-4");
    expect(html).toContain("regra sobre os dados do FlashScore");
    expect(html).toContain("Resolvido deterministicamente");
    expect(html).not.toContain("A IA achou");
    expect(html).not.toContain("Certeza da IA");
    expect(html).not.toContain("Motivo da IA");
  });

  it("sem post de origem a ficha fica como era", () => {
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[0]!} />);
    expect(html).not.toContain("Post original");
    expect(html).not.toContain("abrir o post");
    expect(html).not.toContain("Como foi liquidada");
  });

  it("aposta removida abre só para leitura: por onde saiu, o que o estorno desfez e o Restaurar", async () => {
    const removida = { ...BETS[0]!, status: "void" as const, profit: 0 };
    const removal = { at: "13/06 21:40", origin: "reacao" as const, restorable: true, previous: { status: "won" as const, profit: 0.93 } };
    const onRestoreBets = vi.fn().mockResolvedValue({ ok: true, restored: [removida.id], blocked: [] });
    const view = renderClickable(
      <ApostaScreen bet={removida} removal={removal} onEditBet={vi.fn()} onDeleteBet={vi.fn()} onRestoreBets={onRestoreBets} />,
    );
    const aviso = view.container.querySelector('[role="status"][aria-label="Aposta removida"]');
    expect(aviso?.textContent).toContain("Removida pelo 👎 no canal em 13/06 21:40.");
    expect(aviso?.textContent).toContain("era ganha (+0.93u), resultado estornado");
    expect(view.container.textContent).toContain("era +0.93u, estornado");
    expect([...view.container.querySelectorAll("button")].map((button) => button.textContent)).not.toEqual(
      expect.arrayContaining(["Editar", "Excluir"]),
    );

    await act(async () => { view.click("Restaurar"); });
    expect(onRestoreBets).toHaveBeenCalledExactlyOnceWith("main", [removida.id]);
    expect(vi.mocked(toast)).toHaveBeenCalledWith("Aposta de volta ao tipster", "ok");
    view.unmount();
  });

  /**
   * A edição só volta para a análise quando o servidor a reprocessa; corrigir
   * odd, stake ou casa com o jogo casado mantém o jogo e o fechamento.
   */
  it.each([
    [true, "Aposta atualizada e reenviada para análise"],
    [false, "Aposta atualizada; o jogo casado continua valendo"],
  ])("salvar a edição com requiresEnrich=%s avisa: %s", async (requiresEnrich, aviso) => {
    vi.mocked(toast).mockClear();
    const onEditBet = vi.fn().mockResolvedValue({ ok: true, requiresEnrich });
    const view = renderClickable(<ApostaScreen bet={withVersion(7)} onEditBet={onEditBet} onDeleteBet={vi.fn()} />);

    await act(async () => { view.click("Editar"); });
    const ajuda = view.container.textContent ?? "";
    expect(ajuda).toContain("Na prop de jogador a casa define a regra de liquidação");
    expect(ajuda).toContain("qualquer correção com o jogo ainda não casado");
    await act(async () => { view.click("Salvar alterações"); });

    expect(onEditBet).toHaveBeenCalledOnce();
    expect(vi.mocked(toast)).toHaveBeenCalledWith(aviso, "ok");
    view.unmount();
  });

  it("a edição leva a revisão da aposta vista ao abrir o formulário, mesmo que a ficha se atualize depois", async () => {
    const onEditBet = vi.fn().mockResolvedValue({ ok: true, requiresEnrich: false });
    const view = renderClickable(<ApostaScreen bet={withVersion(7)} onEditBet={onEditBet} onDeleteBet={vi.fn()} />);
    await act(async () => { view.click("Editar"); });
    view.rerender(<ApostaScreen bet={withVersion(8)} onEditBet={onEditBet} onDeleteBet={vi.fn()} />);
    await act(async () => { view.click("Salvar alterações"); });

    expect(onEditBet).toHaveBeenCalledWith(BETS[0]!.bkSlug, BETS[0]!.id, expect.objectContaining({ home: BETS[0]!.home }), 7);
    view.unmount();
  });

  it("removida sem a marca de restaurável diz que não volta e não oferece Restaurar", () => {
    const removal = { at: "02/06 18:12", origin: "painel" as const, restorable: false, previous: null };
    const html = renderDesignMarkup(<ApostaScreen bet={BETS[0]!} removal={removal} onRestoreBets={vi.fn()} />);
    expect(html).toContain("Removida pelo painel em 02/06 18:12.");
    expect(html).toContain("não volta pelo painel");
    expect(html).not.toContain("Restaurar");
  });

  it("entrada pega com 👍 mostra quando; sem a marca, a linha não aparece", () => {
    const pega = { ...BETS[0]!, d: { ...BETS[0]!.d, takenAt: "24/09 14:48" } };
    const html = renderDesignMarkup(<ApostaScreen bet={pega} />);
    expect(html).toContain("Peguei");
    expect(html).toContain("24/09 14:48");
    expect(html).toContain("👍 no post do canal");
    expect(renderDesignMarkup(<ApostaScreen bet={BETS[0]!} />)).not.toContain("👍 no post do canal");
  });

  it("o movimento da abertura é o que o adapter mediu, não uma conta refeita na tela", () => {
    const base = BETS[0]!;
    // Abertura ≤ 1 não mede movimento: o adapter manda `null` e o moveType diz
    // que não houve medição; a tela não pode inventar "+90%".
    const semMedida = { ...base, movimento: null, d: { ...base.d, open: 1, close: 1.9, moveType: null } };
    const html = renderDesignMarkup(<ApostaScreen bet={semMedida} />);
    expect(html).not.toContain("+90.0%");
    expect(html).toContain("movimento não medido");
    const medido = { ...base, movimento: -3.2, d: { ...base.d, open: 2, close: 1.9, moveType: "estavel" as const } };
    expect(renderDesignMarkup(<ApostaScreen bet={medido} />)).toContain("linha -3.2% até o fechamento");
  });
});
