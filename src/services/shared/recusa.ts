/**
 * Recusa de NEGÓCIO: o sistema funcionou e disse não ("Zere o saldo da conta
 * antes de removê-la"). `observeAction` a conta como amostra esperada, fora da
 * taxa de erro, e só ela tem mensagem que pode chegar ao operador. Qualquer
 * outro `Error` continua sendo falha; a distinção está no tipo, não no texto.
 */
export class RecusaDeNegocioError extends Error {
  /** Viaja na saída serializada do job (o pg-boss usa serialize-error), para a
   * DLQ reconhecer a recusa também nas subclasses, que trocam o `name`. */
  readonly businessRefusal = true;
  /** Recusa que se resolve sozinha: o que precisa acontecer antes de repetir
   * ("o evento começar"). Sem ela, a recusa é definitiva até o dado mudar. */
  readonly waitsFor?: string;

  constructor(message: string, options: { waitsFor?: string } = {}) {
    super(message);
    this.name = "RecusaDeNegocioError";
    if (options.waitsFor) this.waitsFor = options.waitsFor;
  }
}

/** Mensagem pública de uma recusa de negócio; qualquer outro erro é relançado. */
export function recusaMessageOrThrow(error: unknown): string {
  if (error instanceof RecusaDeNegocioError) return error.message;
  throw error;
}

/**
 * Resultado de server action do painel. A recusa volta como dado porque, em
 * produção, o Next troca a mensagem de um erro lançado por um texto genérico
 * com digest, e o operador não veria o motivo.
 */
export type ActionResult<T extends object = Record<never, never>> = ({ ok: true } & T) | { ok: false; erro: string };

/**
 * Roda a mutação e devolve a recusa de negócio como `{ ok: false, erro }`; o
 * que `fn` devolve vai junto do `ok: true`. Qualquer outra falha segue como
 * exceção, para o observador e a borda do Next.
 */
export async function refusalAsResult<T extends object = Record<never, never>>(
  fn: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return { ok: true, ...(await fn()) };
  } catch (error) {
    return { ok: false, erro: recusaMessageOrThrow(error) };
  }
}
