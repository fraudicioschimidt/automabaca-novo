import { beforeEach, describe, expect, it, vi } from "vitest";

type Listener = (error?: Error) => void;

const state = vi.hoisted(() => ({
  clients: [] as Array<{
    emit: (event: "error" | "end", error?: Error) => void;
  }>,
}));

vi.mock("pg", () => ({
  Client: class FakeClient {
    private readonly listeners = new Map<string, Listener[]>();

    constructor() {
      state.clients.push(this);
    }

    async connect() {}

    async query() {
      return { rows: [{ locked: true }] };
    }

    on(event: string, listener: Listener) {
      this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
      return this;
    }

    emit(event: "error" | "end", error?: Error) {
      for (const listener of this.listeners.get(event) ?? []) listener(error);
    }

    async end() {
      this.emit("end");
    }
  },
}));

import { acquireWorkerSingletonLock } from "@/src/infra/worker-singleton";

beforeEach(() => {
  state.clients.length = 0;
});

describe("worker singleton connection lifecycle", () => {
  it("reporta uma única vez quando o PostgreSQL encerra a sessão", async () => {
    const onLost = vi.fn();
    const release = await acquireWorkerSingletonLock({ attempts: 1, onLost });
    const client = state.clients[0]!;

    client.emit("end");
    client.emit("error", new Error("erro posterior"));

    expect(onLost).toHaveBeenCalledOnce();
    expect(onLost).toHaveBeenCalledWith(expect.objectContaining({
      message: "conexão do lock singleton encerrada pelo PostgreSQL",
    }));
    await release();
  });

  it("não trata o encerramento intencional como perda do lock", async () => {
    const onLost = vi.fn();
    const release = await acquireWorkerSingletonLock({ attempts: 1, onLost });
    await release();
    await release();
    expect(onLost).not.toHaveBeenCalled();
  });
});
