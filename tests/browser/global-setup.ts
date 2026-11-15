/**
 * PONTO DE ESTRANGULAMENTO: nenhuma suíte de navegador toca banco que não seja
 * `*_e2e*`. O config carrega o `.env`, então `npm run test:ui` / `test:e2e`
 * herdariam a `DATABASE_URL` que estiver lá — e `critical.spec` faz mutação real
 * (cria banca, aposta, liquida). O gate empacotado também recusa
 * (`scripts/lib/docker-runtime.sh`), mas o comando direto passa por fora dele.
 *
 * Por que aqui e não no `playwright.config.ts`: lançar durante o IMPORT do
 * config quebra quem só LÊ o arquivo sem intenção de rodar teste (o knip, por
 * exemplo). `globalSetup` roda uma vez, e só quando a suíte vai mesmo executar:
 * mesma garantia fail-closed, sem sequestrar a leitura do módulo.
 */
export default function guardTestDatabase(): void {
  const banco = process.env.DATABASE_URL ?? "";
  if (banco === "") return;
  const caminho = new URL(banco).pathname;
  if (/(?:^|_)e2e(?:_|$)/i.test(caminho)) return;
  throw new Error(
    `Suite de navegador recusada: DATABASE_URL aponta para "${caminho.slice(1)}", `
      + "e nao para um banco *_e2e*. Use `npm run test:browser:local` (resolve o banco sozinho) "
      + "ou exporte DATABASE_URL para o banco e2e.",
  );
}
