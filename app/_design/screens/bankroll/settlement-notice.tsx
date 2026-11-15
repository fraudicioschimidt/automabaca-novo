"use client";
import { fmtBrl, fmtOdds, fmtUnit } from "@/src/domain/formato-de-resultado";
import type { CSSProperties } from "react";
import { formatSpDateTime } from "@/src/domain/dates";
import type { ManualSettlementView } from "@/src/domain/manual-settlement";
import { rotuloDeStatus } from "@/src/domain/status-de-aposta";
import { useDesign } from "../../kit/context";
import type { SettleTarget } from "./types";
import type { SettlementNotice as Notice } from "./use-manual-settlement";

type ViewKey = keyof ManualSettlementView;

const fields: Array<[ViewKey, string]> = [
  ["event", "Evento"], ["market", "Mercado"], ["selection", "Seleção"], ["date", "Horário"],
  ["sport", "Esporte"], ["competition", "Competição"], ["country", "País"],
  ["bookmaker", "Casa"], ["odds", "Odd"], ["stake", "Stake"], ["unitValue", "Unidade"],
  ["status", "Resultado"], ["profit", "Lucro (u)"],
  ["liveScoreHome", "Placar na entrada (mandante)"], ["liveScoreAway", "Placar na entrada (visitante)"],
];
const value = (field: ViewKey, content: ManualSettlementView[ViewKey]) => field === "status" ? rotuloDeStatus(String(content))
  : field === "date" ? formatSpDateTime(new Date(String(content))) : String(content ?? "—");

export function SettlementNotice({ notice, labels, busy, onConfirm, onClose }: {
  notice: Notice<SettleTarget>;
  labels: Record<string, string>;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { T } = useDesign();
  const current = notice.kind === "conflict" ? notice.current : null;
  const changed = current ? fields.filter(([key]) => notice.view?.[key] !== current[key]) : [];
  const button: CSSProperties = { padding: "10px 14px", minHeight: 44, borderRadius: T.radiusSm, border: `1px solid ${T.border}`, cursor: busy ? "wait" : "pointer", font: "inherit" };
  return <div style={{ padding: 20, color: T.text, lineHeight: 1.5 }}>
    {notice.kind === "conflict" ? <>
      <p>Os dados mudaram desde que você abriu o resultado. Sua escolha foi mantida; confira os dados atuais antes de confirmar novamente.</p>
      <p><strong>{notice.current.event}</strong><br />{notice.current.market} · {notice.current.selection}<br />{formatSpDateTime(new Date(notice.current.date))}{notice.current.kickoffInferred ? " (horário provisório)" : ""}</p>
      <p>Resultado atual: <strong>{rotuloDeStatus(notice.current.status)}</strong> · Stake: {fmtUnit(notice.current.stake)} · Odd: {fmtOdds(notice.current.odds)} · Unidade: {fmtBrl(notice.current.unitValue)}</p>
      {changed.length > 0 ? <ul aria-label="O que mudou">{changed.map(([key, label]) => <li key={key}>
        {label}: {notice.view ? value(key, notice.view[key]) : "não disponível"} → <strong>{value(key, notice.current[key])}</strong>
      </li>)}</ul> : <p>Outros dados relevantes da aposta foram atualizados, ou houve uma alteração seguida de correção.</p>}
    </> : <p role="alert">{notice.message}</p>}
    {notice.kind !== "unavailable" && <p>Sua escolha: <strong>{labels[notice.result]}</strong>{notice.result === "cashout" ? ` · lucro ${notice.cashoutLucro} u` : ""}.</p>}
    <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 20 }}>
      <button type="button" disabled={busy} onClick={onClose} style={{ ...button, background: T.surface2, color: T.text }}>Fechar</button>
      {notice.kind !== "unavailable" && <button type="button" disabled={busy} onClick={onConfirm} style={{ ...button, background: T.accent, color: T.accentText }}>
        {busy ? "Confirmando…" : notice.kind === "conflict" ? `Confirmar ${labels[notice.result]} com estes dados` : "Tentar novamente"}
      </button>}
    </div>
  </div>;
}
