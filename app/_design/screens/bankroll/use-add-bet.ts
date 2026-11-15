import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import { fmtU, fmtUnit } from "@/src/domain/formato-de-resultado";
import type { ManualBetInput } from "@/src/domain/manual-bet";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import type { BankrollActions } from "../../action-contracts";
import { errorMessage, toast } from "../../toast";
import type { LocalBet, Overlay } from "./types";

type Preview = { ret: string; luc: string };
const EMPTY_PREVIEW: Preview = { ret: "—", luc: "—" };

// Lê os campos pelo `name` na hora de enviar, também os que a folha controla (mercado e seleção).
function fieldReader(form: HTMLElement) {
  return (name: string) => form.querySelector<HTMLInputElement | HTMLSelectElement>(`[name="${name}"]`)?.value || "";
}

type ParsedForm =
  | { error: string }
  | { input: ManualBetInput; localBet: LocalBet };

/** Valida o formulário e monta o pedido ao servidor e a aposta otimista. */
function parseAddBetForm(form: HTMLElement, todayKey: string): ParsedForm {
  const get = fieldReader(form);
  const home = get("home").trim();
  const away = get("away").trim();
  const line = get("line").trim();
  const odds = parseDecimalInput(get("odds"));
  const stake = parseDecimalInput(get("stake"));
  if (!home || !away || !line || odds === null || stake === null || !(odds > 1) || !(stake > 0)) {
    return { error: "Preencha mandante, visitante, seleção, odds (> 1.00) e stake (> 0)." };
  }
  const date = get("date") || todayKey;
  // Em branco = horário a confirmar; o servidor grava o dia com esse marcador.
  // Num dia que já passou, a primeira busca de horário que falhar encerra a
  // aposta como sem par, sem a recuperação do histórico: aí a hora é pedida.
  const time = get("time");
  if (!time && date < todayKey) return { error: "Jogo de dia que já passou: informe a hora." };
  const [, month, day] = date.split("-");
  const input = {
    home,
    away,
    date,
    time,
    esporte: get("esporte") || "Soccer",
    region: get("region").trim() || "Outros",
    competition: get("competition").trim() || undefined,
    market: get("market") || "Total",
    line,
    odds,
    stake,
    casa: get("casa").trim() || undefined,
  };
  const localBet: LocalBet = {
    id: `u${Date.now()}`,
    day: date,
    time: time || "—",
    kickoffInferido: !time,
    allowsHalfResult: admitsAsianFractionalSettlement(input.market, input.line),
    home,
    away,
    esporte: input.esporte,
    region: input.region,
    league: input.competition || null,
    market: input.market,
    line: input.line,
    odds,
    clv: null,
    stake,
    status: "pending",
    profit: null,
    d: {
      open: odds,
      close: null,
      liqOpen: null,
      liqClose: null,
      eventAt: time ? `${day}/${month} ${time}` : `${day}/${month} · horário a confirmar`,
      casa: input.casa || null,
      capturedAt: "agora",
      before: "entrada manual",
      origin: "Manual",
      msg: null,
      moveType: null,
    },
  };
  return { input, localBet };
}

/** Retorno e lucro potenciais enquanto o operador digita; "—" até o mínimo estar preenchido. */
function previewFrom(form: HTMLElement): Preview {
  const get = fieldReader(form);
  const odds = parseDecimalInput(get("odds"));
  const stake = parseDecimalInput(get("stake"));
  const complete = get("home").trim() && get("away").trim()
    && odds !== null && stake !== null && odds > 1 && stake > 0;
  return complete
    ? { ret: fmtUnit(stake * odds), luc: fmtU(stake * (odds - 1)) }
    : EMPTY_PREVIEW;
}

// Nós já com o ouvinte do preview: o ref de callback roda a cada render.
const wiredForms = new WeakSet<HTMLElement>();

export function useAddBet({ slug, todayKey, overlay, setOverlay, setExtraBets, onRegisterBet }: {
  slug: string | undefined;
  todayKey: string;
  overlay: Overlay | null;
  setOverlay: (overlay: Overlay | null) => void;
  setExtraBets: Dispatch<SetStateAction<LocalBet[]>>;
  onRegisterBet: BankrollActions["onRegisterBet"];
}) {
  const formRef = useRef<HTMLElement | null>(null);
  const requestId = useRef<string | null>(null);
  const [formErr, setFormErr] = useState("");
  const [preview, setPreview] = useState<Preview>(EMPTY_PREVIEW);
  const [registering, setRegistering] = useState(false);

  useEffect(() => {
    if (overlay === "adicionar") {
      requestId.current = null;
      setFormErr("");
      setPreview(EMPTY_PREVIEW);
    }
  }, [overlay, slug]);

  const addBet = () => {
    if (registering) return;
    const form = formRef.current;
    if (!form) return;
    const parsed = parseAddBetForm(form, todayKey);
    if ("error" in parsed) {
      setFormErr(parsed.error);
      return;
    }
    const { input, localBet } = parsed;
    if (!onRegisterBet || !slug) {
      setExtraBets((current) => [localBet, ...current]);
      setOverlay(null);
      return;
    }
    setFormErr("");
    setRegistering(true);
    const registrationId = requestId.current ??= crypto.randomUUID();
    return onRegisterBet(slug, { ...input, requestId: registrationId })
      .then((result) => {
        if (!result.created) {
          setFormErr("Esta aposta já está cadastrada neste tipster.");
          toast("Aposta já cadastrada", "info");
          return;
        }
        setExtraBets((current) => [{ ...localBet, id: result.betId }, ...current]);
        setOverlay(null);
        toast("Aposta registrada", "ok");
      })
      .catch((error: unknown) => {
        const message = errorMessage(error, "Falha ao registrar aposta");
        setFormErr(message);
        toast(message, "warn");
      })
      .finally(() => setRegistering(false));
  };

  const formCb = (node: HTMLElement | null) => {
    formRef.current = node;
    if (node && !wiredForms.has(node)) {
      wiredForms.add(node);
      node.addEventListener("input", () => setPreview(previewFrom(node)));
    }
  };

  return { formErr, preview, registering, addBet, formCb };
}
