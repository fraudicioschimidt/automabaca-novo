import "dotenv/config";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import {
  geminiKeyRotation, keyHint, ocrApplies, routeId, routeSupportsItem, runAttempt, RouteStopped, type BenchRoute, type LoadedItem,
} from "./lib/bench-call";
import { listCatalog, probeVision, productionModels, refilterCatalog, type Catalog, type CatalogEntry } from "./lib/bench-catalog";
import { renderReport } from "./lib/bench-report";
import { geminiKeyPool } from "@/src/infra/llm/gemini";
import { DEFAULT_LANES, parseGaps, ProviderLane } from "./lib/bench-schedule";
import {
  attemptKey, isCaptionFile, isImageFile, isTextPostFile, latestAttempts, lineOf, parseGabarito, rate, summarizeRun,
  type AttemptRecord, type ExpectedBet, type GabaritoItem, type PlanRoute, type ReadBet,
} from "./lib/bench-scoring";

/**
 * Bancada de leitura: mede cada modelo de Gemini, Groq e Mistral lendo as
 * apostas de uma pasta, com o mesmo contrato da captura. Ferramenta de
 * desenvolvimento, só com o .env local; não entra no worker nem nas imagens.
 *
 *   npm run bench:leitura -- catalogo              lista os modelos das chaves e sonda visão
 *   npm run bench:leitura -- gabarito [--modelo gemini/gemini-2.5-flash]
 *                                                  rascunho do gabarito lido por um modelo
 *   npm run bench:leitura -- rodar [--repeticoes 2] [--provedores gemini,groq]
 *        [--modelos gemini/x,groq/y] [--por-provedor 3] [--itens a.jpg,b.txt]
 *        [--intervalo gemini=7000,groq=4000,mistral=1500] [--timeout 60000] [--refazer-falhas]
 *   npm run bench:leitura -- relatorio             refaz a página com o gabarito atual
 *
 * Opções comuns: --pasta ~/bench-leitura (arquivos + gabarito.json) e
 * --saida <pasta>/resultado. Formato do gabarito: docs/BENCH-LEITURA.md.
 * O catálogo de produção (`src/infra/llm/models.ts`) é só o padrão: marca os
 * modelos "em uso" e é o leitor do gabarito sem --modelo; `rodar` testa todo
 * modelo que as chaves enxergam, ou os de --modelos.
 * As chamadas não passam pelo cache de leituras nem pelo cooldown do banco:
 * cada tentativa vai ao modelo (ver `lib/bench-call.ts`).
 */

type Options = Record<string, string | true>;

function parseArgs(argv: string[]): { command: string; options: Options } {
  const [command = "ajuda", ...rest] = argv;
  const options: Options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i] ?? "";
    if (!arg.startsWith("--")) throw new Error(`argumento inesperado: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2);
    const next = rest[i + 1];
    if (inline !== undefined) options[name ?? ""] = inline;
    else if (next !== undefined && !next.startsWith("--")) { options[name ?? ""] = next; i++; }
    else options[name ?? ""] = true;
  }
  return { command, options };
}

const text = (options: Options, name: string) => (typeof options[name] === "string" ? options[name] : undefined);
const list = (options: Options, name: string) => text(options, name)?.split(",").map((value) => value.trim()).filter(Boolean);
const out = (line = "") => process.stdout.write(`${line}\n`);

type Paths = { folder: string; output: string };
function paths(options: Options): Paths {
  const folder = path.resolve(text(options, "pasta")?.replace(/^~(?=$|\/)/, homedir()) ?? path.join(homedir(), "bench-leitura"));
  const output = path.resolve(text(options, "saida") ?? path.join(folder, "resultado"));
  mkdirSync(output, { recursive: true });
  return { folder, output };
}

const readJson = <T>(file: string): T | undefined => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as T : undefined);
const writeJson = (file: string, value: unknown) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

/* Pasta e gabarito. */

function folderFiles(folder: string): string[] {
  return readdirSync(folder, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => entry.name)
    .filter((name) => isImageFile(name) || isTextPostFile(name)).sort();
}

function folderContext(folder: string) {
  return {
    exists: (name: string) => existsSync(path.join(folder, name)),
    sidecarCaption: (name: string) => {
      const sidecar = path.join(folder, `${name.replace(/\.[^.]+$/, "")}.legenda.txt`);
      return existsSync(sidecar) ? readFileSync(sidecar, "utf8").trim() : undefined;
    },
  };
}

function loadGabarito(folder: string): { items: GabaritoItem[]; problems: string[] } {
  const file = path.join(folder, "gabarito.json");
  const raw = readJson<unknown>(file);
  if (raw === undefined) throw new Error(`falta ${file}. Rode "gabarito" para gerar um rascunho e confira antes.`);
  return parseGabarito(raw, folderContext(folder));
}

const MIME: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp" };

function loadItem(folder: string, item: GabaritoItem): LoadedItem {
  const hash = createHash("sha256");
  const images: LoadedItem["images"] = [];
  let postText: string | undefined;
  for (const name of item.arquivos) {
    const bytes = readFileSync(path.join(folder, name));
    hash.update(bytes);
    if (isTextPostFile(name)) postText = bytes.toString("utf8").trim();
    else images.push({ base64: bytes.toString("base64"), mimeType: MIME[path.extname(name).toLowerCase()] ?? "image/jpeg" });
  }
  // O que muda a leitura muda a chave; corrigir só a resposta esperada não refaz chamadas.
  hash.update(JSON.stringify([item.legenda, item.leitor, item.politica, item.banca ?? null, item.dataPost ?? null]));
  return { item, hash: hash.digest("hex").slice(0, 16), images, ...(postText !== undefined ? { text: postText } : {}) };
}

/* Catálogo. */

function laneFor(provider: string, options: Options): ProviderLane {
  const base = DEFAULT_LANES[provider as keyof typeof DEFAULT_LANES] ?? DEFAULT_LANES.mistral;
  const gap = parseGaps(text(options, "intervalo"))[provider];
  return new ProviderLane({ ...base, ...(gap !== undefined ? { modelGapMs: gap } : {}) });
}

async function buildCatalog(options: Options, output: string): Promise<Catalog> {
  const catalog = await listCatalog();
  if (options["sem-sonda"] !== true) {
    const lanes = new Map<string, ProviderLane>();
    const pending = catalog.entries.filter((entry) => entry.visionSource === "nome" && entry.endpoint !== "ocr");
    out(`Sondando visão de ${pending.length} modelo(s) sem essa informação na API...`);
    await Promise.all(pending.map(async (entry) => {
      const lane = lanes.get(entry.provider) ?? laneFor(entry.provider, options);
      lanes.set(entry.provider, lane);
      await probeVision(entry, lane);
    }));
  }
  writeJson(path.join(output, "catalogo.json"), catalog);
  return catalog;
}

function printCatalog(catalog: Catalog): void {
  for (const provider of ["gemini", "groq", "mistral"]) {
    const raw = catalog.listedNames[provider] ?? [];
    const entries = catalog.entries.filter((entry) => entry.provider === provider);
    const name = (entry: CatalogEntry) => `${entry.model}${entry.inUse.length ? " [em uso]" : ""}${entry.listed ? "" : " [não listado]"}${entry.availability === "ok" || entry.availability === "nao_sondado" ? "" : ` [${entry.availability}]`}${entry.endpoint === "ocr" ? " [OCR]" : ""}`;
    const vision = entries.filter((entry) => entry.vision), textOnly = entries.filter((entry) => !entry.vision);
    const filtered = catalog.filtered.filter((entry) => entry.provider === provider);
    out(`\n== ${provider}: a API listou ${raw.length}; ${entries.length} no teste (${vision.length} com visão, ${textOnly.length} só texto); ${filtered.length} fora`);
    out(`  listados: ${raw.join(", ")}`);
    out(`  visão: ${vision.map(name).join(", ") || "—"}`);
    out(`  só texto: ${textOnly.map(name).join(", ") || "—"}`);
    for (const entry of filtered) out(`  fora: ${entry.model} (${entry.reason})`);
    for (const entry of entries.filter((item) => item.note)) out(`  nota ${entry.model}: ${entry.note}`);
  }
}

async function loadCatalog(options: Options, output: string): Promise<Catalog> {
  const cached = options["novo-catalogo"] === true ? undefined : readJson<Catalog>(path.join(output, "catalogo.json"));
  return cached ? refilterCatalog(cached) : buildCatalog(options, output);
}

/* Execução. */

/** Todas as tentativas, de todas as passadas: a disponibilidade conta cada uma. */
function records(output: string): AttemptRecord[] {
  const file = path.join(output, "leituras.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line) as AttemptRecord);
}

function selectRoutes(catalog: Catalog, options: Options): CatalogEntry[] {
  const providers = list(options, "provedores");
  const models = list(options, "modelos");
  const perProvider = Number(text(options, "por-provedor") ?? Infinity);
  const usable = catalog.entries.filter((entry) => (options["incluir-indisponiveis"] === true || !["indisponivel", "sem_cota"].includes(entry.availability))
    && (!providers || providers.includes(entry.provider))
    && (!models || models.some((wanted) => wanted === routeId(entry) || wanted === entry.model || entry.aliases.includes(wanted))));
  // Com limite por provedor, os modelos em uso entram primeiro.
  const ordered = [...usable].sort((a, b) => Number(b.inUse.length > 0) - Number(a.inUse.length > 0));
  const counts = new Map<string, number>();
  return ordered.filter((entry) => {
    const count = counts.get(entry.provider) ?? 0;
    if (count >= perProvider) return false;
    counts.set(entry.provider, count + 1);
    return true;
  });
}

async function run(options: Options): Promise<void> {
  const { folder, output } = paths(options);
  const { items, problems } = loadGabarito(folder);
  for (const problem of problems) out(`gabarito: ${problem}`);
  const onlyItems = list(options, "itens");
  const selected = items.filter((item) => !onlyItems || onlyItems.includes(item.id));
  if (!selected.length) throw new Error("nenhum item do gabarito para rodar");
  const unconfirmed = selected.filter((item) => !item.conferido).length;
  if (unconfirmed) out(`atenção: ${unconfirmed} item(ns) com "conferido": false — o resultado favorece o modelo do rascunho.`);
  const loaded = selected.map((item) => loadItem(folder, item));
  const catalog = await loadCatalog(options, output);
  const routes = selectRoutes(catalog, options);
  const repetitions = Math.max(1, Number(text(options, "repeticoes") ?? 2));
  const timeoutMs = Number(text(options, "timeout") ?? 60_000);

  const ocrItems = new Set<string>();
  for (const item of loaded) if (item.item.leitor === "bilhete" && await ocrApplies(item)) ocrItems.add(item.item.id);
  const planRoutes: PlanRoute[] = routes.map((route) => ({
    route: routeId(route), provider: route.provider, model: route.model, endpoint: route.endpoint, vision: route.vision,
    inUse: route.inUse.length > 0,
    keys: loaded.filter((item) => routeSupportsItem(route, item.item) && (route.endpoint !== "ocr" || ocrItems.has(item.item.id)))
      .flatMap((item) => Array.from({ length: repetitions }, (_, index) => attemptKey(item.item.id, item.hash, routeId(route), index + 1))),
  }));
  // Rodadas parciais somam ao plano anterior: o relatório segue mostrando os outros modelos.
  const previous = readJson<{ repetitions: number; routes: PlanRoute[] }>(path.join(output, "plano.json"));
  const merged = [...(previous?.routes ?? []).filter((old) => !planRoutes.some((route) => route.route === old.route)), ...planRoutes];
  writeJson(path.join(output, "plano.json"), { repetitions, routes: merged });

  const history = records(output);
  const done = latestAttempts(history);
  const redo = options["refazer-falhas"] === true;
  // A nova passada refaz o que pode mudar com o tempo. Sem acesso (404, cota
  // zero) só volta com --refazer-sem-acesso, por exemplo depois de trocar a chave.
  const retryNoAccess = options["refazer-sem-acesso"] === true;
  const RETRYABLE = new Set(["indisponivel", "timeout", "rate_limit", "erro_rede", ...(retryNoAccess ? ["modelo_indisponivel", "sem_cota"] : [])]);
  const noAccess = new Set(retryNoAccess ? [] : history.filter((record) => ["modelo_indisponivel", "sem_cota", "credencial"].includes(record.transport)).map((record) => record.route));
  const byKey = new Map(loaded.map((item) => [item.item.id, item]));
  const todo = planRoutes.filter((plan) => !(redo && noAccess.has(plan.route))).map((plan) => ({
    plan, route: routes.find((route) => routeId(route) === plan.route) as CatalogEntry,
    keys: plan.keys.filter((key) => { const record = done.get(key); return !record || (redo && RETRYABLE.has(record.transport)); }),
  })).filter((entry) => entry.keys.length);
  const total = todo.reduce((sum, entry) => sum + entry.keys.length, 0);
  out(`${routes.length} modelo(s), ${loaded.length} item(ns), ${repetitions} repetição(ões): ${total} leitura(s) a fazer.`);
  for (const provider of ["gemini", "groq", "mistral"]) {
    const own = todo.filter((entry) => entry.route.provider === provider);
    if (own.length) out(`  ${provider}: ${own.map((entry) => `${entry.route.model} (${entry.keys.length})`).join(", ")}`);
  }

  const lanes = new Map<string, ProviderLane>();
  const stoppedProviders = new Set<string>();
  const keys = geminiKeyRotation();
  let finished = 0;
  const file = path.join(output, "leituras.jsonl");
  await Promise.all(todo.map(async ({ route, keys: routeKeys }) => {
    const lane = lanes.get(route.provider) ?? laneFor(route.provider, options);
    lanes.set(route.provider, lane);
    const benchRoute: BenchRoute = { provider: route.provider, model: route.model, endpoint: route.endpoint, vision: route.vision };
    for (const key of routeKeys) {
      if (stoppedProviders.has(route.provider)) return;
      const [itemPart = "", , repPart = "1"] = key.split("|");
      const item = byKey.get(itemPart.slice(0, itemPart.lastIndexOf("#")));
      if (!item) continue;
      try {
        const record = await runAttempt({ loaded: item, route: benchRoute, rep: Number(repPart), key, lane, timeoutMs,
          keys });
        appendFileSync(file, `${JSON.stringify(record)}\n`);
        finished += 1;
        const verdict = record.transport !== "ok" ? `${record.transport}${record.httpStatus ? ` ${record.httpStatus}` : ""}`
          : `${record.outcome?.kind ?? "?"}${record.outcome?.kind === item.item.resposta ? " ✓" : ` ✗ (esperado ${item.item.resposta})`}`;
        out(`[${finished}/${total}] ${record.route} ${item.item.id} #${record.rep} → ${verdict} ${record.latencyMs !== undefined ? `${(record.latencyMs / 1000).toFixed(1)}s` : ""}`);
      } catch (error) {
        if (!(error instanceof RouteStopped)) throw error;
        out(`${routeId(route)}: parou (${error.status}${error.pending ? ", o resto fica pendente para a próxima rodada" : ""}) — ${error.message}`);
        if (!error.pending) {
          // Registra só a tentativa que parou o modelo: numa nova rodada ele é tentado uma vez e para de novo.
          appendFileSync(file, `${JSON.stringify({ key, itemId: item.item.id, itemHash: item.hash, route: routeId(route), provider: route.provider,
            model: route.model, endpoint: route.endpoint, rep: Number(repPart), at: new Date().toISOString(), transport: error.status,
            error: error.message, totalMs: 0, httpAttempts: Math.max(1, error.keyTrail.length), rateLimitHits: 0,
            ...(error.keyTrail.length ? { keyTrail: error.keyTrail } : {}) } satisfies AttemptRecord)}\n`);
        }
        if (error.scope === "provider") stoppedProviders.add(route.provider);
        return;
      }
    }
  }));
  report(options);
}

/* Relatório. */

function report(options: Options): void {
  const { folder, output } = paths(options);
  const { items, problems } = loadGabarito(folder);
  const plan = readJson<{ repetitions: number; routes: PlanRoute[] }>(path.join(output, "plano.json"));
  if (!plan) throw new Error("ainda não há plano.json: rode \"rodar\" antes");
  const saved = readJson<Catalog>(path.join(output, "catalogo.json"));
  const catalog = saved ? refilterCatalog(saved) : undefined;
  // Chaves de itens que mudaram (legenda, arquivo) saem da conta: só vale a leitura do item atual.
  const current = new Set(items.map((item) => `${item.id}#${loadItem(folder, item).hash}`));
  // Modelo que saiu do catálogo (ex.: agente de pesquisa) sai também da conta.
  const inCatalog = (route: PlanRoute) => !catalog || catalog.entries.some((entry) => routeId(entry) === route.route);
  const routes = plan.routes.filter(inCatalog).map((route) => ({ ...route, keys: route.keys.filter((key) => current.has(key.split("|")[0] ?? "")) }))
    .filter((route) => route.keys.length);
  const { summaries, itemStats } = summarizeRun(routes, records(output), items);
  const input = {
    generatedAt: new Date().toISOString(), folder, repetitions: plan.repetitions,
    items: { total: items.length, text: items.filter((item) => item.leitor === "texto").length,
      image: items.filter((item) => item.leitor !== "texto").length, unconfirmed: items.filter((item) => !item.conferido).length },
    summaries, itemStats, ...(catalog ? { catalog } : {}), problems,
    // Rótulo pela posição em GEMINI_API_KEYS; impressão antiga fora do .env continua na conta.
    keyLabels: Object.fromEntries(geminiKeyPool().map((value, index) => [keyHint(value), `chave ${index + 1} do .env · ${keyHint(value)}`])),
  };
  writeJson(path.join(output, "relatorio.json"), { ...input, catalog: undefined });
  writeFileSync(path.join(output, "relatorio.html"), renderReport(input));
  out("\nRanking (acerto do item · p50 · respostas):");
  for (const [index, summary] of summaries.entries()) {
    const share = rate(summary.item);
    out(`${String(index + 1).padStart(2)}. ${summary.route.padEnd(48)} ${share === null ? "  —" : `${Math.round(share * 100)}%`.padStart(4)} · ${summary.latency.p50 === null ? "—" : `${(summary.latency.p50 / 1000).toFixed(1)}s`} · ${summary.answered}/${summary.planned}${summary.pending ? ` (${summary.pending} pendentes)` : ""}`);
  }
  out(`\nPágina: ${path.join(output, "relatorio.html")}`);
}

/* Gabarito inicial. */

const EXAMPLE = {
  _comentario: [
    "Uma chave por arquivo da pasta (ou um nome qualquer com \"arquivos\", para álbum).",
    "Campos da aposta com os nomes do contrato da captura: evento, mercado, selecao, odds, stake, esporte; linha é o número da linha (2.5, -0.25) ou null.",
    "Campo ausente não é conferido. \"resposta\": \"aposta\" (padrão quando há apostas), \"nao_e_aposta\" ou \"incompleta\" (com \"faltando\").",
    "Legenda do print: \"legenda\" aqui ou um arquivo <imagem>.legenda.txt ao lado. Post de texto: o próprio .txt.",
    "Opcionais: \"leitor\" (texto, bilhete, jogador, album), \"politica\" (AUTO, CAPTION_ODD, IMAGE_ODD), \"banca\" ({ stakePolicy, defaultStakeUnits }), \"dataPost\" (ISO), \"conferido\" (false no rascunho).",
  ],
  "bilhete-01.jpg": {
    legenda: "Flamengo x Palmeiras over 2.5 gols 1u",
    apostas: [{ evento: "Flamengo vs Palmeiras", mercado: "Total de Gols", selecao: "Mais de 2.5", linha: 2.5, odds: 1.9, stake: 1, esporte: "Soccer" }],
  },
  "post-02.txt": {
    _comentario: "Duas simples no mesmo post: cada uma com a sua odd e stake.",
    apostas: [
      { evento: "Lakers vs Celtics", mercado: "Handicap", selecao: "Lakers -4.5", linha: -4.5, odds: 1.95, stake: 0.5, esporte: "Basketball" },
      { evento: "Knicks vs Heat", mercado: "Total de Pontos", selecao: "Under 210.5", linha: 210.5, odds: 1.87, stake: 0.5, esporte: "Basketball" },
    ],
  },
  "resultado-03.png": { _comentario: "Print de green/red: não é aposta nova.", resposta: "nao_e_aposta" },
  "bilhete-04.jpg": {
    legenda: "Entrada no Grêmio",
    resposta: "incompleta", faltando: ["stake"],
    apostas: [{ evento: "Grêmio vs Inter", mercado: "Resultado Final", selecao: "Grêmio", linha: null, odds: 2.1, stake: null }],
  },
};

const toExpected = (bet: ReadBet): ExpectedBet => ({
  evento: bet.evento, mercado: bet.mercado, selecao: bet.selecao, linha: lineOf(bet.selecao, bet.mercado),
  odds: bet.odds, stake: bet.stake, ...(bet.esporte && bet.esporte !== "Unknown" ? { esporte: bet.esporte } : {}),
});

async function draftGabarito(options: Options): Promise<void> {
  const { folder, output } = paths(options);
  const example = path.join(folder, "gabarito.exemplo.json");
  if (!existsSync(example)) { writeJson(example, EXAMPLE); out(`Exemplo: ${example}`); }
  const existing = readJson<Record<string, { arquivos?: string[] }>>(path.join(folder, "gabarito.json")) ?? {};
  const covered = new Set(Object.entries(existing).flatMap(([id, entry]) => entry?.arquivos ?? [id]));
  const files = folderFiles(folder).filter((name) => !covered.has(name) && !isCaptionFile(name));
  if (!files.length) { out("Nenhum arquivo novo na pasta (todos já estão no gabarito.json)."); return; }
  const catalog = await loadCatalog(options, output);
  const reachable = (candidate: CatalogEntry) => !["indisponivel", "sem_cota"].includes(candidate.availability);
  // Sem --modelo, lê como a cascata de hoje: os modelos em uso, na ordem da
  // captura, e o primeiro que responder fica com o item.
  const wanted = text(options, "modelo");
  const inUse = Object.entries(productionModels()).flatMap(([provider, uses]) => uses.map((use) => `${provider}/${use.model}`));
  const candidates = (wanted ? [wanted] : [...new Set(inUse)])
    .map((id) => catalog.entries.find((candidate) => routeId(candidate) === id || candidate.model === id || candidate.aliases.includes(id.split("/")[1] ?? "")))
    .filter((candidate): candidate is CatalogEntry => Boolean(candidate && (wanted || reachable(candidate))));
  if (!candidates.length) throw new Error(wanted ? `modelo ${wanted} não está no catálogo` : "nenhum modelo em uso está acessível; escolha um com --modelo");
  out(`Lendo ${files.length} arquivo(s); ordem dos leitores: ${[...new Set(candidates.map(routeId))].join(", ")}`);
  const context = folderContext(folder);
  const lanes = new Map<string, ProviderLane>();
  const stopped = new Set<string>();
  const stoppedProviders = new Set<string>();
  const keys = geminiKeyRotation();
  // Sem gabarito, o rascunho já nasce como gabarito.json, com todo item "a conferir".
  const target = path.join(folder, existsSync(path.join(folder, "gabarito.json")) ? "gabarito.rascunho.json" : "gabarito.json");
  const draft: Record<string, unknown> = { _comentario: "Rascunho lido por IA, a conferir. Confira cada item contra o print, corrija e troque \"conferido\": false por true. Item sem \"resposta\" não entra na conta." };
  for (const name of files) {
    const item: GabaritoItem = { id: name, arquivos: [name], leitor: isTextPostFile(name) ? "texto" : "bilhete",
      legenda: isTextPostFile(name) ? "" : context.sidecarCaption(name) ?? "", resposta: "aposta", apostas: [], faltando: [],
      politica: "AUTO", conferido: false };
    const loaded = loadItem(folder, item);
    let record: AttemptRecord | undefined;
    const tried: string[] = [];
    let stopReason = "";
    for (const entry of candidates) {
      const route: BenchRoute = { provider: entry.provider, model: entry.model, endpoint: entry.endpoint, vision: entry.vision };
      if (stopped.has(routeId(route)) || stoppedProviders.has(route.provider) || !routeSupportsItem(route, item)
        || tried.includes(routeId(route))) continue;
      tried.push(routeId(route));
      const lane = lanes.get(route.provider) ?? laneFor(route.provider, options);
      lanes.set(route.provider, lane);
      try {
        record = await runAttempt({ loaded, route, rep: 0, key: name, lane, timeoutMs: Number(text(options, "timeout") ?? 60_000), keys });
      } catch (error) {
        if (!(error instanceof RouteStopped)) throw error;
        stopped.add(routeId(route));
        if (error.scope === "provider") stoppedProviders.add(route.provider);
        stopReason = `${routeId(route)} parou: ${error.status} ${error.message}`;
        out(`  ${stopReason}`);
        continue;
      }
      if (record.transport === "ok" && record.outcome?.kind !== "falha") break;
    }
    const outcome = record?.transport === "ok" ? record.outcome : undefined;
    const reader = record ? record.route : "nenhum leitor";
    draft[name] = {
      ...(item.legenda ? { legenda: item.legenda } : {}),
      ...(outcome && outcome.kind !== "falha" ? { resposta: outcome.kind } : {}),
      ...(outcome?.kind === "incompleta" ? { faltando: outcome.missing } : {}),
      apostas: (outcome?.kind === "aposta" ? outcome.bets : outcome?.readingRows ?? []).map(toExpected),
      conferido: false,
      _leitura: outcome ? `${reader}: ${outcome.detail}` : `sem leitura (${tried.join(", ") || "nenhum leitor disponível"}): ${record ? `${record.transport} ${record.error ?? ""}` : stopReason}`.trim(),
    };
    out(`  ${name}: ${(draft[name] as { _leitura?: string })._leitura}`);
  }
  writeJson(target, draft);
  out(`Rascunho: ${target}`);
}

async function main(): Promise<void> {
  const { command, options } = parseArgs(process.argv.slice(2));
  if (command === "catalogo") {
    const { output } = paths(options);
    printCatalog(await buildCatalog(options, output));
    out(`\nCatálogo: ${path.join(output, "catalogo.json")}`);
  } else if (command === "gabarito") await draftGabarito(options);
  else if (command === "rodar") await run(options);
  else if (command === "relatorio") report(options);
  else {
    out("Uso: npm run bench:leitura -- <catalogo|gabarito|rodar|relatorio> [opções]. Detalhes em docs/BENCH-LEITURA.md.");
    out("rodar testa todo modelo que as chaves enxergam (ou os de --modelos); os do catálogo de produção aparecem como [em uso].");
    if (!["ajuda", "--help", "-h"].includes(command)) process.exitCode = 2;
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
