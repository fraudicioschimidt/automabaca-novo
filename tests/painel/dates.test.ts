import { describe, expect, it } from "vitest";
import {
  SAO_PAULO_UTC_OFFSET_HOURS,
  formatDurationMinutes,
  MONTH_ABBREVIATIONS,
  MONTH_NAMES,
  WEEKDAY_ABBREVIATIONS,
  formatSpDateTime,
  formatSpFullDate,
  formatSpDateWithYear,
  formatSpTime,
  parseBrKickoffDetailed,
  parseSpDateTimeInput,
  shiftDayKey,
  spDayKey,
  spGreeting,
  spRelative,
  spStartOfTodayUtc,
  spToUtc,
  spWeekKey,
  utcToSpParts,
} from "@/src/domain/dates";

/** Só o instante: o que sobra de `parseBrKickoffDetailed` quando `dateOnly` não importa. */
const parseBrKickoff = (text: string, ref?: Date): Date | null => parseBrKickoffDetailed(text, ref)?.date ?? null;

/**
 * Fuso SP (UTC-3 fixo) é a base de TODA janela "de hoje"/agrupamento diário do
 * painel (getResumoHoje, curvas, heatmap). Lógica pura, testada aqui sem DB.
 */
describe("dates — fuso São Paulo (UTC-3 fixo)", () => {
  it.each(["10 Sep 13:00", "10 Sep. 13:00", "10 September 2026 13:00"])("preserva a data por extenso lida do bilhete: %s", (source) => {
    const parsed = parseBrKickoffDetailed(source, new Date("2026-09-12T14:00:00Z"));
    expect(parsed?.date.toISOString()).toBe("2026-09-10T16:00:00.000Z");
    expect(parsed?.dateOnly).toBe(false);
  });
  it("mês por extenso conserva ausência de hora e inferência de ano na virada", () => {
    const parsed = parseBrKickoffDetailed("31 December", new Date("2026-01-02T14:00:00Z"));
    expect(parsed?.date.toISOString()).toBe("2025-12-31T03:00:00.000Z");
    expect(parsed?.dateOnly).toBe(true);
  });
  it.each(["31 February 2026 13:00", "29 Feb 2026", "11 Sep 25:00", "Sep 13:00", "Over 2.5"])("não fabrica data a partir de mês ou calendário inválido: %s", (source) => {
    expect(parseBrKickoffDetailed(source, new Date("2026-09-12T14:00:00Z"))).toBeNull();
  });
  it("offset é 3", () => {
    expect(SAO_PAULO_UTC_OFFSET_HOURS).toBe(3);
  });

  it("spToUtc soma 3h ao construir o instante UTC", () => {
    expect(spToUtc({ year: 2026, month: 6, day: 15 }).toISOString()).toBe("2026-06-15T03:00:00.000Z");
    expect(spToUtc({ year: 2026, month: 6, day: 15, hour: 16, minute: 30 }).toISOString()).toBe(
      "2026-06-15T19:30:00.000Z",
    );
  });

  it("parseia campos date/time sempre como horário de São Paulo", () => {
    expect(parseSpDateTimeInput("2026-07-13", "13:45")?.toISOString()).toBe(
      "2026-07-13T16:45:00.000Z",
    );
    expect(parseSpDateTimeInput("2026-07-13", "9:05")?.toISOString()).toBe(
      "2026-07-13T12:05:00.000Z",
    );
  });

  it("rejeita data/hora HTML impossível em vez de fazer rollover", () => {
    expect(parseSpDateTimeInput("2026-02-31", "10:00")).toBeNull();
    expect(parseSpDateTimeInput("2026-13-01", "10:00")).toBeNull();
    expect(parseSpDateTimeInput("2026-07-13", "24:00")).toBeNull();
    expect(parseSpDateTimeInput("13/07/2026", "10:00")).toBeNull();
    // Contrato deliberadamente estrito: inputs HTML date/time são zero-padded.
    expect(parseSpDateTimeInput("2026-8-2", "16:00")).toBeNull();
    expect(parseSpDateTimeInput("2026-08-02", "16:5")).toBeNull();
  });

  it("spDayKey agrupa pelo dia SP, não UTC (vira às 00:00 SP = 03:00Z)", () => {
    expect(spDayKey(new Date("2026-06-15T02:59:00Z"))).toBe("2026-06-14");
    expect(spDayKey(new Date("2026-06-15T03:00:00Z"))).toBe("2026-06-15");
  });

  it("spDayKey é o inverso de spToUtc (round-trip estável no dia)", () => {
    for (const hour of [0, 6, 12, 23]) {
      expect(spDayKey(spToUtc({ year: 2026, month: 6, day: 15, hour }))).toBe("2026-06-15");
    }
  });

  it("shiftDayKey atravessa mês e ano sem converter o dia SP em UTC", () => {
    expect(shiftDayKey("2026-03-01", -1)).toBe("2026-02-28");
    expect(shiftDayKey("2026-01-01", -90)).toBe("2025-10-03");
    expect(shiftDayKey("2026-12-31", 1)).toBe("2027-01-01");
  });

  it("shiftDayKey rejeita chaves de calendário impossíveis", () => {
    expect(() => shiftDayKey("2026-02-31", 0)).toThrow("Chave de dia invalida");
    expect(() => shiftDayKey("2026-13-45", 0)).toThrow("Chave de dia invalida");
  });

  it("spStartOfTodayUtc = 00:00 SP de hoje como instante UTC", () => {
    const now = spToUtc({ year: 2026, month: 6, day: 15, hour: 18 });
    expect(spStartOfTodayUtc(now).toISOString()).toBe("2026-06-15T03:00:00.000Z");
    const meiaNoite = spToUtc({ year: 2026, month: 6, day: 15, hour: 0 });
    expect(spStartOfTodayUtc(meiaNoite).toISOString()).toBe("2026-06-15T03:00:00.000Z");
    // 1 min antes da meia-noite SP ainda pertence ao dia anterior
    const antes = new Date(meiaNoite.getTime() - 60_000);
    expect(spStartOfTodayUtc(antes).toISOString()).toBe("2026-06-14T03:00:00.000Z");
  });

  it("spStartOfTodayUtc atravessa virada de mês (23:30 SP de 30/06 ainda é 30/06)", () => {
    const fimDeMes = spToUtc({ year: 2026, month: 6, day: 30, hour: 23, minute: 30 });
    expect(spStartOfTodayUtc(fimDeMes).toISOString()).toBe("2026-06-30T03:00:00.000Z");
  });

  it("formatadores SP batem o formato das telas", () => {
    const d = spToUtc({ year: 2026, month: 2, day: 4, hour: 16, minute: 0 });
    expect(formatSpTime(d)).toBe("16:00");
    expect(formatSpDateTime(d)).toBe("04/02 16:00");
    expect(formatSpDateWithYear(d)).toBe("04/02/2026");
  });

  it("calendário/formatadores SP falham de forma explícita para Date inválida", () => {
    const invalid = new Date(Number.NaN);
    for (const [caller, operation] of [
      ["utcToSpParts", () => utcToSpParts(invalid)],
      ["spDayKey", () => spDayKey(invalid)],
      ["formatSpTime", () => formatSpTime(invalid)],
      ["formatSpDateTime", () => formatSpDateTime(invalid)],
      ["formatSpDateWithYear", () => formatSpDateWithYear(invalid)],
      ["formatSpFullDate", () => formatSpFullDate(invalid)],
      ["spGreeting", () => spGreeting(invalid)],
      ["spStartOfTodayUtc", () => spStartOfTodayUtc(invalid)],
      ["spRelative", () => spRelative(invalid)],
      ["spWeekKey", () => spWeekKey(invalid)],
    ] as const) {
      expect(operation, caller).toThrow(RangeError);
      expect(operation, caller).toThrow(caller);
    }
    expect(() => spRelative(new Date(), invalid)).toThrow("spRelative");
  });

  it("spGreeting pelo período do dia SP, com bordas", () => {
    const g = (hour: number, minute = 0) =>
      spGreeting(spToUtc({ year: 2026, month: 6, day: 15, hour, minute }));
    expect(g(0)).toBe("Boa noite");
    expect(g(5, 59)).toBe("Boa noite");
    expect(g(6)).toBe("Bom dia");
    expect(g(9)).toBe("Bom dia");
    expect(g(11, 59)).toBe("Bom dia");
    expect(g(12)).toBe("Boa tarde");
    expect(g(17, 59)).toBe("Boa tarde");
    expect(g(18)).toBe("Boa noite");
    expect(g(23)).toBe("Boa noite");
  });

  it("spWeekKey no formato ISO e estável dentro do dia", () => {
    const d = spToUtc({ year: 2026, month: 6, day: 15, hour: 10 });
    expect(spWeekKey(d)).toMatch(/^\d{4}-W\d{2}$/);
    expect(spWeekKey(d)).toBe(spWeekKey(new Date(d.getTime() + 3_600_000)));
  });
});

describe("utcToSpParts — SSOT do shift de fuso (heatmaps/semana usam isto, não offset ad-hoc)", () => {
  it("os getters UTC do retorno leem o relógio de SP (UTC-3)", () => {
    // 2026-06-15T19:00Z = 16:00 de segunda em SP.
    const sp = utcToSpParts(new Date("2026-06-15T19:00:00Z"));
    expect(sp.getUTCHours()).toBe(16);
    expect(sp.getUTCDay()).toBe(1); // segunda
    expect(sp.getUTCDate()).toBe(15);
  });

  it("vira o dia para trás quando UTC já passou da meia-noite mas SP não", () => {
    // 2026-06-16T01:00Z = 22:00 de 15/06 em SP.
    const sp = utcToSpParts(new Date("2026-06-16T01:00:00Z"));
    expect(sp.getUTCDate()).toBe(15);
    expect(sp.getUTCHours()).toBe(22);
  });
});

describe("parseBrKickoff — rejeita data de calendário impossível", () => {
  it("parseia data válida (interpretada em SP → UTC)", () => {
    const d = parseBrKickoff("jogo 15/06 às 16:00", new Date("2026-06-01T00:00:00Z"));
    expect(d?.toISOString()).toBe("2026-06-15T19:00:00.000Z"); // 16:00 SP = 19:00Z
  });

  it("31/02 não vira março (rollover do Date.UTC) — retorna null", () => {
    expect(parseBrKickoff("31/02/2026 10:00")).toBeNull();
    expect(parseBrKickoff("30/02/2026")).toBeNull();
    expect(parseBrKickoff("31/04/2026")).toBeNull(); // abril tem 30
  });

  it("dia/mês fora de faixa → null", () => {
    expect(parseBrKickoff("32/01/2026")).toBeNull();
    expect(parseBrKickoff("10/13/2026")).toBeNull();
  });

  it("sem data reconhecível → null", () => {
    expect(parseBrKickoff("sem data aqui")).toBeNull();
  });

  it("linha de total/handicap (ponto, sem hora/ano) NÃO vira data", () => {
    // "Over 2.5" não pode casar como 2/mai e ser empurrado p/ o ano seguinte (kickoff falso).
    const now = new Date("2026-06-16T12:00:00Z");
    expect(parseBrKickoff("Over 2.5", now)).toBeNull();
    expect(parseBrKickoff("AH 1.5", now)).toBeNull();
    expect(parseBrKickoff("Mercado: Total / Entrada: Over 2.5 / ODD: 1.90", now)).toBeNull();
  });

  it("acha a data REAL mesmo com uma linha de total ANTES (varre todos os matches)", () => {
    const now = new Date("2026-06-16T12:00:00Z");
    const d = parseBrKickoff("Over 2.5\n18/06 16:00", now);
    expect(d?.toISOString()).toBe("2026-06-18T19:00:00.000Z"); // 16:00 SP = 19:00Z
  });

  it("data com PONTO ainda vale quando acompanhada de hora ou ano", () => {
    expect(parseBrKickoff("18.06 16:00", new Date("2026-06-01T00:00:00Z"))?.toISOString()).toBe(
      "2026-06-18T19:00:00.000Z",
    );
    expect(parseBrKickoff("02.05.2026", new Date("2026-01-01T00:00:00Z"))?.toISOString()).toBe(
      "2026-05-02T03:00:00.000Z",
    );
  });

  it("interpreta 24:00 como meia-noite do dia seguinte e rejeita 24:01", () => {
    expect(parseBrKickoff("31/12/2026 24:00")?.toISOString()).toBe(
      "2027-01-01T03:00:00.000Z",
    );
    expect(parseBrKickoff("31/12/2026 24:01")).toBeNull();
  });

  it("parseBrKickoffDetailed marca dateOnly quando não há hora", () => {
    const soDia = parseBrKickoffDetailed("15/06", new Date("2026-06-01T00:00:00Z"));
    expect(soDia?.dateOnly).toBe(true);
    expect(soDia?.date.toISOString()).toBe("2026-06-15T03:00:00.000Z");

    const comHora = parseBrKickoffDetailed("15/06 16:00", new Date("2026-06-01T00:00:00Z"));
    expect(comHora?.dateOnly).toBe(false);
    expect(comHora?.date.toISOString()).toBe("2026-06-15T19:00:00.000Z");

    const horaCheia = parseBrKickoffDetailed("15/06 16h", new Date("2026-06-01T00:00:00Z"));
    expect(horaCheia).toEqual({
      date: new Date("2026-06-15T19:00:00.000Z"),
      dateOnly: false,
    });
  });

  it.each([
    ["27/09 16:00hs", "2026-09-27T19:00:00.000Z"],
    ["27/09 às 16hs", "2026-09-27T19:00:00.000Z"],
    ["27/09 16:00h", "2026-09-27T19:00:00.000Z"],
    ["27/09 16hrs", "2026-09-27T19:00:00.000Z"],
    ["27/09 16h30min", "2026-09-27T19:30:00.000Z"],
    ["27/09 | 16h", "2026-09-27T19:00:00.000Z"],
    ["27/09 | 16:00", "2026-09-27T19:00:00.000Z"],
    ["27/09 • 16:00", "2026-09-27T19:00:00.000Z"],
    ["📅 27/09 ⏰ 16:00", "2026-09-27T19:00:00.000Z"],
    ["27/09 as 16h", "2026-09-27T19:00:00.000Z"],
    ["27/09 à 16:00", "2026-09-27T19:00:00.000Z"],
    ["27/09 (sáb) 16:00", "2026-09-27T19:00:00.000Z"],
    ["27/09/2026 16:00hs", "2026-09-27T19:00:00.000Z"],
    ["2026-09-27 16:00hs", "2026-09-27T19:00:00.000Z"],
    ["27/09 | 16:00, Maracanã", "2026-09-27T19:00:00.000Z"],
    ["📅 27/09 ⏰ 16:00.", "2026-09-27T19:00:00.000Z"],
    ["27/09 (sábado) 16h", "2026-09-27T19:00:00.000Z"],
    ["27/09 sexta-feira 16:00", "2026-09-27T19:00:00.000Z"],
    ["Data: 27/09 Horário: 16:00", "2026-09-27T19:00:00.000Z"],
  ])("hora escrita na linha da data com sufixo ou separador conta: '%s'", (text, iso) => {
    expect(parseBrKickoffDetailed(text, new Date("2026-09-24T15:00:00Z"))).toEqual({ date: new Date(iso), dateOnly: false });
  });

  it.each(["27/09 @1.85", "27/09 1.85", "27/09 Over 2.5 às 20h", "27/09\n16:00", "27/09 2 horas antes do jogo", "27/09 HT 1h", "27/09 • Rodada 5h", "27/09 x 3h", "27/09 | 24:30", "27/09 | 25:00"])(
    "número da mesma linha que não é hora não vira hora: %j",
    (text) => {
      expect(parseBrKickoffDetailed(text, new Date("2026-09-24T15:00:00Z"))).toEqual({ date: new Date("2026-09-27T03:00:00.000Z"), dateOnly: true });
    },
  );

  it.each(["2026-09-27\n16:00", "2026/09/27\r\n1h", "2026-09-27 às\n20h"])(
    "data ISO não toma a hora de outra linha: %j", (text) => {
      expect(parseBrKickoffDetailed(text, new Date("2026-09-24T15:00:00Z"))).toEqual({
        date: new Date("2026-09-27T03:00:00.000Z"), dateOnly: true,
      });
    },
  );

  it("interpreta ISO com barra/hífen antes do parser DD/MM", () => {
    const ref = new Date("2026-08-01T00:00:00Z");
    expect(parseBrKickoffDetailed("2026/08/02 16:00", ref)).toEqual({
      date: new Date("2026-08-02T19:00:00.000Z"),
      dateOnly: false,
    });
    expect(parseBrKickoffDetailed("2026-08-02T16:00", ref)).toEqual({
      date: new Date("2026-08-02T19:00:00.000Z"),
      dateOnly: false,
    });
    expect(parseBrKickoffDetailed("2026/08/02", ref)).toEqual({
      date: new Date("2026-08-02T03:00:00.000Z"),
      dateOnly: true,
    });
    expect(parseBrKickoffDetailed("2026/02/31 16:00", ref)).toBeNull();
  });

  it("preserva o instante de ISO com Z ou offset explícito", () => {
    expect(parseBrKickoffDetailed("2026-08-02T16:00:00Z")).toEqual({
      date: new Date("2026-08-02T16:00:00.000Z"),
      dateOnly: false,
    });
    expect(parseBrKickoffDetailed("2026-08-02T16:00:00-03:00")).toEqual({
      date: new Date("2026-08-02T19:00:00.000Z"),
      dateOnly: false,
    });
    expect(parseBrKickoffDetailed("2026-08-02T16:00:00+99:00")).toBeNull();
  });

  it.each(["Z", "-03:00", "+02:00"])("rejeita calendário ISO impossível com fuso %s", (zone) => {
    expect(parseBrKickoffDetailed(`2026-02-31T16:00:00${zone}`)).toBeNull();
    expect(parseBrKickoffDetailed(`2026-02-29T16:00:00${zone}`)).toBeNull();
    expect(parseBrKickoffDetailed(`2028-02-29T16:00:00${zone}`)?.date).toBeInstanceOf(Date);
  });

  it("virada de ano: ano vem do calendário SP de ref, não do UTC", () => {
    // ref 2027-01-01T01:00Z = ainda 2026-12-31 22:00 em SP. "31/12 23:00" deve cair
    // no ANO de SP (2026) → 2027-01-01T02:00Z, não 2028 (que o ano UTC produziria).
    const d = parseBrKickoff("31/12 23:00", new Date("2027-01-01T01:00:00Z"));
    expect(d?.toISOString()).toBe("2027-01-01T02:00:00.000Z");
  });

  it("virada de ano: kickoff de 01/01 às 10:00 resolve no ano SP correto", () => {
    // ref 2027-01-01T02:00Z = 2026-12-31 23:00 SP. "01/01 10:00" é futuro próximo →
    // 2027-01-01 10:00 SP = 2027-01-01T13:00Z (ano 2026 + rolagem p/ futuro).
    const d = parseBrKickoff("01/01 10:00", new Date("2027-01-01T02:00:00Z"));
    expect(d?.toISOString()).toBe("2027-01-01T13:00:00.000Z");
  });

  it("29/02 sem ano tenta o ano seguinte quando o atual não é bissexto", () => {
    const d = parseBrKickoff("29/02 16:00", new Date("2027-02-01T12:00:00Z"));
    expect(d?.toISOString()).toBe("2028-02-29T19:00:00.000Z");
    expect(parseBrKickoff("29/02 16:00", new Date("2026-02-01T12:00:00Z"))).toBeNull();
  });
});

describe("spRelative", () => {
  const now = new Date("2026-08-02T12:00:00Z");

  it("distingue passado, presente e futuro", () => {
    expect(spRelative(new Date("2026-08-02T11:45:00Z"), now)).toBe("há 15 min");
    expect(spRelative(new Date("2026-08-02T12:00:30Z"), now)).toBe("agora");
    expect(spRelative(new Date("2026-08-02T12:15:00Z"), now)).toBe("em 15 min");
    expect(spRelative(new Date("2026-08-02T14:00:00Z"), now)).toBe("em 2 h");
    expect(spRelative(new Date("2026-08-05T12:00:00Z"), now)).toBe("em 3 d");
  });

  it("mantém a faixa de um minuto para instantes futuros", () => {
    expect(spRelative(new Date(now.getTime() + 61_000), now)).toBe("em 1 min");
    expect(spRelative(new Date(now.getTime() + 90_000), now)).toBe("em 1 min");
  });

  it("recusa data inválida em vez de renderizar NaN/NaN/NaN", () => {
    expect(() => formatSpDateWithYear(new Date(Number.NaN))).toThrow(/data inválida/i);
  });
});

describe("nomes de dia e de mês", () => {
  it("uma fonte para rótulo, abreviação e prosa", () => {
    expect(MONTH_NAMES[2]).toBe("Março");
    expect(MONTH_ABBREVIATIONS).toEqual(["Jan", "Fev", "Mar", "Abr", "Mai", "Jun", "Jul", "Ago", "Set", "Out", "Nov", "Dez"]);
    expect(WEEKDAY_ABBREVIATIONS).toEqual(["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"]);
    expect(formatSpFullDate(new Date("2026-06-13T15:00:00Z"))).toBe("Sábado, 13 de junho");
  });
});

describe("formatDurationMinutes", () => {
  it("uma escala para painel, resumo e alerta", () => {
    expect([null, 0.4, 5.4, 120, 600, 47 * 60, 48 * 60, 150 * 60].map(formatDurationMinutes))
      .toEqual(["—", "<1 min", "5 min", "2.0 h", "10 h", "47 h", "2 dias", "6 dias"]);
  });
});
