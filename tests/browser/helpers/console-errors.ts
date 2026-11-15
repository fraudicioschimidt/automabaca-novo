import type { Page } from "@playwright/test";

/**
 * Coleta erros de console/página — filtrando por ORIGEM, nunca por texto.
 *
 * Em `npm run dev`, cada página do painel emite mensagens
 * `Applying inline style violates ... 'style-src'`. Todas vêm de
 * `next-devtools`, o overlay do próprio Next, que injeta um `<style>` de
 * `@font-face` sem nonce. A produção emite ZERO e o único `<style>` do DOM
 * carrega nonce — o CSP está certo, e afrouxá-lo com `style-src 'unsafe-inline'`
 * é o que o portão `security-config` proíbe, com razão.
 *
 * Por que o filtro é por ORIGEM e não por texto: um `<style>` sem nonce
 * injetado pelo NOSSO código produziria a mensagem IDÊNTICA. Uma lista de
 * textos a ignorar esconderia exatamente o defeito que a asserção existe para
 * pegar — que é o que "verificar console limpo" deixa de significar quando o
 * ruído é normalizado. Aqui, mensagem igual vinda de arquivo nosso continua
 * reprovando.
 *
 * A suíte roda contra BUILD DE PRODUÇÃO, onde o overlay não existe; o filtro é
 * a rede de segurança para quem apontar a suíte (ou uma sonda) para `dev`.
 */

/** Origens que não são código do AutomaBACA — casadas pelo caminho do arquivo. */
const ORIGENS_DE_FERRAMENTA = [
  "next-devtools",
  "/__nextjs",
] as const;

export function ehRuidoDeFerramenta(sourceUrl: string): boolean {
  return ORIGENS_DE_FERRAMENTA.some((marca) => sourceUrl.includes(marca));
}

export type ErroDeNavegador = { origem: string; texto: string };

/**
 * Liga os ouvintes e devolve o array que eles alimentam. `pageerror` entra
 * SEMPRE: exceção não tem origem de ferramenta a perdoar.
 */
export function coletarErrosDoNavegador(page: Page): ErroDeNavegador[] {
  const erros: ErroDeNavegador[] = [];
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    const url = message.location().url;
    if (ehRuidoDeFerramenta(url)) return;
    erros.push({ origem: url, texto: `console: ${message.text()}` });
  });
  page.on("pageerror", (error) => {
    erros.push({ origem: "pageerror", texto: `pageerror: ${error.message}` });
  });
  return erros;
}

/** Texto legível para a mensagem de falha da asserção. */
export function descreverErros(erros: readonly ErroDeNavegador[]): string {
  return erros.map((e) => `${e.texto}  @ ${e.origem}`).join("\n");
}
