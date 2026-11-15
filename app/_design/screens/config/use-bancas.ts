"use client";
import { fmtBrlPerUnit } from "@/src/domain/formato-de-resultado";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { roundMoney } from "@/src/domain/money";
import { parseMoneyInput } from "@/src/domain/decimal-input";
import type { ConfigActions } from "../../action-contracts";
import { errorMessage, toast } from "../../toast";
import type { Banca, BancaForm, BancaOverlay } from "./types";

type BancaActions = Pick<ConfigActions, "onCreateBanca" | "onEditBanca" | "onRemoveBanca" | "onUploadLogo" | "onRemoveLogo">;

const NOVA_BANCA = { name: '', unit: '100', channel: '' };

/** Mesmos centavos do banco; valor inválido não sai do formulário. */
function parseUnitValue(raw: string): number | null {
  const parsed = parseMoneyInput(raw);
  if (parsed === null || parsed <= 0) return null;
  try {
    const value = roundMoney(parsed, 2);
    return value > 0 ? value : null;
  } catch {
    return null;
  }
}

/**
 * Bancas: a lista, o formulário de criação e o modal de editar/excluir. Criar e
 * editar/excluir esperam a action. Logos têm prévia local, mas a resposta só
 * atualiza o formulário que iniciou o envio. Sem action (?mock=1) tudo vale só na tela.
 */
export function useBancas(initial: readonly Banca[], canManage: boolean, actions: BancaActions) {
  const { onCreateBanca, onEditBanca, onRemoveBanca, onUploadLogo, onRemoveLogo } = actions;
  const [bancas, setBancas] = useState<Banca[]>(() => initial.map((b) => ({ ...b })));
  const [adding, setAdding] = useState(false);
  const [newBanca, setNewBanca] = useState(NOVA_BANCA);
  const [ov, setOv] = useState<BancaOverlay | null>(null);
  const [bform, setBform] = useState<BancaForm>({});
  const [pend, setPend] = useState(false);
  const [logoBusy, setLogoBusy] = useState(false);
  const [creating, setCreating] = useState(false);
  const createInFlight = useRef(false);
  const createRequestId = useRef<string | null>(null);
  useEffect(() => { if (!adding) createRequestId.current = null; }, [adding]);
  const logoInFlight = useRef(false);
  const formGeneration = useRef(0);
  const previewUrls = useRef(new Set<string>());
  useEffect(() => {
    const urls = previewUrls.current;
    return () => { for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  }, []);

  // /config?nova=1 é o destino do "Novo bankroll": abre o formulário direto.
  useEffect(() => { if (canManage && typeof location !== 'undefined' && new URLSearchParams(location.search).get('nova') !== null) setAdding(true); }, [canManage]);

  const patchBanca = (id: string, patch: Partial<Banca>) => setBancas((arr) => arr.map((x) => x.id === id ? { ...x, ...patch } : x));
  const closeOv = () => { if (!pend) { formGeneration.current += 1; setOv(null); setBform({}); } };
  /** Ação do modal: uma por vez, fecha no sucesso e mostra o erro sem fechar. */
  const run = async (fn: () => Promise<void>, okMsg: string) => {
    if (pend) return;
    setPend(true);
    try { await fn(); toast(okMsg, 'ok'); setOv(null); setBform({}); }
    catch (e) { toast(errorMessage(e, 'Falha na operação'), 'warn'); }
    finally { setPend(false); }
  };

  const openEdit = (b: Banca) => {
    formGeneration.current += 1;
    setBform({ name: b.name, unit: String(b.unitValue ?? ((b.unit || '').replace(/[^0-9.]/g, '') || '')), channel: b.channelRaw ?? (b.channel === '—' ? '' : b.channel), sharpMode: b.sharpMode || 'CLV_ONLY', capturePolicy: b.capturePolicy || 'AUTO', stakePolicy: b.stakePolicy || 'MESSAGE', defaultStakeUnits: String(b.defaultStakeUnits ?? 1), logoUrl: b.logoUrl || null, channelSports: [...(b.channelSports ?? [])], capturePaused: b.capturePaused === true });
    setOv({ kind: 'editBanca', banca: b });
  };
  const submitEdit = (b: Banca) => {
    if (logoInFlight.current) return;
    const name = (bform.name || '').trim();
    const unit = (bform.unit || '').trim();
    const channel = (bform.channel || '').trim();
    const sharpMode = bform.sharpMode || 'CLV_ONLY';
    const capturePolicy = bform.capturePolicy || 'AUTO';
    const stakePolicy = bform.stakePolicy || 'MESSAGE';
    const defaultStakeUnits = stakePolicy === 'MESSAGE' ? null : (bform.defaultStakeUnits || '').trim();
    const channelSports = bform.channelSports ?? [];
    const capturePaused = bform.capturePaused === true;
    const unitValue = parseUnitValue(unit);
    if (unitValue == null || unitValue <= 0) { toast('Valor da unidade inválido', 'warn'); return; }
    return run(async () => {
      if (onEditBanca) await onEditBanca({ id: b.id, name, unit, channel, sharpMode, capturePolicy, stakePolicy, defaultStakeUnits, channelSports, capturePaused });
      patchBanca(b.id, { name, unit: fmtBrlPerUnit(unitValue), unitValue, channel: channel || '—', channelRaw: channel, sharpMode, capturePolicy, stakePolicy, defaultStakeUnits, channelSports, capturePaused, ...(capturePaused === (b.capturePaused === true) ? {} : { pausedSince: null }) });
    }, 'Tipster atualizado');
  };
  const submitRemove = (b: Banca) => run(async () => {
    if (onRemoveBanca) {
      const res = await onRemoveBanca({ id: b.id, expectedBetCount: b.betCount ?? 0 });
      if (!res.ok) {
        // Apostas chegaram (ou saíram) com o modal aberto: mostra o total novo e
        // deixa o operador confirmar de novo.
        patchBanca(b.id, { betCount: res.betCount });
        setOv({ kind: 'removeBanca', banca: { ...b, betCount: res.betCount } });
        throw new Error(res.erro);
      }
    }
    setBancas((arr) => arr.filter((x) => x.id !== b.id));
  }, 'Tipster excluído definitivamente');

  const onPickLogo = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = '';
    if (!file || !ov || logoInFlight.current || pend) return;
    if (file.size > 2 * 1024 * 1024) { toast('Logo grande demais (máx 2MB).', 'warn'); return; }
    const b = ov.banca;
    const prev = bform.logoUrl || null;
    const generation = formGeneration.current;
    const objectUrl = URL.createObjectURL(file);
    previewUrls.current.add(objectUrl);
    logoInFlight.current = true;
    setBform((f) => ({ ...f, logoUrl: objectUrl }));
    setLogoBusy(true);
    Promise.resolve().then(() => onUploadLogo ? onUploadLogo(b.slug, file) : null)
      .then((res) => {
        const url = (res && res.logoUrl) || objectUrl;
        if (formGeneration.current === generation) setBform((f) => ({ ...f, logoUrl: url }));
        patchBanca(b.id, { logoUrl: url });
        toast('Logo atualizada', 'ok');
      })
      .catch((err: unknown) => { if (formGeneration.current === generation) setBform((f) => ({ ...f, logoUrl: prev })); toast(errorMessage(err, 'Falha ao enviar logo'), 'warn'); })
      .finally(() => {
        logoInFlight.current = false; setLogoBusy(false);
        // No protótipo, a URL ainda é a imagem da lista até desmontar.
        if (onUploadLogo) { URL.revokeObjectURL(objectUrl); previewUrls.current.delete(objectUrl); }
      });
  };
  const removeLogo = () => {
    if (!ov || logoInFlight.current || pend) return;
    logoInFlight.current = true;
    const generation = formGeneration.current;
    const b = ov.banca;
    const prev = bform.logoUrl || null;
    setBform((f) => ({ ...f, logoUrl: null }));
    patchBanca(b.id, { logoUrl: null });
    setLogoBusy(true);
    Promise.resolve().then(() => onRemoveLogo ? onRemoveLogo(b.slug) : null)
      .then(() => { toast('Logo removida', 'ok'); })
      .catch((err: unknown) => { if (formGeneration.current === generation) setBform((f) => ({ ...f, logoUrl: prev })); patchBanca(b.id, { logoUrl: prev }); toast(errorMessage(err, 'Falha ao remover'), 'warn'); })
      .finally(() => { logoInFlight.current = false; setLogoBusy(false); });
  };

  const addBanca = async () => {
    if (createInFlight.current) return;
    const name = newBanca.name.trim();
    if (!name) return;
    const unitValue = parseUnitValue(newBanca.unit || '100');
    if (unitValue == null || unitValue <= 0) { toast('Valor da unidade inválido', 'warn'); return; }
    const channel = newBanca.channel.trim();
    createInFlight.current = true; setCreating(true);
    try {
      const requestId = createRequestId.current ??= crypto.randomUUID();
      const result = onCreateBanca ? await onCreateBanca({ name, unit: newBanca.unit || '100', channel, requestId }) : null;
      setBancas((items) => [...items, { id: result?.id ?? crypto.randomUUID(), slug: result?.slug ?? '', name, sharpMode: 'CLV_ONLY', capturePolicy: 'AUTO', unit: fmtBrlPerUnit(unitValue), unitValue, channel: channel || '—', channelRaw: channel, logoUrl: null }]);
      createRequestId.current = null;
      setNewBanca(NOVA_BANCA); setAdding(false);
      toast('Tipster adicionado', 'ok');
    } catch (error) { toast(errorMessage(error, 'Falha ao criar tipster'), 'warn'); }
    finally { createInFlight.current = false; setCreating(false); }
  };

  return {
    lista: {
      bancas, adding, creating, setAdding, newBanca, setNewBanca, addBanca, openEdit,
      onRemove: (b: Banca) => setOv({ kind: 'removeBanca', banca: b }),
    },
    modal: { ov, pend, closeOv, bform, setBform, logoBusy, onPickLogo, removeLogo, submitEdit, submitRemove },
  };
}

export type BancasLista = ReturnType<typeof useBancas>["lista"];
export type BancaModal = ReturnType<typeof useBancas>["modal"];
