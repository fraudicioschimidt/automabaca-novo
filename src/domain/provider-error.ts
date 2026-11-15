/** Erro de provider independente de transporte, breaker e implementação concreta. */
export class ProviderRequestError extends Error {
  readonly status: number | undefined;
  readonly billed: boolean;
  readonly blocked: boolean;

  constructor(
    label: string,
    result: { status?: number; error: string; blocked?: boolean; billed?: boolean },
  ) {
    super(`${label}: ${result.error}`);
    this.name = "ProviderRequestError";
    this.status = result.status;
    this.billed = result.billed ?? (
      result.status !== undefined && result.status >= 200 && result.status < 300
    );
    this.blocked = result.blocked === true;
  }
}

/** Recusa anterior ao transporte; nunca é falha estrutural do provider. */
export class ProviderRequestGateError extends Error {
  readonly provider: string;
  readonly requestLabel?: string;

  constructor(name: string, message: string, provider: string, requestLabel?: string) {
    super(message);
    this.name = name;
    this.provider = provider;
    this.requestLabel = requestLabel;
  }
}

/** O slot existe, mas deve ser aguardado por um job durável, fora do consumidor. */
export class ProviderCadenceDeferredError extends ProviderRequestGateError {
  constructor(provider: string, readonly retryAt: Date) {
    super("ProviderCadenceDeferredError", "Próxima consulta aguardando capacidade do provedor.", provider);
  }
}

export class BudgetExhaustedError extends ProviderRequestGateError {
  constructor(provider: string, requestLabel?: string) {
    super(
      "BudgetExhaustedError",
      `Budget do provider ${provider} esgotado no periodo corrente.`,
      provider,
      requestLabel,
    );
  }
}

export class ProviderBudgetAccountingError extends ProviderRequestGateError {
  constructor(provider: string, requestLabel: string | undefined, cause: unknown) {
    super(
      "ProviderBudgetAccountingError",
      `Falha ao contabilizar budget do provider ${provider}.`,
      provider,
      requestLabel,
    );
    this.cause = cause;
  }
}

/** HTTP 429 é pressão de cota, não falha estrutural do provider. */
export function isRateLimitedProviderError(err: unknown): boolean {
  return err instanceof ProviderRequestError && err.status === 429;
}

/** Resposta de bloqueio/WAF deve interromper novas chamadas imediatamente. */
export function isBlockedProviderError(err: unknown): boolean {
  return err instanceof ProviderRequestError && err.blocked;
}
