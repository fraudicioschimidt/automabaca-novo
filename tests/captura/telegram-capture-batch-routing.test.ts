import { beforeEach, expect, it, vi } from "vitest";
import type { PgBoss } from "pg-boss";
import type { Prisma } from "@/src/generated/prisma/client";
import type { RegisterBetInput } from "@/src/services/bets/register";
import type { ChannelBankroll } from "@/src/services/bankrolls/lookup";
import type { ParsedBetPost } from "@/src/domain/bet-capture";

const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  enrich: vi.fn(),
  sport: vi.fn(),
  tx: { bet: { findMany: vi.fn() }, retiredBetSource: { findFirst: vi.fn() } },
}));

vi.mock("@/src/services/shared/transaction", () => ({
  runSerializableTransaction: async <T>(_name: string, run: (tx: Prisma.TransactionClient) => Promise<T>) => run(mocks.tx as unknown as Prisma.TransactionClient),
  reuseSerializableTransaction: () => mocks.tx,
}));
vi.mock(import("@/src/services/bets/register"), () => ({ registerBet: mocks.register, findPostSourceUse: vi.fn().mockResolvedValue(null) }));
vi.mock(import("@/src/services/capture/parse-telemetry"), () => ({ recordParseTelemetry: vi.fn() }));
vi.mock(import("@/src/services/capture/channel/reaction-decisions"), () => ({ reconcileCapturedReactionTx: vi.fn().mockResolvedValue(false) }));
vi.mock("@/src/services/ops/alerts", () => ({ sendOperationalAlert: vi.fn(), sendOperatorNotification: vi.fn() }));
vi.mock("@/src/services/scheduling/enqueue-enrich", () => ({ cancelPendingSharpEnrich: vi.fn(), enqueueSharpEnrich: mocks.enrich }));
vi.mock("@/src/services/scheduling/enqueue-sport-resolution", () => ({ enqueueSportResolution: mocks.sport }));
vi.mock("@/src/services/bets/sport-resolution/team-candidates", () => ({ findTeamIdentitySportCandidates: vi.fn().mockResolvedValue([]) }));

import { mapLlmBetToParsedList } from "@/src/services/capture/reading/extraction-mapping";
import { llmBetSchema } from "@/src/services/capture/reading/extraction-contract";
import { extractionContentProblem } from "@/src/services/capture/reading/extraction-quality";
import { preparePlayerCaptureBatch } from "@/src/domain/player-prop-capture";
import { registerCaptureBatch } from "@/src/services/capture/channel/register-post";
import { enqueueAfterCapture } from "@/src/services/scheduling/enqueue-after-capture";

const bankroll: ChannelBankroll = {
  id: "bank", nome: "Banca sintética", slug: "banca-sintetica", capturePolicy: "AUTO", defaultBookmaker: null,
};
const post = { chatId: -1n, messageId: 1, postDate: new Date("2026-09-13T00:00:00Z") };
const caption = "1u cada";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.tx.bet.findMany.mockResolvedValue([]);
  mocks.tx.retiredBetSource.findFirst.mockResolvedValue(null);
  mocks.register.mockImplementation(async (input: RegisterBetInput) => ({
    created: true,
    betId: `bet:${input.evento}`,
    sportResolutionStatus: input.sportResolutionStatus,
  }));
});

function parsedItems(confirmedEvent: string, reverse: boolean): ParsedBetPost[] {
  const base = { mercado: "Resultado Final", selecao: "Casa", esporte: "Soccer", stake: 1, odds: 2, pais: "", casaDeAposta: "" };
  const items = [
    { ...base, evento: confirmedEvent, competicao: "Premier League" },
    { ...base, evento: "Cobalt vs Delta", competicao: "Torneio Sintético" },
  ];
  if (reverse) items.reverse();
  const raw = llmBetSchema.parse({ ...items[0], isBet: true, ticketType: "singles", visibleBetCount: 2, items });
  expect(extractionContentProblem(raw, caption)).toBeNull();
  const mapped = mapLlmBetToParsedList(raw, post.postDate);
  expect(mapped).toHaveLength(2);
  const prepared = preparePlayerCaptureBatch(mapped!, caption, false);
  expect(prepared.ok).toBe(true);
  if (!prepared.ok) throw new Error(prepared.reason);
  return prepared.bets;
}

it.each([
  { confirmedEvent: "Arsenal vs Everton", reverse: false, firstStatus: "CONFIRMED" },
  { confirmedEvent: "Arsenal vs Everton", reverse: true, firstStatus: "CONFIRMED" },
  { confirmedEvent: "Zeta vs Omega", reverse: false, firstStatus: "PENDING" },
  { confirmedEvent: "Zeta vs Omega", reverse: true, firstStatus: "PENDING" },
])("registro e filas mantêm modalidade por item: primeiro $firstStatus, entrada invertida=$reverse", async ({ confirmedEvent, reverse, firstStatus }) => {
  const outcome = await registerCaptureBatch({
    bankroll, post, bets: parsedItems(confirmedEvent, reverse), via: "gemini", caption,
  });
  expect(outcome).toMatchObject({ kind: "registered", sportResolutionStatus: firstStatus });
  if (outcome.kind !== "registered") throw new Error("Lote não registrado");
  expect(outcome.registeredBets).toEqual(expect.arrayContaining([
    { betId: `bet:${confirmedEvent}`, sportResolutionStatus: "CONFIRMED" },
    { betId: "bet:Cobalt vs Delta", sportResolutionStatus: "PENDING" },
  ]));
  expect(outcome.registeredBets).toHaveLength(2);

  const boss = {} as PgBoss;
  await enqueueAfterCapture(boss, outcome.registeredBets ?? [], "telegram-capture");
  expect(mocks.enrich.mock.calls).toEqual([[boss, `bet:${confirmedEvent}`]]);
  expect(mocks.sport.mock.calls).toEqual([[boss, "bet:Cobalt vs Delta", { origem: "telegram-capture" }]]);
});

it("usa o estado devolvido pelo registro quando diverge da preparação", async () => {
  mocks.register.mockImplementation(async (input: RegisterBetInput) => ({
    created: true,
    betId: `bet:${input.evento}`,
    sportResolutionStatus: "CONFLICT",
  }));
  const outcome = await registerCaptureBatch({
    bankroll, post, bets: parsedItems("Arsenal vs Everton", false), via: "gemini", caption,
  });
  expect(outcome).toMatchObject({ kind: "registered", sportResolutionStatus: "CONFLICT" });
  if (outcome.kind !== "registered") throw new Error("Lote não registrado");
  expect(outcome.registeredBets?.map((bet) => bet.sportResolutionStatus)).toEqual(["CONFLICT", "CONFLICT"]);
  await enqueueAfterCapture({} as PgBoss, outcome.registeredBets ?? [], "telegram-capture");
  expect(mocks.enrich).not.toHaveBeenCalled();
  expect(mocks.sport.mock.calls.map((call) => call[1])).toEqual(["bet:Arsenal vs Everton", "bet:Cobalt vs Delta"]);
});
