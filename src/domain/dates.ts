/**
 * Datas no fuso do operador — convenção do projeto: armazenar UTC, interpretar/exibir em America/Sao_Paulo. SP é UTC-3 fixo
 * (sem horário de verão desde 2019), o que permite conversão aritmética.
 * Toda conversão de fuso passa por aqui — nunca ad-hoc.
 */

import { assertValidDate, spToUtc, utcToSpParts } from "@/src/domain/dates-parsing";
export * from "@/src/domain/dates-parsing";

/** Chave de dia no fuso SP ("2026-06-15") — agrupamentos diários. */
export function spDayKey(date: Date): string {
  assertValidDate(date, "spDayKey");
  return utcToSpParts(date).toISOString().slice(0, 10);
}

/**
 * Nomes de dia e de mês, uma fonte só para as telas e o servidor. Capitalizados,
 * como rótulo; na prosa ("13 de junho"), `toLowerCase()`.
 */
export const WEEKDAY_NAMES = [
  "Domingo", "Segunda-feira", "Terça-feira", "Quarta-feira",
  "Quinta-feira", "Sexta-feira", "Sábado",
] as const;
export const MONTH_NAMES = [
  "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
  "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
] as const;
/** "Dom", "Seg"… e "Jan", "Fev"…: as três primeiras letras do nome. */
export const WEEKDAY_ABBREVIATIONS: readonly string[] = WEEKDAY_NAMES.map((d) => d.slice(0, 3));
export const MONTH_ABBREVIATIONS: readonly string[] = MONTH_NAMES.map((m) => m.slice(0, 3));

/** "16:00" no fuso SP. */
export function formatSpTime(date: Date): string {
  assertValidDate(date, "formatSpTime");
  const sp = utcToSpParts(date);
  return `${String(sp.getUTCHours()).padStart(2, "0")}:${String(sp.getUTCMinutes()).padStart(2, "0")}`;
}

/** "15/06" no fuso SP — data sem hora e sem ano (janela de cartão). */
export function formatSpDayMonth(date: Date): string {
  assertValidDate(date, "formatSpDayMonth");
  const sp = utcToSpParts(date);
  return `${String(sp.getUTCDate()).padStart(2, "0")}/${String(sp.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** "15/06 16:00" no fuso SP. */
export function formatSpDateTime(date: Date): string {
  // A validação fica aqui mesmo delegando: o contrato fail-loud é que a
  // mensagem nomeie o formatador que RECEBEU a data inválida. Sem esta linha o
  // erro sai como `formatSpDayMonth`, e quem lê o log procura o chamador errado.
  assertValidDate(date, "formatSpDateTime");
  return `${formatSpDayMonth(date)} ${formatSpTime(date)}`;
}


/** "04/02/2026" no fuso SP — data sem hora (ex.: abertura de conta). */
export function formatSpDateWithYear(date: Date): string {
  assertValidDate(date, "formatSpDateWithYear");
  const sp = utcToSpParts(date);
  return `${String(sp.getUTCDate()).padStart(2, "0")}/${String(sp.getUTCMonth() + 1).padStart(2, "0")}/${sp.getUTCFullYear()}`;
}

/** Saudação pelo período do dia no fuso SP ("Bom dia"/"Boa tarde"/"Boa noite"). */
export function spGreeting(now: Date = new Date()): string {
  assertValidDate(now, "spGreeting");
  const h = utcToSpParts(now).getUTCHours();
  if (h < 6) return "Boa noite";
  if (h < 12) return "Bom dia";
  if (h < 18) return "Boa tarde";
  return "Boa noite";
}

/** "Sábado, 13 de junho" no fuso SP — cabeçalho do resumo de hoje. */
export function formatSpFullDate(date: Date): string {
  assertValidDate(date, "formatSpFullDate");
  const sp = utcToSpParts(date);
  const weekday = WEEKDAY_NAMES[sp.getUTCDay()] ?? "";
  return `${weekday}, ${sp.getUTCDate()} de ${(MONTH_NAMES[sp.getUTCMonth()] ?? "").toLowerCase()}`;
}

/** Início do dia de hoje (00:00 SP) como instante UTC — janelas "de hoje". */
export function spStartOfTodayUtc(now: Date = new Date()): Date {
  assertValidDate(now, "spStartOfTodayUtc");
  const sp = utcToSpParts(now);
  return spToUtc({ year: sp.getUTCFullYear(), month: sp.getUTCMonth() + 1, day: sp.getUTCDate() });
}

/** Tempo relativo curto ("agora", "há 12 min", "em 3 h", "há 2 d"). */
export function spRelative(date: Date, now: Date = new Date()): string {
  assertValidDate(date, "spRelative");
  assertValidDate(now, "spRelative");
  const deltaMs = now.getTime() - date.getTime();
  if (Math.abs(deltaMs) < 60_000) return "agora";
  if (deltaMs < 0) {
    const futureMinutes = Math.floor(-deltaMs / 60_000);
    if (futureMinutes < 60) return `em ${futureMinutes} min`;
    const futureHours = Math.floor(futureMinutes / 60);
    if (futureHours < 24) return `em ${futureHours} h`;
    return `em ${Math.floor(futureHours / 24)} d`;
  }

  const min = Math.floor(deltaMs / 60_000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

/** Duração em minutos, curta ("<1 min", "12 min", "2.5 h", "10 h", "3 dias"); "—" sem valor. */
export function formatDurationMinutes(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return "—";
  if (minutes < 1) return "<1 min";
  if (minutes < 60) return `${Math.round(minutes)} min`;
  if (minutes >= 48 * 60) return `${Math.floor(minutes / (24 * 60))} dias`;
  return `${(minutes / 60).toFixed(minutes < 600 ? 1 : 0)} h`;
}

/** Chave de semana ISO no fuso SP ("2026-W24") + intervalo seg–dom. */
export function spWeekKey(date: Date): string {
  assertValidDate(date, "spWeekKey");
  const sp = utcToSpParts(date);
  const d = new Date(Date.UTC(sp.getUTCFullYear(), sp.getUTCMonth(), sp.getUTCDate()));
  const dayNum = d.getUTCDay() || 7; // seg=1 … dom=7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum); // quinta da semana ISO
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}
