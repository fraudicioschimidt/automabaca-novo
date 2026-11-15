import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "../../scripts/lib/safe-fs.mjs";

const SCRIPT = path.resolve("scripts/publicador-automatico.sh");
const TOP = "b".repeat(40);
const LIVE = "a".repeat(12);

let dir: string;
let state: string;

/** Comando falso no PATH: o publicador fala com o GitHub, a produção e a VPS só por eles. */
function fake(name: string, body: string): void {
  const file = path.join(dir, "bin", name);
  writeFileSync(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "automabaca-publicador-test-"));
  state = path.join(dir, "state", "automabaca");
  mkdirSync(path.join(dir, "bin"));
  // Um commit novo na main, com a CI verde e código mudado, à frente do que está no ar.
  fake("gh", `case "$*" in
  *commits/main*) echo ${TOP} ;;
  *compare*commits*) echo ${TOP} ;;
  *compare*) echo src/worker.ts ;;
  "run list"*) echo "${TOP} 77 completed success" ;;
  "run view"*) echo success ;;
esac`);
  // O mesmo `curl` lê o health e, com `--config -`, entrega o aviso ao Telegram.
  fake("curl", `case "$*" in
  *--config*) cat >> "${dir}/telegram"; printf 200 ;;
  *) echo '{"ok":true,"release":"${LIVE}"}' ;;
esac`);
});

afterEach(() => {
  safeRemoveTreeSync(tmpdir(), dir);
});

/** Uma volta do cron, com o `publicar.sh` da VPS respondendo `output` e saindo com `exitCode`. */
function tick(exitCode: number, output = ""): void {
  fake("ssh", `cat > /dev/null; echo "${output}"; echo x >> "${dir}/published"; exit ${exitCode}`);
  const run = spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, "state"),
      AUTOMABACA_NOTIFICAR_ENV: path.join(dir, "notificar.env"),
    },
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
}

const attempts = () => (existsSync(path.join(dir, "published")) ? readFileSync(path.join(dir, "published"), "utf8").length / 2 : 0);
const outcome = () => (existsSync(path.join(state, "tratados", TOP)) ? readFileSync(path.join(state, "tratados", TOP), "utf8") : null);

/** O arquivo do PC com o bot de notificações; sem ele o publicador só registra no log. */
function configureTelegram(): void {
  writeFileSync(path.join(dir, "notificar.env"), "TELEGRAM_NOTIFY_BOT_TOKEN=123:fake-token\nTELEGRAM_NOTIFY_CHAT_ID=42\n", { mode: 0o600 });
}
const telegram = () => (existsSync(path.join(dir, "telegram")) ? readFileSync(path.join(dir, "telegram"), "utf8") : "");
const sent = () => telegram().split("sendMessage").length - 1;

/** Faz de conta que a última tentativa foi há `minutes` minutos. */
function age(minutes: number): void {
  const when = new Date(Date.now() - minutes * 60_000);
  utimesSync(path.join(state, "tentativas", TOP), when, when);
}

describe("publicador-automatico.sh", () => {
  it("publica o commit verde e não o repete", () => {
    tick(0);
    expect(outcome()).toContain("publicado");
    tick(0);
    expect(attempts()).toBe(1);
  });

  it("guarda que recusa é definitiva", () => {
    tick(2, "RECUSADO: há deriva");
    expect(outcome()).toContain("recusado por uma guarda");
    tick(0);
    expect(attempts()).toBe(1);
  });

  it("causa passageira espera 5 min e tenta de novo", () => {
    tick(4, "PASSAGEIRO: a produção não está saudável agora");
    expect(outcome()).toBeNull();
    tick(0);
    expect(attempts()).toBe(1);
    age(6);
    tick(0);
    expect(attempts()).toBe(2);
    expect(outcome()).toContain("publicado");
  });

  it("causa passageira que não passa vira falha depois de 8 tentativas", () => {
    for (let attempt = 1; attempt <= 7; attempt++) {
      tick(4);
      expect(outcome()).toBeNull();
      age(6);
    }
    tick(4);
    expect(outcome()).toContain("FALHOU");
    tick(0);
    expect(attempts()).toBe(8);
  });

  it("a recusa avisa o dono no Telegram uma vez, com o commit e o motivo", () => {
    configureTelegram();
    tick(2, "RECUSADO: há deriva");
    tick(0);
    expect(sent()).toBe(1);
    expect(telegram()).toContain("recusada por uma guarda");
    expect(telegram()).toContain(`commit ${TOP.slice(0, 7)}`);
    expect(telegram()).toContain("RECUSADO: há deriva");
    expect(telegram()).toContain("publicador.log");
  });

  it("a falha definitiva avisa; a publicação que deu certo e a causa passageira não", () => {
    configureTelegram();
    tick(4, "PASSAGEIRO: a produção não está saudável agora");
    expect(sent()).toBe(0);
    age(6);
    tick(1, "erro na troca");
    expect(outcome()).toContain("FALHOU");
    expect(sent()).toBe(1);
    expect(telegram()).toContain("FALHOU (saída 1)");
  });

  it("aviso que o Telegram não aceitou sai na volta seguinte; o token não vai para o log", () => {
    configureTelegram();
    fake("curl", `case "$*" in
  *--config*) cat > /dev/null; printf 502 ;;
  *) echo '{"ok":true,"release":"${LIVE}"}' ;;
esac`);
    tick(2, "RECUSADO: há deriva");
    expect(sent()).toBe(0);
    fake("curl", `case "$*" in
  *--config*) cat >> "${dir}/telegram"; printf 200 ;;
  *) echo '{"ok":true,"release":"${LIVE}"}' ;;
esac`);
    tick(0);
    tick(0);
    expect(sent()).toBe(1);
    expect(readFileSync(path.join(state, "publicador.log"), "utf8")).not.toContain("fake-token");
  });

  it("sem o arquivo de configuração a recusa fica só no log", () => {
    tick(2, "RECUSADO: há deriva");
    expect(outcome()).toContain("recusado por uma guarda");
    expect(sent()).toBe(0);
    expect(readFileSync(path.join(state, "publicador.log"), "utf8")).toContain("não avisei no Telegram");
  });
});
