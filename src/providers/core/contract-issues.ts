import type { z } from "zod";

/** Bounded schema diagnostics; never include payload values or Zod messages. */
export function contractIssues(issues: readonly z.core.$ZodIssue[]) {
  const output: { code: string; path: string[] }[] = [];
  const visit = (rows: readonly z.core.$ZodIssue[], depth: number) => {
    for (const issue of rows) {
      if (output.length >= 10) break;
      if (issue.code === "invalid_union" && depth < 3) {
        for (const branch of issue.errors) visit(branch, depth + 1);
      } else {
        output.push({ code: issue.code, path: issue.path.slice(0, 10).map((part) => {
          const field = String(part);
          return /^[A-Za-z0-9_]{1,64}$/.test(field) ? field : "[field]";
        }) });
      }
    }
  };
  visit(issues, 0);
  return output;
}

/**
 * Abaixo disto, linhas descartadas não provam que o contrato mudou: a resposta
 * pequena com uma linha ruim continua valendo pelas linhas aceitas.
 */
const MIN_ROWS_TO_JUDGE_CONTRACT = 4;

/** A maioria das linhas fora do contrato é o contrato que mudou, e não linhas ruins. */
export function contractBroken(rejected: number, total: number): boolean {
  // Um lote inteiramente descartado nunca prova ausência de dados, mesmo pequeno.
  return (total > 0 && rejected === total) ||
    (total >= MIN_ROWS_TO_JUDGE_CONTRACT && rejected * 2 > total);
}
