import type { AnalyzerPeriod } from "@/src/domain/analyzer-query";
import { analyzerPeriodDays } from "@/src/domain/analyzer-query";
import { shiftDayKey } from "@/src/domain/dates";
import { diaMesDaChave, isDayKey } from "./calendar-date";
import { contagem } from "./plural";

const DAY_MS = 86_400_000;

type JanelaDeDatas = { inicio: string; fim: string };

/** Meia-noite UTC da chave, ou `null` se ela não é um dia de calendário. */
function dayKeyUtc(dayKey: string): number | null {
  return isDayKey(dayKey) ? Date.parse(dayKey) : null;
}

/** "2026-08-12" ± n dias, na mesma grafia; `null` se a chave é inválida. */
function maisDias(dayKey: string, n: number): string | null {
  return isDayKey(dayKey) ? shiftDayKey(dayKey, n) : null;
}

/**
 * `dayKey` é o dia do jogo. O fim da janela vale para o que já tem resultado: a
 * pendente de jogo futuro entra (a mesma regra do servidor, `analyzerWindowWhere`).
 */
export function inAnalyzerRange(dayKey: string, todayKey: string, range: AnalyzerPeriod, pending = false): boolean {
  if (range === "tudo") return true;
  const day = dayKeyUtc(dayKey);
  const today = dayKeyUtc(todayKey);
  if (day === null || today === null) return false;
  if (day > today) return pending;
  if (range === "hoje") return day === today;
  const days = analyzerPeriodDays(range);
  if (days) return today - day < days * DAY_MS;
  return true;
}

/**
 * A janela imediatamente anterior à selecionada, do mesmo tamanho e sem
 * sobreposição: dá régua ao número ("+6,1% de CLV" não diz se melhorou). Um dia
 * de sobreposição contaria a mesma aposta dos dois lados. `tudo` não tem
 * anterior: comparar com o vazio daria variação infinita.
 */
export function inAnalyzerRangeAnterior(dayKey: string, todayKey: string, range: AnalyzerPeriod): boolean {
  if (range === "tudo") return false;
  const day = dayKeyUtc(dayKey);
  const today = dayKeyUtc(todayKey);
  if (day === null || today === null || day > today) return false;
  const distancia = today - day;
  if (range === "hoje") return distancia === DAY_MS;
  // A atual cobre [0, N) dias atrás; a anterior, [N, 2N).
  const days = analyzerPeriodDays(range);
  if (days) return distancia >= days * DAY_MS && distancia < days * 2 * DAY_MS;
  return false;
}

/** Como a janela anterior se chama na tela. `null` quando não existe. */
export function rotuloDoPeriodoAnterior(range: AnalyzerPeriod): string | null {
  if (range === "hoje") return "ontem";
  const days = analyzerPeriodDays(range);
  if (days) return `os ${contagem(days, "dia")} anteriores`;
  return null;
}

/**
 * A extensão do recorte, em datas: o nome do botão ("Últimos 7 dias", "Tudo")
 * não a diz. Para `hoje` e `Nd` a janela sai da mesma regra que filtra
 * (`inAnalyzerRange`); `tudo` não tem janela pedida, então a extensão é a do
 * dado (`diasPresentes`). `null` quando não há o que delimitar.
 */
export function janelaDoRange(
  range: AnalyzerPeriod,
  todayKey: string,
  diasPresentes: readonly string[] = [],
): JanelaDeDatas | null {
  if (range === "hoje") return dayKeyUtc(todayKey) === null ? null : { inicio: todayKey, fim: todayKey };
  const days = analyzerPeriodDays(range);
  if (days) {
    // Chave inválida invalida a janela inteira: `{ inicio: null }` deixaria o
    // chamador comparar contra null.
    const inicio = maisDias(todayKey, 1 - days);
    return inicio ? { inicio, fim: todayKey } : null;
  }
  const validos = diasPresentes.filter((d) => dayKeyUtc(d) !== null).sort();
  const inicio = validos[0];
  const fim = validos[validos.length - 1];
  return inicio && fim ? { inicio, fim } : null;
}

/** A janela anterior em datas. `null` em `tudo`, que não tem anterior. */
export function janelaAnteriorDoRange(range: AnalyzerPeriod, todayKey: string): JanelaDeDatas | null {
  const desloca = (de: number, ate: number): JanelaDeDatas | null => {
    const inicio = maisDias(todayKey, de);
    const fim = maisDias(todayKey, ate);
    return inicio && fim ? { inicio, fim } : null;
  };
  if (range === "hoje") return desloca(-1, -1);
  const days = analyzerPeriodDays(range);
  if (days) return desloca(1 - days * 2, -days);
  return null;
}

/** "06/08 – 12/08", ou só "12/08" quando a janela é de um dia. */
export function textoDaJanela(janela: JanelaDeDatas | null | undefined): string | null {
  if (!janela) return null;
  const { inicio, fim } = janela;
  if (inicio.slice(0, 4) !== fim.slice(0, 4)) {
    return `${diaMesDaChave(inicio)}/${inicio.slice(0, 4)} – ${diaMesDaChave(fim)}/${fim.slice(0, 4)}`;
  }
  return inicio === fim ? diaMesDaChave(inicio) : `${diaMesDaChave(inicio)} – ${diaMesDaChave(fim)}`;
}
