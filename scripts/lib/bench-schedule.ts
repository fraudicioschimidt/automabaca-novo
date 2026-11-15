import { llmHttpCooldown } from "@/src/infra/llm/route-cooldown";
import type { TransportStatus } from "./bench-scoring";

/*
 * Ritmo da bancada de leitura: a cota gratuita de cada provedor limita
 * requisições por minuto por modelo e, em alguns, por conta. Cada provedor tem
 * uma faixa com concorrência e intervalo mínimo; cada modelo, o seu intervalo
 * e o adiamento pedido pelo 429. A classificação do erro reaproveita a mesma
 * régua do cooldown de produção (`llmHttpCooldown`).
 */

export type FailureAction =
  | { action: "retry"; waitMs: number; reason: "rate_limit" | "transient" }
  /** O modelo sai desta rodada; `pending` deixa as tentativas para a próxima. */
  | { action: "stop_model"; status: TransportStatus; pending: boolean }
  | { action: "stop_provider"; status: TransportStatus }
  | { action: "record"; status: TransportStatus };

const MAX_RATE_LIMIT_RETRIES = 6;
const MAX_TRANSIENT_RETRIES = 2;
/** Acima disto a espera não é por minuto: a cota do dia (ou da janela longa) acabou. */
const LONG_WAIT_MS = 15 * 60_000;

export function failureAction(failure: {
  provider: string;
  status: number;
  message: string;
  retryAfter?: string | null;
  timedOut: boolean;
  /** Novas tentativas já feitas por este motivo. */
  attempt: number;
}, now = Date.now()): FailureAction {
  if (failure.timedOut) return { action: "record", status: "timeout" };
  // Projeto da chave barrado pelo Google: vale para todos os modelos daquela
  // chave. A chave inválida já cai na régua de produção, abaixo.
  if (failure.status === 403 && /project has been denied/i.test(failure.message)) {
    return { action: "stop_provider", status: "credencial" };
  }
  // Modelo que só atende por outra API (agentes do Gemini): toda tentativa daria o mesmo 400.
  if (failure.status === 400 && /only supports interactions api|not supported for generatecontent/i.test(failure.message)) {
    return { action: "stop_model", status: "modelo_indisponivel", pending: false };
  }
  const cooldown = llmHttpCooldown(failure.status, failure.message, failure.retryAfter, now, failure.provider);
  if (!cooldown) return { action: "record", status: "erro_http" };
  switch (cooldown.reason) {
    case "authentication":
    case "billing":
      return { action: "stop_provider", status: "credencial" };
    case "model_permanently_unavailable":
    case "model_unavailable":
      return { action: "stop_model", status: "modelo_indisponivel", pending: false };
    case "quota_zero":
      return { action: "stop_model", status: "sem_cota", pending: false };
    case "daily_quota":
      return { action: "stop_model", status: "sem_cota", pending: true };
    case "rate_limit": {
      const waitMs = Math.max(2000, cooldown.until.getTime() - now);
      if (waitMs > LONG_WAIT_MS) return { action: "stop_model", status: "sem_cota", pending: true };
      return failure.attempt < MAX_RATE_LIMIT_RETRIES
        ? { action: "retry", waitMs, reason: "rate_limit" }
        : { action: "record", status: "rate_limit" };
    }
    default:
      return failure.attempt < MAX_TRANSIENT_RETRIES
        ? { action: "retry", waitMs: 5000 * 3 ** failure.attempt, reason: "transient" }
        : { action: "record", status: failure.status === 0 ? "erro_rede" : "indisponivel" };
  }
}

export type LaneOptions = {
  /** Requisições simultâneas no provedor. */
  concurrency: number;
  /** Intervalo mínimo entre o início de duas requisições do provedor. */
  providerGapMs: number;
  /** Intervalo mínimo entre duas requisições ao mesmo modelo. */
  modelGapMs: number;
};

export const DEFAULT_LANES: Record<"gemini" | "groq" | "mistral", LaneOptions> = {
  // Gemini grátis: 5 a 15 RPM por modelo, conforme o modelo.
  gemini: { concurrency: 3, providerGapMs: 500, modelGapMs: 7000 },
  // Groq grátis: ~30 RPM, mas o teto de tokens por minuto (6k a 8k em vários
  // modelos) segura mais que o de requisições; o 429 informa a espera.
  groq: { concurrency: 2, providerGapMs: 1000, modelGapMs: 4000 },
  // Mistral grátis: ~1 requisição por segundo na conta inteira.
  mistral: { concurrency: 1, providerGapMs: 1500, modelGapMs: 1500 },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Faixa de um provedor: segura cada requisição até caber na concorrência e nos intervalos. */
export class ProviderLane {
  private inFlight = 0;
  private nextProviderStart = 0;
  private readonly nextModelStart = new Map<string, number>();

  constructor(private readonly options: LaneOptions) {}

  /** Adia o modelo (429 com espera informada) sem travar os outros. */
  defer(model: string, untilMs: number): void {
    this.nextModelStart.set(model, Math.max(this.nextModelStart.get(model) ?? 0, untilMs));
  }

  async run<T>(model: string, send: () => Promise<T>): Promise<T> {
    for (;;) {
      const now = Date.now();
      const earliest = Math.max(this.nextProviderStart, this.nextModelStart.get(model) ?? 0);
      if (this.inFlight < this.options.concurrency && now >= earliest) break;
      await sleep(Math.min(250, Math.max(20, earliest - now)));
    }
    const started = Date.now();
    this.inFlight += 1;
    this.nextProviderStart = started + this.options.providerGapMs;
    this.nextModelStart.set(model, Math.max(this.nextModelStart.get(model) ?? 0, started + this.options.modelGapMs));
    try {
      return await send();
    } finally {
      this.inFlight -= 1;
    }
  }
}

/** `gemini=7000,groq=4000` → intervalo por modelo de cada provedor. */
export function parseGaps(raw: string | undefined): Partial<Record<string, number>> {
  const gaps: Partial<Record<string, number>> = {};
  for (const part of (raw ?? "").split(",").map((value) => value.trim()).filter(Boolean)) {
    const [provider, value] = part.split("=");
    const ms = Number(value);
    if (!provider || !Number.isFinite(ms) || ms < 0) throw new Error(`intervalo inválido: ${part} (use gemini=7000,groq=4000)`);
    gaps[provider.trim()] = ms;
  }
  return gaps;
}

/**
 * Pool de chaves do Gemini por modelo. Cota e liberação de modelo são por
 * projeto: a chave que não serve para um modelo (cota zero, 404, 403, cota do
 * dia) sai só para ele, e cada falha passageira tenta o mesmo item na outra
 * chave antes de esperar. Guarda só a impressão da chave, nunca a chave.
 */
export class KeyRotation {
  private readonly blocked = new Map<string, Map<string, { pending: boolean }>>();
  private readonly dead = new Set<string>();

  constructor(private readonly keys: ReadonlyArray<{ hint: string; value: string }>) {}

  /** Próxima chave do modelo fora de `tried`; null quando todas foram tentadas ou saíram. */
  next(model: string, tried: ReadonlySet<string>): { hint: string; value: string } | null {
    const blocked = this.blocked.get(model);
    return this.keys.find((key) => !this.dead.has(key.hint) && !blocked?.has(key.hint) && !tried.has(key.hint)) ?? null;
  }

  /** Chave recusada para qualquer modelo (projeto barrado, chave inválida). */
  blockEverywhere(hint: string): void {
    this.dead.add(hint);
  }

  /** Nenhuma chave serve para modelo nenhum (todas recusadas, ou nenhuma no .env): o provedor inteiro sai. */
  allDead(): boolean {
    return this.keys.every((key) => this.dead.has(key.hint));
  }

  block(model: string, hint: string, pending: boolean): void {
    const blocked = this.blocked.get(model) ?? new Map<string, { pending: boolean }>();
    blocked.set(hint, { pending });
    this.blocked.set(model, blocked);
  }

  /** Nenhuma chave serve mais para o modelo; `pending` se alguma só esgotou a cota do dia. */
  exhausted(model: string): { pending: boolean } | null {
    const blocked = this.blocked.get(model);
    if (this.keys.some((key) => !this.dead.has(key.hint) && !blocked?.has(key.hint))) return null;
    return { pending: [...(blocked?.values() ?? [])].some((entry) => entry.pending) };
  }
}
