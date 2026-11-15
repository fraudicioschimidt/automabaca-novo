/**
 * Barreira de resultado/placar dos providers sharp: resultado só vem do
 * Flashscore, e identidade/odds não podem ser contaminadas por dado pós-jogo.
 * Remove recursivamente (objetos e arrays) chaves result, results, score,
 * scores, period_results e as terminadas em _score, sem diferenciar caixa.
 */
export function stripResultFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripResultFields);
  if (!value || typeof value !== "object") return value;
  const safe: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    const normalized = key.toLowerCase();
    if (
      normalized === "result" ||
      normalized === "results" ||
      normalized === "score" ||
      normalized === "scores" ||
      normalized === "period_results" ||
      normalized.endsWith("_score")
    )
      continue;
    safe[key] = stripResultFields(nested);
  }
  return safe;
}
