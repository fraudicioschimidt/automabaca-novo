import { beforeEach, describe, expect, it, vi } from "vitest";
import { entrouAoVivo, JANELA_DE_JOGO_MS } from "@/src/domain/entrada-ao-vivo";
import { NO_ODDS_REASONS } from "@/src/domain/no-odds-reason";
import type * as ClosingSeries from "@/src/services/sharp/closing/series";

const mocks = vi.hoisted(() => ({
  writeClosingOnce: vi.fn(),
  closeSeriesAfterKickoff: vi.fn(),
  capturePinnacle17Closing: vi.fn(),
}));

vi.mock("@/src/services/sharp/closing-guard", () => ({
  writeClosingOnce: mocks.writeClosingOnce,
}));
vi.mock("@/src/services/ops/alerts", () => ({
  sendOperatorNotification: vi.fn(),
}));
vi.mock("@/src/services/sharp/closing/series", async (original) => ({
  ...await original<typeof ClosingSeries>(),
  closeSeriesAfterKickoff: mocks.closeSeriesAfterKickoff,
}));
vi.mock("@/src/services/sharp/closing/pinnacle17-clv", () => ({
  capturePinnacle17Closing: mocks.capturePinnacle17Closing,
}));

const { processBridgeClv } = await import("@/src/services/sharp/closing/bridge-clv");
const { snapshotClosingForBet } = await import("@/src/services/sharp/closing/pinnacle17-snapshot");

/**
 * Portão: entrada ao vivo não produz CLV.
 *
 * A BridgeOdds guarda closing RETROATIVO: aposta registrada com a bola rolando
 * recebe a linha que fechou no minuto 0, e o painel exibiria um CLV com
 * `clvReliable = true` que não existe, distorcendo a média do canal, que é a
 * métrica central do sistema.
 *
 * O portão cobre as duas metades, porque cada uma sozinha deixa passar:
 *  (a) o PREDICADO, incluindo a borda exata e o caso de kickoff provisório;
 *  (b) que todo caminho que escreve CLV CONSULTA o predicado: são três
 *      escritores (bridge, snapshot, busca pós-jogo), e um guard em um só deixa o buraco.
 */

const KICKOFF = new Date("2026-08-10T21:00:00Z");

describe("entrada ao vivo não tem CLV", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.writeClosingOnce.mockResolvedValue(true);
  });
  it("placar estruturado prova live mesmo quando o horário não prova", () => {
    expect(entrouAoVivo({
      registradoEm: new Date(KICKOFF.getTime() - 60_000),
      kickoff: KICKOFF,
      liveScoreHome: 1,
      liveScoreAway: 0,
    })).toBe(true);
  });

  it("registro depois do kickoff, com o jogo rolando, é ao vivo", () => {
    // Botafogo W × Fluminense W, +51min do apito.
    expect(entrouAoVivo({
      registradoEm: new Date("2026-08-10T21:51:23Z"),
      kickoff: KICKOFF,
      kickoffInferido: false,
    })).toBe(true);
  });

  it("registro muito depois do fim NÃO é ao vivo — é captura atrasada", () => {
    // Sem este teto o guard descartaria capturas atrasadas, que têm perfil de
    // pré-jogo, tirando amostras boas de um sistema cujo gargalo é tamanho de
    // amostra.
    expect(entrouAoVivo({
      registradoEm: new Date("2026-08-13T12:00:00Z"), // +63h
      kickoff: KICKOFF,
    })).toBe(false);
  });

  it("a borda da janela de jogo pertence ao ao vivo", () => {
    const borda = new Date(KICKOFF.getTime() + JANELA_DE_JOGO_MS);
    expect(entrouAoVivo({ registradoEm: borda, kickoff: KICKOFF })).toBe(true);
    expect(entrouAoVivo({
      registradoEm: new Date(borda.getTime() + 1),
      kickoff: KICKOFF,
    })).toBe(false);
  });

  it("registro antes do kickoff não é ao vivo", () => {
    expect(entrouAoVivo({
      registradoEm: new Date("2026-08-10T20:30:00Z"),
      kickoff: KICKOFF,
      kickoffInferido: false,
    })).toBe(false);
  });

  it("registro no instante exato do kickoff não é ao vivo", () => {
    // A borda pertence ao pré-jogo: a linha ainda é a de fechamento, e o viés
    // seguro é não descartar amostra boa.
    expect(entrouAoVivo({ registradoEm: KICKOFF, kickoff: KICKOFF })).toBe(false);
  });

  it("kickoff provisório nunca acusa ao vivo", () => {
    // `kickoffInferido` é meia-noite SP, um placeholder. Comparar contra ele
    // marcaria como ao vivo qualquer aposta registrada durante o dia.
    expect(entrouAoVivo({
      registradoEm: new Date("2026-08-10T23:00:00Z"),
      kickoff: new Date("2026-08-10T03:00:00Z"),
      kickoffInferido: true,
    })).toBe(false);
  });

  it("o motivo existe no vocabulário e é permanente", () => {
    // Permanente porque entrada ao vivo nunca vira pré-jogo: re-caçar odd só
    // gastaria provider, e é o que tira a linha da busca pós-jogo.
    expect(NO_ODDS_REASONS.aposta_ao_vivo.permanent).toBe(true);
  });

  it("writer BridgeOdds persiste ausência explícita sem preço nem CLV", async () => {
    const bet = {
      id: "bridge-live",
      evento: "A vs B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "A",
      odds: 2,
      stake: 1,
      data: KICKOFF,
      registradoEm: new Date(KICKOFF.getTime() + 10 * 60_000),
      kickoffInferido: false,
      liveScoreHome: 1,
      liveScoreAway: 0,
      closing: null,
    } as Parameters<typeof processBridgeClv>[0];
    const now = new Date(KICKOFF.getTime() + 20 * 60_000);

    await expect(processBridgeClv(bet, {} as Parameters<typeof processBridgeClv>[1], now))
      .resolves.toBe(true);
    expect(mocks.writeClosingOnce).toHaveBeenCalledWith(bet, "fetchedAt", {
      clvReliable: false,
      noOddsReason: "aposta_ao_vivo",
      source: "CRON",
      fetchedAt: now,
    });
  });

  it("snapshot congela a entrada ao vivo sem consultar a série nem o provider", async () => {
    const now = new Date(KICKOFF.getTime() + 20 * 60_000);
    await expect(snapshotClosingForBet({
      id: "snapshot-live",
      evento: "A vs B",
      esporte: "Soccer",
      mercado: "Moneyline",
      selecao: "A",
      odds: 2,
      data: KICKOFF,
      registradoEm: new Date(KICKOFF.getTime() + 10 * 60_000),
      kickoffInferido: false,
      liveScoreHome: 1,
      liveScoreAway: 0,
      sharp: { provider: "pinnacle17", providerMatchId: "123" },
      closing: null,
    }, now)).resolves.toEqual({ closed: true });
    expect(mocks.writeClosingOnce).toHaveBeenCalledWith(expect.objectContaining({ id: "snapshot-live" }), "fetchedAt", {
      fetchedAt: now,
      clvReliable: false,
      noOddsReason: "aposta_ao_vivo",
    });
    expect(mocks.closeSeriesAfterKickoff).not.toHaveBeenCalled();
    expect(mocks.capturePinnacle17Closing).not.toHaveBeenCalled();
  });

  it("a série recusa entrada ao vivo mesmo chamada direto", async () => {
    const input = {
      id: "series-live", evento: "A vs B", esporte: "Soccer", mercado: "Moneyline", selecao: "A", odds: 2,
      data: KICKOFF, registradoEm: new Date(KICKOFF.getTime() + 10 * 60_000), kickoffInferido: false,
      liveScoreHome: 1, liveScoreAway: 0,
      sharp: { provider: "pinnacle17", providerMatchId: "123", identityStatus: "MATCHED" }, closing: null,
    };
    const current = { ...input, bankroll: { sharpMode: "CLV_ONLY" }, sportResolutionStatus: "CONFIRMED" };
    const { closingBetEligible } = await import("@/src/services/sharp/closing/series");
    // Mock parcial com todos os campos lidos pela elegibilidade; demais dados
    // do registro não são consultados. É a entrada ao vivo que impede o preço.
    expect(closingBetEligible({ ...current, registradoEm: new Date(KICKOFF.getTime() - 60_000),
      liveScoreHome: null, liveScoreAway: null } as unknown as Parameters<typeof closingBetEligible>[0])).toBe(true);
    expect(closingBetEligible(current as unknown as Parameters<typeof closingBetEligible>[0])).toBe(false);
  });
});
