/** Indisponibilidade transitória: a unidade Telegram deve permanecer em retry. */
export class TelegramParseRetryError extends Error {
  override readonly name = "TelegramParseRetryError";
  /**
   * O que fazer se esta for a última tentativa do job: a recusa que vale
   * quando o provedor que faltou não volta. Sem ela, o post fica na
   * dead-letter.
   */
  readonly onExhausted?: () => Promise<unknown>;

  constructor(kind: "texto" | "foto", messageId: number, options?: ErrorOptions & { onExhausted?: () => Promise<unknown> }) {
    super(`Cascata de extração indisponível para ${kind} do Telegram (msg ${messageId}).`,
      options?.cause === undefined ? undefined : { cause: options.cause });
    if (options?.onExhausted) this.onExhausted = options.onExhausted;
  }
}
