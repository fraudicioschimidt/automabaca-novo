import "server-only";
import { revalidatePath } from "next/cache";

/** Telas que dependem de apostas, saldos ou vínculos financeiros. */
export function revalidateFinancialViews(slug?: string): void {
  revalidatePath("/");
  revalidatePath("/tipsters", "layout");
  if (slug) revalidatePath(`/tipsters/${slug}`);
  revalidatePath("/contas");
  revalidatePath("/aposta");
  revalidatePath("/operacoes");
}
