import { beforeEach, describe, expect, it, vi } from "vitest";

const readLogo = vi.fn();
const sniffLogoExt = vi.fn();
vi.mock("@/src/services/painel/logos", () => ({
  isValidLogoFileName: (name: string) => /^[a-z0-9-]+\.(png|jpe?g|webp)$/.test(name),
  LOGO_CONTENT_TYPES: { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" },
  readLogo,
}));
vi.mock("@/src/services/logos/storage", () => ({ sniffLogoExt }));

const { GET } = await import("@/app/api/logos/[file]/route");

beforeEach(() => {
  readLogo.mockReset();
  sniffLogoExt.mockReset();
});

describe("GET /api/logos/[file]", () => {
  const call = (file: string) => GET(new Request(`http://localhost/api/logos/${file}`), {
    params: Promise.resolve({ file }),
  });

  it("bloqueia traversal e extensões desconhecidas", async () => {
    for (const file of ["../secret.png", "logo.svg", "UPPER.png"]) {
      expect((await call(file)).status).toBe(400);
    }
    expect(readLogo).not.toHaveBeenCalled();
  });

  it("retorna 404 para arquivo válido ausente", async () => {
    readLogo.mockResolvedValue(null);
    expect((await call("canal.png")).status).toBe(404);
  });

  it("serve bytes com tipo explícito e cache privado revalidável", async () => {
    readLogo.mockResolvedValue(Buffer.from([1, 2, 3]));
    sniffLogoExt.mockReturnValue("webp");
    const response = await call("canal.webp");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toContain("must-revalidate");
    expect(response.headers.get("cache-control")).not.toContain("immutable");
    expect(response.headers.get("cache-control")).toContain("private");
    expect(response.headers.get("cache-control")).not.toContain("public");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("recusa conteúdo inválido ou diferente da extensão", async () => {
    readLogo.mockResolvedValue(Buffer.from([1, 2, 3]));
    sniffLogoExt.mockReturnValueOnce(null);
    expect((await call("canal.webp")).status).toBe(415);
    sniffLogoExt.mockReturnValueOnce("png");
    expect((await call("canal.webp")).status).toBe(415);
  });
});
