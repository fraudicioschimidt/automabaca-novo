import { describe, expect, it } from "vitest";
import { isStaleServerActionError } from "@/src/infra/next-request-errors";

describe("classificação de erros de request do Next", () => {
  it("separa cliente antigo ou action inválida de falha interna", () => {
    expect(isStaleServerActionError(new Error(
      "Failed to find Server Action. This request might be from an older or newer deployment.",
    ))).toBe(true);
    expect(isStaleServerActionError(new Error(
      'Error: The Server Reference ID did not match the expected format. Received "ae2257db6a92deb55774810ff607d88ef67dbbb5".',
    ))).toBe(true);
    expect(isStaleServerActionError(new Error(
      'Read more: https://nextjs.org/docs/messages/failed-to-find-server-action',
    ))).toBe(true);
    expect(isStaleServerActionError(new Error("database unavailable"))).toBe(false);
  });
});
