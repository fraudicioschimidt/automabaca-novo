import { describe, expect, it } from "vitest";
import {
  BET_EXPORT_COLUMNS,
  betExportFilename,
  betExportIdentityLabel,
  betExportOriginLabel,
  betExportRow,
  betExportStatusLabel,
  buildBetExportCsv,
  buildBetExportTsv,
  escapeCsvCell,
  uiBetToExportInput,
  type BetExportInput,
} from "@/src/domain/bet-export";

const sample: BetExportInput = {
  day: "2026-07-08",
  time: "21:00",
  home: "Flamengo",
  away: "Palmeiras",
  esporte: "Soccer",
  region: "Brazil",
  league: "Serie A",
  market: "Total – Match",
  line: "Over 2.5",
  scoreAtTip: "1-0",
  casa: "Bet365",
  tipster: "Will",
  origin: "Canal Telegram",
  odds: 1.95,
  opening: 1.88,
  closing: 1.82,
  movimento: -3.2,
  clv: 7.1,
  stake: 1,
  status: "won",
  profit: 0.95,
  identity: "Casada",
  noOdds: "",
};

describe("bet-export (domínio)", () => {
  it("escapeCsvCell protege ; e aspas", () => {
    expect(escapeCsvCell('a;b')).toBe('"a;b"');
    expect(escapeCsvCell('diz "oi"')).toBe('"diz ""oi"""');
    expect(escapeCsvCell(1.95)).toBe('"1,95"');
    expect(escapeCsvCell("=1+1")).toBe("'=1+1");
    expect(escapeCsvCell("+SUM(1;1)")).toBe("\"'+SUM(1;1)\"");
    expect(escapeCsvCell("-0.5")).toBe("-0.5");
    expect(escapeCsvCell("-1,25")).toBe('"-1,25"');
    expect(escapeCsvCell("-CMD()")).toBe("'-CMD()");
    expect(escapeCsvCell(-1)).toBe("-1");
  });

  it("rótulos de status e identidade", () => {
    expect(betExportStatusLabel("halfwon")).toBe("Meia ganha");
    expect(betExportStatusLabel("half_won")).toBe("Meia ganha");
    expect(betExportStatusLabel("half_lost")).toBe("Meia perda");
    expect(betExportStatusLabel("HALF_LOST")).toBe("Meia perda");
    expect(betExportStatusLabel("CANCELED")).toBe("Cancelada");
    expect(betExportIdentityLabel("MATCHED")).toBe("Casada");
    expect(betExportIdentityLabel(null)).toBe("");
  });

  it("origem da captura", () => {
    expect(betExportOriginLabel("telegram-channel:-100")).toBe("Canal Telegram");
    expect(betExportOriginLabel("web")).toBe("Manual (web)");
    expect(betExportOriginLabel("web-manual")).toBe("Manual (web)");
    expect(betExportOriginLabel("telegram-dm:1:bank")).toBe("Telegram (DM)");
  });

  it("CSV tem BOM, ; e todas as colunas sharp", () => {
    const csv = buildBetExportCsv([sample]);
    expect(csv.startsWith("\ufeff")).toBe(true);
    expect(csv).toContain(BET_EXPORT_COLUMNS.join(";"));
    expect(csv).toContain("Opening");
    expect(csv).toContain("Linha%");
    expect(csv).not.toContain("EV%");
    expect(csv).toContain("Identidade");
    expect(csv).toContain("DataLiquidacao");
    expect(csv).toContain("Titular");
    expect(csv).toContain("Flamengo");
    expect(csv).toContain("Ganha");
    expect(betExportRow(sample)).toHaveLength(BET_EXPORT_COLUMNS.length);
  });

  describe("números com vírgula decimal, que o Excel PT-BR lê como número", () => {
    const precos: BetExportInput = {
      ...sample, odds: 1.925, opening: 1.917, closing: 1.862,
      movimento: -2.86906624934794, clv: 3.384, stake: 1.5, profit: 138.75,
    };

    it("no CSV", () => {
      const linha = buildBetExportCsv([precos]).split("\n")[1]!;
      expect(linha).toContain(';"1,925";"1,917";"1,862";"-2,8691";"3,384";"1,5";Ganha;"138,75";');
    });

    it("no TSV do copiar visíveis", () => {
      const linha = buildBetExportTsv([precos]).split("\n")[1]!;
      expect(linha).toContain("\t1,925\t1,917\t1,862\t-2,8691\t3,384\t1,5\tGanha\t138,75\t");
    });

    it("stake e lucro saem com as 6 casas do banco, para a soma da coluna bater com o painel", () => {
      const linha = buildBetExportTsv([{ ...precos, odds: 1.923456789, stake: 0.333333, profit: -0.166667 }]).split("\n")[1]!;
      expect(linha).toContain("\t1,9235\t");
      expect(linha).toContain("\t0,333333\tGanha\t-0,166667\t");
    });

    it("sem separador de milhar nem zero negativo", () => {
      const linha = buildBetExportTsv([{ ...precos, stake: 12345.5, movimento: -0.00001 }]).split("\n")[1]!;
      expect(linha).toContain("\t0\t3,384\t12345,5\t");
    });
  });

  it("placar e seleção que é só a linha saem como texto: a planilha os leria como data ou milhar", () => {
    const colunas = (bet: BetExportInput) => {
      const cells = buildBetExportTsv([bet]).split("\n")[1]!.split("\t");
      return { linha: cells[BET_EXPORT_COLUMNS.indexOf("Linha")], placar: cells[BET_EXPORT_COLUMNS.indexOf("PlacarTip")] };
    };
    expect(colunas({ ...sample, line: "2.5", scoreAtTip: "2-1" })).toEqual({ linha: "'2.5", placar: "'2-1" });
    expect(colunas({ ...sample, line: "-1.5", scoreAtTip: "" })).toEqual({ linha: "'-1.5", placar: "" });
    expect(colunas({ ...sample, line: "+0,25", scoreAtTip: "10-12" })).toEqual({ linha: "'+0,25", placar: "'10-12" });
    // Texto comum e as colunas de data e hora continuam como estão.
    expect(colunas(sample)).toEqual({ linha: "Over 2.5", placar: "'1-0" });
    const csv = buildBetExportCsv([{ ...sample, line: "2.5", scoreAtTip: "2-1" }]).split("\n")[1]!;
    expect(csv.startsWith("2026-07-08;21:00;")).toBe(true);
    expect(csv).toContain(";'2.5;'2-1;");
  });

  it("TSV usa tab e não tem BOM", () => {
    const tsv = buildBetExportTsv([{ ...sample, home: "@SUM(1,1)\tlinha" }]);
    expect(tsv.startsWith("\ufeff")).toBe(false);
    expect(tsv.split("\n")[0]?.split("\t")).toEqual([...BET_EXPORT_COLUMNS]);
    expect(tsv).toContain("'@SUM(1,1) linha");
  });

  it("filename por slug", () => {
    expect(betExportFilename("treino")).toBe("treino-apostas.csv");
    expect(betExportFilename("??")).toBe("apostas.csv");
  });

  it("uiBetToExportInput mapeia d.* da ficha", () => {
    const row = uiBetToExportInput({
      day: "2026-07-08",
      time: "21:00",
      home: "A",
      away: "B",
      esporte: "Soccer",
      region: "BR",
      league: "A",
      market: "ML",
      line: "Casa",
      odds: 2,
      movimento: null,
      clv: null,
      stake: 1,
      status: "pending",
      profit: null,
      d: { open: 1.9, close: null, casa: "Pinnacle", origin: "Canal Telegram" },
    });
    expect(row.opening).toBe(1.9);
    expect(row.movimento).toBeNull();
    expect(row.casa).toBe("Pinnacle");
    expect(row.clv).toBeNull();
  });
});

describe("sanitização CSV/TSV contra injeção de fórmulas, DDE e whitespace", () => {
  it("neutraliza fórmulas que começam com =, +, -, @ ou contêm CR/LF", () => {
    expect(escapeCsvCell("=CMD()")).toBe("'=CMD()");
    expect(escapeCsvCell("+12345")).toBe("+12345"); // número legítimo não deve ser prefixado
    expect(escapeCsvCell("+SUM(A1:A2)")).toBe("'+SUM(A1:A2)");
    expect(escapeCsvCell("@SUM(A1:A2)")).toBe("'@SUM(A1:A2)");
    expect(escapeCsvCell("-10.5")).toBe("-10.5");
    expect(escapeCsvCell("-cmd|' /C calc'!A0")).toBe("'-cmd|' /C calc'!A0");
    expect(escapeCsvCell("=CMD()\rFlamengo")).toBe("'=CMD() Flamengo");
  });

  it("neutraliza injeções com tab, CR inicial ou comando DDE puro", () => {
    expect(escapeCsvCell("\t=CMD()")).toBe("'=CMD()");
    expect(escapeCsvCell("\r=CMD()")).toBe("'=CMD()");
    expect(escapeCsvCell("cmd|' /C calc'!A0")).toBe("'cmd|' /C calc'!A0");
    expect(escapeCsvCell("+1.5")).toBe("+1.5");
    expect(escapeCsvCell("-2.25")).toBe("-2.25");
  });

  it("escapa quebras de linha e carriage returns isolados (\r)", () => {
    const cellWithCr = "Flamengo\r=CMD()";
    const escaped = escapeCsvCell(cellWithCr);
    expect(escaped).not.toContain("\r");
    expect(escaped).toBe("Flamengo =CMD()");
  });

  it("gera CSV e TSV limpos sem tabs nem quebras de linha nas células", () => {
    const mockBet: BetExportInput = {
      day: "01/09/2026",
      time: "15:00",
      home: "Time A\tExtra",
      away: "Time B\nJunior",
      esporte: "Futebol",
      region: "Brasil",
      league: "Serie A",
      market: "Over/Under",
      line: "=1.5",
      scoreAtTip: "0-0",
      casa: "Bet365",
      tipster: "Tipster\r=cmd",
      origin: "telegram-channel",
      odds: 1.95,
      opening: 1.9,
      closing: 1.88,
      movimento: -1.1,
      clv: 3.5,
      stake: 1,
      status: "WON",
      profit: 0.95,
      identity: "Casada",
      noOdds: "",
    };
    const csv = buildBetExportCsv([mockBet]);
    expect(csv).toContain("01/09/2026");
    expect(csv).toContain("Time A Extra");

    const tsv = buildBetExportTsv([mockBet]);
    const lines = tsv.split("\n");
    expect(lines.length).toBe(2); // cabeçalho + 1 linha de dados
    expect(tsv).not.toContain("\r");
  });
});

 describe("precisão para reconstrução", () => {
  it("preserva as seis casas das odds justas", () => {
    const row = betExportRow({ ...sample, opening: 1.987654, closing: 1.876543 });
    expect(row[BET_EXPORT_COLUMNS.indexOf("Opening")]).toBe("1,987654");
    expect(row[BET_EXPORT_COLUMNS.indexOf("Closing")]).toBe("1,876543");
  });
});
