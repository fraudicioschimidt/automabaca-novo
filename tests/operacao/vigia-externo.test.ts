import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { safeRemoveTreeSync } from "../../scripts/lib/safe-fs.mjs";

const SCRIPT = path.resolve("scripts/vigia-externo.sh");
const HEALTHY = '{"ok":true,"db":true,"worker":true,"heartbeat":"fresh","release":"aaaaaaaaaaaa"}';

let dir: string;
let state: string;

/**
 * `curl` falso: o vigia só fala com a produção, o destino neutro e o Telegram
 * por ele. `health` é "<saída do curl> <HTTP> <corpo>"; `network` e
 * `telegram`, se cada um responde.
 */
function world(health: string, options: { network?: boolean; telegram?: boolean } = {}): void {
  const [exit, http, ...body] = health.split(" ");
  writeFileSync(path.join(dir, "bin", "curl"), `#!/usr/bin/env bash
out=/dev/null
args=("$@")
for ((i = 0; i < $#; i++)); do [[ "\${args[i]}" == --output ]] && out="\${args[i+1]}"; done
case "$*" in
  *--config*) ${options.telegram === false ? "cat > /dev/null; printf 502" : `cat >> "${dir}/telegram"; printf 200`} ;;
  *neutral.test*) exit ${options.network === false ? 6 : 0} ;;
  *health.test*) printf '%s' '${body.join(" ")}' > "$out"; printf '%s' '${http}'; exit ${exit} ;;
esac
`);
  chmodSync(path.join(dir, "bin", "curl"), 0o755);
}

function tick(): void {
  const run = spawnSync("bash", [SCRIPT], {
    env: {
      ...process.env, PATH: `${path.join(dir, "bin")}:${process.env.PATH}`, XDG_STATE_HOME: path.join(dir, "state"),
      VIGIA_HEALTH_URL: "https://health.test/api/health", VIGIA_NEUTRAL_URL: "https://neutral.test/",
      AUTOMABACA_NOTIFICAR_ENV: path.join(dir, "notificar.env"),
    },
    encoding: "utf8",
  });
  expect(run.status).toBe(0);
}

function ticks(count: number): void {
  for (let n = 0; n < count; n++) tick();
}

const telegram = () => (existsSync(path.join(dir, "telegram")) ? readFileSync(path.join(dir, "telegram"), "utf8") : "");
const sent = () => telegram().split("sendMessage").length - 1;
const log = () => readFileSync(path.join(state, "vigia-externo.log"), "utf8");

/** Reescreve um instante do estado para `minutes` minutos atrás. */
function rewind(field: string, minutes: number): void {
  const file = path.join(state, "vigia-externo.estado");
  const past = Math.floor(Date.now() / 1000) - minutes * 60;
  writeFileSync(file, readFileSync(file, "utf8").replace(new RegExp(`^${field}=\\d+$`, "m"), `${field}=${past}`));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "automabaca-vigia-test-"));
  state = path.join(dir, "state", "automabaca");
  mkdirSync(path.join(dir, "bin"));
  writeFileSync(path.join(dir, "notificar.env"), "TELEGRAM_NOTIFY_BOT_TOKEN=123:fake-token\nTELEGRAM_NOTIFY_CHAT_ID=42\n", { mode: 0o600 });
});

afterEach(() => {
  safeRemoveTreeSync(tmpdir(), dir);
});

describe("vigia-externo.sh", () => {
  it("produção saudável não avisa e registra uma linha só", () => {
    world(`0 200 ${HEALTHY}`);
    ticks(3);
    expect(sent()).toBe(0);
    expect(log().trim().split("\n")).toHaveLength(1);
  });

  it("avisa na terceira falha seguida, uma vez, dizendo o que falhou", () => {
    world("28 000 ");
    ticks(2);
    expect(sent()).toBe(0);
    ticks(3);
    expect(sent()).toBe(1);
    expect(telegram()).toContain("fora do ar");
    expect(telegram()).toContain("sem resposta em 10 s");
  });

  it.each([
    ["0 502 Bad Gateway", "HTTP 502"],
    ['0 503 {"ok":false,"db":true,"worker":false,"heartbeat":"stale"}', "HTTP 503, worker fora (heartbeat stale)"],
    ['0 200 {"ok":false,"db":false,"worker":false,"heartbeat":"unavailable"}', "ok falso (banco fora)"],
    ['0 200 {"ok":true,"db":true,"worker":false,"heartbeat":"fresh"}', "worker falso"],
    ['0 200 {"ok":true,"db":true,"worker":true,"heartbeat":"stale"}', "heartbeat do worker stale"],
    ["0 200 <html>manutenção</html>", "resposta que não é JSON"],
    ["0 200 ", "resposta que não é o health"],
    ["0 200    ", "resposta que não é o health"],
    [`0 200 ${HEALTHY} ${HEALTHY}`, "resposta que não é o health"],
    ['0 200 {"ok":true,"db":false,"worker":true,"heartbeat":"fresh"}', "banco falso"],
    ['0 200 {"ok":true,"worker":true,"heartbeat":"fresh"}', "banco falso"],
  ])("conta como falha: %s", (health, reason) => {
    world(health);
    ticks(3);
    expect(sent()).toBe(1);
    expect(telegram()).toContain(reason);
  });

  it("uma falha isolada entre respostas boas não avisa", () => {
    world("28 000 ");
    ticks(2);
    world(`0 200 ${HEALTHY}`);
    tick();
    world("28 000 ");
    ticks(2);
    expect(sent()).toBe(0);
  });

  it("repete o aviso só depois de 30 min e avisa a recuperação uma vez, com a duração", () => {
    world("0 502 x");
    ticks(10);
    expect(sent()).toBe(1);
    rewind("avisado_em", 31);
    rewind("desde", 95);
    ticks(2);
    expect(sent()).toBe(2);
    expect(telegram()).toContain("continua fora do ar há 1 h 35 min");
    world(`0 200 ${HEALTHY}`);
    ticks(3);
    expect(sent()).toBe(3);
    expect(telegram()).toContain("voltou");
    expect(telegram()).toContain("Ficou fora por 1 h 35 min");
  });

  it("PC sem rede não conta como falha da produção", () => {
    world("6 000 ", { network: false });
    ticks(5);
    expect(sent()).toBe(0);
    expect(log()).toContain("PC sem rede");
  });

  it("falhas de antes de o PC ficar desligado não se somam às de depois", () => {
    world("28 000 ");
    ticks(2);
    rewind("ultima_volta", 60);
    ticks(2);
    expect(sent()).toBe(0);
    tick();
    expect(sent()).toBe(1);
  });

  it("aviso que o Telegram não aceitou é tentado de novo, e a recuperação também", () => {
    world("28 000 ", { telegram: false });
    ticks(4);
    expect(sent()).toBe(0);
    world("28 000 ");
    tick();
    expect(sent()).toBe(1);
    world(`0 200 ${HEALTHY}`, { telegram: false });
    tick();
    world(`0 200 ${HEALTHY}`);
    ticks(2);
    expect(sent()).toBe(2);
  });

  it("sem o arquivo de configuração registra no log e segue; o token nunca vai para o log", () => {
    world("28 000 ");
    ticks(3);
    expect(log()).not.toContain("fake-token");
    safeRemoveTreeSync(tmpdir(), path.join(dir, "telegram"));
    writeFileSync(path.join(dir, "notificar.env"), "");
    world(`0 200 ${HEALTHY}`);
    tick();
    expect(sent()).toBe(0);
    expect(log()).toContain("não avisei");
    expect(log()).toContain("produção voltou");
  });

  it("recusa o arquivo de configuração legível por outros usuários", () => {
    chmodSync(path.join(dir, "notificar.env"), 0o644);
    world("28 000 ");
    ticks(3);
    expect(sent()).toBe(0);
    expect(log()).toContain("não avisei");
  });
});
