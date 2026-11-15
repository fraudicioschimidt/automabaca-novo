import type { SharpMode } from "@/src/generated/prisma/enums";

/**
 * Os modos de medição do tipster (`Bankroll.sharpMode`), na ordem dos
 * seletores, com o nome curto que o selo e os menus mostram. Fonte única dos
 * rótulos: o servidor (adapters) e o cliente (selo, Config, cabeçalho) leem
 * daqui.
 *
 * OFF é "Sem medição" porque o enrich não roda para ele: a aposta não casa com
 * o jogo da Pinnacle e não tem CLV. "Desligado" se confundiria com a pausa do
 * canal, que para a captura.
 */
export const SHARP_MODES: ReadonlyArray<{ key: SharpMode; label: string; desc: string }> = [
  { key: "CLV_ONLY", label: "CLV", desc: "Casa o jogo e mede o CLV no fechamento" },
  { key: "IDENTITY_ONLY", label: "Identidade", desc: "Casa o jogo, sem cotação de fechamento" },
  { key: "OFF", label: "Sem medição", desc: "Não casa o jogo nem mede CLV" },
];

const LABEL = new Map<string, string>(SHARP_MODES.map((m) => [m.key, m.label]));

export function sharpModeLabel(mode: string): string {
  return LABEL.get(mode) ?? mode;
}
