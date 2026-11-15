import { describe, expect, it } from "vitest";
import {
  CONFIRMACAO_MIN_MS,
  decidirTerminal,
  interruptedFinishOf,
  type ObservacaoAnterior,
} from "@/src/providers/flashscore/terminal";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";

const KICKOFF = new Date("2026-08-04T12:00:00Z");

function partida(opts: {
  placar?: [number, number] | null;
  finished?: boolean;
}): FlashscoreMatch {
  return {
    match_id: "M1",
    timestamp: Math.floor(KICKOFF.getTime() / 1000),
    match_status: {
      stage: null,
      is_cancelled: false,
      is_postponed: false,
      is_started: opts.finished === true,
      is_in_progress: false,
      is_finished: opts.finished === true,
    },
    home_team: { team_id: "h", name: "Casa" },
    away_team: { team_id: "a", name: "Fora" },
    scores: opts.placar
      ? { home: opts.placar[0], away: opts.placar[1] }
      : { home: null, away: null },
  } as FlashscoreMatch;
}

const depois = (h: number) => new Date(KICKOFF.getTime() + h * 3_600_000);
/** `h` = hora, desde o kickoff, em que ESTE placar apareceu pela primeira vez. */
const obs = (placar: string, h: number): ObservacaoAnterior => ({ placar, desde: depois(h) });

describe("esportes com flag do fornecedor", () => {
  it("futebol liquida pela flag, sem esperar nada", () => {
    expect(
      decidirTerminal({ match: partida({ placar: [2, 1], finished: true }), sportId: 1, agora: depois(2) }),
    ).toEqual({ terminal: true, via: "flag" });
  });

  it("futebol sem flag NÃO liquida, mesmo com placar e muito tempo depois", () => {
    // O placar do futebol é AO VIVO: sem a flag, pode ser parcial.
    expect(
      decidirTerminal({ match: partida({ placar: [1, 0] }), sportId: 1, agora: depois(48) }),
    ).toEqual({ terminal: false, motivo: "sem_confirmacao" });
  });
});

describe("esportes por inferência", () => {
  const handebol = 7;

  it("recusa antes do portão de duração, mesmo com placar estável", () => {
    // Medição real: handebol com placar mudando de 38x23 para 45x28 em
    // kickoff+89min. Duas leituras dentro desse intervalo veriam "estável".
    expect(
      decidirTerminal({
        match: partida({ placar: [38, 23] }),
        sportId: handebol,
        agora: depois(1.5),
        anterior: obs("38x23", 1),
      }),
    ).toEqual({ terminal: false, motivo: "cedo_demais" });
  });

  it("recusa sem observação anterior, mesmo passado o portão", () => {
    expect(
      decidirTerminal({ match: partida({ placar: [30, 28] }), sportId: handebol, agora: depois(9) }),
    ).toEqual({ terminal: false, motivo: "sem_confirmacao" });
  });

  it("recusa quando o placar mudou entre as observações", () => {
    expect(
      decidirTerminal({
        match: partida({ placar: [31, 28] }),
        sportId: handebol,
        agora: depois(9),
        anterior: obs("30x28", 8),
      }),
    ).toEqual({ terminal: false, motivo: "placar_mudou" });
  });

  it("recusa placar que ainda não completou a janela de estabilidade", () => {
    const agora = depois(9);
    const quase = new Date(agora.getTime() - CONFIRMACAO_MIN_MS + 60_000);
    expect(
      decidirTerminal({
        match: partida({ placar: [30, 28] }),
        sportId: handebol,
        agora,
        anterior: { placar: "30x28", desde: quase },
      }),
    ).toEqual({ terminal: false, motivo: "sem_confirmacao" });
  });

  /**
   * O caso que ninguém testava, e que deixava a inferência inteira inerte: com
   * a janela ancorada na ÚLTIMA leitura, a cadência de 15min do job nunca a
   * alcançava — cada observação empurrava a referência para frente. Ancorada na
   * PRIMEIRA aparição do placar, a estabilidade acumula entre os ciclos.
   */
  it("acumula estabilidade entre ciclos de 10min — a cadência real do job", () => {
    const CICLO_MS = 10 * 60_000;
    const placar = "30x28";
    const match = partida({ placar: [30, 28] });
    let ancora: Date | null = null;
    let liquidouEm: number | null = null;

    for (let ciclo = 1; ciclo <= 40; ciclo += 1) {
      const agora = new Date(KICKOFF.getTime() + ciclo * CICLO_MS);
      const anterior: ObservacaoAnterior | null = ancora ? { placar, desde: ancora } : null;
      const decisao = decidirTerminal({ match, sportId: handebol, agora, anterior });
      if (decisao.terminal && liquidouEm === null) liquidouEm = ciclo;
      // O job regrava a observação a cada ciclo, propagando a âncora enquanto o
      // placar não muda — é isso que `flashscore.ts` grava em `placarDesde`.
      ancora = ancora ?? agora;
    }

    // Portão do handebol são 4h; a estabilidade de 30min corre em paralelo e já
    // está cumprida quando ele abre.
    expect(liquidouEm).not.toBeNull();
    expect(liquidouEm! * CICLO_MS).toBeLessThanOrEqual(5 * 3_600_000);
  });

  it("aceita com portão vencido, placar estável e leituras separadas", () => {
    expect(
      decidirTerminal({
        match: partida({ placar: [30, 28] }),
        sportId: handebol,
        agora: depois(9),
        anterior: obs("30x28", 8),
      }),
    ).toEqual({ terminal: true, via: "inferencia" });
  });

  it("sem placar nunca liquida — cobre jogo futuro e adiado", () => {
    expect(
      decidirTerminal({
        match: partida({ placar: null }),
        sportId: handebol,
        agora: depois(48),
        anterior: obs("0x0", 47),
      }),
    ).toEqual({ terminal: false, motivo: "sem_placar" });
  });

  it("críquete tem portão muito mais longo que handebol", () => {
    const args = { match: partida({ placar: [241, 142] }), agora: depois(9), anterior: obs("241x142", 8) };
    expect(decidirTerminal({ ...args, sportId: 13 })).toEqual({
      terminal: false,
      motivo: "cedo_demais",
    });
    expect(decidirTerminal({ ...args, sportId: 7 })).toMatchObject({ terminal: true });
  });
});

describe("esportes sem placar utilizável e desconhecidos", () => {
  it("boxe e MMA nunca liquidam: o placar é o método da luta, não contagem", () => {
    for (const sportId of [16, 28]) {
      expect(
        decidirTerminal({
          match: partida({ placar: [2, 2] }),
          sportId,
          agora: depois(48),
          anterior: obs("2x2", 47),
        }),
      ).toEqual({ terminal: false, motivo: "esporte_sem_placar_utilizavel" });
    }
  });

  it("id fora do mapa falha fechado", () => {
    expect(
      decidirTerminal({
        match: partida({ placar: [1, 0], finished: true }),
        sportId: 999,
        agora: depois(48),
        anterior: obs("1x0", 47),
      }),
    ).toEqual({ terminal: false, motivo: "esporte_desconhecido" });
  });
});

const VOLLEYBALL_KICKOFF = new Date("2026-08-09T19:30:00Z");

function volleyballMatch(): FlashscoreMatch {
  return {
    match_id: "arg-col",
    timestamp: Math.floor(VOLLEYBALL_KICKOFF.getTime() / 1_000),
    match_status: {
      stage: null,
      is_cancelled: false,
      is_postponed: false,
      is_started: false,
      is_in_progress: false,
      is_finished: false,
    },
    home_team: { team_id: "arg", name: "Argentina" },
    away_team: { team_id: "col", name: "Colombia" },
    scores: { home: 0, away: 3 },
  } as FlashscoreMatch;
}

describe("inferência de terminalidade do vôlei", () => {
  it("não liquida antes de 5h, mesmo com placar parado há 30min", () => {
    const agora = new Date(VOLLEYBALL_KICKOFF.getTime() + 5 * 3_600_000 - 1);
    expect(decidirTerminal({
      match: volleyballMatch(),
      sportId: 12,
      agora,
      anterior: {
        placar: "0x3",
        desde: new Date(agora.getTime() - 30 * 60_000),
      },
    })).toEqual({ terminal: false, motivo: "cedo_demais" });
  });

  it("só aceita depois do portão e da estabilidade", () => {
    const agora = new Date(VOLLEYBALL_KICKOFF.getTime() + 5 * 3_600_000);
    expect(decidirTerminal({
      match: volleyballMatch(),
      sportId: 12,
      agora,
      anterior: {
        placar: "0x3",
        desde: new Date(agora.getTime() - 30 * 60_000),
      },
    })).toEqual({ terminal: true, via: "inferencia" });
  });
});

describe("jogo que acabou sem ser jogado até o fim", () => {
  it("reconhece as grafias reais do catálogo em produção", () => {
    expect(interruptedFinishOf("Finished / retired")).toBe("retired");
    expect(interruptedFinishOf("Walkover")).toBe("walkover");
    expect(interruptedFinishOf("Awarded")).toBe("awarded");
    expect(interruptedFinishOf("Abandoned")).toBe("abandoned");
    expect(interruptedFinishOf("W.O.")).toBe("walkover");
  });

  it("jogo parado (Interrupted, Suspended) também não liquida pelo placar do momento", () => {
    expect(interruptedFinishOf("Interrupted")).toBe("interrupted");
    expect(interruptedFinishOf("Suspended")).toBe("interrupted");
  });

  it("não confunde fim normal, prorrogação ou jogo em andamento", () => {
    for (const stage of [
      "Finished", "After Extra Time", "After Penalties", "After Overtime",
      "Set 2", "Break Time", "Half Time", "Postponed", "Cancelled", "", null,
    ]) {
      expect(interruptedFinishOf(stage)).toBeNull();
    }
  });
});
