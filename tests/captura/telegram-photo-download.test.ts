import { describe, expect, it, vi } from "vitest";
import {
  MAX_TELEGRAM_IMAGE_BYTES,
  telegramImageResponseToBase64,
} from "@/src/telegram/photo-download";

describe("download de imagem Telegram", () => {
  it.each([
    { status: 503, headers: { "content-type": "image/png" } },
    { status: 200, headers: { "content-type": "text/html" } },
    { status: 200, headers: { "content-type": "image/png", "content-length": String(MAX_TELEGRAM_IMAGE_BYTES + 1) } },
  ] as ResponseInit[])("cancela corpo recusado antes da leitura (%j)", async (init) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    await expect(telegramImageResponseToBase64(new Response(body, init))).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("libera o reader após estouro do teto incremental", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(MAX_TELEGRAM_IMAGE_BYTES + 1)); }, cancel,
    });
    await expect(telegramImageResponseToBase64(new Response(body, { headers: { "content-type": "image/png" } })))
      .rejects.toThrow(/limite/i);
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });

  it("aceita imagem válida e preserva o mime", async () => {
    const res = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "image/png", "content-length": "3" },
    });
    await expect(telegramImageResponseToBase64(res)).resolves.toEqual({
      base64: "AQID",
      mimeType: "image/png",
    });
  });

  it("identifica JPEG quando o Telegram envia content-type genérico", async () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    const res = new Response(jpeg, {
      headers: { "content-type": "application/octet-stream" },
    });
    await expect(telegramImageResponseToBase64(res)).resolves.toEqual({
      base64: Buffer.from(jpeg).toString("base64"),
      mimeType: "image/jpeg",
    });
  });

  it("rejeita conteúdo desconhecido mesmo com content-type genérico", async () => {
    const res = new Response(new Uint8Array([1, 2, 3]), {
      headers: { "content-type": "application/octet-stream" },
    });
    await expect(telegramImageResponseToBase64(res)).rejects.toThrow(/não reconhecido/i);
  });

  it("rejeita tamanho declarado acima do limite antes de carregar o corpo", async () => {
    const res = new Response(new Uint8Array([1]), {
      headers: {
        "content-type": "image/jpeg",
        "content-length": String(MAX_TELEGRAM_IMAGE_BYTES + 1),
      },
    });
    await expect(telegramImageResponseToBase64(res)).rejects.toThrow(/limite/i);
  });
});
