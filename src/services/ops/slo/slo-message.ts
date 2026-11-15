/**
 * Texto do Telegram para uma violação de SLO. Os `reasons` continuam técnicos
 * (o painel de Observabilidade e os testes dependem deles); aqui eles viram
 * frase: "p95 25087ms > 15000ms" diz pouco a quem só quer saber se algo
 * parou de funcionar.
 */

const TIPO: Readonly<Record<string, string>> = {
  provider: "Serviço externo",
  queue: "Fila de tarefas",
  action: "Ação do painel",
  http: "Página ou API",
};

function segundos(ms: number): string {
  if (ms >= 60_000) {
    const min = ms / 60_000;
    return `${Number.isInteger(min) ? min : min.toFixed(1)} min`;
  }
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)}s`;
}

function nomeLegivel(kind: string, name: string): string {
  const llm = /^llm\.transport\.([a-z0-9]+)\.([a-z0-9-]+)$/.exec(name);
  if (llm) {
    const [, provedor = "", operacao = ""] = llm;
    return `IA ${provedor.charAt(0).toUpperCase()}${provedor.slice(1)} (${operacao})`;
  }
  if (name === "llm.cascade") return "Cascata de IAs";
  if (kind === "provider" && name.endsWith(".breaker")) return name.slice(0, -".breaker".length);
  return name;
}

/** Traduz um motivo de `classify`; o que não reconhece passa como veio. */
function motivoSloLegivel(reason: string): string {
  let m = /^sucesso ([\d.]+)% < ([\d.]+)%$/.exec(reason);
  if (m) return `só ${m[1]}% das chamadas deram certo (meta: ${m[2]}%)`;
  m = /^p95 (\d+)ms > (\d+)ms$/.exec(reason);
  if (m) return `lento: as respostas levam até ${segundos(Number(m[1]))} (limite: ${segundos(Number(m[2]))})`;
  m = /^atraso p95 (\d+)ms > (\d+)ms$/.exec(reason);
  if (m) return `tarefas esperando até ${segundos(Number(m[1]))} para começar (limite: ${segundos(Number(m[2]))})`;
  m = /^atraso\+execução p95 (\d+)ms > (\d+)ms$/.exec(reason);
  if (m) return `espera + execução chegam a ${segundos(Number(m[1]))} (limite: ${segundos(Number(m[2]))})`;
  m = /^retentativas ([\d.]+)% > ([\d.]+)%$/.exec(reason);
  if (m) return `${m[1]}% das tarefas precisaram ser repetidas (limite: ${m[2]}%)`;
  m = /^circuito do provider abriu (\d+) (vez|vezes) na janela$/.exec(reason);
  if (m) return `foi desligado por excesso de falhas ${m[1]} ${m[2]}`;
  return reason;
}

export function mensagemSloViolado(row: {
  kind: string;
  name: string;
  samples: number;
  reasons: readonly string[];
}): string {
  const tipo = TIPO[row.kind] ?? row.kind;
  const motivos = row.reasons.map((r) => `• ${motivoSloLegivel(r)}`).join("\n");
  const base = row.samples === 1 ? "1 registro" : `${row.samples} registros`;
  return `🐢 ${tipo} com problema: ${nomeLegivel(row.kind, row.name)}\n${motivos}\nBase: ${base} na última hora.`;
}
