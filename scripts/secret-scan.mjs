import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const explicitIndex = process.argv.indexOf("--files");
const files = explicitIndex >= 0
  ? [...new Set(process.argv.slice(explicitIndex + 1).filter(Boolean))]
  : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
const forbiddenPaths = files.filter((file) =>
  /(^|\/)\.env(?!\.example$)(?:\.|$)|\.saved-credentials|google_token\.json|\.pem$|\.key$/i.test(file),
);
const secretPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b\d{8,}:[A-Za-z0-9_-]{30,}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /\bgh[opusr]_[A-Za-z0-9]{30,}\b/,
  // Groq, chave privada do age e RapidAPI. A da Mistral não tem formato próprio.
  /\bgsk_[A-Za-z0-9]{40,}\b/,
  /\bAGE-SECRET-KEY-1[0-9A-Z]{50,}\b/,
  /\b[0-9a-z]{10}msh[0-9a-z]{15}p1[0-9a-z]{6}jsn[0-9a-z]{12}\b/,
  // URL de banco com senha de 12 caracteres ou mais (as de exemplo são curtas).
  // Ficam de fora a máquina local (exemplos, CI) e os hosts que não existem,
  // usados nos testes (`host`, TLDs reservados).
  /\bpostgres(?:ql)?:\/\/[A-Za-z0-9_.-]+:[A-Za-z0-9_.~%!*+=-]{12,}@(?!localhost\b|127\.|host\b|[A-Za-z0-9.-]*\.(?:invalid|internal|example|test)\b)[A-Za-z0-9.-]+/,
];
const leaks = [];
for (const file of files) {
  if (/\.(?:png|jpe?g|webp|woff2?|ico|lock)$/i.test(file)) continue;
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  for (const pattern of secretPatterns) {
    if (pattern.test(text)) leaks.push(`${file}: ${pattern}`);
  }
}
if (forbiddenPaths.length || leaks.length) {
  throw new Error(
    [
      ...forbiddenPaths.map((file) => `arquivo sensível versionado: ${file}`),
      ...leaks.map((leak) => `segredo provável: ${leak}`),
    ].join("\n"),
  );
}
const scope = explicitIndex >= 0 ? "alterados" : "versionados";
process.stdout.write(`OK secret scan (${files.length} arquivos ${scope}).\n`);
