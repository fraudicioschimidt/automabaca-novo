import { headers } from "next/headers";

/**
 * Nome do operador para EXIBIÇÃO e para escopar leitura de sessões de
 * dispositivo. Vem do `x-auth-user`, que o `proxy.ts` apaga na entrada e só
 * grava depois de revalidar cookie HMAC + época + sessão de dispositivo — o
 * header não é forjável pelo cliente.
 *
 * Falha fechado: sem o header (matcher mal configurado, rota nova fora do
 * proxy), recusa em vez de renderizar o painel — e listar sessões de
 * dispositivo — para um usuário inventado com `?? "operador"`.
 *
 * Mutação NÃO usa isto: `_auth.ts` revalida a sessão inteira, porque lá o
 * custo se justifica e a regra é não confiar só em `x-auth-*`.
 */
export async function operadorAtual(): Promise<string> {
  const username = (await headers()).get("x-auth-user");
  if (!username) {
    throw new Error(
      "Requisição de painel sem operador autenticado (x-auth-user ausente) — " +
        "verifique se a rota passa pelo proxy.",
    );
  }
  return username;
}
