const REASON_LABELS: Readonly<Record<string, string>> = {
  no_results: "Nenhuma partida foi retornada pelos providers na janela do kickoff.",
  below_threshold: "As partidas encontradas ficaram abaixo do score mínimo de identidade.",
  llm_indisponivel: "O auto-match não foi conclusivo e o juiz LLM estava indisponível.",
  zona_cinzenta_recusada: "O juiz LLM recusou os candidatos da zona cinzenta.",
  auto_ambiguo_gap: "Os dois melhores candidatos ficaram próximos demais para decisão automática.",
  provisional_kickoff_day_expired: "O dia do kickoff provisório terminou sem identidade confiável.",
  enrich_dead_letter_retryable: "A busca falhou e seguirá em retry enquanto a janela do evento estiver aberta.",
  enrich_dead_letter_terminal: "As tentativas de busca terminaram sem identidade após o evento.",
  kickoff_changed_reopened: "O kickoff mudou e a busca de identidade foi reaberta.",
};

export function trainingCaseReasonLabel(reason: string): string {
  const normalized = reason.trim();
  if (normalized.startsWith("past_event:")) {
    return `O evento já passou sem identidade confiável. ${trainingCaseReasonLabel(normalized.slice(11))}`;
  }
  if (/^esporte_.+_sem_match_nos_tiers$/.test(normalized)) {
    return "Nenhum provider de identidade configurado encontrou a partida para este esporte.";
  }
  return REASON_LABELS[normalized] ?? `A busca automática foi recusada (${normalized}).`;
}

/** O motivo em poucas palavras, para o selo do caso em Vincular; a frase inteira é `trainingCaseReasonLabel`. */
const REASON_TAGS: Readonly<Record<string, string>> = {
  no_results: "nenhum candidato",
  below_threshold: "candidatos fracos",
  llm_indisponivel: "juiz de IA indisponível",
  zona_cinzenta_recusada: "juiz de IA recusou",
  auto_ambiguo_gap: "candidatos próximos",
  provisional_kickoff_day_expired: "kickoff provisório venceu",
  enrich_dead_letter_retryable: "busca falhou",
  enrich_dead_letter_terminal: "busca esgotada",
  kickoff_changed_reopened: "kickoff mudou",
};

export function trainingCaseReasonTag(reason: string): string {
  const normalized = reason.trim();
  // O selo mostra a causa; "o evento já passou" fica na frase inteira.
  if (normalized.startsWith("past_event:")) return trainingCaseReasonTag(normalized.slice(11));
  if (/^esporte_.+_sem_match_nos_tiers$/.test(normalized)) return "nenhum provider achou";
  return REASON_TAGS[normalized] ?? "busca recusada";
}
