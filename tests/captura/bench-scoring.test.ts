import { describe, expect, it } from "vitest";
import {
  achievableItems, attemptKey, compareBet, latestAttempts, lineOf, marketMatches, parseGabarito, percentile, rankRoutes, scoreAttempt,
  routeVerdict, selectionMatches, summarizeRoute, summarizeRun, type AttemptRecord, type GabaritoItem, type PlanRoute, type ReadBet,
} from "@/scripts/lib/bench-scoring";

const folder = (files: string[], captions: Record<string, string> = {}) => ({
  exists: (name: string) => files.includes(name),
  sidecarCaption: (name: string) => captions[name],
});

const bet = (overrides: Partial<ReadBet> = {}): ReadBet => ({
  evento: "Flamengo vs Palmeiras", mercado: "Total de Gols", selecao: "Mais de 2.5", odds: 1.9, stake: 1, esporte: "Soccer", ...overrides,
});

const item = (overrides: Partial<GabaritoItem> = {}): GabaritoItem => ({
  id: "a.png", arquivos: ["a.png"], legenda: "", leitor: "bilhete", resposta: "aposta", faltando: [], politica: "AUTO", conferido: true,
  apostas: [{ evento: "Flamengo vs Palmeiras", mercado: "Total de Gols", selecao: "Mais de 2.5", linha: 2.5, odds: 1.9, stake: 1, esporte: "Soccer" }],
  ...overrides,
});

let sequence = 0;
const record = (overrides: Partial<AttemptRecord> = {}): AttemptRecord => ({
  key: `k${++sequence}`, itemId: "a.png", itemHash: "h", route: "gemini/m", provider: "gemini", model: "m", endpoint: "generate", rep: 1,
  at: "2026-09-23T12:00:00.000Z", transport: "ok", latencyMs: 1000, totalMs: 1000, httpAttempts: 1, rateLimitHits: 0, contractValid: true,
  outcome: { kind: "aposta", detail: "1 aposta(s)", missing: [], bets: [bet()], readingRows: [bet()] },
  ...overrides,
});

describe("parseGabarito", () => {
  it("resolve leitor, resposta padrão e legenda do arquivo ao lado", () => {
    const { items, problems } = parseGabarito({
      _comentario: "ignorado",
      "a.png": { apostas: [{ evento: "A vs B", odds: 2 }] },
      "b.txt": { resposta: "nao_e_aposta" },
      album: { arquivos: ["c.png", "d.png"], resposta: "incompleta", faltando: ["stake"] },
    }, folder(["a.png", "b.txt", "c.png", "d.png"], { "a.png": "1u no over" }));
    expect(problems).toEqual([]);
    expect(items.map((entry) => [entry.id, entry.leitor, entry.resposta, entry.legenda])).toEqual([
      ["a.png", "bilhete", "aposta", "1u no over"],
      ["b.txt", "texto", "nao_e_aposta", ""],
      ["album", "album", "incompleta", ""],
    ]);
  });

  it("lista cada problema sem derrubar os itens válidos", () => {
    const { items, problems } = parseGabarito({
      "ok.png": { resposta: "nao_e_aposta" },
      "sumiu.png": { resposta: "nao_e_aposta" },
      "sem-resposta.png": { conferido: false },
      "contraditorio.png": { resposta: "nao_e_aposta", apostas: [{ evento: "A vs B" }] },
    }, folder(["ok.png", "sem-resposta.png", "contraditorio.png"]));
    expect(items.map((entry) => entry.id)).toEqual(["ok.png"]);
    expect(problems).toHaveLength(3);
  });
});

describe("comparação campo a campo", () => {
  it("lê a linha pelo leitor de linhas da liquidação", () => {
    expect(lineOf("Mais de 2.5", "Total de Gols")).toBe(2.5);
    expect(lineOf("Barcelona +0.5", "Handicap Asiático")).toBe(0.5);
    expect(lineOf("Grêmio -0.5, -1.0", "Handicap Asiático")).toBe(-0.75);
    expect(lineOf("Corinthians", "Resultado Final")).toBeNull();
  });

  it("aceita a mesma seleção escrita de outro jeito e recusa lado, direção ou linha diferentes", () => {
    expect(selectionMatches("Mais de 2.5", "Over 2.5 gols", "Total de Gols")).toBe(true);
    expect(selectionMatches("Barcelona +0.5", "Barcelona AH +0.5", "Handicap Asiático")).toBe(true);
    expect(selectionMatches("Mais de 2.5", "Menos de 2.5", "Total de Gols")).toBe(false);
    expect(selectionMatches("Mais de 2.5", "Mais de 3.5", "Total de Gols")).toBe(false);
    expect(selectionMatches("Barcelona +0.5", "Real Madrid +0.5", "Handicap Asiático")).toBe(false);
  });

  it("compara mercado pelo catálogo e pela estatística", () => {
    expect(marketMatches("Total de Gols", "total de gols")).toBe(true);
    expect(marketMatches("Total de Escanteios", "Total de Gols", "Mais de 9.5")).toBe(false);
  });

  it("lê props de jogador e mercados fora do catálogo pelo significado", () => {
    expect(lineOf("Jamal Musiala 2+ desarmes", "Jogador – Total de Desarmes")).toBe(1.5);
    expect(selectionMatches("Jamal Musiala 2+ desarmes", "Jamal Musiala Over 1.5 Tackles", "Player Tackles")).toBe(true);
    expect(selectionMatches("Jamal Musiala 2+ desarmes", "Jamal Musiala 3+", "Player Tackles")).toBe(false);
    expect(marketMatches("Jogador – Total de Desarmes", "Player Tackles", "Jamal Musiala 2+")).toBe(true);
    expect(marketMatches("Jogador – Chutes ao Gol", "Player Shots", "Estela Carbonell Over 0.5")).toBe(false);
    expect(marketMatches("Jogador – Total de Pontos", "Player Points", "A'ja Wilson Under 27.5")).toBe(true);
    expect(marketMatches("Vencer sem sofrer gols – Jogo", "Win to Nil", "Independiente Medellin")).toBe(true);
    expect(selectionMatches("Independiente Medellin vence de zero – Sim", "Independiente Medellin")).toBe(true);
    expect(marketMatches("Total de Cartões Asiático – Jogo", "Asian Total Cards", "Under 3.5")).toBe(true);
    expect(marketMatches("Handicap – Jogo", "Handicap – 1º Tempo", "Trier -3.5")).toBe(false);
  });

  it("confere odd e stake como número e ignora campo ausente no gabarito", () => {
    const fields = compareBet({ evento: "Flamengo x Palmeiras", odds: 1.9, stake: null }, bet({ odds: 1.9000, stake: null }));
    expect(fields).toEqual({ evento: true, odds: true, stake: true });
    expect(compareBet({ evento: "Flamengo vs Palmeiras", odds: 1.9 }, bet({ odds: 1.91 })).odds).toBe(false);
    expect(compareBet({ evento: "Flamengo vs Palmeiras", odds: 1.9 }, undefined)).toEqual({ evento: false, odds: false });
  });
});

describe("scoreAttempt", () => {
  it("dá o item como certo só com tipo, quantidade e todos os campos certos", () => {
    expect(scoreAttempt(record(), item())).toMatchObject({ itemCorrect: true, kindCorrect: true, betsCorrect: 1, errors: [] });
    const wrongOdd = scoreAttempt(record({ outcome: { kind: "aposta", detail: "", missing: [], bets: [bet({ odds: 2 })], readingRows: [] } }), item());
    expect(wrongOdd).toMatchObject({ itemCorrect: false, kindCorrect: true, betsCorrect: 0 });
    expect(wrongOdd?.errors[0]).toContain("odds errado");
  });

  it("não derruba a aposta inteira por esporte não informado, mas derruba por esporte errado", () => {
    const unknown = scoreAttempt(record({ outcome: { kind: "aposta", detail: "", missing: [], bets: [bet({ esporte: "Unknown" })], readingRows: [] } }), item());
    expect(unknown).toMatchObject({ itemCorrect: true, fields: [expect.objectContaining({ esporte: false })] });
    const wrong = scoreAttempt(record({ outcome: { kind: "aposta", detail: "", missing: [], bets: [bet({ esporte: "Basketball" })], readingRows: [] } }), item());
    expect(wrong?.itemCorrect).toBe(false);
    expect(scoreAttempt(record({ outcome: { kind: "aposta", detail: "", missing: [], bets: [bet({ esporte: "Futebol" })], readingRows: [] } }), item())?.fields[0]?.esporte).toBe(true);
  });

  it("pareia várias apostas sem depender da ordem e cobra a quantidade", () => {
    const expected = item({ apostas: [{ evento: "Lakers vs Celtics", odds: 1.95 }, { evento: "Knicks vs Heat", odds: 1.87 }] });
    const both = [bet({ evento: "Knicks vs Heat", odds: 1.87 }), bet({ evento: "Lakers vs Celtics", odds: 1.95 })];
    expect(scoreAttempt(record({ outcome: { kind: "aposta", detail: "", missing: [], bets: both, readingRows: [] } }), expected)?.itemCorrect).toBe(true);
    const one = scoreAttempt(record({ outcome: { kind: "aposta", detail: "", missing: [], bets: [both[1] as ReadBet], readingRows: [] } }), expected);
    expect(one).toMatchObject({ itemCorrect: false, betsCorrect: 1, betsTotal: 2 });
  });

  it("mede incompleta pelo tipo e confere o que falta, usando as linhas da leitura", () => {
    const expected = item({ resposta: "incompleta", faltando: ["stake"], apostas: [{ evento: "Flamengo vs Palmeiras", odds: 1.9, stake: null }] });
    const draft = record({ outcome: { kind: "incompleta", detail: "rascunho sem stake", missing: ["stake"], bets: [], readingRows: [bet({ stake: null })] } });
    expect(scoreAttempt(draft, expected)).toMatchObject({ itemCorrect: true, missingCorrect: true, betsCorrect: 1 });
  });

  it("não dá nota a quem não respondeu", () => {
    expect(scoreAttempt(record({ transport: "rate_limit", outcome: undefined }), item())).toBeNull();
  });
});

describe("métricas por modelo", () => {
  it("calcula percentil com interpolação linear", () => {
    expect(percentile([], 50)).toBeNull();
    expect(percentile([5], 95)).toBe(5);
    expect(percentile([1, 2, 3, 4], 50)).toBe(2.5);
    expect(percentile([10, 20, 30, 40, 50], 95)).toBeCloseTo(48);
  });

  const plan = (route: string, keys: string[]): PlanRoute => ({ route, provider: route.split("/")[0] ?? "", model: route.split("/")[1] ?? "", endpoint: "generate", vision: true, inUse: false, keys });

  it("resume acerto, latência, falhas e pendências do plano", () => {
    const items = new Map([["a.png", item()], ["b.txt", item({ id: "b.txt", leitor: "texto", resposta: "nao_e_aposta", apostas: [] })]]);
    const records = [
      record({ key: "1" }),
      record({ key: "2", itemId: "b.txt", latencyMs: 3000, outcome: { kind: "aposta", detail: "", missing: [], bets: [bet()], readingRows: [] } }),
      record({ key: "3", transport: "rate_limit", outcome: undefined, latencyMs: undefined, rateLimitHits: 7 }),
    ];
    const summary = summarizeRoute(plan("gemini/m", ["1", "2", "3", "4"]), records, items);
    expect(summary).toMatchObject({ planned: 4, recorded: 3, pending: 1, answered: 2, rateLimitHits: 7, transport: { ok: 2, rate_limit: 1 } });
    expect(summary.item).toEqual({ correct: 1, total: 2 });
    expect(summary.image).toEqual({ correct: 1, total: 1 });
    expect(summary.text).toEqual({ correct: 0, total: 1 });
    expect(summary.kinds.nao_e_aposta).toEqual({ correct: 0, total: 1 });
    expect(summary.latency.p50).toBe(2000);
    expect(summary.errors).toHaveLength(1);
  });

  it("ordena por amostra, acerto e depois velocidade", () => {
    const items = new Map([["a.png", item()]]);
    const fast = summarizeRoute(plan("groq/rapido", ["f"]), [record({ key: "f", route: "groq/rapido", latencyMs: 500 })], items);
    const slow = summarizeRoute(plan("gemini/lento", ["s"]), [record({ key: "s", route: "gemini/lento", latencyMs: 9000 })], items);
    const empty = summarizeRoute(plan("mistral/sem-cota", ["e"]), [record({ key: "e", route: "mistral/sem-cota", transport: "sem_cota", outcome: undefined })], items);
    expect(rankRoutes([empty, slow, fast]).map((summary) => summary.route)).toEqual(["groq/rapido", "gemini/lento", "mistral/sem-cota"]);
  });

  it("conta a última resposta de cada leitura e todas as tentativas na disponibilidade", () => {
    const items = new Map([["a.png", item()]]);
    const history = [
      record({ key: "x", transport: "indisponivel", outcome: undefined, latencyMs: undefined }),
      record({ key: "x" }),
      record({ key: "y", transport: "timeout", outcome: undefined, latencyMs: undefined }),
    ];
    expect([...latestAttempts(history).values()].map((entry) => [entry.key, entry.transport])).toEqual([["x", "ok"], ["y", "timeout"]]);
    const summary = summarizeRoute(plan("gemini/m", ["x", "y"]), history, items);
    expect(summary).toMatchObject({ attempts: 3, recorded: 2, answered: 1, transport: { ok: 1, indisponivel: 1, timeout: 1 } });
    expect(summary.item).toEqual({ correct: 1, total: 1 });
  });

  it("mede o acerto alcançável só nos itens que algum modelo acertou", () => {
    const items = new Map([["a.png", item()], ["b.png", item({ id: "b.png", arquivos: ["b.png"] })]]);
    const miss = { kind: "incompleta" as const, detail: "revisão", missing: [], bets: [], readingRows: [] };
    const records = [
      record({ key: "a1", route: "gemini/bom" }), record({ key: "b1", route: "gemini/bom", itemId: "b.png", outcome: miss }),
      record({ key: "a2", route: "groq/ruim", outcome: miss }), record({ key: "b2", route: "groq/ruim", itemId: "b.png", outcome: miss }),
    ];
    const achievable = achievableItems(records, items);
    expect([...achievable]).toEqual(["a.png"]);
    const good = summarizeRoute(plan("gemini/bom", ["a1", "b1"]), records, items, achievable);
    expect(good.item).toEqual({ correct: 1, total: 2 });
    expect(good.achievable).toEqual({ correct: 1, total: 1 });
  });

  it("no relatório, a leitura de uma versão antiga do item não conta no alcançável nem na tabela por item", () => {
    const items = [item(), item({ id: "b.png", arquivos: ["b.png"] })];
    const miss = { kind: "incompleta" as const, detail: "revisão", missing: [], bets: [], readingRows: [] };
    const current = { a: attemptKey("a.png", "novo", "gemini/m", 1), b: attemptKey("b.png", "novo", "gemini/m", 1) };
    const records = [
      // Acertou o print antigo; o dono trocou o arquivo e o item ganhou hash novo.
      record({ key: attemptKey("a.png", "velho", "gemini/m", 1), itemHash: "velho" }),
      record({ key: current.a, itemHash: "novo", outcome: miss }),
      record({ key: current.b, itemHash: "novo", itemId: "b.png" }),
    ];
    const { summaries, itemStats } = summarizeRun([plan("gemini/m", [current.a, current.b])], records, items);
    expect(summaries[0]?.achievable).toEqual({ correct: 1, total: 1 });
    expect(summaries[0]?.item).toEqual({ correct: 1, total: 2 });
    expect(itemStats).toEqual([
      { id: "a.png", correct: 0, answered: 1, commonMiss: "revisão (1)" },
      { id: "b.png", correct: 1, answered: 1 },
    ]);
  });

  it("elimina por acerto, contrato ou lentidão e só manda reconfirmar a indisponibilidade", () => {
    const items = new Map([["a.png", item()]]);
    const keys = ["1", "2", "3", "4", "5"];
    const good = summarizeRoute(plan("gemini/bom", keys), keys.map((key) => record({ key, route: "gemini/bom" })), items);
    expect(routeVerdict(good, 20_000)).toEqual({ verdict: "manter", reasons: [] });
    const slow = summarizeRoute(plan("gemini/lento", keys), keys.map((key) => record({ key, route: "gemini/lento", latencyMs: 25_000, overProductionTimeout: true })), items);
    expect(routeVerdict(slow, 20_000).reasons[0]).toContain("lento");
    const wrong = summarizeRoute(plan("gemini/erra", keys), keys.map((key) => record({ key, route: "gemini/erra", contractValid: false,
      outcome: { kind: "nao_e_aposta", detail: "", missing: [], bets: [], readingRows: [] } })), items);
    expect(routeVerdict(wrong, 20_000)).toMatchObject({ verdict: "eliminar", reasons: [expect.stringContaining("acerto baixo"), expect.stringContaining("contrato inválido")] });
    const busy = summarizeRoute(plan("gemini/ocupado", keys), [
      ...keys.map((key) => record({ key, route: "gemini/ocupado", transport: "indisponivel", outcome: undefined })),
      record({ key: "1", route: "gemini/ocupado" }),
    ], items);
    expect(routeVerdict(busy, 20_000).verdict).toBe("reconfirmar");
    const locked = summarizeRoute(plan("gemini/fora", keys), [record({ key: "1", route: "gemini/fora", transport: "modelo_indisponivel", outcome: undefined, error: "404" })], items);
    expect(routeVerdict(locked, 20_000).verdict).toBe("sem_acesso");
  });
});
