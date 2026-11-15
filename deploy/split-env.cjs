/* eslint-disable @typescript-eslint/no-require-imports -- roda com `node` puro no servidor, em CommonJS */
/**
 * Gera /etc/automabaca-novo/{web,worker}.env a partir do runtime.env.
 *
 * Quem decide o que vai para cada container é `env-allowlist.cjs`, ao lado
 * deste arquivo na árvore do commit publicado. Até 17/09/2026 a allowlist era
 * lida de `/srv/apps/automabaca-novo/source/` por caminho fixo, um checkout que
 * outras sessões trocavam de branch à vontade e que, naquele dia, estava parado
 * num commit de 8 de setembro: o ambiente de produção era gerado a partir de um
 * código que não era o que estava rodando.
 *
 * A configuração vem só do ARQUIVO auditado, nunca do shell de quem chamou: um
 * `export GEMINI_API_KEY=…` numa sessão de debug não pode virar configuração
 * permanente e invisível (auditoria externa 004, achado 9).
 *
 *   cd /srv/apps/automabaca-novo/source && sudo node deploy/split-env.cjs
 *
 * AUTOMABACA_ENV_FILE e AUTOMABACA_ENV_OUT_DIR trocam origem e destino (testes).
 */
const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");

function carregarAllowlist() {
  const caminho = path.join(__dirname, "env-allowlist.cjs");
  if (!fs.existsSync(caminho)) {
    // Acontece ao rodar a cópia solta em /srv/apps/automabaca-novo/deploy/, que
    // não é uma árvore do projeto e existe só para o verificador de deriva.
    throw new Error(
      "env-allowlist.cjs não encontrado em " + caminho + ".\n"
      + "Rode a partir de um checkout no commit publicado:\n"
      + "  cd /srv/apps/automabaca-novo/source && sudo node deploy/split-env.cjs",
    );
  }
  return { caminho, ...require(caminho) };
}

function main() {
  if (process.argv.length > 2) {
    throw new Error("split-env.cjs não recebe argumentos; a allowlist vem de deploy/env-allowlist.cjs");
  }
  const allowlist = carregarAllowlist();
  const origem = process.env.AUTOMABACA_ENV_FILE || "/etc/automabaca-novo/runtime.env";
  const destino = process.env.AUTOMABACA_ENV_OUT_DIR || "/etc/automabaca-novo";
  if (!fs.existsSync(origem)) throw new Error("arquivo de ambiente ausente: " + origem);

  const ambientes = allowlist.ambientesDeProducao(parseEnv(fs.readFileSync(origem, "utf8")));
  // Valida os dois antes de gravar qualquer um: nada de web.env novo com worker.env velho.
  const arquivos = Object.entries(ambientes).map(([papel, env]) => [papel, env, Object.entries(env).map(([chave, valor]) => {
    if (/[\r\n]/.test(String(valor))) throw new Error("Ambiente multiline não suportado: " + chave);
    return chave + "=" + valor;
  }).join("\n") + "\n"]);
  const gerados = [];
  for (const [papel, env, conteudo] of arquivos) {
    const arquivo = path.join(destino, papel + ".env");
    fs.writeFileSync(arquivo, conteudo, { mode: 0o600 });
    fs.chmodSync(arquivo, 0o600);
    gerados.push({ papel, variaveis: Object.keys(env).length });
    process.stdout.write(papel + ": ambiente gerado pela allowlist; " + Object.keys(env).length + " variáveis.\n");
  }
  process.stdout.write(JSON.stringify({ allowlist: allowlist.caminho, origem, destino, gerados }) + "\n");
}

main();
