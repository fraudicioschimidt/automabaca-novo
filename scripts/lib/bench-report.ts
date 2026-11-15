import { formatSpDateTime } from "@/src/domain/dates";
import { GEMINI_REQUEST_TIMEOUT_MS } from "@/src/infra/llm/gemini";
import { GROQ_REQUEST_TIMEOUT_MS } from "@/src/infra/llm/groq";
import { MISTRAL_OCR_REQUEST_TIMEOUT_MS, MISTRAL_REQUEST_TIMEOUT_MS } from "@/src/infra/llm/mistral";
import { productionTimeoutMs } from "./bench-call";
import type { Catalog } from "./bench-catalog";
import { BET_FIELDS, hasEnoughSample, rate, routeVerdict, type Ratio, type RouteSummary, type Verdict } from "./bench-scoring";

/*
 * Página única do resultado da bancada de leitura: ranking ordenável, detalhe
 * dos erros de cada modelo e o catálogo. Sem dependências externas além das
 * fontes, para abrir do disco ou publicada.
 */

export type ReportInput = {
  generatedAt: string;
  folder: string;
  repetitions: number;
  items: { total: number; text: number; image: number; unconfirmed: number };
  summaries: RouteSummary[];
  /** Por item: quantos modelos acertaram entre os que responderam, e o desfecho mais comum dos erros. */
  itemStats: Array<{ id: string; correct: number; answered: number; commonMiss?: string }>;
  /** Rótulo de cada impressão de chave do Gemini ("nova 1fb21064"). */
  keyLabels: Record<string, string>;
  catalog?: Catalog;
  problems: string[];
};

const escapeHtml = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[char] ?? char));

const pct = (value: Ratio) => {
  const share = rate(value);
  return share === null ? { text: "—", sort: -1 } : { text: `${Math.round(share * 100)}%`, sort: share };
};
const seconds = (ms: number | null) => (ms === null ? { text: "—", sort: Number.MAX_SAFE_INTEGER } : { text: `${(ms / 1000).toFixed(1)} s`, sort: ms });
const tone = (value: Ratio) => {
  const share = rate(value);
  if (share === null) return "none";
  return share >= 0.9 ? "good" : share >= 0.7 ? "warn" : "bad";
};

const FIELD_LABELS: Record<typeof BET_FIELDS[number], string> = {
  evento: "Evento", mercado: "Mercado", selecao: "Seleção", linha: "Linha", odds: "Odd", stake: "Stake", esporte: "Esporte",
};

function cell(value: { text: string; sort: number | string }, className = "") {
  return `<td class="num ${className}" data-sort="${escapeHtml(value.sort)}">${escapeHtml(value.text)}</td>`;
}
const ratioCell = (value: Ratio) => cell(pct(value), `tone-${tone(value)}`);

function failures(summary: RouteSummary): number {
  return Object.entries(summary.transport).filter(([status]) => status !== "ok").reduce((sum, [, count]) => sum + (count ?? 0), 0);
}

const VERDICTS: Record<Verdict["verdict"], { label: string; tone: string; sort: number; title: string }> = {
  manter: { label: "manter", tone: "good", sort: 0, title: "Seguem para a próxima rodada" },
  reconfirmar: { label: "reconfirmar", tone: "warn", sort: 1, title: "A reconfirmar (disponibilidade ou amostra curta)" },
  eliminar: { label: "eliminar", tone: "bad", sort: 2, title: "Saem (acerto, contrato ou lentidão)" },
  sem_acesso: { label: "sem acesso", tone: "none", sort: 3, title: "Sem acesso nesta chave (404, cota zero, Labs)" },
};

const verdictOf = (summary: RouteSummary) => routeVerdict(summary, productionTimeoutMs(summary));

function verdictCell(summary: RouteSummary): string {
  const { verdict, reasons } = verdictOf(summary);
  const shown = VERDICTS[verdict];
  return `<td class="verdict tone-${shown.tone}" data-sort="${shown.sort}" title="${escapeHtml(reasons.join("; "))}">${shown.label}</td>`;
}

function verdictSection(summaries: RouteSummary[]): string {
  const rows = summaries.map((summary) => ({ summary, ...verdictOf(summary) }));
  const block = (verdict: Verdict["verdict"]) => {
    const own = rows.filter((entry) => entry.verdict === verdict);
    return `<div><div class="muted">${VERDICTS[verdict].title} (${own.length})</div><ul>${own.map((entry) =>
      `<li><span class="mono">${escapeHtml(entry.summary.route)}</span>${entry.reasons.length ? `<br><span class="muted">${escapeHtml(entry.reasons.join("; "))}</span>` : ""}</li>`).join("") || "<li>—</li>"}</ul></div>`;
  };
  return `<section><h2>Proposta da rodada</h2>
    <p class="muted" style="margin-bottom:10px">Sai quem, com 5+ respostas, acerta menos de 60% dos itens que algum modelo acertou, responde fora do contrato em mais de 20% ou passa do prazo de produção em 20%+ das respostas. 503, timeout, 429 e cota do dia não eliminam: o modelo volta para reconfirmar. É proposta: quem decide é o dono.</p>
    <div class="podium">${block("manter")}${block("reconfirmar")}${block("eliminar")}${block("sem_acesso")}</div></section>`;
}

/** Qual chave serve para qual modelo: chamadas por impressão, de todas as passadas. */
function keySection(summaries: RouteSummary[], keyLabels: Record<string, string>): string {
  const withKeys = summaries.filter((summary) => Object.keys(summary.keys).length);
  if (!withKeys.length) return "";
  const hints = [...new Set(withKeys.flatMap((summary) => Object.keys(summary.keys)))];
  const describeKey = (counts: Partial<Record<string, number>> | undefined) => {
    if (!counts) return { text: "—", sort: -1 };
    const total = Object.values(counts).reduce((sum: number, value) => sum + (value ?? 0), 0);
    const ok = counts.ok ?? 0;
    const rest = Object.entries(counts).filter(([status]) => status !== "ok").map(([status, count]) => `${count} ${status}`).join(", ");
    return { text: `${ok}/${total} ok${rest ? ` · ${rest}` : ""}`, sort: total ? ok / total : -1 };
  };
  return `<section><h2>Chaves do Gemini</h2>
    <p class="muted" style="margin-bottom:10px">Chamadas de cada modelo por chave (impressão sha256), somando as passadas. Falha passageira numa chave passa o item à outra antes de esperar; chave sem acesso ao modelo sai só para ele.</p>
    <div class="table-wrap"><table class="sortable"><thead><tr><th scope="col">Modelo</th>${hints.map((hint) => `<th scope="col">${escapeHtml(keyLabels[hint] ?? hint)}</th>`).join("")}</tr></thead>
    <tbody>${withKeys.map((summary) => `<tr><td class="mono" data-sort="${escapeHtml(summary.route)}">${escapeHtml(summary.route)}</td>${hints.map((hint) => {
      const value = describeKey(summary.keys[hint]);
      return `<td data-sort="${value.sort}">${escapeHtml(value.text)}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}

function itemSection(stats: ReportInput["itemStats"]): string {
  if (!stats.length) return "";
  return `<section><h2>Itens</h2>
    <p class="muted" style="margin-bottom:10px">Quantos modelos leram cada item como o gabarito. Item que ninguém acerta costuma ser recusa da própria captura (conciliação com a legenda, placar ao vivo, prop de jogador), não do modelo.</p>
    <div class="table-wrap"><table class="sortable"><thead><tr><th scope="col">Item</th><th scope="col">Acertaram</th><th scope="col">Desfecho mais comum dos erros</th></tr></thead>
    <tbody>${stats.map((stat) => `<tr><td class="mono" data-sort="${escapeHtml(stat.id)}">${escapeHtml(stat.id)}</td>${cell({ text: `${stat.correct}/${stat.answered}`, sort: stat.answered ? stat.correct / stat.answered : -1 })}<td data-sort="${escapeHtml(stat.commonMiss ?? "")}">${escapeHtml(stat.commonMiss ?? "—")}</td></tr>`).join("")}</tbody></table></div></section>`;
}

function row(summary: RouteSummary, position: number): string {
  const tags = [
    summary.inUse ? '<span class="tag tag-use">em uso</span>' : "",
    summary.endpoint === "ocr" ? '<span class="tag">OCR</span>' : summary.vision ? '<span class="tag">visão</span>' : '<span class="tag">só texto</span>',
    hasEnoughSample(summary) ? "" : '<span class="tag tag-low">amostra curta</span>',
  ].join("");
  const ok = summary.transport.ok ?? 0;
  const down = (summary.transport.indisponivel ?? 0) + (summary.transport.timeout ?? 0) + (summary.transport.erro_rede ?? 0);
  const availability = { text: summary.attempts ? `${Math.round((ok / summary.attempts) * 100)}%` : "—", sort: summary.attempts ? ok / summary.attempts : -1 };
  const answered = { text: `${summary.answered}/${summary.planned}`, sort: summary.planned ? summary.answered / summary.planned : 0 };
  const tokens = summary.tokens.input === null ? { text: summary.tokens.pages === null ? "—" : `${summary.tokens.pages.toFixed(1)} pág.`, sort: -1 }
    : { text: `${Math.round(summary.tokens.input)} / ${Math.round(summary.tokens.output ?? 0)}`, sort: summary.tokens.input };
  return `<tr>
    <td class="num" data-sort="${position}">${position}</td>
    ${verdictCell(summary)}
    <td data-sort="${escapeHtml(summary.route)}"><a href="#m-${escapeHtml(summary.route.replace(/[^a-z0-9]+/gi, "-"))}" class="model">${escapeHtml(summary.route)}</a><div class="tags">${tags}</div></td>
    ${ratioCell(summary.item)}${ratioCell(summary.achievable)}${ratioCell(summary.text)}${ratioCell(summary.image)}${ratioCell(summary.bets)}
    ${ratioCell(summary.kinds.nao_e_aposta)}${ratioCell(summary.kinds.incompleta)}
    ${BET_FIELDS.map((field) => ratioCell(summary.fields[field])).join("")}
    ${ratioCell({ correct: summary.contractValid, total: summary.answered })}
    ${cell(seconds(summary.latency.p50))}${cell(seconds(summary.latency.p95))}
    ${cell({ text: String(summary.overProductionTimeout), sort: summary.overProductionTimeout })}
    ${cell(answered)}${cell(availability)}${cell({ text: String(down), sort: down })}${cell({ text: String(summary.rateLimitHits), sort: summary.rateLimitHits })}
    ${cell({ text: String(failures(summary)), sort: failures(summary) })}${cell({ text: String(summary.pending), sort: summary.pending })}
    ${cell(tokens)}
  </tr>`;
}

function detail(summary: RouteSummary): string {
  const transport = Object.entries(summary.transport).map(([status, count]) => `${escapeHtml(status)}: ${count}`).join(" · ") || "nenhuma tentativa";
  const errors = summary.errors.length
    ? `<ul class="errors">${summary.errors.map((error) => `<li><span class="mono">${escapeHtml(error.itemId)} #${error.rep}</span><ul>${error.lines.map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></li>`).join("")}</ul>`
    : '<p class="muted">Nenhum erro de leitura nas respostas.</p>';
  return `<details id="m-${escapeHtml(summary.route.replace(/[^a-z0-9]+/gi, "-"))}">
    <summary><span class="mono">${escapeHtml(summary.route)}</span><span class="muted"> · acerto ${pct(summary.item).text} · p50 ${seconds(summary.latency.p50).text} · ${summary.errors.length} item(ns) com erro</span></summary>
    <div class="detail-body">
      <p class="muted">Tentativas: ${transport}. Pendentes: ${summary.pending}.${summary.lastError ? ` Último erro: ${escapeHtml(summary.lastError)}` : ""}</p>
      ${errors}
    </div>
  </details>`;
}

function catalogSection(catalog: Catalog | undefined): string {
  if (!catalog) return "";
  const providers = ["gemini", "groq", "mistral"];
  const blocks = providers.map((provider) => {
    const entries = catalog.entries.filter((entry) => entry.provider === provider);
    const list = (predicate: (entry: typeof entries[number]) => boolean) => entries.filter(predicate)
      .map((entry) => `<li><span class="mono">${escapeHtml(entry.model)}</span>${entry.inUse.length ? ' <span class="tag tag-use">em uso</span>' : ""}${entry.listed ? "" : ' <span class="tag tag-low">não listado</span>'}${entry.availability === "ok" || entry.availability === "nao_sondado" ? "" : ` <span class="tag tag-low">${escapeHtml(entry.availability)}</span>`}</li>`).join("");
    const filtered = catalog.filtered.filter((entry) => entry.provider === provider)
      .map((entry) => `<li><span class="mono">${escapeHtml(entry.model)}</span> <span class="muted">— ${escapeHtml(entry.reason)}</span></li>`).join("");
    return `<div class="catalog-col"><h3>${escapeHtml(provider)}</h3>
      <h4>Visão (${entries.filter((entry) => entry.vision).length})</h4><ul>${list((entry) => entry.vision)}</ul>
      <h4>Só texto (${entries.filter((entry) => !entry.vision).length})</h4><ul>${list((entry) => !entry.vision)}</ul>
      <h4>Fora do teste (${catalog.filtered.filter((entry) => entry.provider === provider).length})</h4><ul>${filtered}</ul></div>`;
  }).join("");
  return `<section><h2>Catálogo</h2><p class="muted">Gerado em ${escapeHtml(catalog.generatedAt)}. Apelidos do mesmo modelo contam uma vez.</p><div class="catalog">${blocks}</div></section>`;
}

const STYLE = `
:root{--ground:#f5f6f2;--surface:#ffffff;--ink:#18211d;--muted:#5d6a64;--rule:#d8ddd6;--accent:#1d6b4f;--accent-soft:#e3efe8;
--good:#1f7a4d;--good-bg:#e4f2ea;--warn:#8f5c00;--warn-bg:#fbf0d9;--bad:#a8261e;--bad-bg:#f8e3e1;--tag:#eef1ec}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark;--ground:#101513;--surface:#161d1a;--ink:#e3eae6;--muted:#95a39c;--rule:#29332e;--accent:#63c79a;--accent-soft:#1c2d25;
--good:#7fd6a8;--good-bg:#17301f;--warn:#e7b85c;--warn-bg:#342a14;--bad:#f09a92;--bad-bg:#3a1c1a;--tag:#1f2824}}
:root[data-theme="dark"]{color-scheme:dark;--ground:#101513;--surface:#161d1a;--ink:#e3eae6;--muted:#95a39c;--rule:#29332e;--accent:#63c79a;--accent-soft:#1c2d25;
--good:#7fd6a8;--good-bg:#17301f;--warn:#e7b85c;--warn-bg:#342a14;--bad:#f09a92;--bad-bg:#3a1c1a;--tag:#1f2824}
body{background:var(--ground);color:var(--ink);font:15px/1.5 "IBM Plex Sans",system-ui,sans-serif;padding-inline:16px;padding-block:24px 48px}
main{max-width:1200px;margin:0 auto;display:grid;gap:32px}
main>*{min-width:0}
h1{font:600 28px/1.2 "IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;margin:0;text-wrap:balance}
h2{font:600 19px/1.3 "IBM Plex Sans Condensed","IBM Plex Sans",system-ui,sans-serif;margin:0 0 8px}
h3{font-size:15px;margin:0 0 4px;text-transform:uppercase;letter-spacing:.06em}
h4{font-size:13px;margin:12px 0 4px;color:var(--muted);font-weight:600}
p{margin:0;max-width:72ch}
.muted{color:var(--muted)}
.mono{font-family:"IBM Plex Mono",ui-monospace,monospace;font-size:13px}
.facts{display:flex;flex-wrap:wrap;gap:8px 24px;color:var(--muted);font-size:14px}
.facts b{color:var(--ink);font-variant-numeric:tabular-nums}
.alert{background:var(--warn-bg);color:var(--warn);padding:10px 14px;border-radius:6px;max-width:none}
.podium{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;align-items:start}
.podium>div{min-width:0}
.podium>div{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:12px 14px}
.podium .big{font:600 24px/1.1 "IBM Plex Mono",monospace;color:var(--accent);font-variant-numeric:tabular-nums}
.table-wrap{overflow-x:auto;border:1px solid var(--rule);border-radius:8px;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid var(--rule);text-align:left;white-space:nowrap}
th{position:sticky;top:0;background:var(--surface);cursor:pointer;user-select:none;font-weight:600;color:var(--muted)}
th:hover,th:focus-visible{color:var(--accent);outline:none}
th[aria-sort="descending"]::after{content:" ↓"}th[aria-sort="ascending"]::after{content:" ↑"}
td.verdict{font-weight:600;font-size:12px}
td.num{text-align:right;font-family:"IBM Plex Mono",ui-monospace,monospace;font-variant-numeric:tabular-nums}
.tone-good{color:var(--good);background:var(--good-bg)}.tone-warn{color:var(--warn);background:var(--warn-bg)}.tone-bad{color:var(--bad);background:var(--bad-bg)}
a.model{color:var(--ink);font-family:"IBM Plex Mono",ui-monospace,monospace;text-decoration:none}
a.model:hover,a.model:focus-visible{color:var(--accent);text-decoration:underline}
.tags{display:flex;gap:4px;margin-top:3px}
.tag{font-size:11px;padding:0 6px;border-radius:4px;background:var(--tag);color:var(--muted)}
.tag-use{background:var(--accent-soft);color:var(--accent)}.tag-low{background:var(--warn-bg);color:var(--warn)}
details{border-top:1px solid var(--rule);padding:8px 0}
summary{cursor:pointer}summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.detail-body{display:grid;gap:8px;padding:8px 0 4px 16px}
ul{margin:0;padding-left:18px}.errors>li{margin-bottom:6px}.errors ul{color:var(--muted);font-size:13px}
.catalog{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:16px}
.catalog-col{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:12px 14px;font-size:13px}
.method{display:grid;gap:8px;font-size:14px}
@media (prefers-reduced-motion: reduce){*{scroll-behavior:auto}}
`;

const SCRIPT = `
document.querySelectorAll("table.sortable").forEach(function (table) {
  var headers = table.querySelectorAll("th");
  headers.forEach(function (th, index) {
    th.tabIndex = 0;
    function sort() {
      var descending = th.getAttribute("aria-sort") !== "descending";
      headers.forEach(function (other) { other.removeAttribute("aria-sort"); });
      th.setAttribute("aria-sort", descending ? "descending" : "ascending");
      var body = table.tBodies[0];
      var rows = Array.prototype.slice.call(body.rows);
      rows.sort(function (a, b) {
        var x = a.cells[index].getAttribute("data-sort"), y = b.cells[index].getAttribute("data-sort");
        var nx = Number(x), ny = Number(y);
        var result = isNaN(nx) || isNaN(ny) ? String(x).localeCompare(String(y)) : nx - ny;
        return descending ? -result : result;
      });
      rows.forEach(function (row) { body.appendChild(row); });
    }
    th.addEventListener("click", sort);
    th.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); sort(); } });
  });
});
`;

export function renderReport(input: ReportInput): string {
  const ranked = input.summaries;
  const eligible = ranked.filter(hasEnoughSample);
  const fastest = [...eligible].filter((summary) => (rate(summary.item) ?? 0) >= 0.9)
    .sort((a, b) => (a.latency.p50 ?? Infinity) - (b.latency.p50 ?? Infinity))[0];
  const best = eligible[0];
  const podium = best ? `<div class="podium">
    <div><div class="muted">Mais certeiro</div><div class="big">${pct(best.item).text}</div><div class="mono">${escapeHtml(best.route)}</div><div class="muted">p50 ${seconds(best.latency.p50).text}</div></div>
    ${fastest ? `<div><div class="muted">Mais rápido com ≥ 90% de acerto</div><div class="big">${seconds(fastest.latency.p50).text}</div><div class="mono">${escapeHtml(fastest.route)}</div><div class="muted">acerto ${pct(fastest.item).text}</div></div>` : ""}
    <div><div class="muted">Modelos com amostra suficiente</div><div class="big">${eligible.length}/${ranked.length}</div><div class="muted">≥ metade das leituras respondidas</div></div>
  </div>` : "";
  const headers = ["#", "Proposta", "Modelo", "Acerto", "Alcançável", "Texto", "Imagem", "Aposta inteira", "Não é aposta", "Incompleta",
    ...BET_FIELDS.map((field) => FIELD_LABELS[field]), "Contrato", "p50", "p95", "> prazo prod.", "Respostas", "Disponível", "503/timeout", "429", "Falhas", "Pendentes", "Tokens in/out"];
  return `<title>Bancada de leitura</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;600&family=IBM+Plex+Sans+Condensed:wght@600&family=IBM+Plex+Sans:wght@400;600&display=swap">
<style>${STYLE}</style>
<main>
  <header style="display:grid;gap:10px">
    <h1>Bancada de leitura de apostas</h1>
    <p class="muted">Cada modelo leu os mesmos itens, um de cada vez, com o prompt, o schema, o julgamento e o porteiro da captura. A nota compara o que a captura registraria com o gabarito.</p>
    <div class="facts"><span>Itens <b>${input.items.total}</b> (${input.items.text} texto, ${input.items.image} imagem)</span><span>Repetições <b>${input.repetitions}</b></span><span>Modelos <b>${ranked.length}</b></span><span>Gerado <b>${escapeHtml(formatSpDateTime(new Date(input.generatedAt)))}</b></span></div>
    ${input.items.unconfirmed ? `<p class="alert">${input.items.unconfirmed} item(ns) do gabarito ainda não foram conferidos ("conferido": false). O resultado favorece o modelo que gerou o rascunho.</p>` : ""}
    ${input.problems.length ? `<p class="alert">Fora da conta por problema no gabarito: ${input.problems.map(escapeHtml).join(" · ")}</p>` : ""}
  </header>
  ${podium}
  <section>
    <h2>Ranking</h2>
    <p class="muted" style="margin-bottom:10px">Ordem: amostra suficiente, acerto do item inteiro e, no empate, p50. Clique no cabeçalho para reordenar. Acertos contam só leituras respondidas; latência é a da chamada que valeu, sem as esperas de cota.</p>
    <div class="table-wrap"><table class="sortable"><thead><tr>${headers.map((header) => `<th scope="col">${escapeHtml(header)}</th>`).join("")}</tr></thead>
    <tbody>${ranked.map((summary, index) => row(summary, index + 1)).join("")}</tbody></table></div>
  </section>
  ${verdictSection(ranked)}
  ${keySection(ranked, input.keyLabels)}
  ${itemSection(input.itemStats)}
  <section>
    <h2>Erros por modelo</h2>
    ${ranked.map(detail).join("")}
  </section>
  ${catalogSection(input.catalog)}
  <section class="method">
    <h2>Como ler</h2>
    <p><b>Acerto</b>: item inteiro certo — o tipo (aposta, não é aposta, incompleta) e, se for aposta, todas as apostas com todos os campos do gabarito. <b>Alcançável</b>: o mesmo acerto, só nos itens que algum modelo acertou. <b>Aposta inteira</b>: apostas do gabarito com todos os campos certos.</p>
    <p><b>Acerto</b> conta a última resposta de cada leitura; <b>Disponível</b>, <b>503/timeout</b> e <b>429</b> contam todas as tentativas, de todas as passadas.</p>
    <p><b>Campos</b>: odd e linha comparadas como número; evento pelo comparador de confrontos do projeto; seleção por lado, direção e linha; mercado pelo catálogo de mercados; esporte pelo nome. Campo ausente no gabarito não conta. Esporte não informado erra o campo, mas não derruba a aposta inteira (a captura resolve o esporte depois); esporte errado derruba.</p>
    <p><b>Contrato</b>: resposta que passa no schema da extração. <b>&gt; prazo prod.</b>: respostas mais lentas que o prazo por requisição da captura (Gemini ${GEMINI_REQUEST_TIMEOUT_MS / 1000} s, Groq ${GROQ_REQUEST_TIMEOUT_MS / 1000} s, Mistral ${MISTRAL_REQUEST_TIMEOUT_MS / 1000} s, OCR ${MISTRAL_OCR_REQUEST_TIMEOUT_MS / 1000} s). <b>Pendentes</b>: leituras que a cota do dia não deixou fazer; rode de novo para completar.</p>
    <p class="muted">Pasta: <span class="mono">${escapeHtml(input.folder)}</span></p>
  </section>
</main>
<script>${SCRIPT}</script>
`;
}
