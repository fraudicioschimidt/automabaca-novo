/**
 * Vocabulário puro da AUTORIA de migration — o que dá para provar sem banco.
 *
 * Vive separado de `prisma-migrate-dev.mjs` porque aquele arquivo derruba e
 * recria um banco no primeiro passo: um teste que quisesse conferir o formato
 * do carimbo teria de escolher entre importar o script inteiro (e executá-lo)
 * ou reescrever a regra — e uma regra reescrita no teste pode divergir da real
 * sem que o teste perceba.
 */

/**
 * Carimbo no formato que o `prisma migrate deploy` ordena os diretórios:
 * `YYYYMMDDHHmmss`, sempre UTC. Em horário local, um deploy no fuso errado
 * ordenaria a migration nova ANTES de uma que já existe.
 */
export function carimboDeMigration(data) {
  const d = (n, tamanho = 2) => String(n).padStart(tamanho, "0");
  return (
    `${d(data.getUTCFullYear(), 4)}${d(data.getUTCMonth() + 1)}${d(data.getUTCDate())}` +
    `${d(data.getUTCHours())}${d(data.getUTCMinutes())}${d(data.getUTCSeconds())}`
  );
}

/** O nome vira diretório e é lido em `git log`; nada de espaço nem acento. */
export function nomeDeMigrationValido(nome) {
  return typeof nome === "string" && /^[a-z][a-z0-9_]{2,79}$/.test(nome);
}

/**
 * As duas únicas flags que a autoria aceita. Flag desconhecida FALHA em vez de
 * ser ignorada: quem digitasse `--create-only=true` ou uma flag do
 * `migrate dev` antigo teria a migration aplicada sem querer.
 */
export function parseArgsDeAutoria(argv) {
  const opcoes = { nome: null, apenasCriar: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--create-only") {
      opcoes.apenasCriar = true;
    } else if (arg === "--name") {
      const valor = argv[i + 1];
      if (!valor || valor.startsWith("--")) throw new Error("--name exige um valor.");
      opcoes.nome = valor;
      i += 1;
    } else if (arg.startsWith("--name=")) {
      opcoes.nome = arg.slice("--name=".length);
    } else {
      throw new Error(
        `flag não reconhecida na autoria: ${arg}. Aceitas: --name <nome>, --create-only.`,
      );
    }
  }
  return opcoes;
}
