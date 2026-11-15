/**
 * As três faixas de largura das telas, decididas por media query no CSS (nunca
 * medindo a janela em JS: o servidor não sabe a largura, e a tela "pularia" ao
 * hidratar).
 *
 * - compacto: abaixo de 1024px. Header com gaveta em vez da sidebar.
 * - médio: 1024–1079px. Sidebar, mas grades de 4 colunas caem para 2.
 * - largo: 1080px ou mais.
 *
 * Os valores aparecem literais nos `@media` (CSS não aceita variável ali):
 * `max-width: 1023px` / `1079px`. Mudar uma faixa é mudar todas as folhas.
 */
export const APP_COMPACT_BREAKPOINT = 1024;
export const APP_WIDE_BREAKPOINT = 1080;
