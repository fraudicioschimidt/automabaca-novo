/* eslint-disable @typescript-eslint/no-require-imports -- carregador CommonJS do binário N-API */
// Um alvo só: linux-x64-gnu, o das imagens (node:24 bookworm) e do WSL. O
// require tem o nome literal para o tracing do Next e do esbuild acharem o arquivo.
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error(`@automabaca/dominio-node só existe para linux-x64-gnu (aqui: ${process.platform}-${process.arch})`);
}
try {
  module.exports = require("./dominio-node.linux-x64-gnu.node");
} catch (error) {
  if (error?.code !== "MODULE_NOT_FOUND") throw error;
  throw new Error("Binário da ponte Rust ausente em rust/crates/dominio-node: rode `npm run build:dominio-node`.", { cause: error });
}
