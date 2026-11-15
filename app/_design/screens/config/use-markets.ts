"use client";
import { useRef, useState } from "react";
import { normalizeMercadoKey } from "@/src/domain/mercados/catalog";
import type { ConfigActions } from "../../action-contracts";
import { errorMessage, toast } from "../../toast";
import type { Market } from "./types";

/**
 * Taxonomia de mercados: a lista muda depois da confirmação do servidor.
 * A mesma normalização do cadastro evita duas grafias para um alias. Sem action (?mock=1) valem só na tela.
 */
export function useMarkets(initial: readonly Market[], { onAddAlias, onRemoveAlias }: Pick<ConfigActions, "onAddAlias" | "onRemoveAlias">) {
  const [markets, setMarkets] = useState<Market[]>(() => initial.map((m) => ({ ...m, aliases: [...m.aliases] })));
  const [mq, setMq] = useState('');
  const [addAlias, setAddAlias] = useState<{ canon: string | null; val: string }>({ canon: null, val: '' });

  const setAliases = (canon: string, update: (aliases: string[]) => string[]) =>
    setMarkets((arr) => arr.map((m) => m.canon === canon ? { ...m, aliases: update(m.aliases) } : m));
  const inFlight = useRef(new Set<string>());
  const [pendingMarkets, setPendingMarkets] = useState<ReadonlySet<string>>(() => new Set());
  const updatePending = (canon: string, busy: boolean) => {
    if (busy) inFlight.current.add(canon); else inFlight.current.delete(canon);
    setPendingMarkets(new Set(inFlight.current));
  };
  const removeAlias = async (canon: string, alias: string) => {
    if (inFlight.current.has(canon)) return;
    updatePending(canon, true);
    try {
      await onRemoveAlias?.(canon, alias);
      setAliases(canon, (aliases) => aliases.filter((a) => a !== alias));
    } catch (error) { toast(errorMessage(error, 'Falha ao remover alias'), 'warn'); }
    finally { updatePending(canon, false); }
  };
  const commitAlias = async (canon: string) => {
    const value = addAlias.val.trim();
    if (!value || addAlias.canon !== canon || inFlight.current.has(canon)) return;
    updatePending(canon, true);
    try {
      await onAddAlias?.(canon, value);
      const key = normalizeMercadoKey(value);
      setAliases(canon, (aliases) => {
        const index = aliases.findIndex((alias) => normalizeMercadoKey(alias) === key);
        return index < 0 ? [...aliases, value] : aliases.map((alias, i) => i === index ? value : alias);
      });
      setAddAlias((current) => current.canon === canon && current.val.trim() === value ? { canon: null, val: '' } : current);
      toast('Alias adicionado', 'ok');
    } catch (error) { toast(errorMessage(error, 'Falha ao adicionar alias'), 'warn'); }
    finally { updatePending(canon, false); }
  };

  return { pendingMarkets, markets, mq, setMq, addAlias, setAddAlias, commitAlias, removeAlias };
}

export type MarketsState = ReturnType<typeof useMarkets>;
