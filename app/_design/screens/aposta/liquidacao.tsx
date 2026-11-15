"use client";

import type { ReactNode } from "react";
import type { SettlementCard } from "../../adapters/aposta";
import { useDesign } from "../../kit/context";
import { porFaixa } from "../../kit/faixas";
import { Cap, Panel } from "../../kit/primitives";

const SCORE_LABEL: Record<NonNullable<SettlementCard["score"]>["kind"], string> = {
  decided: 'Placar final',
  seen: 'O FlashScore viu',
  partial: 'Última leitura do FlashScore',
};

const HALF_SCORE_LABEL: Record<NonNullable<SettlementCard["score"]>["kind"], string> = {
  decided: 'Placar do 1º tempo',
  seen: 'O FlashScore viu no 1º tempo',
  partial: 'Última leitura do 1º tempo',
};

/**
 * A prova do resultado que está valendo: quem liquidou, o placar e o jogo que
 * o FlashScore viu, o que a IA achou e a conferência que veio depois. Encurta
 * a conferência do dono sem sair da ficha; o Telegram só mostra na hora.
 */
export function SettlementPanel({ card }: { card: SettlementCard }) {
  const { T, numFont } = useDesign();
  const faint = { color: T.textFaint };
  const linkStyle = { color: T.accent, fontWeight: 600, textDecoration: 'none' };
  const { score, judge } = card;

  const fields: Array<{ label: string; value: ReactNode }> = [
    { label: 'Decidida por', value: card.source },
    { label: 'Quando', value: <span style={numFont}>{card.at}</span> },
    ...(score ? [{
      label: (score.period === "HT" ? HALF_SCORE_LABEL : SCORE_LABEL)[score.kind],
      value: <span><b style={numFont}>{score.value}</b>{score.detail ? <span style={faint}> · {score.detail}</span> : null}</span>,
    }] : []),
    ...(card.fixture ? [{ label: 'Jogo no FlashScore', value: card.fixture }] : []),
    ...(card.outcome ? [{ label: 'Como', value: card.outcome }] : []),
    ...(card.player ? [{ label: 'Jogador', value: card.player }] : []),
    // Sem modelo, a regra leu o snapshot do FlashScore: não há "certeza" a mostrar.
    ...(judge && !judge.model ? [
      { label: 'O FlashScore mostrou', value: <>&ldquo;{judge.found}&rdquo;</> },
      { label: 'Fonte', value: 'regra sobre os dados do FlashScore' },
    ] : []),
    ...(judge?.model ? [
      { label: 'A IA achou', value: <>&ldquo;{judge.found}&rdquo;</> },
      { label: 'Certeza da IA', value: <span style={numFont}>{judge.confidence}</span> },
      { label: 'Fonte da IA', value: judge.link
        ? <a href={judge.link} target="_blank" rel="noopener noreferrer" style={linkStyle}>abrir em {judge.site}</a>
        : judge.fromFlashscore
          ? 'dados do FlashScore'
          : <span style={faint}>— sem link de fonte confiável</span> },
    ] : []),
    ...(card.crossCheck ? [{ label: 'Conferência', value: card.crossCheck }] : []),
  ];

  return (
    <Panel>
      <h3 style={{ margin: '0 0 4px', fontFamily: T.font.display, fontSize: 17, fontWeight: 600, color: T.text, letterSpacing: '-0.01em' }}>Como foi liquidada</h3>
      <div style={{ fontSize: 12.5, color: T.textFaint, marginBottom: 16 }}>De onde veio o resultado que está valendo</div>
      <div {...porFaixa({ display: 'grid', gap: 20 }, { gridTemplateColumns: { largo: 'repeat(4,1fr)', medio: 'repeat(2,1fr)' } })}>
        {fields.map(({ label, value }) => (
          <div key={label} style={{ minWidth: 0 }}>
            <Cap style={{ fontSize: 9.5, marginBottom: 7 }}>{label}</Cap>
            <div style={{ fontFamily: T.font.body, fontSize: 13.5, color: T.text, overflowWrap: 'anywhere' }}>{value}</div>
          </div>
        ))}
      </div>
      {judge?.reason ? (
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: `1px solid ${T.borderSoft}` }}>
          <Cap style={{ fontSize: 9.5, marginBottom: 7 }}>{judge.model ? `Motivo da IA · ${judge.model}` : 'Motivo'}</Cap>
          <p style={{ margin: 0, fontFamily: T.font.body, fontSize: 13.5, color: T.text, lineHeight: 1.5, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{judge.reason}</p>
        </div>
      ) : null}
    </Panel>
  );
}
