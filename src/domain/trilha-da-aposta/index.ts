/**
 * SSOT da TRILHA da aposta — como cada mudança de estado vira frase: a trilha
 * de DECISÃO (liquidação, RE-liquidação, edição, kickoff), ao lado da de PREÇO
 * (`ClvOrigem`/`OddsTrajectory`). Sem ela, uma aposta cujo resultado foi trocado
 * depois de liquidada (edição do post, caixa de ações, recálculo) mostraria só
 * o estado final, sem como saber que antes era outro.
 *
 * A frase é uniforme e o NEGRITO marca só a parte variável, então numa coluna
 * de frases parecidas o olho pousa no que difere. Isso só funciona se o
 * conectivo for realmente igual entre dois eventos do mesmo tipo — por isso
 * `narrar` devolve `Trecho[]` em vez de string, e o portão prova a propriedade.
 *
 * Duas consequências no desenho:
 *
 * 1. **Tipo narrável ≠ `action` de auditoria.** `kickoff.resolve_attempt` com
 *    `aplicado: true` e `false` são frases de sentidos opostos; forçá-las no
 *    mesmo molde faria o conectivo variar. Viram tipos distintos, como
 *    `classificaCausa` faz em `falha-de-job`.
 * 2. **Diff não cabe na frase.** `bet.edit` muda de 1 a 8 campos; embutir a
 *    lista na sentença quebraria a uniformidade E seria ilegível. A frase diz
 *    QUEM editou, e as mudanças saem em `mudancas`, campo a campo.
 */


import {
  VAZIO,
  diff,
  instante,
  numero,
  origemDaCaptura,
  origemDoPost,
  rotuloDaFonteDeLiquidacao,
  statusEmProsa,
  texto,
} from "./leitura";
import { fmtOdds, fmtU, fmtUnit } from "@/src/domain/formato-de-resultado";
import type { ChaveDeEvento, EventoBruto, EventoSpec, Narracao } from "./tipos";

export type {
  ChaveDeEvento, EventoBruto, MudancaDeCampo, Narracao, Trecho,
} from "./tipos";
export { rotuloDaFonteDeLiquidacao } from "./leitura";

export const EVENTOS_DA_TRILHA: Readonly<Record<ChaveDeEvento, EventoSpec>> = {
  captura: {
    rotulo: "Capturada",
    acaoDeAuditoria: "bet.create",
    narrar: (e) => ({
      frase: [
        { texto: "Aposta capturada de " },
        { texto: origemDaCaptura(e.ator), forte: true },
        { texto: " — " },
        { texto: texto(e.dados, "selecao"), forte: true },
        { texto: " em " },
        { texto: texto(e.dados, "mercado"), forte: true },
        { texto: " a " },
        { texto: fmtOdds(numero(e.dados, "odds")), forte: true },
        { texto: ", stake " },
        { texto: fmtUnit(numero(e.dados, "stake")), forte: true },
        { texto: "." },
      ],
    }),
  },

  captura_repetida: {
    rotulo: "Chegou de novo",
    acaoDeAuditoria: "bet.duplicate_absorbed",
    narrar: (e) => ({
      frase: [
        { texto: "A mesma aposta chegou de novo por " },
        { texto: origemDoPost(e.dados), forte: true },
        { texto: " e ficou nesta, sem virar outra." },
      ],
    }),
  },

  edicao: {
    rotulo: "Editada",
    acaoDeAuditoria: "bet.edit",
    narrar: (e) => ({
      frase: [
        { texto: "Aposta editada por " },
        { texto: e.ator || VAZIO, forte: true },
        { texto: "." },
      ],
      mudancas: diff(e.dados),
    }),
  },

  nao_peguei: {
    rotulo: "Não peguei",
    acaoDeAuditoria: "bet.soft_delete",
    narrar: (e) => ({
      frase: [
        { texto: "Marcada como não pega por " },
        { texto: e.ator || VAZIO, forte: true },
        { texto: " — " },
        { texto: texto(e.dados, "motivo"), forte: true },
        { texto: ". O ledger estornou " },
        { texto: fmtU(numero(e.dados, "previousLucro")), forte: true },
        { texto: " de uma aposta " },
        { texto: statusEmProsa(e.dados, "previousStatus"), forte: true },
        { texto: "." },
      ],
    }),
  },

  nao_peguei_desfeito: {
    rotulo: "Não peguei desfeito",
    acaoDeAuditoria: "bet.not_taken_undone",
    narrar: (e) => ({
      frase: [
        { texto: "Desfeita a marca de não pega por " },
        { texto: e.ator || VAZIO, forte: true },
        { texto: " — a aposta voltou a " },
        { texto: statusEmProsa(e.dados, "restoredStatus"), forte: true },
        { texto: "." },
      ],
    }),
  },

  peguei: {
    rotulo: "Peguei",
    acaoDeAuditoria: "bet.taken",
    narrar: (e) => ({
      frase: [
        { texto: "Entrada marcada como pega em " },
        { texto: instante(e.dados, "takenAt"), forte: true },
        { texto: " — " },
        { texto: texto(e.dados, "via"), forte: true },
        { texto: "." },
      ],
    }),
  },

  peguei_desfeito: {
    rotulo: "Peguei desfeito",
    acaoDeAuditoria: "bet.taken_undone",
    narrar: (e) => ({
      frase: [
        { texto: "Desfeita a marca de pega de " },
        { texto: instante(e.dados, "previousTakenAt"), forte: true },
        { texto: " — " },
        { texto: texto(e.dados, "via"), forte: true },
        { texto: "." },
      ],
    }),
  },

  mercado_corrigido: {
    rotulo: "Mercado corrigido",
    acaoDeAuditoria: "bet.market_correct",
    narrar: (e) => ({
      frase: [
        { texto: "Mercado corrigido por " },
        { texto: e.ator || VAZIO, forte: true },
        { texto: " — " },
        { texto: texto(e.dados, "motivo"), forte: true },
        { texto: "." },
      ],
      mudancas: diff(e.dados),
    }),
  },

  identidade_auto: {
    rotulo: "Identidade casada",
    acaoDeAuditoria: "identidade_auto",
    narrar: (e) => ({
      frase: [
        { texto: "Identidade casada automaticamente com " },
        { texto: texto(e.dados, "match"), forte: true },
        { texto: " (confiança " },
        { texto: `${numero(e.dados, "confidence") ?? VAZIO}%`, forte: true },
        { texto: ", id " },
        { texto: texto(e.dados, "providerMatchId"), forte: true },
        { texto: ")." },
      ],
      mudancas: diff(e.dados),
    }),
  },

  identidade_llm: {
    rotulo: "Identidade casada por LLM",
    acaoDeAuditoria: "identidade_llm",
    narrar: (e) => ({
      frase: [
        { texto: "Identidade casada por LLM com " },
        { texto: texto(e.dados, "match"), forte: true },
        { texto: " (confiança " },
        { texto: `${numero(e.dados, "confidence") ?? VAZIO}%`, forte: true },
        { texto: ", id " },
        { texto: texto(e.dados, "providerMatchId"), forte: true },
        { texto: ")." },
      ],
      mudancas: diff(e.dados),
    }),
  },

  identidade_vinculada: {
    rotulo: "Jogo vinculado",
    acaoDeAuditoria: "identidade_vinculada",
    narrar: (e) => ({
      frase: [
        { texto: "Jogo vinculado por " },
        { texto: e.ator || VAZIO, forte: true },
        { texto: ": " },
        { texto: texto(e.dados, "match"), forte: true },
        { texto: " (id " },
        { texto: texto(e.dados, "providerMatchId"), forte: true },
        { texto: ")." },
      ],
      mudancas: diff(e.dados),
    }),
  },

  kickoff_corrigido: {
    rotulo: "Início corrigido",
    acaoDeAuditoria: "kickoff.resolve_attempt",
    narrar: (e) => ({
      frase: [
        { texto: "Início do jogo corrigido de " },
        { texto: instante(e.dados, "anterior"), forte: true },
        { texto: " para " },
        { texto: instante(e.dados, "resolvido"), forte: true },
        { texto: " pela fonte " },
        { texto: texto(e.dados, "source"), forte: true },
        { texto: ". A janela de fechamento e o CLV passam a medir contra o novo horário." },
      ],
    }),
  },

  kickoff_tentativa: {
    rotulo: "Início não resolvido",
    acaoDeAuditoria: "kickoff.resolve_attempt",
    narrar: (e) => ({
      frase: [
        { texto: "Tentativa de resolver o início do jogo pela fonte " },
        { texto: texto(e.dados, "source"), forte: true },
        { texto: " não encontrou o evento — o horário segue " },
        { texto: instante(e.dados, "anterior"), forte: true },
        { texto: "." },
      ],
    }),
  },

  // A busca nunca troca o esporte: achou o jogo em outro e deixou os dois como estavam.
  kickoff_outro_esporte: {
    rotulo: "Jogo achado em outro esporte",
    acaoDeAuditoria: "kickoff.resolve_attempt",
    narrar: (e) => ({
      frase: [
        { texto: "A fonte " },
        { texto: texto(e.dados, "source"), forte: true },
        { texto: " achou o jogo em " },
        { texto: texto(e.dados, "esporteResolvido"), forte: true },
        { texto: ", mas a aposta está em " },
        { texto: texto(e.dados, "esporteAnterior"), forte: true },
        { texto: ": nem o esporte nem o horário foram trocados — o horário segue " },
        { texto: instante(e.dados, "anterior"), forte: true },
        { texto: "." },
      ],
    }),
  },

  kickoff_remarcado: {
    rotulo: "Jogo remarcado",
    acaoDeAuditoria: "bet.kickoff_moved_by_provider",
    narrar: (e) => ({
      frase: [
        { texto: "Início do jogo remarcado de " },
        { texto: instante(e.dados, "anterior"), forte: true },
        { texto: " para " },
        { texto: instante(e.dados, "novo"), forte: true },
        { texto: " pelo horário da " },
        { texto: texto(e.dados, "provider"), forte: true },
        { texto: ". O fechamento passa a medir contra o novo horário." },
      ],
    }),
  },

  reabertura: {
    rotulo: "Reaberta",
    acaoDeAuditoria: null,
    narrar: (e) => ({
      frase: [
        { texto: "Reaberta de " },
        { texto: statusEmProsa(e.dados, "from"), forte: true },
        { texto: " para pendente por " },
        { texto: rotuloDaFonteDeLiquidacao(texto(e.dados, "source")), forte: true },
        { texto: ". O resultado anterior foi desfeito." },
      ],
    }),
  },

  liquidacao: {
    rotulo: "Liquidada",
    acaoDeAuditoria: null,
    narrar: (e) => ({
      frase: [
        { texto: "Liquidada como " },
        { texto: statusEmProsa(e.dados, "to"), forte: true },
        { texto: " por " },
        { texto: rotuloDaFonteDeLiquidacao(texto(e.dados, "source")), forte: true },
        { texto: " — " },
        { texto: fmtU(numero(e.dados, "lucro")), forte: true },
        { texto: "." },
      ],
    }),
  },

  reliquidacao: {
    rotulo: "Resultado alterado",
    acaoDeAuditoria: null,
    narrar: (e) => ({
      frase: [
        { texto: "Resultado alterado de " },
        { texto: statusEmProsa(e.dados, "from"), forte: true },
        { texto: " para " },
        { texto: statusEmProsa(e.dados, "to"), forte: true },
        { texto: " por " },
        { texto: rotuloDaFonteDeLiquidacao(texto(e.dados, "source")), forte: true },
        { texto: " — o ledger passou a " },
        { texto: fmtU(numero(e.dados, "lucro")), forte: true },
        { texto: "." },
      ],
    }),
  },

  liquidacao_delegada: {
    rotulo: "Liquidação delegada",
    acaoDeAuditoria: "bet.settle_delegated",
    narrar: (e) => ({
      frase: [
        { texto: "Liquidação delegada pelo agente " },
        { texto: texto(e.dados, "agent"), forte: true },
        { texto: ", aprovada por " },
        { texto: texto(e.dados, "approvedBy"), forte: true },
        { texto: " — " },
        { texto: texto(e.dados, "evidence"), forte: true },
        { texto: "." },
      ],
    }),
  },

  // O agente (ou o `ops-resolve-sport`) confirmando o esporte: a edição do
  // resolvedor aparece à parte, e é aqui que se vê quem pediu e por quê.
  esporte_por_operador: {
    rotulo: "Esporte pelo operador",
    acaoDeAuditoria: "bet.sport_resolve.operator",
    narrar: (e) => ({
      frase: [
        { texto: "Esporte " },
        { texto: e.dados["status"] === "resolved" ? "confirmado" : "avaliado sem confirmar", forte: true },
        { texto: " por " },
        { texto: e.ator || VAZIO, forte: true },
        { texto: ": " },
        { texto: texto(e.dados, "sport"), forte: true },
        { texto: " — " },
        { texto: texto(e.dados, "evidence") === VAZIO ? texto(e.dados, "reason") : texto(e.dados, "evidence"), forte: true },
        { texto: "." },
      ],
    }),
  },
};

export const CHAVES_DE_EVENTO = Object.keys(EVENTOS_DA_TRILHA) as ChaveDeEvento[];

/**
 * As `action` de auditoria que a trilha exibe — DERIVADO do registro, nunca
 * digitado de novo. `audit-purge` consome esta lista para garantir que o que a
 * tela mostra a purga não apague antes da aposta.
 */
export const ACOES_DE_AUDITORIA_DA_TRILHA: readonly string[] = [
  ...new Set(
    CHAVES_DE_EVENTO.map((c) => EVENTOS_DA_TRILHA[c].acaoDeAuditoria).filter(
      (a): a is string => a !== null,
    ),
  ),
].sort();

/**
 * `action` de auditoria → chave narrável. Uma action pode virar mais de uma
 * chave (kickoff aplicado, tentativa, jogo em outro esporte) — é o motivo de
 * existir esta função em vez de um mapa. Devolve `null` para o que a trilha
 * não narra, e quem chama DESCARTA: exibir sem saber narrar seria uma linha
 * muda na trilha.
 */
export function classificarEventoDeAuditoria(
  action: string,
  dados: Record<string, unknown>,
): ChaveDeEvento | null {
  if (action === "kickoff.resolve_attempt") {
    if (dados["aplicado"] === true) return "kickoff_corrigido";
    return dados["missReason"] === "other_sport" ? "kickoff_outro_esporte" : "kickoff_tentativa";
  }
  const chave = CHAVES_DE_EVENTO.find(
    (c) => EVENTOS_DA_TRILHA[c].acaoDeAuditoria === action,
  );
  return chave ?? null;
}

/** A frase pronta. Separada de `EVENTOS_DA_TRILHA` para o chamador não indexar na mão. */
export function narrar(evento: EventoBruto): Narracao {
  return EVENTOS_DA_TRILHA[evento.chave].narrar(evento);
}
