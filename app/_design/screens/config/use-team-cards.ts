"use client";
import { useEffect, useRef, useState } from "react";
import type { ConfigActions } from "../../action-contracts";
import { errorMessage, toast } from "../../toast";
import type { ConfigData, TeamCardsPage } from "./types";

type TeamActions = Pick<ConfigActions, "onLoadTeamCards" | "onRemoveTipsterName" | "onRequestCatalogPairing" | "onLoadCatalogPairing">;

/**
 * Enquanto a rodada pedida está na fila ou rodando, a situação é relida a cada
 * 10 s, por até 5 min. Fila ilegível é "não sei": a leitura continua.
 */
const PAIRING_POLL_MS = 10_000;
const PAIRING_POLL_LIMIT = 30;
/** A busca espera o operador parar de digitar. */
const SEARCH_DEBOUNCE_MS = 250;

/** Sem a action (?mock=1), a busca e o filtro valem só sobre a página que veio. */
function filterPage(page: TeamCardsPage, query: string, sport: string | null): TeamCardsPage {
  const needle = query.trim().toLocaleLowerCase("pt-BR");
  const cards = page.cards.filter((card) => (!sport || card.sport === sport) && (!needle || [
    card.flashscoreName, card.flashscoreTeamId, ...card.pinnacleNames.map((n) => n.name), ...card.tipsterNames.map((n) => n.name),
  ].some((name) => name.toLocaleLowerCase("pt-BR").includes(needle))));
  return { ...page, cards, total: cards.length, nextOffset: null };
}

/**
 * As fichas de time: a página chega com as primeiras, sem busca; a busca, o
 * filtro de esporte e o "Mostrar mais" leem o servidor. Resposta de uma busca
 * que o operador já trocou é descartada.
 */
export function useTeamCards(data: Pick<ConfigData, "teamCards" | "catalogPairing">, actions: TeamActions) {
  const { onLoadTeamCards, onRemoveTipsterName } = actions;
  const initial = data.teamCards;
  const [query, setQuery] = useState('');
  const [sport, setSport] = useState<string | null>(null);
  const [page, setPage] = useState(initial);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [failed, setFailed] = useState(false);
  const generation = useRef(0);
  const firstRun = useRef(true);
  const pairing = useCatalogPairing(data.catalogPairing, actions);

  useEffect(() => {
    // A primeira página sem filtro é a que a página já trouxe.
    if (firstRun.current) { firstRun.current = false; return; }
    const current = ++generation.current;
    if (!onLoadTeamCards) { setPage(filterPage(initial, query, sport)); return; }
    setLoading(true);
    const timer = setTimeout(() => {
      onLoadTeamCards({ query: query.trim(), sport, offset: 0 })
        .then((next) => { if (generation.current === current) { setPage(next); setFailed(false); } })
        .catch((error: unknown) => {
          if (generation.current !== current) return;
          setFailed(true);
          toast(errorMessage(error, 'Falha ao buscar times'), 'warn');
        })
        .finally(() => { if (generation.current === current) setLoading(false); });
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, sport, onLoadTeamCards, initial]);

  const loadMore = () => {
    if (!onLoadTeamCards || page.nextOffset === null || loadingMore || loading || failed) return;
    const current = generation.current;
    setLoadingMore(true);
    onLoadTeamCards({ query: query.trim(), sport, offset: page.nextOffset })
      .then((next) => {
        if (generation.current !== current) return;
        // A lista pode ter andado entre as páginas: a ficha repetida fica uma vez.
        setPage((shown) => {
          const seen = new Set(shown.cards.map((card) => card.id));
          return { ...next, cards: [...shown.cards, ...next.cards.filter((card) => !seen.has(card.id))] };
        });
      })
      .catch((error: unknown) => { toast(errorMessage(error, 'Falha ao carregar mais times'), 'warn'); })
      .finally(() => setLoadingMore(false));
  };

  /** Sem action (?mock=1), vale só na tela; com ela, depois de o servidor confirmar. Lança a recusa para o diálogo. */
  const removeTipsterName = async (cardId: string, nameId: string) => {
    if (onRemoveTipsterName) await onRemoveTipsterName(nameId);
    setPage((shown) => ({
      ...shown,
      cards: shown.cards.map((card) => card.id !== cardId ? card
        : { ...card, tipsterNames: card.tipsterNames.filter((name) => name.id !== nameId) }),
    }));
    toast('Nome de tipster removido da ficha', 'ok');
  };

  return {
    cards: page.cards, total: page.total, nextOffset: page.nextOffset, sports: page.sports,
    /** O tamanho do acervo, sem busca: o número da aba. */
    inventory: initial.total,
    query, setQuery, sport, setSport, loading, loadingMore, failed, loadMore,
    removeTipsterName, pairing,
  };
}

/**
 * "Buscar jogos agora" e a linha de situação do pareamento dos catálogos. O
 * worker roda a rodada; a tela relê a situação até a fila esvaziar.
 */
function useCatalogPairing(initial: ConfigData["catalogPairing"], actions: TeamActions) {
  const { onRequestCatalogPairing, onLoadCatalogPairing } = actions;
  const [status, setStatus] = useState(initial);
  const [requesting, setRequesting] = useState(false);
  const [polling, setPolling] = useState(initial.inProgress === true);
  /** O limite da releitura chegou com a rodada ainda na fila (ou sem saber). */
  const [stale, setStale] = useState(false);
  useEffect(() => {
    setStatus(initial);
    if (initial.inProgress) setPolling(true);
  }, [initial]);
  useEffect(() => {
    if (!polling || !onLoadCatalogPairing) return;
    setStale(false);
    let polls = 0;
    let cancelled = false;
    const giveUp = () => { setPolling(false); setStale(true); };
    let reading = false;
    const deadline = Date.now() + PAIRING_POLL_MS * PAIRING_POLL_LIMIT;
    const timer = setInterval(() => {
      if (Date.now() >= deadline) { giveUp(); return; }
      if (reading) return;
      reading = true;
      polls += 1;
      const last = polls >= PAIRING_POLL_LIMIT;
      onLoadCatalogPairing()
        .then((next) => {
          if (cancelled) return;
          // Sem ler a fila, fica o que a tela já sabia sobre ela.
          setStatus((current) => ({ ...next, inProgress: next.inProgress ?? current.inProgress }));
          if (next.inProgress === false) setPolling(false);
          else if (last) giveUp();
        })
        .catch(() => { if (!cancelled && last) giveUp(); })
        .finally(() => { reading = false; });
    }, PAIRING_POLL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [polling, onLoadCatalogPairing]);

  const request = () => {
    if (requesting) return;
    if (!onRequestCatalogPairing) { toast('Busca na fila — o resultado aparece em cerca de 1 minuto', 'ok'); return; }
    setRequesting(true);
    onRequestCatalogPairing()
      .then(({ status: queued }) => {
        toast(queued === 'enfileirado' ? 'Busca na fila — o resultado aparece em cerca de 1 minuto' : 'Já há uma busca em andamento', queued === 'enfileirado' ? 'ok' : 'info');
        setStatus((current) => ({ ...current, inProgress: true }));
        setPolling(true);
      })
      .catch((error: unknown) => { toast(errorMessage(error, 'Falha ao pedir a busca'), 'warn'); })
      .finally(() => setRequesting(false));
  };

  return { status, stale, requesting, request };
}

export type TeamCardsState = ReturnType<typeof useTeamCards>;
