import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderCadenceDeferredError, ProviderRequestError } from "@/src/domain/provider-error";
import { fetchJsonWithRetry, parseRetryAfterMs } from "@/src/providers/core/http";

const fetchMock = vi.fn<typeof fetch>();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Retry-After: aceita segundos OU HTTP-date, tetado em 15s. */
describe("parseRetryAfterMs", () => {
  it("segundos numéricos (tetado em 15s); nulo/inválido → null", () => {
    expect(parseRetryAfterMs("5")).toBe(5000);
    expect(parseRetryAfterMs("0")).toBe(0);
    expect(parseRetryAfterMs("9999")).toBe(15_000);
    expect(parseRetryAfterMs(null)).toBeNull();
    expect(parseRetryAfterMs("abc")).toBeNull();
  });

  it("forma HTTP-date: futuro → ms até lá (tetado); passado → 0", () => {
    const ms = parseRetryAfterMs(new Date(Date.now() + 5000).toUTCString());
    expect(ms).not.toBeNull();
    expect(ms!).toBeGreaterThan(2500);
    expect(ms!).toBeLessThanOrEqual(15_000);
    expect(parseRetryAfterMs(new Date(Date.now() - 5000).toUTCString())).toBe(0);
  });
});

describe("fetchJsonWithRetry", () => {
  const base = {
    url: "https://provider.invalid/events",
    label: "provider-test",
    maxRetries: 2,
    baseBackoffMs: 0,
  };

  it.each([401, 403, 429, 503, 200])("cancela corpo descartado em HTTP %i", async (status) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    fetchMock.mockResolvedValue(new Response(body, {
      status,
      headers: {
        "content-type": "application/json",
        ...(status === 200 ? { "content-length": String(25 * 1024 * 1024 + 1) } : {}),
      },
    }));
    const result = await fetchJsonWithRetry({ ...base, maxRetries: 0 });
    expect(result).toMatchObject({ ok: false, status });
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("libera a resposta rejeitada antes de iniciar o próximo fetch", async () => {
    const cancel = vi.fn();
    fetchMock
      .mockResolvedValueOnce(new Response(new ReadableStream({ cancel }), {
        status: 503, headers: { "content-type": "application/json" },
      }))
      .mockImplementationOnce(async () => {
        expect(cancel).toHaveBeenCalledOnce();
        return Response.json({ ok: true });
      });
    await expect(fetchJsonWithRetry(base)).resolves.toMatchObject({ ok: true, data: { ok: true } });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recupera de 500 antes de devolver o JSON", async () => {
    fetchMock
      .mockResolvedValueOnce(Response.json({ error: "down" }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ events: [1] }));

    await expect(fetchJsonWithRetry<{ events: number[] }>(base)).resolves.toEqual({
      ok: true,
      status: 200,
      data: { events: [1] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("encerra em erro JSON não-retriável ou no último 5xx", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ moved: true }, { status: 302 }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 302,
      error: "HTTP 302",
    });

    fetchMock.mockReset().mockResolvedValue(Response.json({ error: "down" }, { status: 503 }));
    await expect(fetchJsonWithRetry({ ...base, maxRetries: 0 })).resolves.toEqual({
      ok: false,
      status: 503,
      error: "HTTP 503",
    });
  });

  it("trata 429 como terminal para não consumir várias chamadas numa reserva", async () => {
    fetchMock.mockResolvedValue(new Response("quota", {
      status: 429,
      headers: { "retry-after": "0" },
    }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 429,
      error: "HTTP 429",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("renova a credencial uma vez sem consumir retry transitório", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    const onUnauthorized = vi.fn().mockResolvedValue({ authorization: "Bearer renewed" });

    const result = await fetchJsonWithRetry({ ...base, maxRetries: 0, onUnauthorized });
    expect(result.ok).toBe(true);
    expect(onUnauthorized).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[1]?.[1]?.headers).get("authorization")).toBe("Bearer renewed");
  });

  it("adiamento durante reautenticação propaga sem virar erro de rede ou novo retry", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const deferred = new ProviderCadenceDeferredError("bridgeodds", new Date(Date.now() + 60_000));
    await expect(fetchJsonWithRetry({ ...base, onUnauthorized: async () => { throw deferred; } }))
      .rejects.toBe(deferred);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("falha de renovação termina em 401 e não entra em loop", async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const onUnauthorized = vi.fn().mockResolvedValue(null);
    await expect(fetchJsonWithRetry({ ...base, onUnauthorized })).resolves.toEqual({
      ok: false,
      status: 401,
      error: "re-autenticação falhou",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it("não retenta 4xx definitivo", async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 404,
      error: "HTTP 404",
    });
    expect(fetchMock).toHaveBeenCalledOnce();

  });

  it("retenta corpo 2xx inválido e se recupera sem perder a contabilização", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("{", {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(Response.json({ events: [1] }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: true,
      status: 200,
      data: { events: [1] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("preserva status 2xx ao esgotar retries de JSON para marcar a chamada como cobrada", async () => {
    fetchMock.mockResolvedValue(new Response("{", {
      status: 200,
      headers: { "content-type": "application/json" },
    }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 200,
      error: "JSON inválido na resposta",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("recusa HTML 2xx sem retry e distingue bloqueio anti-bot", async () => {
    fetchMock.mockResolvedValue(new Response("<html>Just a moment...</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));

    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 200,
      error: "bloqueio anti-bot (text/html)",
      blocked: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recusa HTML 5xx sem retry nem leitura ilimitada", async () => {
    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn().mockResolvedValueOnce({
      done: false,
      value: new TextEncoder().encode(`<html>Cloudflare${"x".repeat(8_000)}</html>`),
    });
    fetchMock.mockResolvedValue({
      ok: false,
      status: 502,
      headers: new Headers({ "content-type": "text/html" }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    } as unknown as Response);

    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 502,
      error: "bloqueio anti-bot (text/html)",
      blocked: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("retenta gateway 5xx não-JSON quando não há sinal anti-bot", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("gateway temporarily unavailable", {
        status: 503,
        headers: { "content-type": "text/html" },
      }))
      .mockResolvedValueOnce(Response.json({ events: [1] }));

    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: true,
      status: 200,
      data: { events: [1] },
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recusa 2xx sem content-type mesmo quando a amostra não pode ser lida", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: { getReader: () => ({ read: vi.fn().mockRejectedValue(new Error("body indisponível")), cancel: vi.fn(), releaseLock: vi.fn() }) },
    } as unknown as Response);

    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 200,
      error: "resposta não-JSON (sem content-type)",
      blocked: true,
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("recusa resposta sem JSON quando não há stream ou chegam chunks vazios", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      headers: new Headers(),
      body: null,
    } as unknown as Response);
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 200,
      error: "resposta não-JSON (sem content-type)",
      blocked: true,
    });

    const cancel = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: undefined })
      .mockResolvedValueOnce({ done: true, value: undefined });
    fetchMock.mockReset().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/plain" }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    } as unknown as Response);
    await expect(fetchJsonWithRetry(base)).resolves.toMatchObject({ ok: false, blocked: true });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("normaliza rejeição não-Error durante leitura JSON antes do retry", async () => {
    fetchMock
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        body: { getReader: () => ({ read: vi.fn().mockRejectedValue("stream falhou"), releaseLock: vi.fn() }) },
      } as unknown as Response)
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: true,
      status: 200,
      data: { ok: true },
    });
  });

  it("recusa content-length acima do teto sem consumir o corpo nem retentar", async () => {
    fetchMock.mockResolvedValue(new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json",
        "content-length": String(25 * 1024 * 1024 + 1),
      },
    }));

    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 200,
      error: "corpo da resposta acima de 25MB",
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("interrompe stream que ultrapassa o teto, inclusive após chunk vazio", async () => {
    const cancel = vi.fn().mockRejectedValue(new Error("cancel já fechado"));
    const read = vi.fn()
      .mockResolvedValueOnce({ done: false, value: undefined })
      .mockResolvedValueOnce({
        done: false,
        value: new Uint8Array(25 * 1024 * 1024 + 1),
      });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: { getReader: () => ({ read, cancel, releaseLock: vi.fn() }) },
    } as unknown as Response);

    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      status: 200,
      error: "corpo da resposta acima de 25MB",
    });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("usa res.json quando a resposta não expõe stream", async () => {
    const json = vi.fn().mockResolvedValue({ events: [7] });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      json,
    } as unknown as Response);

    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: true,
      status: 200,
      data: { events: [7] },
    });
    expect(json).toHaveBeenCalledOnce();
  });

  it("sem stream, lê por arrayBuffer ou text e mantém o teto de tamanho", async () => {
    const semStream = (extra: Record<string, unknown>) => ({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "application/json" }),
      body: null,
      ...extra,
    } as unknown as Response);
    const encoded = new TextEncoder().encode(JSON.stringify({ events: [8] }));
    fetchMock.mockResolvedValueOnce(semStream({ arrayBuffer: async () => encoded.buffer }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({ ok: true, status: 200, data: { events: [8] } });

    fetchMock.mockResolvedValueOnce(semStream({ text: async () => JSON.stringify({ events: [9] }) }));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({ ok: true, status: 200, data: { events: [9] } });

    const acimaDoTeto = 25 * 1024 * 1024 + 1;
    fetchMock.mockResolvedValueOnce(semStream({ arrayBuffer: async () => new ArrayBuffer(acimaDoTeto) }));
    await expect(fetchJsonWithRetry(base)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/acima de 25MB/) });

    fetchMock.mockResolvedValueOnce(semStream({ text: async () => "x".repeat(acimaDoTeto) }));
    await expect(fetchJsonWithRetry(base)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/acima de 25MB/) });

    fetchMock.mockResolvedValueOnce(semStream({}));
    await expect(fetchJsonWithRetry(base)).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/acima de 25MB/) });
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("esgota retries de rede e preserva o erro diagnóstico", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"));
    await expect(fetchJsonWithRetry(base)).resolves.toEqual({
      ok: false,
      error: "fetch failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("abort já recebido não reserva cota nem inicia HTTP", async () => {
    const signal = AbortSignal.abort(new Error("prazo encerrado"));
    const beforeAttempt = vi.fn();
    await expect(fetchJsonWithRetry({ ...base, signal, beforeAttempt })).resolves.toMatchObject({ ok: false });
    expect(beforeAttempt).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("abort durante o gate não inicia HTTP com sinal morto", async () => {
    const controller = new AbortController();
    fetchMock.mockRejectedValue(new Error("aborted"));
    await expect(fetchJsonWithRetry({ ...base, signal: controller.signal,
      beforeAttempt: async () => { controller.abort(); },
    })).resolves.toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("abort durante backoff termina imediatamente sem cobrar outra tentativa", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      const beforeAttempt = vi.fn();
      fetchMock.mockImplementation(async () => Response.json({}, { status: 503 }));
      const pending = fetchJsonWithRetry({ ...base, signal: controller.signal, beforeAttempt, baseBackoffMs: 10_000 });
      let finished = false;
      const completion = pending.then(() => { finished = true; });
      await vi.advanceTimersByTimeAsync(0);
      controller.abort();
      await vi.advanceTimersByTimeAsync(0);
      expect(finished).toBe(true);
      await expect(pending).resolves.toMatchObject({ ok: false });
      await completion;
      expect(beforeAttempt).toHaveBeenCalledOnce();
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });

  it.each([
    new Headers({ "x-api-key": "synthetic", authorization: "Bearer old" }),
    [["x-api-key", "synthetic"], ["authorization", "Bearer old"]] as [string, string][],
  ])("renovação conserva headers RequestInit (%j)", async (headers) => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    await fetchJsonWithRetry({ ...base, init: { headers },
      onUnauthorized: async () => ({ authorization: "Bearer new" }),
    });
    const retried = new Headers(fetchMock.mock.calls[1]?.[1]?.headers);
    expect(retried.get("x-api-key")).toBe("synthetic");
    expect(retried.get("authorization")).toBe("Bearer new");
  });

  it("abort externo encerra sem retry", async () => {
    const controller = new AbortController();
    fetchMock.mockImplementation(async (_url: string | URL | Request, init?: RequestInit) => {
      const signal = init?.signal;
      await new Promise<never>((_, reject) => {
        const fail = () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        if (signal?.aborted) return fail();
        signal?.addEventListener("abort", fail, { once: true });
      });
      return Response.json({ ok: true });
    });
    const pending = fetchJsonWithRetry({ ...base, signal: controller.signal, maxRetries: 3 });
    // Deixa a primeira tentativa iniciar; o cancelamento anterior ao fetch é outro caso.
    await Promise.resolve();
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: "aborted" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("recusa de cota antes do retry propaga o erro sem novo fetch", async () => {
    fetchMock.mockResolvedValue(Response.json({ error: "down" }, { status: 503 }));
    const quota = new Error("sem cota");
    const beforeAttempt = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(quota);
    await expect(fetchJsonWithRetry({ ...base, beforeAttempt })).rejects.toBe(quota);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const firstQuota = new Error("sem cota na primeira");
    await expect(fetchJsonWithRetry({ ...base, beforeAttempt: async () => { throw firstQuota; } }))
      .rejects.toBe(firstQuota);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("aplica defaults e normaliza rejeições que não são Error", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ ok: true }));
    await expect(fetchJsonWithRetry({
      url: base.url,
      label: base.label,
    })).resolves.toEqual({ ok: true, status: 200, data: { ok: true } });

    fetchMock.mockReset().mockRejectedValue("socket encerrado");
    await expect(fetchJsonWithRetry({ ...base, maxRetries: 1 })).resolves.toEqual({
      ok: false,
      error: "socket encerrado",
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("ProviderRequestError", () => {
  it("marca como cobrada apenas falha em resposta 2xx", () => {
    expect(new ProviderRequestError("x", { status: 200, error: "JSON" }).billed).toBe(true);
    expect(new ProviderRequestError("x", { status: 429, error: "quota" }).billed).toBe(false);
    expect(new ProviderRequestError("x", { error: "timeout" }).billed).toBe(false);
    expect(new ProviderRequestError("x", { status: 200, error: "WAF", blocked: true }).blocked).toBe(true);
  });
});
