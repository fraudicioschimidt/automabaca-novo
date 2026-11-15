import { beforeEach, describe, expect, it, vi } from "vitest";

// O Google responde assim quando o projeto da chave é barrado.
const fetchMock = vi.fn(async () => new Response(JSON.stringify({
  error: { code: 403, message: "Your project has been denied access. Please contact support.", status: "PERMISSION_DENIED" },
}), { status: 403, headers: { "content-type": "application/json" } }));
vi.stubGlobal("fetch", fetchMock);

const { runAttempt, RouteStopped } = await import("@/scripts/lib/bench-call");
const { KeyRotation, ProviderLane } = await import("@/scripts/lib/bench-schedule");

const loaded = {
  item: { id: "post.txt", arquivos: ["post.txt"], legenda: "", leitor: "texto" as const, resposta: "aposta" as const,
    apostas: [], faltando: [], politica: "AUTO" as const, conferido: false },
  hash: "h1",
  text: "Flamengo x Palmeiras over 2.5 gols @1.90 1u",
  images: [],
};

function attempt(model: string, keys: InstanceType<typeof KeyRotation>) {
  return runAttempt({
    loaded, route: { provider: "gemini", model, endpoint: "generate", vision: true }, rep: 1, key: `k-${model}`,
    lane: new ProviderLane({ concurrency: 1, providerGapMs: 0, modelGapMs: 0 }), timeoutMs: 5000, keys,
  });
}

async function stopOf(promise: Promise<unknown>) {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error).toBeInstanceOf(RouteStopped);
  return error as InstanceType<typeof RouteStopped>;
}

beforeEach(() => fetchMock.mockClear());

describe("runAttempt no Gemini, com as chaves recusadas", () => {
  it("o projeto barrado nas duas chaves para o provedor, e o modelo seguinte para sem chamar de novo", async () => {
    const keys = new KeyRotation([{ hint: "aaaa1111", value: "chave-a" }, { hint: "bbbb2222", value: "chave-b" }]);

    const first = await stopOf(attempt("gemini-2.5-flash", keys));
    expect({ scope: first.scope, status: first.status }).toEqual({ scope: "provider", status: "credencial" });
    expect(first.keyTrail).toEqual([{ key: "aaaa1111", outcome: "credencial" }, { key: "bbbb2222", outcome: "credencial" }]);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const second = await stopOf(attempt("gemini-2.5-flash-lite", keys));
    expect({ scope: second.scope, status: second.status }).toEqual({ scope: "provider", status: "credencial" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sem nenhuma chave no .env, para o provedor na hora", async () => {
    const stop = await stopOf(attempt("gemini-2.5-flash", new KeyRotation([])));
    expect({ scope: stop.scope, status: stop.status }).toEqual({ scope: "provider", status: "credencial" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
