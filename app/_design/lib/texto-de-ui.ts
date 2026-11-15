/**
 * Limpeza de texto que nasceu para OUTRO canal e vai ser exibido no painel.
 *
 * Alertas de ops (`src/services/ops/*`) escrevem para o Telegram, onde emoji é
 * vocabulário legítimo — "🔴 3 jobs na dead-letter" lê bem no celular. A MESMA
 * string vira descrição de incidente na Caixa de ações, e ali o emoji quebra o
 * padrão (`docs/DESIGN.md`): a severidade já tem cor, chip e ícone
 * próprios.
 *
 * A limpeza mora na BORDA de exibição, não na origem: mudar a origem tiraria o
 * emoji do Telegram junto.
 */

/** Emoji, símbolos e variation selectors — preserva acentos e pontuação PT-BR. */
const EMOJI = /[\p{Extended_Pictographic}\u{1F3FB}-\u{1F3FF}\u{FE0F}\u{20E3}]/gu;

export function semEmoji(texto: string | null | undefined): string {
  if (!texto) return "";
  return texto
    .replace(EMOJI, "")
    // O emoji costuma vir grudado no início ("⚠️ Conflito"), deixando espaço
    // duplo ou um separador órfão quando some. A quebra de linha fica: o alerta
    // separa o próximo passo ("👉 …") numa linha própria.
    .replace(/[^\S\n]{2,}/g, " ")
    .replace(/[^\S\n]*\n[^\S\n]*/g, "\n")
    .replace(/^[\s·—-]+/, "")
    .trim();
}
