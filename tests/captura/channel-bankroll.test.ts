import { afterEach, describe, expect, it, vi } from "vitest";
import { GrammyError, HttpError, type Api } from "grammy";
import { resetEnvCacheForTests } from "@/src/infra/env";
import { telegramChannelProfileLoader } from "@/src/telegram/channel/channel-bankroll";

/** Só canal que o dono administra ganha banca sozinho: assinante não basta. */
function api(statuses: Record<string, string | Error>) {
  return {
    getChat: vi.fn(async () => ({ id: -100, type: "channel", title: "Canal Sintético", photo: { big_file_id: "grande", small_file_id: "pequena" } })),
    getChatMember: vi.fn(async (_chat: string, user: number) => {
      const status = statuses[String(user)];
      if (status instanceof Error) throw status;
      if (!status) throw new GrammyError("user not found", { ok: false, error_code: 400, description: "Bad Request: user not found" }, "getChatMember", {});
      return { status, user: { id: user } };
    }),
  } as unknown as Api;
}

afterEach(() => { vi.unstubAllEnvs(); resetEnvCacheForTests(); });

describe("telegramChannelProfileLoader", () => {
  it.each([
    ["creator", true],
    ["administrator", true],
    ["member", false],
    ["left", false],
  ])("dono com status %s → administra=%s", async (status, expected) => {
    vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "111, 222");
    resetEnvCacheForTests();
    const profile = await telegramChannelProfileLoader(api({ "222": status }))(-100n);
    expect(profile).toEqual({ title: "Canal Sintético", photoFileId: "grande", operatorIsAdmin: expected });
  });

  it("sem usuário autorizado configurado ninguém administra", async () => {
    vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "");
    resetEnvCacheForTests();
    expect((await telegramChannelProfileLoader(api({}))(-100n)).operatorIsAdmin).toBe(false);
  });

  it.each([
    ["429", new GrammyError("Too Many Requests", { ok: false, error_code: 429, description: "Too Many Requests: retry after 5" }, "getChatMember", {})],
    ["500", new GrammyError("Internal", { ok: false, error_code: 500, description: "Internal Server Error" }, "getChatMember", {})],
  ])("erro %s da API sobe em vez de virar \"não administra\"", async (_code, error) => {
    vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "111");
    resetEnvCacheForTests();
    await expect(telegramChannelProfileLoader(api({ "111": error }))(-100n)).rejects.toBe(error);
  });

  it("recusa 403 sobre o membro conta como \"não administra\"", async () => {
    vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "111");
    resetEnvCacheForTests();
    const forbidden = new GrammyError("Forbidden", { ok: false, error_code: 403, description: "Forbidden: bot is not a member" }, "getChatMember", {});
    expect((await telegramChannelProfileLoader(api({ "111": forbidden }))(-100n)).operatorIsAdmin).toBe(false);
  });

  it("erro de rede sobe para o update voltar pela fila", async () => {
    vi.stubEnv("TELEGRAM_ALLOWED_CHATS", "111");
    resetEnvCacheForTests();
    const loader = telegramChannelProfileLoader(api({ "111": new HttpError("rede fora", new Error("ECONNRESET")) }));
    await expect(loader(-100n)).rejects.toBeInstanceOf(HttpError);
  });
});
