import type { CapturePolicy, SharpMode, StakePolicy } from "./types";
import { SHARP_MODES } from "../../lib/sharp-mode";

export const SHARP_OPTS: readonly (readonly [SharpMode, string])[] = SHARP_MODES.map((m) => [m.key, m.label] as const);
export const CAPTURE_OPTS: readonly (readonly [CapturePolicy, string])[] = [
  ['AUTO', 'Automático (pela legenda)'],
  ['CAPTION_ODD', 'Odd da legenda (@) manda'],
  ['IMAGE_ODD', 'Odd do print manda'],
];
export const CAPTURE_HINT: Record<CapturePolicy, string> = {
  AUTO: 'Legenda no formato "1u @1.85" vale como odd cravada; sem isso, vale o print/parser.',
  CAPTION_ODD: 'Exige a odd no "@" da legenda — sem ela a captura é recusada em vez de adivinhar.',
  IMAGE_ODD: 'A odd sai do print; número na legenda é referência mínima, não a odd cravada.',
};
export const STAKE_OPTS: readonly (readonly [StakePolicy, string])[] = [
  ['MESSAGE', 'Usar a stake da mensagem'],
  ['WHEN_MISSING', 'Usar padrão quando faltar na mensagem'],
  ['ALWAYS', 'Usar stake fixa em todas as entradas'],
];

/** O `value` de um `<select>` de volta ao tipo da opção (undefined se não for uma delas). */
export function opcao<V extends string>(opts: readonly (readonly [V, string])[], value: string): V | undefined {
  return opts.find(([v]) => v === value)?.[0];
}

