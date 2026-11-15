/**
 * SSOT do vocabulário de CAUSA de falha de job — o que o operador faz agora.
 *
 * O pg-boss guarda na linha de dead-letter o erro (`output`), o payload
 * (`data`, com `betId` e origem) e `retry_count`; sem ler isso, falhas com
 * ações opostas (circuito aberto, timeout, provider fora, deploy) aparecem como
 * linhas idênticas, e um circuito aberto vira dezenas de "problemas".
 *
 * Eixo próprio, não paralelo a `classifyDlqError`. Aquele responde "o sistema
 * deve re-enfileirar sozinho?" (`transient`/`business`/`other`) e alimenta o
 * dlq-handler. Este responde "o que EU faço agora?": `circuito_aberto` é
 * transitório (o sistema espera e re-tenta) E é inútil para replay manual neste
 * instante. Mesma separação de `permanent` vs `base` em `no-odds-reason`.
 */

import { classifyDlqError, extractDlqErrorPayload } from "@/src/domain/dlq-classification";

type CausaDeFalhaSpec = {
  /** Prosa PT-BR exibida na linha de falha. */
  label: string;
  /**
   * O que fazer — a coluna "Próximas etapas" da tabela de decline codes que
   * originou a ideia. Frase de AÇÃO, não paráfrase do rótulo.
   */
  proximaEtapa: string;
  /**
   * Clicar Replay AGORA resolve? `false` = o job morre de novo enquanto a causa
   * não sair. É o campo que decide se o botão fica habilitado.
   */
  replayResolveAgora: boolean;
};

export const CAUSAS_DE_FALHA = {
  worker_saiu: {
    label: "o worker saiu no meio do trabalho",
    proximaEtapa: "O trabalho está intacto — replay resolve.",
    replayResolveAgora: true,
  },
  tempo_esgotado: {
    label: "o job estourou o tempo",
    proximaEtapa: "Replay uma vez; se repetir, é lentidão do provider ou bug.",
    replayResolveAgora: true,
  },
  circuito_aberto: {
    label: "circuito aberto — nós cortamos o provider",
    proximaEtapa: "Espere o circuito fechar; replay agora falha na hora.",
    replayResolveAgora: false,
  },
  provider_fora: {
    label: "o provider não respondeu",
    proximaEtapa: "Confira o provider; replay depois que ele voltar.",
    replayResolveAgora: false,
  },
  regra_aguardando: {
    label: "a regra pediu para esperar",
    proximaEtapa: "Espere o que o erro pede (o evento começar, o horário ser confirmado) e então dê replay.",
    replayResolveAgora: false,
  },
  regra_de_negocio: {
    label: "a regra recusou o trabalho",
    proximaEtapa: "Replay não resolve — corrija o dado da aposta primeiro.",
    replayResolveAgora: false,
  },
  desconhecida: {
    label: "falha sem classificação",
    proximaEtapa: "Abra o erro bruto: nenhuma causa conhecida casou.",
    replayResolveAgora: false,
  },
} as const satisfies Record<string, CausaDeFalhaSpec>;

export type CausaDeFalha = keyof typeof CAUSAS_DE_FALHA;

export function causaLabel(causa: CausaDeFalha): string {
  return CAUSAS_DE_FALHA[causa].label;
}

export function proximaEtapaDaCausa(causa: CausaDeFalha): string {
  return CAUSAS_DE_FALHA[causa].proximaEtapa;
}

export function replayResolveAgora(causa: CausaDeFalha): boolean {
  return CAUSAS_DE_FALHA[causa].replayResolveAgora;
}

/**
 * As frases que o PRÓPRIO pg-boss escreve quando a execução sai — não são erro
 * de código nosso, são o `manager.js` dele: o drain do reload, o supervisor
 * expirando o job e o timer do worker reprovando o handler que passou do
 * prazo. `"timeout"` NÃO cobre as duas últimas: a grafia exata importa, senão
 * o job fica retido para replay manual (coberto em
 * `tests/operacao/falha-de-job.test.ts`).
 */
const ABANDONO_PGBOSS = ["shut down while active", "job timed out", "handler execution exceeded"] as const;

/**
 * Classifica a saída bruta do pg-boss numa causa do vocabulário.
 *
 * `desconhecida` no fim, e nunca `null`: um erro fora do catálogo tem de virar
 * uma LINHA com "abra o erro bruto", não sumir. Mesmo viés pessimista de
 * `foraDaBaseDeCobertura` — na dúvida, aparece.
 */
export function classificaCausa(output: unknown): CausaDeFalha {
  const { message, name, businessRefusal, waitsFor } = extractDlqErrorPayload(output);
  const texto = message.toLowerCase();

  // O nome da classe vem primeiro: é o sinal mais forte, e `CircuitOpenError`
  // traz "circuit breaker aberto" na mensagem, que casaria com provider_fora.
  if (name === "CircuitOpenError" || texto.includes("circuitopenerror")) return "circuito_aberto";
  if (texto.includes("circuit breaker aberto")) return "circuito_aberto";

  // Abandono ANTES de tempo/rede: "job timed out" é o pg-boss dizendo que o
  // worker sumiu, não o provider demorando — e a ação é diferente.
  if (ABANDONO_PGBOSS.some((marca) => texto.includes(marca))) {
    return texto.includes("shut down") ? "worker_saiu" : "tempo_esgotado";
  }

  if (name === "ProviderRequestError") return "provider_fora";
  if (
    texto.includes("fetch failed")
    || texto.includes("econnrefused")
    || texto.includes("socket hang up")
    || texto.includes("etimedout")
  ) return "provider_fora";

  // `classifyDlqError` já sabe separar regra de negócio de transitório —
  // reusar em vez de redigitar a lista de marcadores.
  if (classifyDlqError({ name, message, businessRefusal }) === "business") return waitsFor ? "regra_aguardando" : "regra_de_negocio";

  if (texto.includes("timeout")) return "tempo_esgotado";
  return "desconhecida";
}

/**
 * O provider nomeado num `CircuitOpenError`, quando a mensagem o traz.
 *
 * Serve para perguntar ao `provider_circuits` se ESTE circuito ainda está
 * aberto: bloquear o replay por "algum circuito está aberto" mataria o botão de
 * uma falha do bridgeodds porque o `llm:gemini` estava fora — e o operador não
 * teria como saber a diferença. `null` quando a grafia não casa: aí o chamador
 * cai no critério grosso, que é conservador de propósito.
 */
export function providerDoCircuito(output: unknown): string | null {
  const { message } = extractDlqErrorPayload(output);
  const casado = /circuit breaker aberto para "([^"]+)"/i.exec(message);
  return casado?.[1] ?? null;
}

/** `betId` do payload do job, quando ele carregava um. */
export function betIdDoPayload(data: unknown): string | null {
  if (data == null || typeof data !== "object") return null;
  const betId = (data as { betId?: unknown }).betId;
  return typeof betId === "string" && betId.length > 0 ? betId : null;
}
