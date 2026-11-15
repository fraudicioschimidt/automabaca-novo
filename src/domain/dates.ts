/**
 * Datas no fuso do operador — convenção do projeto: armazenar UTC, interpretar/exibir em America/Sao_Paulo. SP é UTC-3 fixo
 * (sem horário de verão desde 2019), o que permite conversão aritmética.
 * Toda conversão de fuso passa por aqui — nunca ad-hoc.
 */

// As contas moram em Rust (`rust/crates/dominio/src/dates.rs`): no servidor
// pela N-API, nas telas pelo WebAssembly. Aqui fica a conferência do `Date`
// (o nome de quem recebeu a data inválida vai na mensagem) e os nomes de dia e
// de mês das telas.
import dominio from "@automabaca/dominio";
import { assertValidDate } from "@/src/domain/dates-parsing";
export * from "@/src/domain/dates-parsing";

/** Chave de dia no fuso SP ("2026-06-15") — agrupamentos diários. */
export function spDayKey(date: Date): string {
  assertValidDate(date, "spDayKey");
  return dominio.spDayKey(date.getTime());
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
  return dominio.formatSpTime(date.getTime());
}

/** "15/06" no fuso SP — data sem hora e sem ano (janela de cartão). */
export function formatSpDayMonth(date: Date): string {
  assertValidDate(date, "formatSpDayMonth");
  return dominio.formatSpDayMonth(date.getTime());
}

/** "15/06 16:00" no fuso SP. */
export function formatSpDateTime(date: Date): string {
  // A validação fica aqui: o contrato fail-loud é que a mensagem nomeie o
  // formatador que RECEBEU a data inválida.
  assertValidDate(date, "formatSpDateTime");
  return dominio.formatSpDateTime(date.getTime());
}


/** "04/02/2026" no fuso SP — data sem hora (ex.: abertura de conta). */
export function formatSpDateWithYear(date: Date): string {
  assertValidDate(date, "formatSpDateWithYear");
  return dominio.formatSpDateWithYear(date.getTime());
}

/** Saudação pelo período do dia no fuso SP ("Bom dia"/"Boa tarde"/"Boa noite"). */
export function spGreeting(now: Date = new Date()): string {
  assertValidDate(now, "spGreeting");
  return dominio.spGreeting(now.getTime());
}

/** "Sábado, 13 de junho" no fuso SP — cabeçalho do resumo de hoje. */
export function formatSpFullDate(date: Date): string {
  assertValidDate(date, "formatSpFullDate");
  return dominio.formatSpFullDate(date.getTime());
}

/** Início do dia de hoje (00:00 SP) como instante UTC — janelas "de hoje". */
export function spStartOfTodayUtc(now: Date = new Date()): Date {
  assertValidDate(now, "spStartOfTodayUtc");
  return new Date(dominio.spStartOfTodayUtc(now.getTime()));
}

/** Tempo relativo curto ("agora", "há 12 min", "em 3 h", "há 2 d"). */
export function spRelative(date: Date, now: Date = new Date()): string {
  assertValidDate(date, "spRelative");
  assertValidDate(now, "spRelative");
  return dominio.spRelative(date.getTime(), now.getTime());
}

/** Duração em minutos, curta ("<1 min", "12 min", "2.5 h", "10 h", "3 dias"); "—" sem valor. */
export function formatDurationMinutes(minutes: number | null): string {
  return dominio.formatDurationMinutes(minutes ?? null);
}

/** Chave de semana ISO no fuso SP ("2026-W24") + intervalo seg–dom. */
export function spWeekKey(date: Date): string {
  assertValidDate(date, "spWeekKey");
  return dominio.spWeekKey(date.getTime());
}
