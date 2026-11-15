"use client";

import type { ApostaData, ApostaActions } from "../../action-contracts";
import { useState, type ChangeEvent, type ReactNode } from "react";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import { ModalForm } from "../../kit/ModalForm";
import { toast } from "../../toast";
import styles from "./bet-actions.module.css";

function Field({ label, children, wide = false }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <label className={wide ? styles.fieldWide : styles.field}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  );
}

type Props = {
  b: NonNullable<ApostaData>;
  action: "edit" | "delete";
  onClose: () => void;
  onEdit?: ApostaActions["onEditBet"];
  onDelete?: ApostaActions["onDeleteBet"];
};

export function BetActions({ b, action, onClose, onEdit, onDelete }: Props) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  // A revisão da aposta vista ao abrir, junto com o formulário: se um worker
  // gravar enquanto ele está aberto, o servidor recusa em vez de devolver os
  // valores velhos.
  const [version] = useState(b.settlementView?.version ?? null);
  const [form, setForm] = useState({
    home: b.home || "",
    away: b.away || "",
    date: b.day || "",
    // "—" é o rótulo do horário a confirmar, não uma hora: o campo começa vazio.
    time: b.kickoffInferido ? "" : b.time || "",
    esporte: b.esporte || "Soccer",
    competition: b.league || "",
    region: b.region || "",
    market: b.market || "",
    line: b.line || "",
    odds: String(b.odds ?? ""),
    stake: String(b.stake ?? ""),
    casa: b.d?.casa || "",
  });
  const set = (key: keyof typeof form) => (event: ChangeEvent<HTMLInputElement>) => {
    setError("");
    setForm((current) => ({ ...current, [key]: event.target.value }));
  };
  const odds = parseDecimalInput(form.odds);
  const stake = parseDecimalInput(form.stake);
  const canSave =
    form.home.trim() &&
    form.away.trim() &&
    form.date &&
    // Vazio mantém o horário a confirmar; só a aposta com horário confirmado exige a hora.
    (form.time || b.kickoffInferido) &&
    form.market.trim() &&
    form.line.trim() &&
    odds !== null && odds > 1 &&
    stake !== null && stake > 0;

  const submitEdit = async () => {
    if (!canSave || odds === null || stake === null || !onEdit || !b.bkSlug || version === null || pending) return;
    setPending(true);
    setError("");
    try {
      const { requiresEnrich } = await onEdit(b.bkSlug, b.id, {
        ...form,
        home: form.home.trim(),
        away: form.away.trim(),
        odds,
        stake,
      }, version);
      toast(requiresEnrich ? "Aposta atualizada e reenviada para análise" : "Aposta atualizada; o jogo casado continua valendo", "ok");
      onClose();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível editar a aposta.";
      setError(message);
      toast(message, "warn");
    } finally {
      setPending(false);
    }
  };

  const submitDelete = async () => {
    if (!onDelete || !b.bkSlug || pending) return;
    setPending(true);
    setError("");
    try {
      await onDelete(b.bkSlug, b.id);
      toast("Aposta excluída; histórico e auditoria preservados", "ok");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Não foi possível excluir a aposta.";
      setError(message);
      setPending(false);
      toast(message, "warn");
    }
  };

  if (action === "delete") {
    return (
      <ModalForm
        pending={pending}
        onClose={onClose}
        title="Excluir aposta"
        sub={`${b.home} vs ${b.away}`}
        submitLabel="Excluir aposta"
        submitTone="neg"
        canSubmit={Boolean(onDelete && b.bkSlug)}
        onSubmit={submitDelete}
      >
        <div className={styles.deleteCopy}>
          A aposta sairá das telas e qualquer resultado lançado será estornado da conta vinculada. O registro não é apagado fisicamente: origem, histórico financeiro e auditoria continuam preservados.
        </div>
        {error ? <div className={styles.error} role="alert">{error}</div> : null}
      </ModalForm>
    );
  }

  return (
    <ModalForm
      pending={pending}
      onClose={onClose}
      title="Editar aposta"
      sub="Corrija o evento, mercado, entrada ou vínculo financeiro"
      submitLabel="Salvar alterações"
      canSubmit={Boolean(canSave && onEdit && b.bkSlug && version !== null)}
      onSubmit={submitEdit}
      width={680}
    >
      {b.status !== "pending" ? (
        <div className={styles.warning}>
          Esta aposta já tem resultado. Ao salvar, o lançamento anterior será estornado e ela voltará para Pendente antes de uma nova liquidação.
        </div>
      ) : null}
      <div className={styles.grid}>
        <Field label="Mandante"><input value={form.home} onChange={set("home")} className={styles.input} /></Field>
        <Field label="Visitante"><input value={form.away} onChange={set("away")} className={styles.input} /></Field>
        <Field label="Data"><input type="date" value={form.date} onChange={set("date")} className={styles.input} /></Field>
        <Field label="Horário (São Paulo)"><input type="time" value={form.time} onChange={set("time")} className={styles.input} /></Field>
        <Field label="Esporte"><input value={form.esporte} onChange={set("esporte")} className={styles.input} /></Field>
        <Field label="Competição"><input value={form.competition} onChange={set("competition")} className={styles.input} /></Field>
        <Field label="Região"><input value={form.region} onChange={set("region")} className={styles.input} /></Field>
        <Field label="Casa de aposta"><input value={form.casa} onChange={set("casa")} className={styles.input} /></Field>
        <Field label="Mercado"><input value={form.market} onChange={set("market")} className={styles.input} /></Field>
        <Field label="Seleção / linha"><input value={form.line} onChange={set("line")} className={styles.input} /></Field>
        <Field label="Odd"><input inputMode="decimal" value={form.odds} onChange={set("odds")} className={`${styles.input} ${styles.number}`} /></Field>
        <Field label="Stake (u)"><input inputMode="decimal" value={form.stake} onChange={set("stake")} className={`${styles.input} ${styles.number}`} /></Field>
      </div>
      {b.kickoffInferido ? <div className={styles.help}>O horário do jogo está a confirmar: deixe o campo vazio para manter assim.</div> : null}
      <div className={styles.help}>Com o jogo já casado, corrigir só a odd, a stake ou a casa mantém o jogo e o fechamento, e o CLV é refeito com a odd nova. Na prop de jogador a casa define a regra de liquidação: trocá-la refaz o processamento, e corrigir a odd ou a stake descarta o fechamento, porque a prop não tem preço de referência. Qualquer outra mudança, ou qualquer correção com o jogo ainda não casado, descarta o fechamento e as métricas sharp antigas, e o processamento roda de novo com os dados corrigidos.</div>
      {error ? <div className={styles.error} role="alert">{error}</div> : null}
    </ModalForm>
  );
}
