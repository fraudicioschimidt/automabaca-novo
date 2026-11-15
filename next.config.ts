import type { NextConfig } from "next";

// Headers estáticos de defesa em profundidade. A CSP usa nonce por requisição
// e é aplicada no proxy, antes da renderização do App Router.
const SECURITY_HEADERS = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
];

/**
 * Origens aceitas pelo servidor de DESENVOLVIMENTO.
 *
 * Medido em 11/08/2026: o dev do Next aceita `localhost` e RECUSA `127.0.0.1` e
 * o IP da máquina. A recusa não aparece como erro de página — ela derruba só o
 * upgrade do WebSocket de HMR, e sem HMR o runtime do Turbopack nunca carrega
 * os chunks dos componentes cliente. O resultado é o pior sintoma possível: a
 * página renderiza inteira, bonita, e NÃO HIDRATA. Nenhum clique funciona,
 * nenhum atalho, nenhum modal — e o console só mostra "WebSocket failed".
 *
 * Custou a auditoria de UI inteira: toda verificação teve de rodar em build
 * standalone (~2 min por iteração) porque o dev parecia quebrado sem motivo.
 *
 * `127.0.0.1` é o laço local — mesma máquina, mesma confiança que `localhost`,
 * e é o que os nossos scripts de verificação usam. `AB_DEV_ORIGINS` deixa somar
 * o IP/host de onde o dono abre o painel sem editar código. Só vale em dev: o
 * standalone de produção não lê esta lista.
 */
const DEV_ORIGINS = [
  "127.0.0.1",
  ...(process.env.AB_DEV_ORIGINS ?? "")
    .split(",")
    .map((origem) => origem.trim())
    .filter(Boolean),
];

const nextConfig: NextConfig = {
  output: "standalone",
  // O AGENTS.md é a fonte única das regras dos agentes, escrita à mão. Sem
  // isto, o `next dev` rodado por um agente (Claude Code, Codex) acrescenta
  // nele o bloco de regras do Next e suja a árvore.
  agentRules: false,
  // Ponte Rust (rust/crates/ponte): no servidor, binário N-API carregado pelo
  // require do Node em runtime, nunca empacotado pelo Turbopack; no navegador,
  // a condição `browser` do pacote entrega o WebAssembly. O `prepare-standalone`
  // copia o lado do servidor para o node_modules do standalone.
  serverExternalPackages: ["@automabaca/dominio"],
  allowedDevOrigins: DEV_ORIGINS,
  // O CI executa `tsc --noEmit` como gate independente antes de produzir o
  // artefato. Somente seus builds redundantes podem pular a segunda passagem;
  // build local/deploy sem essa declaração continuam fail-closed.
  typescript: {
    ignoreBuildErrors:
      process.env.CI_SKIP_DUPLICATE_TYPECHECK === "1"
      && (process.env.CI === "true" || process.env.AB_DEPLOY === "1"),
  },
  // Não deixe o Turbopack inferir uma raiz acima do checkout quando houver
  // lockfiles vizinhos (worktrees e sandboxes visuais usam cópias isoladas).
  turbopack: { root: process.cwd() },
  experimental: {
    // Logos aceitam 2 MiB; a folga cobre o envelope multipart da Server Action.
    // Campos textuais continuam limitados nos serviços de domínio.
    serverActions: { bodySizeLimit: "3mb" },
  },
  // O tracing do standalone (NFT) já arrastou a raiz inteira do repo pro bundle
  // por causa de um caminho dinâmico — .git (histórico!), docs e tests. O
  // fallback de logos agora é relativo e estático; os excludes seguem como
  // defesa em profundidade e mantêm o artefato enxuto.
  // O standalone não contém .env: deploy/split-env.cjs entrega a cada container
  // só a sua allowlist, o que também evita expandir os `$` do hash scrypt.
  outputFileTracingExcludes: {
    "/*": [
      "./.git/**",
      "./.github/**",
      "./.saved-credentials/**",
      "./.eslintcache",
      "./.env",
      "./.env.*",
      "./**/.env",
      "./**/.env.*",
      "./BLUEPRINT.md",
      "./CLAUDE.md",
      "./README.md",
      "./docs/**",
      "./artifacts/**",
      "./reports/**",
      "./coverage/**",
      "./test-results/**",
      "./playwright-report/**",
      "./scratch/**",
      "./.claude/**",
      "./tests/**",
      "./scripts/**",
      "./infra/**",
      "./dist/**",
      "./**/*.test.ts",
      "./**/*.db.test.ts",
      // Cache de build: nunca traçar p/ dentro do standalone.
      "./**/.next/cache/**",
    ],
  },
  poweredByHeader: false,
  reactStrictMode: true,
  async headers() {
    return [{ source: "/:path*", headers: SECURITY_HEADERS }];
  },
  // Favoritos antigos: a tela de Entradas saiu (as apostas pendentes ficam em
  // Tipsters) e a antiga Bancas virou Tipsters.
  async redirects() {
    return [
      { source: "/entradas", destination: "/tipsters", permanent: true },
      { source: "/bankrolls", destination: "/tipsters", permanent: true },
      { source: "/bankrolls/:path*", destination: "/tipsters/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
