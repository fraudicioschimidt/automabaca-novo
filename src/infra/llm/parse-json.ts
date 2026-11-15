/** Tira a vírgula sobrando antes de `}` ou `]`, fora das strings. Nunca
 * reescreve números: um float longo é JSON válido, e cortá-lo só mudaria a
 * odd ou a stake. A aspa final opcional deixa a string sem fechar ir até o fim
 * numa passada só: exigida, cada aspa escapada viraria um novo começo, e a
 * resposta degenerada (sem teto de tamanho) custaria tempo quadrático. */
function repairJsonText(raw: string): string {
  return raw.replace(/"(?:[^"\\]|\\[\s\S])*"?|,(\s*[}\]])/g, (match, closer?: string) => closer ?? match);
}

/** Accept only a complete JSON document or one complete Markdown wrapper.
 * Never rewrites numbers, strings, commas or a truncated model response. */
export function parseStrictLlmJsonText(content: string): unknown | null {
  const trimmed = content.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)```$/i)?.[1]?.trim();
  try { return JSON.parse(fenced ?? trimmed) as unknown; } catch { return null; }
}

/** Tolera cercas de markdown, texto em volta e vírgula sobrando. Resposta
 * truncada sem o `}` final nunca é completada: a cascata tenta outro provedor. */
export function parseLlmJsonText(content: string): unknown | null {
  const trimmed = content.trim();
  if (!trimmed) return null;

  const tryParse = (raw: string): unknown | null => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  for (const candidate of [trimmed, repairJsonText(trimmed)]) {
    const direct = tryParse(candidate);
    if (direct !== null) return direct;

    const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
    if (fenced) {
      const fromFence = tryParse(fenced) ?? tryParse(repairJsonText(fenced));
      if (fromFence !== null) return fromFence;
    }

    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start >= 0 && end > start) {
      const slice = candidate.slice(start, end + 1);
      const fromSlice = tryParse(slice) ?? tryParse(repairJsonText(slice));
      if (fromSlice !== null) return fromSlice;
    }
  }

  return null;
}
