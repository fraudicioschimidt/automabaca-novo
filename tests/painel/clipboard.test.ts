import { afterEach, describe, expect, it, vi } from "vitest";
import { copyText } from "@/app/_design/lib/clipboard";

describe("copyText", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("só resolve depois da confirmação do Clipboard API", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await expect(copyText("resumo")).resolves.toBeUndefined();
    expect(writeText).toHaveBeenCalledWith("resumo");
  });

  it("propaga a recusa quando não existe fallback disponível", async () => {
    const denied = new Error("permission denied");
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn().mockRejectedValue(denied) } });
    await expect(copyText("resumo")).rejects.toBe(denied);
  });
});
