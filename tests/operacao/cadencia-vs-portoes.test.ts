import { describe, expect, it } from "vitest";
import { SCHEDULE_MANIFEST } from "@/src/jobs/schedules";
import { cadenciaDaFila } from "../helpers/cadencia";
import { QUEUES } from "@/src/infra/queue-contract";
import {
  CONFIRMACAO_MIN_MS,
  chavePlacar,
  decidirTerminal,
  type ObservacaoAnterior,
} from "@/src/providers/flashscore/terminal";
import type { FlashscoreMatch } from "@/src/providers/flashscore/types";

/**
 * Constante de espera tem de ser ALCANÇÁVEL pela cadência que a avalia.
 *
 * O risco: duas constantes corretas quando lidas sozinhas, cada uma num arquivo,
 * e contraditórias quando postas na mesma linha do tempo. Se a inferência exige
 * placar estável há ≥30min e ancora na observação ANTERIOR, que o job regrava a
 * cada 15min, a distância fica sempre em ~15min e nada liquida. Um teste puro do
 * detector passa assim mesmo, porque nunca roda DUAS leituras seguidas.
 *
 * O que este portão faz de diferente de um teste de unidade: ele roda o LOOP da
 * cadência REAL contra a função REAL, e reprova se o portão nunca abre. A
 * cadência vem de `SCHEDULE_MANIFEST` — a fonte que o worker usa —, então mudar
 * o cron sem revisar as esperas reprova aqui em vez de virar feature morta.
 */

// `cadenciaMinutos`/`cadenciaDaFila` vivem em `tests/helpers/cadencia.ts`: o
// portão `frescor-declarado` precisa da mesma resposta, e duas cópias de um
// parser de cron discordando deixam um portão verde medindo outra coisa.

const KICKOFF = new Date("2026-08-05T12:00:00Z");

function partida(placar: { home: number; away: number }): FlashscoreMatch {
  return {
    match_id: "m1",
    timestamp: KICKOFF.getTime() / 1000,
    home_team: { name: "A", team_id: "a", red_cards: null },
    away_team: { name: "B", team_id: "b", red_cards: null },
    scores: placar,
    match_status: {
      stage: "LIVE",
      is_finished: false,
      is_cancelled: false,
      is_postponed: false,
    },
    tournament: { name: "Liga" },
  } as unknown as FlashscoreMatch;
}

describe("portão: a cadência real alcança as esperas que ela avalia", () => {
  it("o manifesto é legível e as cadências saem dele, não de cópia", () => {
    // Guarda contra vacuidade: se o parser quebrar, tudo abaixo passaria com NaN.
    const cadencia = cadenciaDaFila(QUEUES.flashscoreResults);
    expect(Number.isFinite(cadencia)).toBe(true);
    expect(cadencia).toBeGreaterThan(0);
    expect(SCHEDULE_MANIFEST.length).toBeGreaterThan(5);
  });

  /**
   * 24h de ciclos na cadência REAL, com o placar parado desde o kickoff. A
   * inferência TEM de liquidar em algum ciclo.
   *
   * Com a âncora errada (a leitura anterior em vez da primeira aparição) este
   * loop devolvia `{ cedo_demais: 15, sem_confirmacao: 81 }` — nunca terminal.
   */
  it("a inferência liquida dentro de 24h de ciclos na cadência real", () => {
    const cadencia = cadenciaDaFila(QUEUES.flashscoreResults);
    const passoMs = cadencia * 60_000;
    const ciclos = Math.ceil((24 * 3_600_000) / passoMs);

    const placar = { home: 2, away: 1 };
    const match = partida(placar);
    // Placar e âncora em variáveis separadas: uma `let` de objeto atribuída só
    // dentro do laço é estreitada para `never` pelo fluxo do TypeScript.
    let placarVisto: string | null = null;
    let ancora: Date | null = null;
    let liquidouNoCiclo: number | null = null;
    const motivos = new Map<string, number>();

    for (let i = 1; i <= ciclos; i += 1) {
      const agora = new Date(KICKOFF.getTime() + i * passoMs);
      const anterior: ObservacaoAnterior | null =
        placarVisto !== null && ancora !== null
          ? { placar: placarVisto, desde: ancora }
          : null;
      const decisao = decidirTerminal({ match, sportId: 7, agora, anterior });
      if (decisao.terminal) {
        liquidouNoCiclo = i;
        break;
      }
      motivos.set(decisao.motivo, (motivos.get(decisao.motivo) ?? 0) + 1);
      // É ISTO que o job faz a cada ciclo: propaga a âncora enquanto o placar
      // não muda. Simular a propagação errada esconderia a âncora errada.
      const chave = chavePlacar(match);
      if (chave !== null) {
        if (chave !== placarVisto) ancora = agora;
        placarVisto = chave;
      }
    }

    expect(
      liquidouNoCiclo,
      liquidouNoCiclo !== null
        ? ""
        : `A inferência NUNCA liquidou em ${ciclos} ciclos de ${cadencia}min ` +
          `(24h com o placar parado desde o kickoff).\n` +
          `Motivos acumulados: ${JSON.stringify(Object.fromEntries(motivos))}\n\n` +
          `Uma espera que a cadência não alcança é feature morta que passa no ` +
          `teste de unidade — lição 78. Reveja a constante ou a cadência.`,
    ).not.toBeNull();
  });

  /**
   * O contra-peso, e ele protege dinheiro: a espera não pode ser tão curta que
   * o portão abra na PRIMEIRA leitura. Se abrir, o placar nunca foi confirmado
   * como estável e a liquidação vira aposta no parcial.
   */
  it("a inferência NÃO liquida na primeira leitura", () => {
    const cadencia = cadenciaDaFila(QUEUES.flashscoreResults);
    const agora = new Date(KICKOFF.getTime() + cadencia * 60_000);
    const decisao = decidirTerminal({
      match: partida({ home: 2, away: 1 }),
      sportId: 7,
      agora,
      anterior: null,
    });
    expect(decisao.terminal).toBe(false);
  });

  /**
   * E a relação que dá nome à classe: a espera precisa de MAIS DE UM ciclo para
   * ser confirmada. Uma espera menor que a cadência é confirmada por acidente,
   * na primeira releitura — que é o oposto de provar estabilidade.
   */
  it("a espera de confirmação vale mais de um ciclo da cadência", () => {
    const cadenciaMs = cadenciaDaFila(QUEUES.flashscoreResults) * 60_000;
    expect(
      CONFIRMACAO_MIN_MS,
      `CONFIRMACAO_MIN_MS (${CONFIRMACAO_MIN_MS / 60_000}min) precisa ser maior ` +
        `que a cadência de ${cadenciaMs / 60_000}min, senão "estável" é confirmado ` +
        `pela releitura seguinte e não prova nada.`,
    ).toBeGreaterThan(cadenciaMs);
  });
});
