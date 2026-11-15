export const CAPTURE_POLICIES = ["AUTO", "CAPTION_ODD", "IMAGE_ODD"] as const;
export type CapturePolicy = (typeof CAPTURE_POLICIES)[number];

/**
 * Decisão de QUEM manda na odd durante a captura, derivada da política da banca
 * (dado) e da legenda do post (conteúdo), para que canal novo com formato
 * próprio não exija mexer em código. Aqui é lógica pura — o guard só consome o
 * resultado.
 */

export type CapturePolicyDecision = {
  /** A odd extraída da legenda substitui a do parser/print. */
  captionOddAuthoritative: boolean;
  /** Legenda com `@` mas sem odd legível = rejeita a captura (não adivinha). */
  requireCaptionOdd: boolean;
};

/** Legenda no formato `stake @odd` (ex.: "0.75u @1.850"). */
export function captionCarriesAuthoritativeOdd(caption: string): boolean {
  const blob = caption.trim();
  if (!blob) return false;
  if (/\bwill\b/i.test(blob) && /@\s*\d/.test(blob)) return true;
  return /\d+(?:[.,]\d+)?\s*u?\s*@\s*\d/.test(blob);
}

export function resolveCapturePolicy(
  policy: CapturePolicy,
  caption: string,
): CapturePolicyDecision {
  const hasAt = /@\s*\d/.test(caption);

  if (policy === "CAPTION_ODD") {
    return { captionOddAuthoritative: true, requireCaptionOdd: hasAt };
  }
  if (policy === "IMAGE_ODD") {
    // O print é a verdade: número na legenda é piso/referência, não a odd cravada.
    return { captionOddAuthoritative: false, requireCaptionOdd: false };
  }
  // AUTO: o formato da legenda decide — era o comportamento das bancas de treino
  // (multi-formato) e o padrão dos canais que às vezes trazem a odd no texto.
  const authoritative = captionCarriesAuthoritativeOdd(caption) || hasAt;
  return { captionOddAuthoritative: authoritative, requireCaptionOdd: false };
}
