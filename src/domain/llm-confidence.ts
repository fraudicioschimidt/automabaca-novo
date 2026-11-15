import { z } from "zod";

/** Confiança externa: fração sem sufixo ou percentual explícito/na escala 0–100. */
export const llmConfidenceSchema = z.preprocess((value) => {
  const text = typeof value === "string" ? value.trim() : null;
  const isPercent = text?.endsWith("%") === true;
  const raw = text === null ? value : (isPercent ? text.slice(0, -1).trim() : text);
  if (raw === "") return value;
  const number = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(",", ".")) : NaN;
  if (!Number.isFinite(number)) return value;
  if (isPercent || (number > 1 && number <= 100)) return number / 100;
  return number;
}, z.number().min(0).max(1));
