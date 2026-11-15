import { useState } from "react";
import { uiHexA } from "../../utils";
import { useDesign } from "../../kit/context";
import { MANUAL_BET_MARKETS } from "./constants";
import { fieldStyle, FormField } from "../../kit/form";
import { SPORT_OPTIONS } from "../../lib/sport-options";
import styles from "./add-bet-sheet.module.css";
import { cssVars } from "../../kit/css-vars";
import type { useAddBet } from "./use-add-bet";

type AddBetForm = ReturnType<typeof useAddBet>;

export function AddBetSheet({
  todayKey, formCb, formErr, preview, addBet, registering, onClose,
}: Pick<AddBetForm, "formCb" | "formErr" | "preview" | "addBet" | "registering"> & {
  todayKey: string;
  onClose: () => void;
}) {
  const { T, numFont } = useDesign();
  const [market, setMarket] = useState('Total');
  // Trocar o mercado limpa a seleção: um "Over 2.5" não sobra num 1X2.
  const [line, setLine] = useState('');
  return (
    <div ref={formCb} className={styles.scroll} style={cssVars({ '--add-border': T.border, '--add-border-soft': T.borderSoft, '--add-text': T.text, '--add-muted': T.textMuted, '--add-faint': T.textFaint, '--add-pos': T.pos, '--add-neg': T.neg, '--add-accent': T.accent, '--add-accent-text': T.accentText, '--add-body': T.font.body, '--add-num': T.font.num, '--add-radius-md': `${T.radiusMd}px`, '--add-shadow': `0 8px 20px -8px ${uiHexA(T.accent, 0.55)}` })}>
      <div className={styles.grid}>
        <FormField label="Mandante"><input name="home" maxLength={145} style={fieldStyle(T)} placeholder="Time A" /></FormField>
        <FormField label="Visitante"><input name="away" maxLength={145} style={fieldStyle(T)} placeholder="Time B" /></FormField>
        <FormField label="Esporte"><select name="esporte" defaultValue="Soccer" style={fieldStyle(T)}>
          {SPORT_OPTIONS.map(({ value, label }) => <option key={value} value={value}>{label}</option>)}
        </select></FormField>
        <FormField label="País / região" hint="ex.: Brasil"><input name="region" maxLength={100} style={fieldStyle(T)} placeholder="Brasil" /></FormField>
        <FormField label="Competição / liga" span hint="ex.: Série A"><input name="competition" maxLength={200} style={fieldStyle(T)} placeholder="Série A" /></FormField>
        <FormField label="Mercado"><select name="market" value={market} onChange={(event) => { setMarket(event.target.value); setLine(''); }} style={fieldStyle(T)}>
          {Object.keys(MANUAL_BET_MARKETS).map((o) => <option key={o}>{o}</option>)}
        </select></FormField>
        <FormField label="Seleção / linha"><input name="line" list="add-bet-line-suggestions" maxLength={200} value={line} onChange={(event) => setLine(event.target.value)} style={fieldStyle(T)} placeholder={MANUAL_BET_MARKETS[market]?.[0]} />
          <datalist id="add-bet-line-suggestions">{(MANUAL_BET_MARKETS[market] ?? []).map((o) => <option key={o} value={o} />)}</datalist>
        </FormField>
        <FormField label="Odds de entrada"><input name="odds" type="text" inputMode="decimal" className={styles.numericInput} style={fieldStyle(T)} placeholder="1,950" /></FormField>
        <FormField label="Stake (unidades)"><input name="stake" type="text" inputMode="decimal" defaultValue="0,50" className={styles.numericInput} style={fieldStyle(T)} /></FormField>
        <FormField label="Data"><input name="date" type="date" defaultValue={todayKey} className={styles.numericInput} style={fieldStyle(T)} /></FormField>
        <FormField label="Hora" hint="em branco = horário a confirmar (hoje em diante)"><input name="time" type="time" className={styles.numericInput} style={fieldStyle(T)} /></FormField>
        <FormField label="Casa de apostas (opcional)" span><input name="casa" maxLength={100} style={fieldStyle(T)} placeholder="ex.: Bet365" /></FormField>
      </div>
      <div className={styles.bottom}>
        {formErr && <div className={styles.error}>{formErr}</div>}
        <div className={styles.footer}>
          <div className={styles.summary}>
            Retorno potencial <b className={styles.value} style={numFont}>{preview.ret}</b>
            <span className={styles.separator}> · </span>lucro <b className={`${styles.value} ${styles.profit}`} style={numFont}>{preview.luc}</b>
          </div>
          <div className={styles.actions}>
            <button type="button" onClick={onClose} className={`${styles.button} ${styles.cancel}`}>Cancelar</button>
            <button type="button" onClick={addBet} disabled={registering} aria-busy={registering} className={`${styles.button} ${styles.submit}`}>
              {registering ? "Adicionando…" : "Adicionar aposta"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
