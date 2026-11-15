import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

it("sanitiza mensagem final interpolada, overloads, child e causas antes do stdout", () => {
  const output = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", `
    import { logger } from './src/infra/logger.ts';
    const secret = 'SYNTHETIC_ONLY_123456';
    logger.info('token=' + secret);
    logger.info({ token: secret }, 'apiKey=%s', secret);
    logger.warn('Authorization: Bearer %s', secret);
    logger.error(new Error('password=' + secret));
    logger.child({ mod: 'child' }).error({ err: new Error('token=' + secret, {
      cause: new Error('postgresql://user:' + secret + '@host/db')
    }) }, 'cookie=%s', secret);
    logger.info({ msg: 'secret=' + secret });
    logger.info('operação %s: %d itens', 'concluída', 3);
    logger.info('payload=%j', { accessToken: secret, password: 'with spaces ' + secret });
    logger.info('payload=%o', { api_key: secret, cookie: 'quoted "' + secret + '" value' });
    logger.info('access_token=%s', secret);
    logger.flush();
  `], { encoding: "utf8", env: { ...process.env, NODE_ENV: "production", LOG_LEVEL: "info" } });
  expect(output).not.toContain("SYNTHETIC_ONLY");
  const rows = output.trim().split("\n").map((row) => JSON.parse(row));
  expect(rows).toHaveLength(10);
  expect(rows[1].msg).toBe("apiKey=[redacted]");
  expect(rows[4].err.cause.message).toBe("postgresql://[redacted]");
  expect(rows[6].msg).toBe("operação concluída: 3 itens");
});

describe("logger operacional", () => {
  it("inclui release e redige identificadores pessoais", () => {
    const source = `
      import { logger } from "./src/infra/logger.ts";
      logger.info({
        ip: "127.0.0.1",
        username: "fabricio",
        chatId: "123456",
        actor: "fabricio",
        password: "senha-secreta",
        token: "token-secreto",
        secret: "segredo",
        apiKey: "chave-api",
        authorization: "Bearer secreto",
        cookie: "session=secreta",
        usernameHash: "safe-hash",
      }, "teste");
      const databaseError = Object.assign(new Error("conexão encerrada"), {
        code: "57P01",
        client: { secretKey: 123456, password: "não-vazar" },
        request: { headers: { authorization: "Bearer não-vazar" } },
      });
      logger.error({ err: databaseError }, "falha de banco");
      logger.flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          AUTOMABACA_PROCESS: "test",
          AUTOMABACA_RELEASE_SHA: "abcdef1234567890",
          AUTOMABACA_RELEASE_ID: "release-test",
        },
      },
    );
    const rows = output.trim().split("\n").map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    const row = rows[0];

    expect(row).toMatchObject({
      service: "automabaca",
      process: "test",
      releaseSha: "abcdef1234567890",
      releaseId: "release-test",
      ip: "[redacted]",
      username: "[redacted]",
      chatId: "[redacted]",
      actor: "[redacted]",
      password: "[redacted]",
      token: "[redacted]",
      secret: "[redacted]",
      apiKey: "[redacted]",
      authorization: "[redacted]",
      cookie: "[redacted]",
      usernameHash: "safe-hash",
    });
    expect(rows[1]).toMatchObject({
      err: {
        type: "Error",
        message: "conexão encerrada",
        code: "57P01",
      },
    });
    expect(JSON.stringify(rows[1])).not.toContain("secretKey");
    expect(JSON.stringify(rows[1])).not.toContain("não-vazar");
    expect(JSON.stringify(rows[1])).not.toContain("client");
  });

  it("não deixa campo de um log vazar para os seguintes nem para o contexto", () => {
    const source = `
      import { createLogger } from "./src/infra/logger.ts";
      import {
        getObservabilityContext,
        runWithObservabilityContext,
      } from "./src/infra/observability-context.ts";
      const alerts = createLogger("alerts");
      const worker = createLogger("worker");
      await runWithObservabilityContext(
        { correlationId: "job_x", source: "queue:health.heartbeat" },
        async () => {
          alerts.info({ cleared: 1, providers: ["p1", "p2"] }, "com campos");
          worker.info("sem campos");
          alerts.error({ err: new Error("falha isolada") }, "erro");
          worker.info("depois do erro");
          worker.info({ contexto: getObservabilityContext() }, "contexto final");
        },
      );
      logger.flush?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    `.replace("logger.flush?.();", "");
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          AUTOMABACA_PROCESS: "test",
          AUTOMABACA_RELEASE_SHA: "abcdef1234567890",
          AUTOMABACA_RELEASE_ID: "release-test",
        },
      },
    );
    const rows = output.trim().split("\n").map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );

    for (const row of rows) {
      expect(row["correlationId"]).toBe("job_x");
      expect(row["source"]).toBe("queue:health.heartbeat");
    }
    expect(rows[0]).toMatchObject({ cleared: 1, providers: ["p1", "p2"] });
    expect(rows[1]).not.toHaveProperty("cleared");
    expect(rows[1]).not.toHaveProperty("providers");
    expect(rows[3]).not.toHaveProperty("err");
    expect(rows[4]?.["contexto"]).toEqual({
      correlationId: "job_x",
      source: "queue:health.heartbeat",
    });
  });

  it("serializa metadados do Prisma, issues do Zod e digest sem vazar segredos", () => {
    const source = `
      import { logger } from "./src/infra/logger.ts";
      const prismaError = Object.assign(new Error("Unique constraint failed"), {
        name: "PrismaClientKnownRequestError",
        code: "P2002",
        clientVersion: "7.10.0",
        meta: { modelName: "Bet", target: ["source", "sourceExternalId"], secretToken: "token-secreto" },
      });
      const zodError = Object.assign(new Error("Validation error"), {
        name: "ZodError",
        issues: [{ path: ["odds"], message: "Expected positive number", code: "custom" }],
      });
      const nextError = Object.assign(new Error("Next error"), {
        digest: "123456789",
        statusCode: 400,
        statusText: "Bad Request",
      });
      logger.error({ err: prismaError }, "prisma");
      logger.error({ err: zodError }, "zod");
      logger.error({ err: nextError }, "next");
      logger.flush();
      await new Promise((resolve) => setTimeout(resolve, 20));
    `;
    const output = execFileSync(
      process.execPath,
      ["--import", "tsx", "--input-type=module", "--eval", source],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "production",
          LOG_LEVEL: "info",
          AUTOMABACA_PROCESS: "test",
          AUTOMABACA_RELEASE_SHA: "abcdef1234567890",
          AUTOMABACA_RELEASE_ID: "release-test",
        },
      },
    );
    const rows = output.trim().split("\n").map(
      (line) => JSON.parse(line) as Record<string, unknown>,
    );
    expect(rows[0]?.["err"]).toMatchObject({
      type: "PrismaClientKnownRequestError",
      code: "P2002",
      clientVersion: "7.10.0",
      meta: {
        modelName: "Bet",
        target: ["source", "sourceExternalId"],
        secretToken: "[redacted]",
      },
    });
    expect(rows[1]?.["err"]).toMatchObject({
      type: "ZodError",
      issues: [{ path: ["odds"], message: "Expected positive number", code: "custom" }],
    });
    expect(rows[2]?.["err"]).toMatchObject({
      type: "Error",
      digest: "123456789",
      status: 400,
      statusText: "Bad Request",
    });
  });
});