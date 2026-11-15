// @vitest-environment jsdom
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { JobsCard } from "@/app/_design/screens/operacoes/jobs-card";
import { SecurityCard } from "@/app/_design/screens/config/security-card";
import { TeamsCard } from "@/app/_design/screens/config/teams-card";
import { useTeamCards } from "@/app/_design/screens/config/use-team-cards";
import type { ConfigData, TeamCardsPage } from "@/app/_design/screens/config/types";
import type { ConfigActions } from "@/app/_design/action-contracts";
import { renderClickable } from "../helpers/click-render";
import { renderDesignMarkup } from "../helpers/design-markup";

const situacao = { lastRound: "12:37", stoppedBy: null, linkedToday: 184, teamCards: 2310, inProgress: false as boolean | null };

describe("ações perigosas exigem o segundo gesto", () => {
  it("replay agrupado não dispara sem preview", () => {
    const replayJob = vi.fn();
    const html = renderDesignMarkup(
      <JobsCard
        jobs={[{
          id: "g1",
          name: "sharp.enrich.dlq",
          causa: "o job estourou o tempo",
          proximaEtapa: "Replay uma vez",
          n: 3,
          at: "hoje",
          bets: ["bet-1"],
          replay: true,
          replayHabilitado: true,
          motivoBloqueio: null,
          replayJobIds: ["j1", "j2", "j3"],
        }]}
        jobsTotal={3}
        available
        replayJob={replayJob}
      />,
    );
    expect(html).toContain("Replay");
    expect(html).not.toContain("Replay da falha");
    expect(html).not.toContain("Reenfileirar");
    expect(replayJob).not.toHaveBeenCalled();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it("revogar outras sessões exige o segundo gesto", () => {
    const onRevokeOtherSessions = vi.fn().mockResolvedValue({ count: 2 });
    const view = renderClickable(
      <SecurityCard
        security={{
          username: "fabricio",
          sessionsTotal: 3,
          sessions: [
            { id: "s1", deviceName: "Chrome", createdAt: "hoje", lastSeenAt: "hoje", current: true },
            { id: "s2", deviceName: "Firefox", createdAt: "hoje", lastSeenAt: "hoje", current: false },
          ],
        }}
        onRevokeSession={vi.fn()}
        onRevokeOtherSessions={onRevokeOtherSessions}
      />,
    );
    view.click("Revogar outras");
    expect(onRevokeOtherSessions).not.toHaveBeenCalled();
    expect(view.container.textContent).toMatch(/universo ativo/i);
    expect(view.container.textContent).toContain("2 sessões fora desta");
    expect(view.container.textContent).toContain("Isto revoga 2 sessões");
    view.submit("Confirmar revogação");
    expect(onRevokeOtherSessions).toHaveBeenCalledOnce();
    view.unmount();
  });
});

const fenix = {
  id: "card-1", sport: "Soccer", name: "Fenix", country: "Uruguay", league: "Segunda Division", category: "principal",
  flashscoreTeamId: "8hWKNqzL", flashscoreName: "Fenix",
  pinnacleNames: [{ name: "Fenix", games: 12 }, { name: "CA Fenix", games: 1 }],
  tipsterNames: [{ id: "n1", name: "Atletico Fenix Montevideo", confirmed: true }, { id: "n2", name: "Fenix MVD", confirmed: false }],
};
const reserva = { ...fenix, id: "card-2", name: "Nacional II", league: "Reserves", category: "reserva", flashscoreTeamId: "rsv1",
  flashscoreName: "Nacional 2", pinnacleNames: [{ name: "Nacional II", games: 1 }], tipsterNames: [] };
const paginaDeTimes = (cards = [fenix], extra: Partial<TeamCardsPage> = {}): TeamCardsPage =>
  ({ cards, total: cards.length, nextOffset: null, sports: [{ sport: "Soccer", count: cards.length }], ...extra });

/** O card de times com o hook de verdade, como a Config o monta; o dado da página não muda entre renders. */
function CardDeTimes({ actions, data, canManage = true }: { actions: ConfigActions; data: Pick<ConfigData, "teamCards" | "catalogPairing">; canManage?: boolean }) {
  const { inventory: _inventory, ...times } = useTeamCards(data, actions);
  return <TeamsCard {...times} canManage={canManage} />;
}
const semBusca = { teamCards: paginaDeTimes([]), catalogPairing: situacao };
const comFenix = { teamCards: paginaDeTimes([fenix, reserva]), catalogPairing: situacao };

/** Digita no campo controlado como o navegador: o React só ouve o setter nativo + `input`. */
function digitar(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

/** O nome principal de cada ficha na lista. */
const nomesNaLista = (container: HTMLElement) => [...container.querySelectorAll("li")].map((li) => li.querySelector("b")?.textContent);
/** Deixa a cadeia de promessas da action (unwrap, estado, fechar o diálogo) andar. */
async function esvaziarPromessas() { for (let i = 0; i < 5; i += 1) await Promise.resolve(); }

describe("card de times: a ficha", () => {
  afterEach(() => { vi.useRealTimers(); document.body.replaceChildren(); });

  it("mostra a ficha em árvore: nome, país e liga, nomes da Pinnacle com os jogos, o do FlashScore e os dos tipsters", () => {
    const view = renderClickable(<CardDeTimes actions={{}} data={comFenix} />);
    const [primeira, segunda] = [...view.container.querySelectorAll("li")].map((li) => li.textContent);
    expect(view.container.querySelector("h2")?.textContent).toBe("Times");
    expect(view.container.textContent).toContain("montados pela Pinnacle17 e pelo FlashScore");
    expect(primeira).toBe(
      "Fenix · Uruguay · Segunda Division" + "id FS 8hWKNqzL"
      + "├─Pinnacle:Fenix (12 jogos)· CA Fenix (1 jogo)"
      + "├─FlashScore:Fenix"
      + "└─Tipsters:Atletico Fenix Montevideo ✓(confirmado)Fenix MVD (pendente)",
    );
    // A categoria só aparece quando não é o time principal.
    expect(segunda).toContain("id FS rsv1 · reserva");
    expect(segunda).toContain("Tipsters:nenhum nome ainda");
    // Um esporte só: sem filtro, e o esporte não se repete em cada ficha.
    expect(view.container.querySelector("select")).toBeNull();
    // Saíram as abas e as revogações do sistema antigo.
    expect(view.container.textContent).not.toMatch(/Suspeitos|Associações revogadas|Promover/);
    view.unmount();
  });

  it("remover um nome de tipster pede confirmação, chama a action com o id do nome e o tira da ficha", async () => {
    const remove = vi.fn().mockResolvedValue({ ok: true });
    const view = renderClickable(<CardDeTimes actions={{ onRemoveTipsterName: remove }} data={comFenix} />);
    act(() => { view.container.querySelector<HTMLButtonElement>('button[aria-label="Remover o nome de tipster Fenix MVD"]')!.click(); });
    expect(remove).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Fenix MVD → Fenix");

    await act(async () => { view.submit("Remover nome"); await esvaziarPromessas(); });
    expect(remove).toHaveBeenCalledWith("n2");
    expect(view.container.querySelector("li")?.textContent).not.toContain("Fenix MVD");
    expect(view.container.querySelector("li")?.textContent).toContain("Atletico Fenix Montevideo");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
    view.unmount();
  });

  it("a recusa do servidor fica no diálogo e o nome continua na ficha", async () => {
    const remove = vi.fn().mockRejectedValue(new Error("Esse nome já tinha sido removido da ficha."));
    const view = renderClickable(<CardDeTimes actions={{ onRemoveTipsterName: remove }} data={comFenix} />);
    act(() => { view.container.querySelector<HTMLButtonElement>('button[aria-label="Remover o nome de tipster Fenix MVD"]')!.click(); });
    await act(async () => { view.submit("Remover nome"); await esvaziarPromessas(); });
    expect(document.body.querySelector('[role="alert"]')?.textContent).toBe("Esse nome já tinha sido removido da ficha.");
    expect(view.container.querySelector("li")?.textContent).toContain("Fenix MVD");
    view.unmount();
  });

  it("sem sessão para gerenciar, não há botão de remover nem de buscar jogos", () => {
    const view = renderClickable(<CardDeTimes actions={{}} data={comFenix} canManage={false} />);
    expect(view.container.querySelector('button[aria-label^="Remover o nome de tipster"]')).toBeNull();
    expect(view.container.textContent).not.toContain("Buscar jogos agora");
    expect(view.container.textContent).toContain("Última busca: 12:37");
    view.unmount();
  });

  it("a busca espera a digitação, pede ao servidor a primeira página e descarta a resposta de uma busca já trocada", async () => {
    vi.useFakeTimers();
    let answerOld: (page: TeamCardsPage) => void = () => undefined;
    const load = vi.fn()
      .mockImplementationOnce(() => new Promise<TeamCardsPage>((resolve) => { answerOld = resolve; }))
      .mockResolvedValueOnce(paginaDeTimes([reserva]));
    const view = renderClickable(<CardDeTimes actions={{ onLoadTeamCards: load }} data={comFenix} />);
    const campo = view.container.querySelector<HTMLInputElement>('input[type="search"]')!;

    digitar(campo, "fe");
    digitar(campo, "fen");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(load).toHaveBeenCalledOnce();
    expect(load).toHaveBeenLastCalledWith({ query: "fen", sport: null, offset: 0 });

    digitar(campo, "nacional");
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(load).toHaveBeenLastCalledWith({ query: "nacional", sport: null, offset: 0 });
    await act(async () => { answerOld(paginaDeTimes([fenix])); await esvaziarPromessas(); });
    expect(nomesNaLista(view.container)).toEqual(["Nacional II"]);
    expect(view.container.textContent).toContain("1 time encontrado");
    view.unmount();
  });

  it("mostrar mais traz a próxima página da mesma busca e junta à lista", async () => {
    const load = vi.fn().mockResolvedValue(paginaDeTimes([reserva], { total: 2, nextOffset: null }));
    const data = { teamCards: paginaDeTimes([fenix], { total: 2, nextOffset: 1 }), catalogPairing: situacao };
    const view = renderClickable(<CardDeTimes actions={{ onLoadTeamCards: load }} data={data} />);
    await act(async () => { view.click("Mostrar mais · 1 restante"); await esvaziarPromessas(); });
    expect(load).toHaveBeenCalledWith({ query: "", sport: null, offset: 1 });
    expect(nomesNaLista(view.container)).toEqual(["Fenix", "Nacional II"]);
    expect(view.container.textContent).not.toContain("Mostrar mais");
    view.unmount();
  });

  it("com mais de um esporte, o filtro aparece e cada ficha diz o esporte", async () => {
    vi.useFakeTimers();
    const basquete = { ...fenix, id: "card-3", sport: "Basketball", name: "Flamengo", flashscoreTeamId: "bk1" };
    const load = vi.fn().mockResolvedValue(paginaDeTimes([basquete]));
    const data = { teamCards: paginaDeTimes([fenix, basquete], { sports: [{ sport: "Basketball", count: 1 }, { sport: "Soccer", count: 1 }] }), catalogPairing: situacao };
    const view = renderClickable(<CardDeTimes actions={{ onLoadTeamCards: load }} data={data} />);
    const filtro = view.container.querySelector<HTMLSelectElement>('select[aria-label="Esporte"]')!;
    expect([...filtro.options].map((option) => option.textContent)).toEqual(["Todos os esportes", "Basquete (1)", "Futebol (1)"]);
    expect(view.container.querySelector("li")?.textContent).toContain("Fenix · Futebol · Uruguay");

    act(() => {
      filtro.value = "Basketball";
      filtro.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(250); });
    expect(load).toHaveBeenLastCalledWith({ query: "", sport: "Basketball", offset: 0 });
    view.unmount();
  });

  it("sem ficha nenhuma, diz de onde elas vêm", () => {
    const view = renderClickable(<CardDeTimes actions={{}} data={semBusca} />);
    expect(view.container.textContent).toContain("Nenhum time ainda. As fichas aparecem depois da primeira busca de jogos.");
    view.unmount();
  });
});

describe("card de times: buscar jogos agora", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("mostra a situação do pareamento e, depois do pedido, relê até a rodada terminar", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({ ok: true, status: "enfileirado" });
    const load = vi.fn()
      .mockResolvedValueOnce({ ...situacao, inProgress: true })
      .mockResolvedValueOnce({ ...situacao, lastRound: "15:02", linkedToday: 190, teamCards: 2320, inProgress: false });
    const view = renderClickable(<CardDeTimes actions={{ onRequestCatalogPairing: request, onLoadCatalogPairing: load }} data={semBusca} />);
    const linha = () => view.container.querySelector('[role="status"]')?.textContent;
    expect(linha()).toBe("Última busca: 12:37 · 184 jogos de hoje ligados · 2310 times com id do FlashScore");

    view.click("Buscar jogos agora");
    view.click("Buscar jogos agora");
    await act(async () => { await Promise.resolve(); });
    // O segundo clique chegou com o primeiro pedido ainda no ar.
    expect(request).toHaveBeenCalledOnce();
    expect(linha()).toContain("Busca em andamento");

    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(linha()).toContain("Busca em andamento");
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000); });
    expect(linha()).toBe("Última busca: 15:02 · 190 jogos de hoje ligados · 2320 times com id do FlashScore");
    // Terminada a rodada, a tela para de perguntar.
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(load).toHaveBeenCalledTimes(2);
    view.unmount();
  });

  it("fila ilegível não encerra a releitura; no limite, a rodada ainda na fila vira aviso para recarregar", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockResolvedValue({ ok: true, status: "ja_na_fila" });
    const load = vi.fn()
      .mockResolvedValueOnce({ ...situacao, inProgress: null })
      .mockRejectedValueOnce(new Error("fora do ar"))
      .mockResolvedValue({ ...situacao, inProgress: true });
    const view = renderClickable(<CardDeTimes actions={{ onRequestCatalogPairing: request, onLoadCatalogPairing: load }} data={semBusca} />);
    const linha = () => view.container.querySelector('[role="status"]')?.textContent;
    view.click("Buscar jogos agora");
    await act(async () => { await Promise.resolve(); });

    await act(async () => { await vi.advanceTimersByTimeAsync(20_000); });
    // "Não sei" e erro de leitura: segue relendo, e o aviso fica.
    expect(linha()).toContain("Busca em andamento");
    await act(async () => { await vi.advanceTimersByTimeAsync(280_000); });
    // O prazo inclui a primeira espera de 10 s; no instante dos 5 min, encerra.
    expect(load).toHaveBeenCalledTimes(29);
    expect(linha()).toContain("Busca ainda na fila — recarregue a tela mais tarde");
    expect(linha()).not.toContain("Busca em andamento");
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
    expect(load).toHaveBeenCalledTimes(29);
    view.unmount();
  });
});
