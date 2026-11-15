import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ send: vi.fn(), getEnv: vi.fn(), activity: vi.fn(), executeRaw: vi.fn(), logWarn: vi.fn() }));
vi.mock("@/src/infra/env", () => ({ getEnv: mocks.getEnv }));
vi.mock("@/src/infra/boss", () => ({ getSharedBoss: async () => ({ send: mocks.send }) }));
vi.mock("@/src/infra/prisma", () => ({ prisma: { $executeRaw: mocks.executeRaw } }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => ({ warn: mocks.logWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }) }));
// A contagem real (sobre um banco falso): o que se prova é que a resposta não espera por ela.
vi.mock(import("@/src/services/capture/channel/channel-activity"), async (importOriginal) => {
  const real = await importOriginal();
  mocks.activity.mockImplementation(real.recordChannelActivityInBackground);
  return { ...real, recordChannelActivityInBackground: mocks.activity };
});

const { POST } = await import("@/app/api/telegram/webhook/route");
const { uuidFromKey } = await import("@/src/domain/telegram-job");

function request(body: string, secret = "s".repeat(32), headers: HeadersInit = {}) {
  return new NextRequest("http://localhost/api/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
      ...headers,
    },
    body,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEnv.mockReturnValue({ TELEGRAM_WEBHOOK_SECRET: "s".repeat(32) });
  mocks.send.mockResolvedValue("job-1");
  mocks.executeRaw.mockResolvedValue(1);
});

describe("POST /api/telegram/webhook", () => {
  it("rejeita segredo incorreto antes de tocar a fila", async () => {
    const response = await POST(request('{"update_id":1}', "wrong"));
    expect(response.status).toBe(401);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("valida o update e enfileira direto na fila ordenada, com id por update_id e sem throttle", async () => {
    const response = await POST(request('{"update_id":981,"message":{"message_id":5,"date":1,"chat":{"id":77,"type":"private"},"text":"tip"}}'));
    expect(response.status).toBe(200);
    expect(mocks.send).toHaveBeenCalledWith(
      "telegram.updates",
      expect.objectContaining({ kind: "telegram_update", update: expect.objectContaining({ update_id: 981, message: expect.objectContaining({ text: "tip" }) }) }),
      expect.objectContaining({ id: uuidFromKey("telegram-update:981"), singletonKey: "tg:dm:77:5" }),
    );
    expect(mocks.send.mock.calls[0]?.[2]).not.toHaveProperty("singletonSeconds");
  });

  it("tipo de update que o código ainda não conhece segue para a fila inteiro", async () => {
    const response = await POST(request('{"update_id":983,"tipo_futuro":{"id":"x"}}'));
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({ update: { update_id: 983, tipo_futuro: { id: "x" } } });
    expect(mocks.send.mock.calls[0]?.[2]).toMatchObject({ singletonKey: "tg:update:983" });
  });

  it("confirma JSON inválido/update sem payload para interromper retry; limita corpo grande", async () => {
    const malformed = await POST(request("{"));
    expect(malformed.status).toBe(200);
    await expect(malformed.json()).resolves.toEqual({ ok: true, ignored: true });
    const unknown = await POST(request('{"update_id":1}'));
    expect(unknown.status).toBe(200);
    await expect(unknown.json()).resolves.toEqual({ ok: true, ignored: true });
    expect(mocks.send).not.toHaveBeenCalled();
    expect((await POST(request('{"update_id":1,"message":{}}', undefined, { "content-length": String(256 * 1024 + 1) }))).status).toBe(413);
  });

  it("rejeita corpo real acima do limite mesmo sem Content-Length confiável", async () => {
    const response = await POST(request(
      JSON.stringify({ update_id: 1, padding: "x".repeat(1024 * 1024) }),
      undefined,
      { "content-length": "1" },
    ));
    expect(response.status).toBe(413);
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("aceita reentrega deduplicada já persistida", async () => {
    mocks.send.mockResolvedValue(null);
    const response = await POST(request('{"update_id":981,"message":{}}'));
    await expect(response.json()).resolves.toEqual({ ok: true, duplicate: true });
    expect(mocks.activity).not.toHaveBeenCalled();
  });

  it("conta a atividade do canal depois de enfileirar, sem segurar a resposta", async () => {
    const update = { update_id: 983, channel_post: { message_id: 7, chat: { id: -1001, type: "channel" } } };
    const response = await POST(request(JSON.stringify(update)));
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.activity).toHaveBeenCalledWith(expect.objectContaining(update));
    expect(mocks.send.mock.invocationCallOrder[0]).toBeLessThan(mocks.activity.mock.invocationCallOrder[0] ?? 0);
    expect(mocks.executeRaw).toHaveBeenCalledTimes(1);
  });

  it("banco lento ou fora na contagem não segura nem derruba a resposta", async () => {
    const update = JSON.stringify({ update_id: 984, channel_post: { message_id: 8, chat: { id: -1001, type: "channel" } } });
    mocks.executeRaw.mockReturnValueOnce(new Promise(() => {}));
    await expect((await POST(request(update))).json()).resolves.toEqual({ ok: true });

    mocks.executeRaw.mockRejectedValueOnce(new Error("banco fora"));
    await expect((await POST(request(update))).json()).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(mocks.logWarn).toHaveBeenCalledWith(expect.objectContaining({ err: expect.any(Error) }), expect.stringContaining("não gravada")));
  });

  it.each(["stopped_message_generation", "subscription"])("preserva o novo update %s na fila", async (kind) => {
    const payload = { id: "telegram-fixture" };
    const response = await POST(request(JSON.stringify({ update_id: 982, [kind]: payload })));
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(mocks.send.mock.calls[0]?.[1]).toMatchObject({ update: { update_id: 982, [kind]: payload } });
  });
});
