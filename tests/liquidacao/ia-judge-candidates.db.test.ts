import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "../helpers/db";
import { findIaJudgeCandidates, findStalledSettlementCandidates } from "@/src/services/settlement/ia-judge/candidates";
import { reportIaCrossCheck } from "@/src/services/settlement/flashscore/ia-crosscheck";
import { isScoreResolvableMarket } from "@/src/domain/settlement/markets";
import { NON_SCORE_STAT_TERMS } from "@/src/domain/mercados/stat-qualifier";

vi.mock("@/src/infra/llm/cascade", () => ({ llmGenerateJson: vi.fn() }));
vi.mock("@/src/infra/llm/gemini-search", () => ({
  geminiGenerateJsonWithSearch: vi.fn(),
  resolveGroundingRedirectHost: vi.fn(),
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperationalAlert: vi.fn(),
  sendOperatorNotification: vi.fn(),
}));

/**
 * Ninguém pode cair no LIMBO entre o espelho SQL e o domínio.
 *
 * - o espelho `scoreResolvableMercadoWhere()` só olha `mercado`;
 * - `isScoreResolvableMarket()` olha `mercado` E `selecao`.
 *
 * Uma aposta no meio dos dois — mercado com cara de placar ("Moneyline"),
 * estatística declarada na SELEÇÃO ("Gremio 2+ cards") — é admitida pelo lote
 * SQL e recusada pelo domínio; o IA-Judge precisa alcançá-la mesmo assim.
 *
 * Este portão não tenta afinar o espelho — `contains` do Prisma é substring, e
 * espelhar `\d+\s*\+?\s*(termo)` exigiria enumerar dígito por termo, enquanto um
 * espelho amplo tiraria "Las Vegas Aces" do moneyline. Ele cobra a garantia que
 * IMPORTA: o que o domínio recusa tem de chegar a alguém.
 *
 * As formas são GERADAS do vocabulário exportado, então termo novo entra no
 * portão sozinho — não depende de alguém lembrar de acrescentar o caso.
 */

let db: TestDb;

/** Kickoff há ~8h — dentro da janela 6h–7d do IA-Judge. */
const PASSADO = new Date("2026-01-01T12:00:00Z");
const AGORA = new Date("2026-01-01T20:00:00Z");

beforeAll(() => {
  db = createTestDb();
});
afterAll(async () => {
  await db.dispose();
});
beforeEach(async () => {
  await db.reset();
  vi.resetAllMocks();
});

/**
 * Teto de candidatos que `findIaJudgeCandidates` devolve por ciclo.
 *
 * Precisa estar aqui porque a amostra deste portão TEM de caber num lote: uma
 * amostra maior acusaria como órfãs apostas que são só truncamento — o tipo
 * de falso alarme que faz um portão ser ignorado. Se o
 * `BATCH_SIZE` do serviço mudar, o caso de sanidade abaixo reprova e alguém
 * ajusta a amostra em vez de descobrir isso como "flake".
 */
const LOTE_DO_IA_JUDGE = 20;

/** Amostra de termos da fonte exportada, para o portão não virar lista à mão. */
function amostraDeTermos(): string[] {
  const literais = NON_SCORE_STAT_TERMS.split("|")
    .map((a) => a.replace(/s\?$/, "s"))
    .filter((a) => !/[[\]()?*+{}\\]/.test(a));
  // Fatia estável e variada, dimensionada para caber num lote. A cobertura
  // exaustiva por FORMA vive no teste puro (`settlement-markets-stat-lines`);
  // aqui o que se prova é o RESGATE, e para isso bastam formas representativas.
  return [literais[0], literais[8]].filter((t): t is string => typeof t === "string");
}

/**
 * Mercados que o espelho SQL admite (cara de placar) combinados com seleções que
 * o domínio recusa (estatística declarada). O produto é exatamente o limbo.
 */
function casosDeLimbo(): Array<{ mercado: string; selecao: string }> {
  const MERCADOS_COM_CARA_DE_PLACAR = ["Moneyline", "Handicap Asiático", "Total – Match"];
  const FORMAS = [
    (t: string) => `Time A 2+ ${t}`,
    (t: string) => `Over 2.5 ${t}`,
    (t: string) => `${t} Over 2.5`,
  ];
  const casos: Array<{ mercado: string; selecao: string }> = [];
  for (const mercado of MERCADOS_COM_CARA_DE_PLACAR) {
    for (const termo of amostraDeTermos()) {
      for (const forma of FORMAS) {
        const selecao = forma(termo);
        // Só é LIMBO se o domínio realmente recusar. Se um dia o domínio passar
        // a aceitar, o caso sai daqui sozinho em vez de virar falso alarme.
        if (!isScoreResolvableMarket({ mercado, selecao, esporte: "Soccer" })) {
          casos.push({ mercado, selecao });
        }
      }
    }
  }
  return casos;
}

async function semear() {
  const bankroll = await db.prisma.bankroll.create({
    data: { nome: "Banca Limbo", slug: "banca-limbo", valorUnidade: 50 },
  });
  const conta = await db.prisma.conta.create({
    data: {
      casaDeAposta: "Bet365",
      titular: "Fabricio",
      saldoInicial: 1000,
      saldoAtual: 1000,
    },
  });
  let n = 0;
  const criar = (mercado: string, selecao: string, data = PASSADO, esporte = "Soccer") =>
    db.prisma.bet.create({
      data: {
        sportResolutionStatus: "CONFIRMED",
        sportResolvedAt: new Date(),
        settledAt: null,
        bankrollId: bankroll.id,
        contaId: conta.id,
        data,
        evento: `Evento ${(n += 1)}`,
        esporte,
        odds: 1.9,
        stake: 2,
        status: "PENDING",
        mercado,
        selecao,
      },
    });
  return { criar };
}

describe("portão: o limbo entre espelho SQL e domínio não engole aposta", () => {
  it("a geração produz limbo de verdade — senão o portão passa por vacuidade", () => {
    const casos = casosDeLimbo();
    expect(casos.length).toBeGreaterThan(5);
    // …e cabe num lote. Sem esta trava, ampliar a amostra devolveria "órfãs"
    // que são só truncamento — falso alarme é o que faz portão ser ignorado.
    expect(casos.length).toBeLessThanOrEqual(LOTE_DO_IA_JUDGE);
    // E o Moneyline com "Ambas 2+ cards" na seleção continua no limbo.
    expect(
      isScoreResolvableMarket({
        mercado: "Moneyline",
        selecao: "Ambas 2+ cards",
        esporte: "Soccer",
      }),
    ).toBe(false);
  });

  it("toda aposta que o domínio recusa chega ao IA-Judge", async () => {
    const { criar } = await semear();
    const casos = casosDeLimbo();
    const criadas = new Map<string, { mercado: string; selecao: string }>();
    for (const caso of casos) {
      const bet = await criar(caso.mercado, caso.selecao);
      criadas.set(bet.id, caso);
    }

    const candidatos = new Set(
      (await findIaJudgeCandidates(AGORA)).map((c) => c.id),
    );

    const orfas = [...criadas.entries()].filter(([id]) => !candidatos.has(id));
    expect(
      orfas,
      orfas.length === 0
        ? ""
        : `Aposta(s) sem liquidador automático E sem juiz — o limbo da lição 64:\n` +
            orfas
              .map(([, c]) => `  • "${c.mercado}" / "${c.selecao}"`)
              .join("\n") +
            `\n\nO domínio recusa (não liquida por placar) e o IA-Judge não as vê.\n` +
            `Só o card de settlement manual, em kickoff+6h, alcança essas apostas.`,
    ).toEqual([]);
  });

  it("a recusa que depende do evento também chega ao IA-Judge", async () => {
    const { criar } = await semear();
    // Sem o evento, "Flamengo e Over 2.5" passa por total do jogo; com ele, o
    // motor vê o time sozinho numa perna e recusa a combinada.
    const bet = await criar("Total de Gols", "Flamengo e Over 2.5");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { evento: "Flamengo vs Vasco" } });

    const candidatos = (await findIaJudgeCandidates(AGORA)).map((c) => c.id);

    expect(candidatos).toContain(bet.id);
  });

  it("continua varrendo quando uma página SQL inteira é recusada pelo domínio", async () => {
    const { criar } = await semear();
    // O espelho SQL classifica Moneyline como resolvível por placar, mas estes
    // 80 itens também são realmente resolvíveis no domínio. Um `take: 80`
    // aplicado antes da guarda JS esconderia para sempre o 81º item em limbo.
    for (let index = 0; index < LOTE_DO_IA_JUDGE * 4; index += 1) {
      await criar(
        "Moneyline",
        `Time ${String(index).padStart(3, "0")}`,
        new Date(PASSADO.getTime() + index * 1_000),
      );
    }
    const alvo = await criar(
      "Moneyline",
      "Time A 2+ cards",
      new Date(PASSADO.getTime() + LOTE_DO_IA_JUDGE * 4 * 1_000),
    );

    const candidatos = await findIaJudgeCandidates(AGORA);

    expect(candidatos.map((item) => item.id)).toContain(alvo.id);
  });

  it("o contra-peso: moneyline de verdade NÃO é puxado para o juízo", async () => {
    const { criar } = await semear();
    // Se o resgate virar funil, o IA-Judge passa a julgar o que o placar resolve
    // sozinho — gasto de LLM e latência para nada.
    const placarPuro = await criar("Moneyline", "Time A");
    const handicap = await criar("Handicap Asiático", "Time A -0.5");
    const nomeComEstatistica = await criar("Moneyline", "Las Vegas Aces");

    const candidatos = new Set(
      (await findIaJudgeCandidates(AGORA)).map((c) => c.id),
    );

    expect(candidatos.has(placarPuro.id)).toBe(false);
    expect(candidatos.has(handicap.id)).toBe(false);
    expect(candidatos.has(nomeComEstatistica.id)).toBe(false);
  });

  it("placar de esporte que o FlashScore não liquida vai ao juízo, mesmo com a observação fechada", async () => {
    const { criar } = await semear();
    // A observação fecha estas apostas logo de cara (`sport_without_terminal_status`,
    // `unsupported_sport`): sem o juiz, só a liquidação à mão as alcança.
    const luta = await criar("Moneyline", "Alex Pereira", PASSADO, "MMA");
    const formula1 = await criar("Vencedor", "Max Verstappen", PASSADO, "Formula 1");
    await db.prisma.betResult.create({ data: {
      betId: luta.id, resultProvider: "flashscore", resultFinal: true,
      resultSnapshot: { outcome: "sport_without_terminal_status", sport: "MMA", sportId: 28 },
    } });
    await db.prisma.betResult.create({ data: {
      betId: formula1.id, resultProvider: "flashscore", resultFinal: true,
      resultSnapshot: { outcome: "unsupported_sport", sport: "Formula 1" },
    } });

    const ids = (await findIaJudgeCandidates(AGORA)).map((candidate) => candidate.id);

    expect(ids).toContain(luta.id);
    expect(ids).toContain(formula1.id);
  });
});

describe("apostas paradas depois do FlashScore", () => {
  it("fica de fora a que o FlashScore já fechou; entram a que ele não fechou e a sem resultado", async () => {
    const { criar } = await semear();
    const fechada = await criar("Moneyline", "Time A");
    const aberta = await criar("Moneyline", "Time B");
    const semResultado = await criar("Moneyline", "Time C");
    await db.prisma.betResult.create({ data: { betId: fechada.id, resultProvider: "flashscore", resultFinal: true } });
    await db.prisma.betResult.create({ data: { betId: aberta.id, resultProvider: "flashscore", resultFinal: false } });

    const ids = (await findStalledSettlementCandidates(AGORA)).map((candidate) => candidate.id);
    expect(ids).toContain(aberta.id);
    expect(ids).toContain(semResultado.id);
    expect(ids).not.toContain(fechada.id);
  });
});

describe("conferência do FlashScore que diverge da IA", () => {
  it("tira a aposta da IA: reaberta pelo dono, ela não volta a ser candidata", async () => {
    const { criar } = await semear();
    const bet = await criar("Total (Corners) – Match", "Over 9.5");
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "WON", lucro: 1.8, settledAt: AGORA } });

    await reportIaCrossCheck(
      { ...bet, status: "WON" },
      { kind: "status", status: "LOST", evidence: "corners 4-3" },
      AGORA,
    );
    await db.prisma.bet.update({ where: { id: bet.id }, data: { status: "PENDING", lucro: 0, settledAt: null } });

    const ids = [
      ...(await findIaJudgeCandidates(AGORA)),
      ...(await findStalledSettlementCandidates(AGORA)),
    ].map((candidate) => candidate.id);
    expect(ids).not.toContain(bet.id);
    // Ainda dentro da janela do juiz: o cooldown vale até ela fechar.
    const later = new Date(AGORA.getTime() + 20 * 86_400_000);
    expect((await findStalledSettlementCandidates(later)).map((candidate) => candidate.id)).not.toContain(bet.id);
  });
});
