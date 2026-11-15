import { cpSync, existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { safeRemoveTreeSync } from "./lib/safe-fs.mjs";

const projectRoot = path.resolve(".");
const root = path.resolve(".next", "standalone");

if (!existsSync(root)) {
  throw new Error(`Standalone ausente: ${root}`);
}

// O Next copia esses arquivos explicitamente para output: "standalone",
// fora das regras de outputFileTracingExcludes. Nenhum .env entra no runtime.
for (const fileName of [".env", ".env.production"]) {
  rmSync(path.join(root, fileName), { force: true });
}

function replaceDirectory(source, destination) {
  if (!existsSync(source)) {
    throw new Error(`Diretorio de build ausente: ${source}`);
  }
  safeRemoveTreeSync(projectRoot, destination);
  cpSync(source, destination, { recursive: true });
}

// Copiar para um destino já existente com `cp -r origem destino` cria
// public/public ou static/static. Substituir o diretório mantém as URLs exatas.
replaceDirectory(path.resolve(".next", "static"), path.join(root, ".next", "static"));
replaceDirectory(path.resolve("public"), path.join(root, "public"));

// O tracing do Next 16.2 pode omitir runtimes app-route usados por chunks
// Turbopack. Copiar somente esse diretório interno mantém o standalone
// autocontido sem depender do node_modules do checkout para servir APIs.
replaceDirectory(
  path.resolve("node_modules", "next", "dist", "compiled", "next-server"),
  path.join(root, "node_modules", "next", "dist", "compiled", "next-server"),
);

// O NFT copia o binding do Sharp, mas pode omitir o libvips opcional porque a
// descoberta do pacote nativo acontece dinamicamente em runtime. Sem o .so o
// build parece verde e toda página que importa logos responde 500.
const sharpPackage = JSON.parse(readFileSync("node_modules/sharp/package.json", "utf8"));
// npm ci seleciona os opcionais da plataforma atual (incluindo musl/arm64).
// Copiar os pacotes instalados mantém o mesmo runtime no artefato.
for (const packageName of Object.keys(sharpPackage.optionalDependencies ?? {})) {
  if (!packageName.startsWith("@img/")) continue;
  const source = path.resolve("node_modules", packageName);
  if (existsSync(source)) {
    replaceDirectory(source, path.join(root, "node_modules", packageName));
  }
}

process.stdout.write("OK ambiente removido e assets preparados no standalone.\n");
