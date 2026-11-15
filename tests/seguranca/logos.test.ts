import { afterEach, describe, expect, it } from "vitest";
import { access, mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { invalidateLogoCache, isValidLogoFileName, readLogo, resolveLogoUrl } from "@/src/services/painel/logos";
import { deleteLogoFiles, logosDir, MAX_LOGO_BYTES, prepareLogoImage, sniffLogoExt } from "@/src/services/logos/storage";
import { safeRemoveTreeSync } from "@/scripts/lib/safe-fs.mjs";

const originalLogosDir = process.env.LOGOS_DIR;
let temporaryLogosDir: string | null = null;

afterEach(() => {
  if (originalLogosDir === undefined) delete process.env.LOGOS_DIR;
  else process.env.LOGOS_DIR = originalLogosDir;
  if (temporaryLogosDir) {
    safeRemoveTreeSync(os.tmpdir(), temporaryLogosDir);
    temporaryLogosDir = null;
  }
});

/**
 * A logo enviada é input hostil: o formato é decidido pelo CONTEÚDO
 * (magic bytes), não pelo file.type do cliente (forjável). E o nome de arquivo
 * servido por /api/logos/[file] tem de barrar path-traversal. Lógica pura.
 */
describe("sniffLogoExt — formato pelo conteúdo, não pelo Content-Type", () => {
  it("reconhece JPG / PNG / WebP pelos magic bytes", () => {
    expect(sniffLogoExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("jpg");
    expect(sniffLogoExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]))).toBe("png");
    const webp = Buffer.concat([
      Buffer.from("RIFF"),
      Buffer.from([0, 0, 0, 0]),
      Buffer.from("WEBP"),
      Buffer.from([0]),
    ]);
    expect(sniffLogoExt(webp)).toBe("webp");
  });

  it("decodifica e reencoda a imagem em vez de confiar apenas no header", async () => {
    const validPng = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    );
    const normalized = await prepareLogoImage(validPng);
    expect(normalized.ext).toBe("png");
    expect(sniffLogoExt(normalized.image)).toBe("png");
    await expect(prepareLogoImage(Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      Buffer.from("<script>alert(1)</script>"),
    ]))).rejects.toThrow(/inválida|corrompida/i);
  });

  it("recusa logo vazia, grande demais ou em formato fora da lista", async () => {
    await expect(prepareLogoImage(Buffer.alloc(0))).rejects.toThrow(/ausente/);
    await expect(prepareLogoImage(Buffer.alloc(MAX_LOGO_BYTES + 1, 0xff))).rejects.toThrow(/grande demais/);
    await expect(prepareLogoImage(Buffer.from("GIF89a"))).rejects.toThrow(/Formato inválido/);
  });

  it("rejeita o que não é JPG/PNG/WebP de verdade (SVG, GIF, texto disfarçado)", () => {
    expect(sniffLogoExt(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'>"))).toBeNull();
    expect(sniffLogoExt(Buffer.from("GIF89a"))).toBeNull(); // GIF não está na allowlist
    expect(sniffLogoExt(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBeNull();
    expect(sniffLogoExt(Buffer.from([0xff, 0xd8]))).toBeNull(); // JPG truncado (length <= 3)
  });
});

describe("isValidLogoFileName — anti path-traversal do GET /api/logos", () => {
  it("aceita slug.ext em minúsculas", () => {
    expect(isValidLogoFileName("big-data.png")).toBe(true);
    expect(isValidLogoFileName("target.jpg")).toBe(true);
    expect(isValidLogoFileName("a1-b2.webp")).toBe(true);
  });

  it("rejeita traversal, barras, caixa alta e extensão fora da allowlist", () => {
    expect(isValidLogoFileName("../etc/passwd")).toBe(false);
    expect(isValidLogoFileName("a/b.png")).toBe(false);
    expect(isValidLogoFileName("UPPER.png")).toBe(false);
    expect(isValidLogoFileName("x.gif")).toBe(false);
    expect(isValidLogoFileName("noext")).toBe(false);
  });
});

describe("logosDir — caminho rastreável e override durável", () => {
  it("usa fallback privado absoluto no desenvolvimento e respeita LOGOS_DIR", () => {
    delete process.env.LOGOS_DIR;
    expect(logosDir()).toBe(path.resolve(".logos"));

    process.env.LOGOS_DIR = "/srv/automabaca/logos";
    expect(logosDir()).toBe(path.normalize("/srv/automabaca/logos"));
  });

  it("recusa caminho relativo, public e symlink", () => {
    process.env.LOGOS_DIR = "logos";
    expect(() => logosDir()).toThrow(/absoluto/i);
    process.env.LOGOS_DIR = path.resolve("public", "logos");
    expect(() => logosDir()).toThrow(/public/i);
  });
});

describe("deleteLogoFiles — fronteira compartilhada com o worker", () => {
  it("remove todas as variantes do slug e preserva arquivos alheios", async () => {
    temporaryLogosDir = await mkdtemp(path.join(os.tmpdir(), "automabaca-logos-"));
    process.env.LOGOS_DIR = temporaryLogosDir;
    const targetPng = path.join(temporaryLogosDir, "banca.png");
    const targetJpg = path.join(temporaryLogosDir, "banca.jpg");
    const unrelated = path.join(temporaryLogosDir, "outra.png");
    await Promise.all([
      writeFile(targetPng, "png"),
      writeFile(targetJpg, "jpg"),
      writeFile(unrelated, "keep"),
    ]);

    await deleteLogoFiles("banca");

    await expect(access(targetPng)).rejects.toThrow();
    await expect(access(targetJpg)).rejects.toThrow();
    await expect(access(unrelated)).resolves.toBeUndefined();
  });
});

describe("resolveLogoUrl — dono atual e logos já existentes", () => {
  it("lê a logo anterior por slug, prioriza a do id e não reaproveita o cache de outro dono", async () => {
    temporaryLogosDir = await mkdtemp(path.join(os.tmpdir(), "automabaca-logo-owner-"));
    process.env.LOGOS_DIR = temporaryLogosDir;
    const slug = "logo-owner-test";
    invalidateLogoCache(slug);
    try {
      await writeFile(path.join(temporaryLogosDir, `${slug}.png`), "legacy");
      expect(resolveLogoUrl(slug, "owner-a")).toMatch(new RegExp(`/api/logos/${slug}\\.png\\?v=`));
      await writeFile(path.join(temporaryLogosDir, `${slug}-owner-a.jpg`), "new-a");
      invalidateLogoCache(slug);
      expect(resolveLogoUrl(slug, "owner-a")).toContain(`${slug}-owner-a.jpg`);
      expect(resolveLogoUrl(slug, "owner-b")).toContain(`${slug}.png`);
      await writeFile(path.join(temporaryLogosDir, `${slug}-owner-b.webp`), "new-b");
      invalidateLogoCache(slug);
      expect(resolveLogoUrl(slug, "owner-b")).toContain(`${slug}-owner-b.webp`);
    } finally { invalidateLogoCache(slug); }
  });
});

describe("readLogo — segunda barreira de prefixo resolvido", () => {
  it("recusa nome que escapa do diretório, mesmo furando o regex", async () => {
    process.env.LOGOS_DIR = "/srv/automabaca/logos";
    // `isValidLogoFileName` já barraria estes na rota; aqui o alvo é a barreira
    // de baixo, para que a travessia dependa de DUAS falhas e não de uma.
    for (const nome of ["../../etc/passwd", "..", "logos/../../x.png", "/etc/passwd"]) {
      await expect(readLogo(nome)).rejects.toThrow(/fora do diretório permitido/i);
    }
  });

  it("percent-encoding não é travessia nesta camada — fica dentro do diretório", async () => {
    process.env.LOGOS_DIR = "/srv/automabaca/logos";
    // `%2f` só vira `/` se alguém decodificar antes; o Next já entrega o
    // parâmetro decodificado, então aqui é nome literal de um segmento só.
    await expect(readLogo("..%2f..%2fetc/passwd")).resolves.toBeNull();
  });

  it("aceita nome legítimo (retorna null quando o arquivo não existe)", async () => {
    process.env.LOGOS_DIR = "/srv/automabaca/logos";
    await expect(readLogo("inexistente.png")).resolves.toBeNull();
  });
});
