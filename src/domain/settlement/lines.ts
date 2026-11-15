import type { BetStatus } from "@/src/domain/bet-status";
import { normalizeStr } from "@/src/domain/text";

/**
 * Linhas de handicap/total em QUARTOS INTEIROS (linha × 4): decisão de
 * VOID/meio-ganho vira aritmética exata — zero epsilon de float decidindo
 * dinheiro.
 */

/** -0.25 → -1; 2.5 → 10; null quando não é múltiplo de 0.25. */
export function lineToQuarters(line: number): number | null {
  if (!Number.isFinite(line)) return null;
  const quarters = line * 4;
  const rounded = Math.round(quarters);
  if (Math.abs(quarters - rounded) > 1e-6) return null;
  return rounded;
}

/**
 * Grafia de split line: dois números COLADOS por vírgula/barra ("2.0,2.5",
 * "-0.5, -1.0"). É o único caso em que a média define a linha — dois números
 * soltos no texto são coisas diferentes (número do jogo, minuto, período).
 */
function hasSplitLinePair(text: string): boolean {
  return /\d\s*[,/]\s*[+-]?\d/.test(normalizeLineText(text));
}

function normalizeLineText(text: string): string {
  return normalizeStr(text)
    .replace(/[−–—]/g, "-")
    // Sinal SEPARADO do número por espaço ("Flamengo - 0.5", grafia comum de
    // OCR e de tipster). O extrator exige o sinal colado; sem isto a linha sai
    // POSITIVA e o handicap inverte o dinheiro. Cola aqui, uma vez, para
    // `extractSignedNumbers`, o guard de sinais opostos e os splits.
    .replace(/([+-])\s+(?=\d)/g, "$1")
    // Split Bet365 colado ("2.0,2.5") é DOIS números, não um decimal: sem este
    // espaço o `2.5` some e "Over 2.0,2.5" com 2 gols daria VOID em vez de
    // HALF_LOST. Mesma normalização de `canonicalizeAsianHandicapSelecao`, para
    // quem chega ao settlement sem passar pela canonicalização.
    .replace(/(\d\.\d+),(?=[+-]?\d)/g, "$1, ");
}

/**
 * Separador que NÃO é grafia conhecida de split line. Dois números ligados por
 * ";", "|", "&" ou " e " não têm procedência: podem ser duas pernas asiáticas,
 * uma perna e uma odd, ou um combo ("Over 2.5 e 1 escanteio"). Tirar média
 * inventa uma linha; escolher uma perna decide dinheiro em silêncio. Falha
 * fechado até existir grafia real da captura.
 */
export const UNKNOWN_LINE_SEPARATOR = /\d\s*(?:[;|&]|\se\s)\s*[+-]?\d/;

function uniqueLooseLineCandidate(text: string): number | null {
  const normalized = normalizeLineText(text);
  if (UNKNOWN_LINE_SEPARATOR.test(normalized)) return null;
  // Quando a captura inclui a odd, a linha continua inequívoca se estiver
  // imediatamente ligada à direção do total: "Over 2.5 @ 1.90". Exige uma
  // única ocorrência direcional para não escolher entre dois mercados.
  const directed = [...normalized.matchAll(
    /\b(?:over|under|mais|menos|acima|abaixo)\b(?:\s+(?:de|que))?\s*([+-]?\d+(?:[.,]\d+)?)/g,
  )];
  if (directed.length === 1) {
    const raw = directed[0]?.[1] ?? "";
    const value = Number(raw.replace(",", "."));
    if (Number.isFinite(value)) {
      if (/[.,]/.test(raw)) return value;
      // Com mais de um número, uma linha inteira só é inequívoca quando o
      // outro numeral está rotulado como metadado (rodada/jogo/período).
      // "Over 2 15ª R." → 2; "Over 2 5" continua ambíguo e falha fechado.
      const metadata =
        /\b(?:rodada|round|jornada|matchday|jogo|game|tempo|half|periodo|period|mapa|map|set)\b/.test(normalized) ||
        /(?:^|\s)\d+\s*[ªºa.]?\s*[rj]\.?(?:\s|$)/.test(normalized);
      if (metadata) return value;
    }
  }

  // Sinal explícito é a evidência mais forte em handicap. Evita que número do
  // clube/período concorra com a linha: "Schalke 04 -1.5" e
  // "AH França -1.0 jogo 3" continuam -1.5/-1.0.
  // O parêntese é fronteira como o espaço. Este ramo só é alcançado com DOIS
  // números no texto, então o caso real é um numeral que sobrevive ao
  // `stripTeamNames` — "Schalke 04 (-1.5)" quando o evento grafa só "Schalke",
  // ou os rótulos "Time 2 (-1.5)"/"2 (-1.5)". Sem o parêntese aqui, a linha cairia
  // no ramo decimal, que devolve o valor ABSOLUTO, e o handicap liquidaria
  // invertido. Com um número só ("Flamengo (-1.5)" após remover o nome), o sinal
  // já vem correto pelo caminho de valor único.
  const signed = [...normalized.matchAll(/(?:^|[\s(])([+-]\d+(?:[.,]\d+)?)(?=$|[\s)])/g)]
    .map((match) => Number((match[1] ?? "").replace(",", ".")))
    .filter(Number.isFinite);
  if (signed.length === 1) return signed[0] ?? null;
  // DOIS números assinados que não formaram par (a normalização de split já
  // rodou) não elegem um vencedor: o ramo decimal abaixo devolveria o valor
  // ABSOLUTO de quem tivesse casa decimal, e o sinal — que é o LADO — sumiria.
  // "Flamengo -0.5 -110" (linha e preço americano) viraria +0.5.
  if (signed.length > 1) return null;

  // Sem sinal, uma única casa decimal diferencia a linha de números soltos
  // como rodada/tempo. Dois inteiros adjacentes ("Over 2 5") são ambíguos:
  // pode ser OCR de 2.5, e escolher 2 ou fazer média gravaria outro mercado.
  const decimals = [...normalized.matchAll(/(?:^|[^0-9])([0-9]+[.,][0-9]+)(?=$|[^0-9])/g)]
    .map((match) => Number((match[1] ?? "").replace(",", ".")))
    .filter(Number.isFinite);
  return decimals.length === 1 ? decimals[0] ?? null : null;
}

/**
 * Meio-tempo numerado ("1ºT", "(1°T)", "2T", "1º tempo", "1st half", "H1"). O
 * dígito dele não é número da linha: com a vírgula decimal, "Over 0,5 1ºT"
 * seria a linha dividida 0.5/1, e "Total 1ºT" com a seleção "Over", a linha 1.
 * Quem lê a linha de um texto que pode nomear o tempo apaga o tempo antes.
 */
const NUMBERED_HALF = /(?<![\d.,])\b(?:[12]\s*(?:[ºª°oa]|st|nd)?\s*(?:t|tempo|half|h|parte|etapa|metade)|h[12])\b/gi;

export function withoutNumberedHalf(text: string): string {
  return text.replace(NUMBERED_HALF, " ");
}

export function extractSignedNumbers(text: string): number[] {
  const normalized = normalizeLineText(text);
  const values: number[] = [];
  // Captura gulosa já engole o decimal ("2,5"/"2.5"); o lookahead só garante
  // que não paramos no meio de dígitos — vírgula de LISTA fica fora.
  const tokenRe = /(?:^|[^a-z0-9.,+-])([+-]?\d+(?:[.,]\d+)?)(?=$|[^0-9])/g;
  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(` ${normalized} `)) !== null) {
    const raw = match[1];
    if (!raw) continue;
    const parsed = Number(raw.replace(/\s+/g, "").replace(",", "."));
    if (Number.isFinite(parsed)) values.push(parsed);
  }
  return values;
}

/**
 * Linha da seleção em quartos. Duas linhas explícitas ("-0.5, -1.0") viram a
 * média (quarter line). `allowNegative` distingue handicap (±) de total (≥0).
 */
export function parseLineQuarters(
  selecao: string,
  opts: { allowNegative: boolean },
): number | null {
  // Totais Bet365 podem chegar crus como `Over 2,2.5`. No contexto que proíbe
  // linha negativa a vírgula seguida de uma perna decimal é inequivocamente um
  // split.
  //
  // No handicap a vírgula também é split (`0,-0.5` = -0.25), mas só quando a
  // SEGUNDA perna declara sinal — é a mesma regra que
  // `canonicalizeAsianHandicapSelecao` aplica na captura, e que faz `2,2.5`
  // falhar fechado em vez de inventar um lado. Sem este passo o extrator
  // enxergaria só a primeira perna e a linha viraria OUTRA: `0,-0.5` num 0-0
  // daria VOID (estorno) onde o correto é HALF_LOST, e `-1,-1.5` num 1-0
  // também. Não é recusa: é liquidação com a linha errada.
  // Decimais em português com vírgula ("-0,5", "+0,25", "Flamengo -1,75") sem split
  // viram ponto ("-0.5", "+0.25", "-1.75") para o extrator ler o número e sinal unívocos.
  const comPontoDecimal = selecao.replace(
    /(^|[^\d.,+-])([+-]\d+),(\d{1,2})(?=$|[^\d.,+-])/g,
    "$1$2.$3",
  );
  // Cola o sinal ao número ANTES de qualquer regra de split: os padrões abaixo
  // procuram `[+-]\d`, e um espaço no meio (`+0 ,- 0.5`) faria todos falharem
  // em cadeia.
  const comSinalColado = comPontoDecimal.replace(/([+-])\s+(?=\d)/g, "$1");
  let lineText = opts.allowNegative
    ? comSinalColado
        // "mais"/"menos" por EXTENSO são o sinal escrito em PT. No contexto de
        // handicap (o único que chega aqui com `allowNegative`) "Flamengo menos
        // 0.5" é -0.5, e o extrator só enxerga `[+-]`: a linha sairia POSITIVA e
        // num 0-0 daria WON onde a casa paga LOST. A forma COM
        // preposição ("menos DE 0.5") fica de fora de propósito — ali a palavra
        // é direção de total, e é assim que `totalDirectionOf` a lê; num
        // mercado de total `allowNegative` é falso e nada disto acontece.
        .replace(/\bmenos\s+(?=\d)/g, "-")
        .replace(/\bmais\s+(?=\d)/g, "+")
        // Duas pernas separadas só por ESPAÇO ("+0 -0.5", "-1 -1.5") são a mesma
        // split line que a vírgula grafa; no ramo de "um decimal" o sinal
        // sumiria e `-1 -1.5` (= -1.25) liquidaria como +1.5. Vira vírgula para
        // herdar TODAS as regras do split (zero neutro, sinais opostos, média).
        //
        // A exigência de as pernas distarem exatamente 0.5 é o que separa split
        // de coincidência: é a definição de quarter line, e mantém de fora o par
        // "linha + odd americana" ("-0.5 -110"), que não é linha nenhuma.
        .replace(
          /([+-]\d+(?:[.,]\d+)?)\s+(?=[+-]\d)/g,
          (match, first: string, offset: number, text: string) => {
            const second = text.slice(offset + match.length).match(/^[+-]\d+(?:[.,]\d+)?/)?.[0];
            if (!second) return match;
            const a = lineToQuarters(Number(first.replace(",", ".")));
            const b = lineToQuarters(Number(second.replace(",", ".")));
            if (a === null || b === null || Math.abs(a - b) !== 2) return match;
            return `${first}, `;
          },
        )
        // Zero com sinal e segunda perna sem sinal (`-0/0.5`, `+0/0.5`): o
        // sinal é do par, como na vírgula da Bet365 (`-2,2.5`); `-0/0.5` é -0.25.
        .replace(/(^|[^\d.,])([+-])\s*0(?:[.,]0+)?\s*([,/])\s*(?=\d)/g, "$1 0$3$2")
        // `+0` ou `-0` é zero neutro em qualquer perna: `+0,-0.5` (-0.25) ou
        // `+0.5,-0` (+0.25), e cairia em `invalid_line`. A barra é a outra grafia (`+0/-0.5`).
        .replace(/(^|[^\d.,])[+-]\s*0(?:[.,]0+)?(?=\s*[,/]\s*(?:[+-]|\d+[.,]\d))/g, "$1 0")
        .replace(/([,/]\s*)[+-]\s*0(?:[.,]0+)?(?=$|[^\d.,])/g, "$10")
        .replace(/(\d)\s*,(?=\s*[+-]\d)/g, "$1, ")
        // Primeira perna ZERO com a segunda sem sinal (`0,0.5` = +0.25): o
        // zero é neutro, então o split é inequívoco mesmo sem sinal — mesma
        // exceção que `canonicalizeAsianHandicapSelecao` abre. Sem ela o
        // extrator veria só `[0]`, a linha viraria 0 e a meia-ganha, VOID.
        .replace(/(^|[^\d.,])(0(?:[.,]0+)?)\s*,(?=\s*\d+[.,]\d)/g, "$1$2, ")
    : comSinalColado.replace(/(\d+),(?=\d+\.\d)/g, "$1, ");
  if (opts.allowNegative) {
    // Sinal SOLTO grudado na vírgula (`1-,1.5`) é grafia corrompida: pode ser
    // `1,-1.5` (-1.25) ou `1,1.5` (+1.25) — dois lados opostos. Ler só a
    // primeira perna liquidaria com +1.0, uma linha que ninguém escreveu. Não
    // há leitura defensável: recusa.
    if (/\d\s*[+-]\s*[,/]/.test(normalizeLineText(lineText))) return null;

    const normalized = normalizeLineText(lineText);
    const splitMatch = normalized.match(
      /(?:^|[^\d.,+-])([+-]?)\s*(\d+(?:[.,]\d+)?)\s*([,/])\s*([+-]?)\s*(\d+(?:[.,]\d+)?)(?=$|[^\d.,+-])/,
    );
    if (splitMatch) {
      const [, firstSign = "", firstBody = "", sep = ",", secondSignRaw = "", secondBody = ""] = splitMatch;
      const firstVal = Number(firstBody.replace(",", "."));
      const isSplit =
        sep === "/" ||
        firstBody.includes(".") ||
        secondBody.includes(".") ||
        Boolean(secondSignRaw);

      if (isSplit) {
        // Sinais explícitos opostos não formam uma linha asiática válida (ex: -2,+2.5 ou 2,-2.5)
        if (firstSign && secondSignRaw && firstSign !== secondSignRaw) {
          return null;
        }
        // Split cuja primeira perna não declara sinal e não é zero (ex: 2, 2.5 ou 2, -2.5)
        if (firstSign === "" && firstVal !== 0) {
          return null;
        }
        // Se a primeira perna tem sinal explícito e a segunda não declara sinal, a segunda herda o sinal.
        if (firstSign && !secondSignRaw) {
          lineText = lineText.replace(
            new RegExp(`([+-]?\\s*${firstBody.replace(".", "\\.")}\\s*${sep}\\s*)${secondBody.replace(".", "\\.")}`),
            `$1 ${firstSign}${secondBody}`,
          );
        }
      }
    }
  }
  const values = extractSignedNumbers(lineText).filter((v) =>
    opts.allowNegative ? true : v >= 0,
  );
  if (values.length === 0) return null;

  // Tres ou mais numeros nao definem uma linha asiatica univoca. Falhar
  // fechado evita escolher silenciosamente os dois primeiros.
  if (values.length > 2) return null;

  if (values.length === 2) {
    // Só vira quarter line quando os dois números são um par COLADO por
    // vírgula/barra. Dois números soltos no texto não formam linha, e a média
    // inventaria um mercado diferente ("Over 2 5" viraria Over 3.5,
    // "AH França -1.0 jogo 3" viraria +1.0).
    // Sem o par, só aceitamos um candidato marcado por sinal ou casa decimal.
    // Se não houver evidência unívoca, falha fechado em vez de inventar linha.
    if (!hasSplitLinePair(lineText)) {
      const candidate = uniqueLooseLineCandidate(lineText);
      return candidate === null ? null : lineToQuarters(candidate);
    }
    const [first, second] = values;
    if (first === undefined || second === undefined) return null;
    const a = lineToQuarters(first);
    const b = lineToQuarters(second);
    if (a === null || b === null) return null;
    // Splits por vírgula/barra devem ter distância de exatamente 0.5 (2 quartos).
    if (Math.abs(a - b) !== 2) return null;
    const mid = (a + b) / 2;
    return Number.isInteger(mid) ? mid : null;
  }
  const [only] = values;
  return only === undefined ? null : lineToQuarters(only);
}

/** Diferença ajustada em quartos → status: ±1 quarto é meia, 0 é devolução. */
export function statusFromAdjustedQuarters(adjustedQ: number): BetStatus {
  if (adjustedQ === 0) return "VOID";
  if (adjustedQ === 1) return "HALF_WON";
  if (adjustedQ === -1) return "HALF_LOST";
  return adjustedQ > 0 ? "WON" : "LOST";
}
