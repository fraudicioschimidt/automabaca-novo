/** Server-owned provenance. Model text cannot supply reader identity or confer
 * factual accuracy. Financial policy/normalization remains separately visible. */
export type OcrReading = {
  provider: "gemini" | "groq" | "mistral";
  model: string;
  modelVersion?: string;
  endpoint: "generate" | "chat" | "ocr" | "search";
  contractVersion?: string;
  contractHash: string;
  sourceHash: string;
  responseHash: string;
  receivedAt: string;
  cached?: boolean;
};
export type CaptureOcrEvidence = {
  version: 1;
  state: "complete" | "draft" | "review" | "not_bet";
  accuracy: "unreviewed";
  readers: OcrReading[];
  sourceFields: Record<string, unknown>;
  transformations: string[];
  itemIndex?: number;
  registration?: Record<string, string | number | null>;
};

/** Snapshot the final persisted terms without rewriting the reader's literals. */
export function captureRegisteredOcrEvidence(parsed: unknown, registration: NonNullable<CaptureOcrEvidence["registration"]>): unknown {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return parsed;
  const capture = parsed as Record<string, unknown>;
  const evidence = capture.ocrEvidence as CaptureOcrEvidence | undefined;
  if (evidence?.version !== 1 || evidence.accuracy !== "unreviewed" || !Array.isArray(evidence.readers)) return parsed;
  const changes = ["evento", "mercado", "selecao", "odds", "stake"].filter((field) => capture[field] !== registration[field]);
  return { ...capture, ocrEvidence: { ...evidence, registration,
    transformations: [...new Set([...evidence.transformations, ...changes.map((field) => `registration_${field}_normalization`)])] } };
}
