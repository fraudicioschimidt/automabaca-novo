/**
 * Deduplicação de requisição em voo, por processo: chamadores simultâneos com
 * a mesma chave recebem a mesma promessa, e a chave é liberada quando ela
 * termina (com sucesso ou erro). Não é cache: a próxima chamada depois disso
 * executa de novo.
 */
export class SingleFlight<T> {
  private readonly pending = new Map<string, Promise<T>>();

  run(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.pending.get(key);
    if (existing) return existing;
    const promise = fn().finally(() => {
      if (this.pending.get(key) === promise) this.pending.delete(key);
    });
    this.pending.set(key, promise);
    return promise;
  }

  /** A execução em voo com esta chave, sem iniciar outra. */
  inFlight(key: string): Promise<T> | undefined {
    return this.pending.get(key);
  }

  clear(): void {
    this.pending.clear();
  }
}
