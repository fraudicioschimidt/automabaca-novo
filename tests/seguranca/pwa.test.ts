import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { describe, expect, it } from "vitest";
import manifest from "@/app/manifest";

const ORIGIN = "https://painel.example";

type Listener = (event: Record<string, unknown>) => void;

const basicResponse = (body: string) => {
  const response = new Response(body);
  Object.defineProperty(response, "type", { value: "basic" });
  return response;
};

/**
 * Roda o `public/sw.js` de verdade num contexto isolado, com `caches` e `fetch`
 * de mentira no lugar dos do navegador, e devolve o que ficou guardado.
 */
async function loadServiceWorker(existingCaches: string[] = []) {
  const source = await readFile(new URL("../../public/sw.js", import.meta.url), "utf8");
  const stores = new Map<string, Map<string, Response>>(existingCaches.map((name) => [name, new Map()]));
  const store = (name: string) => {
    const current = stores.get(name) ?? new Map<string, Response>();
    stores.set(name, current);
    return current;
  };
  const caches = {
    open: async (name: string) => ({
      addAll: async (urls: string[]) => { for (const url of urls) store(name).set(new URL(url, ORIGIN).href, basicResponse("ícone")); },
      put: async (request: { url: string }, response: Response) => { store(name).set(request.url, response); },
    }),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (request: { url: string }) => {
      for (const current of stores.values()) {
        const hit = current.get(request.url);
        if (hit) return hit;
      }
      return undefined;
    },
  };
  let network: "online" | "offline" = "online";
  const fetched: string[] = [];
  const fetchStub = async (request: { url: string }) => {
    fetched.push(request.url);
    if (network === "offline") throw new TypeError("Failed to fetch");
    return basicResponse(`rede:${request.url}`);
  };
  const listeners = new Map<string, Listener>();
  const self = {
    addEventListener: (type: string, listener: Listener) => listeners.set(type, listener),
    location: { origin: ORIGIN },
    skipWaiting: async () => {},
    clients: { claim: async () => {} },
  };
  vm.runInNewContext(source, { self, caches, fetch: fetchStub, URL, Response, Promise });

  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const lifecycle = async (type: "install" | "activate") => {
    const pending: Promise<unknown>[] = [];
    listeners.get(type)?.({ waitUntil: (promise: Promise<unknown>) => pending.push(promise) });
    await Promise.all(pending);
  };
  const request = async (path: string, init: { method?: string; mode?: string } = {}) => {
    const pending: Promise<unknown>[] = [];
    let responded: Promise<Response> | undefined;
    listeners.get("fetch")?.({
      request: { method: "GET", mode: "cors", url: new URL(path, ORIGIN).href, ...init },
      respondWith: (response: Promise<Response>) => { responded = response; },
      waitUntil: (promise: Promise<unknown>) => pending.push(promise),
    });
    const response = responded ? await responded : undefined;
    await Promise.all(pending);
    await settle();
    return { intercepted: responded !== undefined, body: response ? await response.clone().text() : undefined };
  };
  const cachedUrls = () => [...stores.values()].flatMap((current) => [...current.keys()].map((url) => new URL(url).pathname)).sort();

  await lifecycle("install");
  await lifecycle("activate");
  return {
    request, cachedUrls, fetched,
    cacheNames: () => [...stores.keys()],
    goOffline: () => { network = "offline"; },
  };
}

const ICONS = ["/pwa-icon-192.png", "/pwa-icon-512.png", "/pwa-icon-maskable-512.png"];

describe("PWA conservadora", () => {
  it("publica identidade, ícones instaláveis e navegação standalone", () => {
    const value = manifest();
    expect(value.name).toBe("AutomaBACA");
    expect(value.display).toBe("standalone");
    expect(value.start_url).toBe("/");
    expect(value.icons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ src: "/pwa-icon-192.png", sizes: "192x192" }),
        expect.objectContaining({ purpose: "maskable" }),
      ]),
    );
  });

  it("nunca armazena APIs, documentos ou páginas autenticadas", async () => {
    const worker = await loadServiceWorker();
    for (const path of ["/api/bets", "/api/health", "/banca/principal", "/config"]) {
      expect(await worker.request(path)).toEqual({ intercepted: false, body: undefined });
    }
    expect(await worker.request("/", { mode: "navigate" })).toEqual({ intercepted: false, body: undefined });
    expect(await worker.request("/fonts/inter.woff2", { method: "POST" })).toEqual({ intercepted: false, body: undefined });
    expect(worker.cachedUrls()).toEqual([...ICONS].sort());
  });

  it("não guarda os chunks do Next: cada release nova não acumula no aparelho", async () => {
    const worker = await loadServiceWorker();
    for (const release of ["a1b2", "c3d4", "e5f6"]) {
      // O Next já serve /_next/static com cache imutável de um ano; o navegador cuida dele.
      expect((await worker.request(`/_next/static/chunks/${release}.js`)).intercepted).toBe(false);
    }
    expect(worker.cachedUrls()).toEqual([...ICONS].sort());
  });

  it("a versão nova apaga o que as anteriores guardaram, sem mexer no cache de outro dono", async () => {
    const worker = await loadServiceWorker(["automabaca-static-v1", "automabaca-static-v2", "outro-cache"]);
    const names = worker.cacheNames();
    expect(names).not.toContain("automabaca-static-v1");
    expect(names).not.toContain("automabaca-static-v2");
    expect(names).toContain("outro-cache");
    expect(names.filter((name) => name.startsWith("automabaca-static-"))).toHaveLength(1);
  });

  it("fontes e ícones vêm da rede, e o cache só responde quando ela falha", async () => {
    const worker = await loadServiceWorker();
    const url = `${ORIGIN}/fonts/inter.woff2`;
    expect(await worker.request("/fonts/inter.woff2")).toEqual({ intercepted: true, body: `rede:${url}` });
    expect(worker.cachedUrls()).toContain("/fonts/inter.woff2");
    worker.goOffline();
    expect(await worker.request("/fonts/inter.woff2")).toEqual({ intercepted: true, body: `rede:${url}` });
    expect(worker.fetched.filter((fetched) => fetched === url)).toHaveLength(2);
  });
});
