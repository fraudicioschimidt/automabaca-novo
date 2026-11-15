import { beforeEach, describe, expect, it, vi } from "vitest";

const actor = vi.fn();
const searchPanel = vi.fn();

vi.mock("@/app/(painel)/_auth", () => ({ actor }));
vi.mock("@/src/services/painel/search", () => ({ searchPanel }));

const actions = await import("@/app/(painel)/command-actions");

beforeEach(() => {
  vi.clearAllMocks();
  actor.mockResolvedValue("fabricio");
  searchPanel.mockResolvedValue([]);
});

describe("ações da paleta de comandos", () => {
  it("autentica antes de recusar uma busca curta", async () => {
    await expect(actions.searchPanelAction("a")).resolves.toEqual([]);
    expect(actor).toHaveBeenCalledOnce();
    expect(searchPanel).not.toHaveBeenCalled();
  });

  it("executa busca válida somente após autenticação", async () => {
    searchPanel.mockResolvedValue([{ id: "b:1", kind: "Banca", title: "Treino", detail: "Abrir", href: "/tipsters/treino" }]);
    await expect(actions.searchPanelAction(" treino ")).resolves.toHaveLength(1);
    expect(actor).toHaveBeenCalledOnce();
    expect(searchPanel).toHaveBeenCalledWith("treino");
  });

});
