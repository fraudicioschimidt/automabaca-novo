"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { READING_FIELDS, type ReadingField } from "@/src/domain/bet-capture";
import { formatSpDateTime, formatSpDateWithYear } from "@/src/domain/dates";
import type { OcrModelsReport, ReaderAccuracyRow } from "@/src/services/painel/ocr-models";
import type { TaskComparison } from "@/src/services/painel/ocr-models-comparison";
import { contagem } from "../../lib/plural";
import styles from "./ocr-models-card.module.css";

const results: Record<string, string> = {
  accepted: "Leitura aceita", rejected: "Leitura rejeitada", ocr_conflict: "Conflito na transcrição",
  rate_limit: "Limite de quota", timeout: "Tempo esgotado", http_error: "Erro da API",
  request_error: "Falha na chamada", empty: "Resposta vazia", invalid_json: "JSON inválido", truncated: "Resposta cortada",
};
function resultLabel(result: string, statusCode?: number | null): string {
  const [reason = result, status] = result.split(":");
  const code = statusCode ?? Number(status);
  const http: Record<number, string> = { 400: "Requisição incompatível", 401: "Autenticação recusada", 402: "Saldo insuficiente", 403: "Acesso negado", 404: "Modelo indisponível" };
  return code >= 400 && code !== 429 ? `${http[code] ?? results[reason] ?? reason} (HTTP ${code})` : results[reason] ?? reason;
}
const usd = (value: number | null) => value === null ? "—" : new Intl.NumberFormat("pt-BR", { style: "currency", currency: "USD", maximumFractionDigits: 4 }).format(value);
const seconds = (value: number | null) => value === null ? "—" : `${(value / 1000).toFixed(2).replace(".", ",")} s`;
const pct = (value: number, total: number) => total > 0 ? `${(100 * value / total).toFixed(1).replace(".", ",")}%` : "—";
const MODEL_LABEL: Record<string, string> = { gemini: "Google", groq: "Groq", mistral: "Mistral" };
/** Amostra pequena não decide nada — o IC de Wilson já abre, mas o aviso é explícito. */
const MIN_SAMPLE = 20;

function FairTable({ task }: { task: TaskComparison }) {
  return <div className={styles.scroll} tabIndex={0} role="region" aria-label="Comparação por item">
    <table><thead><tr>
      <th scope="col">Modelo</th><th scope="col">Itens atribuídos</th><th scope="col">Resolveu</th>
      <th scope="col">IC 95%</th><th scope="col">Quando respondeu</th>
      <th scope="col">Salvamentos</th><th scope="col">Falhas exclusivas</th>
    </tr></thead><tbody>{task.models.map((row) => <tr key={`${row.provider}/${row.model}`}>
      <th scope="row"><strong>{row.model}</strong><span>{MODEL_LABEL[row.provider] ?? row.provider}</span></th>
      <td>{row.assigned}{row.assigned < MIN_SAMPLE && <span>amostra pequena</span>}</td>
      <td>{row.accepted}<span>{pct(row.accepted, row.assigned)}</span></td>
      <td>{row.qualityLow === null || row.qualityHigh === null ? "—"
        : `${(100 * row.qualityLow).toFixed(0)}–${(100 * row.qualityHigh).toFixed(0)}%`}
        <span>intervalo de Wilson</span></td>
      <td>{pct(row.accepted, row.produced)}<span>{contagem(row.produced, "resposta")} com conteúdo</span></td>
      <td>{row.rescued}<span>{contagem(row.rescueAttempts, "tentativa")} fora da 1ª posição</span></td>
      <td>{row.uniqueFailures}<span>outro modelo resolveu</span></td>
    </tr>)}</tbody></table>
  </div>;
}

const FIELD_LABEL: Record<ReadingField, string> = {
  evento: "Evento", mercado: "Mercado", selecao: "Seleção", linha: "Linha", odds: "Odd", stake: "Stake",
};

function readerLabel(row: ReaderAccuracyRow): { name: string; detail: string } {
  if (row.kind === "rule") return { name: "Leitor por regra", detail: "Sem IA" };
  const provider = MODEL_LABEL[row.provider ?? ""] ?? row.provider ?? "IA";
  const endpoint = row.endpoint === "ocr" ? " · OCR" : "";
  return { name: row.model ?? "Modelo não registrado", detail: `${provider}${endpoint}${row.contractVersion ? ` · contrato ${row.contractVersion}` : ""}` };
}

function ReaderAccuracyTable({ rows }: { rows: ReaderAccuracyRow[] }) {
  return <div className={styles.scroll} tabIndex={0} role="region" aria-label="Acerto por leitor">
    <table><thead><tr>
      <th scope="col">Leitor</th><th scope="col">Registradas</th><th scope="col">Corrigidas</th>
      {READING_FIELDS.map((field) => <th scope="col" key={field}>{FIELD_LABEL[field]}</th>)}
    </tr></thead><tbody>{rows.map((row) => {
      const label = readerLabel(row);
      return <tr key={`${row.kind}/${row.provider}/${row.model}/${row.endpoint}/${row.contractVersion}`}>
        <th scope="row"><strong>{label.name}</strong><span>{label.detail}</span></th>
        <td>{row.registered}{row.registered < MIN_SAMPLE && <span>amostra pequena</span>}</td>
        <td>{row.corrected}<span>{pct(row.corrected, row.registered)}</span></td>
        {READING_FIELDS.map((field) => <td key={field}>{row.fields[field]}<span>{pct(row.fields[field], row.registered)}</span></td>)}
      </tr>;
    })}</tbody></table>
  </div>;
}

export function OcrModelsCard({ report }: { report?: OcrModelsReport }) {
  const [days, setDays] = useState(7);
  const [provider, setProvider] = useState("all");
  const [task, setTask] = useState("");
  const router = useRouter();
  const rows = report?.periods.find((period) => period.days === days)?.models ?? [];
  const selected = rows.filter((row) => provider === "all" || row.provider === provider);
  const comparison = report?.comparisons?.find((period) => period.days === days);
  const tasks = comparison?.tasks ?? [];
  const currentTask = tasks.find((item) => item.task === task) ?? tasks[0];
  const readers = (report?.readers?.find((period) => period.days === days)?.rows ?? [])
    .filter((row) => provider === "all" || row.provider === provider);
  const available = report?.available === true;
  return <section className={styles.card} aria-labelledby="ocr-models-title">
    <div className={styles.header}>
      <div><h2 id="ocr-models-title">Modelos de OCR</h2>
        <p>Compare a leitura das imagens de apostas e o consumo de cada modelo.</p></div>
      <button type="button" onClick={() => router.refresh()}>Atualizar</button>
    </div>
    <div className={styles.controls}>
      <div className={styles.periods} role="group" aria-label="Período dos modelos OCR">
        {[1, 7, 30].map((value) => <button type="button" key={value} aria-pressed={days === value} onClick={() => setDays(value)}>
          {value === 1 ? "24 horas" : `${value} dias`}
        </button>)}
      </div>
      <div><label htmlFor="ocr-model-provider">Provedor </label><select id="ocr-model-provider" value={provider} onChange={(event) => setProvider(event.target.value)}>
        <option value="all">Todos</option><option value="gemini">Google</option>
        <option value="mistral">Mistral</option><option value="groq">Groq</option>
      </select></div>
      {report && <span>{report.evaluation ? "Rotação de avaliação ligada" : "Ordem habitual do carrossel"}</span>}
    </div>
    {!available ? <p role="status">Não foi possível carregar as métricas de OCR. Tente atualizar; isso não significa que não houve chamadas.</p> : <>
      {tasks.length > 0 && currentTask && <section className={styles.fair}>
        <h3>Comparação por item {report.evaluation ? "" : "(rotação desligada)"}</h3>
        <p className={styles.note}>Um item é uma extração — um post. Como o carrossel para na primeira leitura aceita,
          medir por tentativa pune quem só é chamado quando os anteriores falharam e premia quem quase não responde.
          Aqui só entra a <strong>primeira tentativa de cada item</strong> observada no histórico. A janela segue
          o início da cascata, quando registrado. O regime de sorteio é conferido na própria amostra.</p>
        <div className={styles.controls}>
          <div><label htmlFor="ocr-task">Tarefa </label><select id="ocr-task" value={currentTask.task}
            onChange={(event) => setTask(event.target.value)}>
            {tasks.map((item) => <option key={item.task} value={item.task}>{`${item.task} (${contagem(item.items, "item", "itens")})`}</option>)}
          </select></div>
          <span>{currentTask.randomized
            ? "Ordem sorteada registrada em toda a amostra"
            : "Sorteio não comprovado em toda a amostra — comparação descritiva"}</span>
        </div>
        <p className={styles.buckets}>{`${contagem(currentTask.resolved, "item", "itens")} de ${currentTask.items} tiveram leitura completa.`} {" "}
          {currentTask.withoutReading > 0
            ? `${contagem(currentTask.withoutReading, "item", "itens")} ficaram sem leitura de ninguém — veja a lista abaixo antes de culpar um modelo.`
            : "Nenhum item ficou sem leitura."}</p>
        <FairTable task={currentTask} />
        <p className={styles.note}>IC 95% é o intervalo de Wilson da taxa de leituras completas aceitas. Faixa larga ou "amostra pequena"
          significa que ainda não dá para decidir. Cotas e rotas disponíveis podem mudar a amostra; o intervalo
          individual não prova superioridade entre modelos. Resolver é ler a aposta completa: rascunho sem número e
          "não é aposta" não contam. Salvamentos são itens que este modelo resolveu fora da primeira
          posição — o valor de quem cobre a falha dos outros.</p>
      </section>}
      <section className={styles.fair}>
        <h3>Acerto conferido por você</h3>
        <p className={styles.note}>Cada aposta capturada guarda quem a leu. Quando você edita uma aposta capturada
          no painel, os campos da leitura que mudaram contam como correção desse leitor. Remover a aposta não conta:
          a remoção não diz se foi erro de leitura. Uma edição por decisão sua, como apostar outra stake, também
          aparece aqui.</p>
        {readers.length > 0 ? <ReaderAccuracyTable rows={readers} />
          : <p role="status">Nenhuma aposta capturada no período.</p>}
      </section>
      <h3>Diagnóstico por modelo</h3>
      <div className={styles.scroll} tabIndex={0} role="region" aria-label="Comparação dos modelos OCR">
        <table><thead><tr>
          <th scope="col">Modelo / situação</th><th scope="col">Tentativas</th><th scope="col">Aptas / respostas</th>
          <th scope="col">Rejeitadas</th><th scope="col">Quota</th><th scope="col">Outras falhas</th>
          <th scope="col">Tempo médio / p95</th><th scope="col">Equivalente pago</th>
        </tr></thead><tbody>{selected.map((row) => <tr key={`${row.provider}/${row.model}/${row.endpoint}`}>
          <th scope="row"><strong>{row.model}</strong><span>{row.provider === "gemini" ? "Google" : row.provider} · {row.enabled ? "Habilitado" : "Fora da configuração"}</span>
            {row.parkedUntil && <span>{`Fora da rotação até ${formatSpDateWithYear(new Date(row.parkedUntil))} em ${contagem(row.parkedCredentials, "chave")}: modelo indisponível para a conta. Tire-o da configuração.`}</span>}
            <span>{row.scope}</span><span>{row.lastAt ? `${resultLabel(row.lastResult ?? "", row.lastStatusCode)} · ${formatSpDateTime(new Date(row.lastAt))}` : "Ainda sem tentativas no período"}</span></th>
          <td>{row.attempts}</td>
          <td>{row.accepted} / {row.responses}<span>{row.responses ? pct(row.accepted, row.responses) : "Sem resposta para avaliar"}</span>
            {row.fixedStake > 0 && <span>{contagem(row.fixedStake, "leitura")} com stake fixa</span>}</td>
          <td>{row.rejected}
            {row.rejected > 0 && <span>{contagem(row.rejectedDraft, "rejeição", "rejeições")} por falta de número · {contagem(row.rejectedReview, "rejeição", "rejeições")} por conteúdo</span>}</td>
          <td>{row.rateLimits}</td><td>{row.errors}</td>
          <td>{seconds(row.usefulAverageMs)}<span>p95 útil: {seconds(row.usefulP95Ms)} · {contagem(row.usefulSamples, "leitura")}</span>
            <span>todas as respostas: {seconds(row.averageMs)} · p95 {seconds(row.p95Ms)}</span></td>
          <td>{usd(row.paidEquivalentUsd)}<span>{usd(row.costPerAcceptedUsd)} por leitura apta</span>
            <span>{contagem(row.pricedSamples, "chamada")} com custo calculável</span></td>
        </tr>)}</tbody></table>
      </div>
      {comparison && comparison.unresolved.length > 0 && <details className={styles.details}>
        <summary>Itens sem leitura de ninguém ({comparison.unresolved.length})</summary>
        <p className={styles.note}>Posts em que nenhum modelo produziu leitura completa. Poucos modelos tentados indica
          cascata interrompida por orçamento ou cota — isso não condena os modelos. Muitos modelos tentados sugere
          imagem realmente ilegível. Confira a imagem antes de concluir.</p>
        <ul>{comparison.unresolved.map((item) => <li key={`${item.at}-${item.task}-${item.modelsTried}`}>
          {formatSpDateTime(new Date(item.at))} · {item.task} · tentado por {contagem(item.modelsTried, "modelo")}
          {item.messageId !== null && <> · mensagem {item.messageId}</>}
          {item.chatIdHash && <span>canal {item.chatIdHash}</span>}
        </li>)}</ul>
      </details>}
      <p className={styles.note}>Leituras aptas passaram pelas validações e regras do tipster. Incluem aceites de rascunhos e de mensagens sem aposta. Isso não é acurácia: o acerto conferido por você está na tabela acima. Quotas e falhas de acesso ficam fora da taxa e dos tempos de resposta.</p>
      <p className={styles.note}>Quando o tipster está configurado com stake fixa, esse valor vem da configuração. Sua ausência na imagem não reprova a leitura.</p>
      <p className={styles.note}>Quota conta recusas de chamadas, não modelos desativados. No Gemini, ao esgotar a quota de um modelo em um projeto, o carrossel tenta as chaves dos outros projetos. O último erro exibido não comprova indisponibilidade em todas as chaves.</p>
      <details className={styles.details}><summary>Detalhes de consumo e falhas por modelo</summary>
        {selected.filter((row) => row.attempts > 0).map((row) => <div key={`${row.provider}/${row.model}/${row.endpoint}`}>
          <h3>{row.model}</h3>
          <p>{row.complete} completas · {row.drafts} rascunhos · {row.notBets} sem aposta, conforme a classificação disponível.</p>
          <p>Entrada: {row.inputTokens.toLocaleString("pt-BR")} tokens · Saída: {row.outputTokens.toLocaleString("pt-BR")} tokens · Raciocínio reportado, já incluído na saída: {row.reasoningTokens.toLocaleString("pt-BR")} · Páginas: {row.pages}. Consumo disponível em {contagem(row.usageSamples, "chamada")}.</p>
          <p>{Object.entries(row.reasons).map(([reason, total]) => `${resultLabel(reason)}: ${total}`).join(" · ")}</p>
        </div>)}
      </details>
      <p className={styles.note}>O equivalente pago usa os tokens ou páginas informados pela API e a tarifa padrão conhecida, em dólar. Inclui respostas rejeitadas que consumiram processamento. Não é a fatura: não desconta quota gratuita, cache, créditos ou impostos. Dados antigos sem consumo e modelos sem tarifa cadastrada aparecem sem estimativa.</p>
      <p className={styles.note}>As primeiras tentativas são distribuídas durante a avaliação. O carrossel para na primeira leitura aceita; perfis de imagem, quotas e fallbacks podem gerar amostras diferentes. Atualizado em {formatSpDateTime(new Date(report.generatedAt))}.</p>
    </>}
  </section>;
}
