import { parseSpDateTimeInput } from "@/src/domain/dates";
import { parseDecimalInput } from "@/src/domain/decimal-input";
import { canonicalSport } from "@/src/domain/sports/registry";

/** Entrada manual compartilhada pelo cadastro e pela edição. */
export type ManualBetInput = {
  home: string;
  away: string;
  date: string;
  /** Em branco = horário a confirmar. */
  time?: string;
  esporte?: string;
  region?: string;
  competition?: string;
  market?: string;
  line?: string;
  odds: number | string;
  stake: number | string;
  casa?: string;
};

/** Normalização determinística; os serviços aplicam depois os limites de sanidade. */
export function normalizeManualBetInput(input: ManualBetInput) {
  const home = String(input.home ?? "").trim();
  const away = String(input.away ?? "").trim();
  const odds = parseDecimalInput(input.odds);
  const stake = parseDecimalInput(input.stake);
  if (!home || !away || odds === null || stake === null || odds <= 1 || stake <= 0) {
    throw new Error("Preencha mandante, visitante, odds (> 1) e stake (> 0).");
  }
  const date = String(input.date ?? "").trim();
  const time = String(input.time ?? "").trim();
  // Sem hora, o dia vale com o marcador de meia-noite das tips que só trazem o
  // dia: o horário fica a confirmar e a busca de horário o corrige.
  const kickoffInferido = time === "";
  const kickoff = parseSpDateTimeInput(date, kickoffInferido ? "00:00" : time);
  if (!kickoff) throw new Error("Data ou horário inválido.");
  const esporte = canonicalSport(String(input.esporte ?? "Soccer").trim() || "Soccer");
  if (!esporte) throw new Error("Selecione uma modalidade esportiva reconhecida.");
  const mercado = String(input.market ?? "Total").trim() || "Total";
  return {
    data: kickoff,
    kickoffInferido,
    evento: `${home} vs ${away}`,
    esporte,
    competicao: String(input.competition ?? "").trim(),
    pais: String(input.region ?? "").trim(),
    casaDeAposta: String(input.casa ?? "").trim(),
    mercado,
    selecao: String(input.line ?? "").trim() || mercado,
    odds,
    stake,
  };
}
