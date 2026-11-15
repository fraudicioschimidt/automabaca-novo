#!/usr/bin/env node
import { randomBytes, scryptSync } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_PATH = path.join(ROOT, ".env");
const RUNTIME_DIR = path.join(ROOT, ".runtime");
const TEMP_ENV_PATH = path.join(ROOT, `.env.tmp.${process.pid}`);

function safeLocalLogin(value, label) {
  if (!/^[a-zA-Z0-9._-]{3,64}$/.test(value)) {
    throw new Error(`${label} deve ter entre 3 e 64 caracteres seguros.`);
  }
  return value;
}

if (existsSync(ENV_PATH)) {
  process.stdout.write("✓ .env local já existe; conteúdo preservado.\n");
  process.exit(0);
}

const username = safeLocalLogin(process.env.AB_DEV_USERNAME ?? "fabricio", "AB_DEV_USERNAME");
const password = safeLocalLogin(
  process.env.AB_DEV_PASSWORD ?? "automabaca-local",
  "AB_DEV_PASSWORD",
);
const salt = randomBytes(16).toString("hex");
const passwordHash = scryptSync(password, salt, 32).toString("hex");

mkdirSync(path.join(RUNTIME_DIR, "logos"), { recursive: true, mode: 0o700 });

const lines = [
  "# Gerado por npm run dev:setup. Exclusivo desta máquina; nunca versionar.",
  'DATABASE_URL="postgresql://automabaca:automabaca@127.0.0.1:5432/automabaca"',
  'TEST_DATABASE_URL="postgresql://automabaca:automabaca@127.0.0.1:5433/automabaca_test"',
  "PORT=3100",
  "PUBLIC_APP_URL=http://127.0.0.1:3100",
  "LOG_LEVEL=debug",
  `LOG_HASH_SECRET=${randomBytes(32).toString("hex")}`,
  "DB_POOL_MAX=10",
  `AUTH_USERS=${username}:scrypt\\$${salt}\\$${passwordHash}:admin`,
  `AUTH_SESSION_SECRET=${randomBytes(32).toString("hex")}`,
  "FLASHSCORE_MODE=off",
  "PINNACLE17_MODE=off",
  "SHARP_AUTO_MATCH_MIN_SCORE=1.5",
  "SHARP_JUDGE_MIN_CONFIDENCE=0.75",
  `LOGOS_DIR=${path.join(RUNTIME_DIR, "logos")}`,
  "",
];

try {
  writeFileSync(TEMP_ENV_PATH, lines.join("\n"), {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(TEMP_ENV_PATH, ENV_PATH);
  chmodSync(ENV_PATH, 0o600);
} catch (error) {
  rmSync(TEMP_ENV_PATH, { force: true });
  throw error;
}

process.stdout.write(
  `✓ .env local criado. Login de desenvolvimento: ${username} / ${password}\n`,
);
