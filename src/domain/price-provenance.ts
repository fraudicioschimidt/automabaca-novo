import {
  autoFairOdds,
  combineQuarterLineOdds,
  powerFairOdds,
  percentualContraFair,
  type QuarterLineSide,
} from "./odds";
import { parseTypedPriceReference } from "./price-reference";

export const PRICE_SNAPSHOT_VERSION = 1 as const;

export type PriceSnapshotComponent = {
  /** Linha em quartos (ex.: 35 = 8.75), quando aplicável. */
  readonly lineQ: number | null;
  readonly rawOdds: readonly number[];
  readonly selectedIndex: number;
  readonly devig: "auto" | "power";
};

/** Família da linha de quarto: com o `selectedIndex`, diz o lado apostado. */
export type QuarterLineMarket = "total" | "spread";

/**
 * Evidência mínima, imutável e sem payload proprietário para recalcular uma
 * fair odd. Não guarda nomes de atletas/equipes nem a resposta completa do
 * provider: somente o book que entrou na decisão e a versão da matemática.
 *
 * Na linha de quarto, `market` e as linhas dos componentes dizem qual deles é
 * o mais difícil, e daí a combinação exata (`combineQuarterLineOdds`). Outra
 * combinação (a `quarter-average`, média de probabilidades) não é recalculável.
 */
export type PriceSnapshot = {
  readonly version: typeof PRICE_SNAPSHOT_VERSION;
  readonly combination: "single" | "quarter-line";
  /** Limite cotado para esta linha; conserva frações que a coluna inteira não guarda. */
  readonly maxBet?: number;
  readonly market?: QuarterLineMarket;
  readonly components: readonly PriceSnapshotComponent[];
};

export function singlePriceSnapshot(params: {
  rawOdds: readonly number[];
  selectedIndex: number;
  devig: PriceSnapshotComponent["devig"];
  lineQ?: number | null;
  maxBet?: number | null;
}): PriceSnapshot {
  return Object.freeze({
    version: PRICE_SNAPSHOT_VERSION,
    combination: "single" as const,
    ...(typeof params.maxBet === "number" && Number.isFinite(params.maxBet) && params.maxBet >= 0
      ? { maxBet: params.maxBet } : {}),
    components: Object.freeze([
      Object.freeze({
        lineQ: params.lineQ ?? null,
        rawOdds: Object.freeze([...params.rawOdds]),
        selectedIndex: params.selectedIndex,
        devig: params.devig,
      }),
    ]),
  });
}

export function quarterPriceSnapshot(
  market: QuarterLineMarket,
  components: readonly PriceSnapshotComponent[],
): PriceSnapshot {
  return Object.freeze({
    version: PRICE_SNAPSHOT_VERSION,
    combination: "quarter-line" as const,
    market,
    components: Object.freeze(
      components.map((c) =>
        Object.freeze({
          lineQ: c.lineQ ?? null,
          rawOdds: Object.freeze([...c.rawOdds]),
          selectedIndex: c.selectedIndex,
          devig: c.devig,
        }),
      ),
    ),
  });
}

function componentOdds(component: PriceSnapshotComponent): {
  raw: number;
  fair: number;
} | null {
  if (
    component.selectedIndex < 0 ||
    component.selectedIndex >= component.rawOdds.length
  ) return null;
  const raw = component.rawOdds[component.selectedIndex];
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw <= 1) return null;
  const fairOdds = component.devig === "power"
    ? powerFairOdds(component.rawOdds)
    : autoFairOdds(component.rawOdds);
  const fair = fairOdds?.[component.selectedIndex];
  if (typeof fair !== "number" || !Number.isFinite(fair) || fair <= 1) return null;
  return { raw, fair };
}

export function isPriceSnapshotComponent(value: unknown): value is PriceSnapshotComponent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const component = value as Record<string, unknown>;
  return (
    (component.lineQ === null ||
      (typeof component.lineQ === "number" && Number.isInteger(component.lineQ))) &&
    Array.isArray(component.rawOdds) &&
    component.rawOdds.length >= 2 &&
    component.rawOdds.every((odd) =>
      typeof odd === "number" && Number.isFinite(odd) && odd > 1
    ) &&
    typeof component.selectedIndex === "number" &&
    Number.isInteger(component.selectedIndex) &&
    component.selectedIndex >= 0 &&
    component.selectedIndex < component.rawOdds.length &&
    (component.devig === "auto" || component.devig === "power")
  );
}

export function isPriceSnapshot(value: unknown): value is PriceSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const snapshot = value as Record<string, unknown>;
  if (
    snapshot.version !== PRICE_SNAPSHOT_VERSION ||
    !Array.isArray(snapshot.components) ||
    !snapshot.components.every(isPriceSnapshotComponent)
  ) return false;
  if (snapshot.combination === "single") {
    return snapshot.market === undefined && snapshot.components.length === 1;
  }
  return snapshot.combination === "quarter-line" &&
    (snapshot.market === "total" || snapshot.market === "spread") &&
    snapshot.components.length === 2;
}

/**
 * Lado apostado e linhas na perspectiva dele. O book do total é [over, under];
 * o do handicap é [casa, fora] com a linha da casa, que troca de sinal para
 * quem apostou fora.
 */
function quarterLineSide(
  market: QuarterLineMarket,
  components: readonly PriceSnapshotComponent[],
): { side: QuarterLineSide; lines: [number, number] } | null {
  const [a, b] = components;
  if (!a || !b || a.lineQ === null || b.lineQ === null || a.selectedIndex !== b.selectedIndex) return null;
  if (a.rawOdds.length !== 2 || b.rawOdds.length !== 2) return null;
  if (market === "total") {
    return { side: a.selectedIndex === 0 ? "over" : "under", lines: [a.lineQ, b.lineQ] };
  }
  const sign = a.selectedIndex === 0 ? 1 : -1;
  return { side: "handicap", lines: [sign * a.lineQ, sign * b.lineQ] };
}

/** Recalcula exatamente raw/fair sem depender de cache ou do provider. */
export function recomputePriceSnapshot(snapshot: PriceSnapshot): {
  raw: number;
  fair: number;
} | null {
  if (!isPriceSnapshot(snapshot)) return null;
  const resolved = snapshot.components.map(componentOdds);
  if (resolved.some((component) => component === null)) return null;
  const complete = resolved as Array<{ raw: number; fair: number }>;
  if (snapshot.combination === "single") {
    return complete.length === 1 ? complete[0]! : null;
  }
  const oriented = snapshot.market ? quarterLineSide(snapshot.market, snapshot.components) : null;
  if (complete.length !== 2 || !oriented) return null;
  const harder = oriented.side === "over"
    ? (oriented.lines[0] > oriented.lines[1] ? 0 : 1)
    : (oriented.lines[0] < oriented.lines[1] ? 0 : 1);
  // A justa da linha mais difícil não pode ser menor: isso implicaria massa
  // negativa no resultado que anula a linha inteira. A bruta tem margens
  // próprias por linha; a restrição de distribuição é sobre as justas.
  if (complete[harder]!.fair + 1e-10 < complete[1 - harder]!.fair) return null;
  const combine = (pick: (c: { raw: number; fair: number }) => number) => combineQuarterLineOdds({
    side: oriented.side,
    components: [
      { lineQ: oriented.lines[0], odd: pick(complete[0]!) },
      { lineQ: oriented.lines[1], odd: pick(complete[1]!) },
    ],
  });
  const raw = combine((c) => c.raw);
  const fair = combine((c) => c.fair);
  return raw && fair ? { raw, fair } : null;
}

export type PriceProvenanceInput = {
  fair: number | null | undefined;
  raw: number | null | undefined;
  snapshot: unknown;
  provider: string | null | undefined;
  reference?: string | null | undefined;
  requireReference?: boolean;
  observedAt?: Date | null | undefined;
};

// Meia unidade da última casa de cada coluna (mais a folga do ponto flutuante):
// fair em Decimal(12, 6) (closingOdd, openingOdd) e raw em Decimal(10, 4)
// (closingRawOdd, openingRawOdd). Alargou a coluna? Aperte a constante junto.
const FAIR_TOLERANCE = 5e-7 + 1e-12;
const RAW_TOLERANCE = 5e-5 + 1e-12;

/**
 * Guard de escrita para SHP-005. O snapshot é a fonte matemática: fair/raw
 * informados pelo adapter precisam ser exatamente reproduzíveis antes de
 * chegarem ao Prisma. A tolerância cobre apenas arredondamento decimal de
 * persistência, nunca uma cotação diferente (as odds chegam com 3 casas).
 */
export function assertPriceProvenance(
  input: PriceProvenanceInput,
  label = "preço",
): { raw: number; fair: number } {
  if (
    typeof input.fair !== "number" || !Number.isFinite(input.fair) || input.fair <= 1 ||
    typeof input.raw !== "number" || !Number.isFinite(input.raw) || input.raw <= 1
  ) {
    throw new Error(`${label}: fair/raw ausentes ou inválidos.`);
  }
  const recomputed = recomputePriceSnapshot(input.snapshot as PriceSnapshot);
  if (!recomputed) throw new Error(`${label}: snapshot ausente ou irreproduzível.`);
  if (
    Math.abs(recomputed.fair - input.fair) > FAIR_TOLERANCE ||
    Math.abs(recomputed.raw - input.raw) > RAW_TOLERANCE
  ) {
    throw new Error(`${label}: fair/raw divergem do snapshot.`);
  }
  const provider = typeof input.provider === "string" ? input.provider.trim() : "";
  if (!provider) throw new Error(`${label}: provider ausente.`);
  if (input.requireReference) {
    const reference = parseTypedPriceReference(provider, input.reference);
    if (!reference) {
      throw new Error(`${label}: referência tipada ausente ou incompatível com o provider.`);
    }
    if (reference.provider === "pinnacle17") {
      // A Pinnacle17 entrega o book da linha exata. Um preço recalculável de
      // outra linha ou outro lado não sustenta a referência de fechamento.
      const snapshot = input.snapshot as PriceSnapshot;
      const component = snapshot.components[0]!;
      const moneyline = reference.marketType === "moneyline";
      const bookSize = component.rawOdds.length;
      const expectedIndex = moneyline
        ? (bookSize === 3 ? ["home", "draw", "away"] : ["home", "away"]).indexOf(reference.outcome)
        : reference.marketType === "spread" ? ["home", "away"].indexOf(reference.outcome)
        : reference.outcome.endsWith("over") ? 0 : 1;
      if (snapshot.combination !== "single" || (moneyline ? bookSize !== 2 && bookSize !== 3 : bookSize !== 2)
        || component.lineQ !== (moneyline ? null : Number(reference.line))
        || expectedIndex < 0 || component.selectedIndex !== expectedIndex) {
        throw new Error(`${label}: referência e snapshot descrevem termos diferentes.`);
      }
    }
  }
  if (!(input.observedAt instanceof Date) || Number.isNaN(input.observedAt.getTime())) {
    throw new Error(`${label}: instante real de observação ausente ou inválido.`);
  }
  return recomputed;
}

/** Defesa de leitura para linhas históricas ou SQL direto fora dos writers. */
export function hasRecomputablePriceEvidence(input: PriceProvenanceInput): boolean {
  try {
    assertPriceProvenance(input);
    return true;
  } catch {
    return false;
  }
}

/** A prova do preço também precisa sustentar o CLV gravado para a odd atual. */
export function hasRecomputableClvEvidence(input: PriceProvenanceInput & {
  odds: number | null | undefined;
  clv: number | null | undefined;
}): boolean {
  if (typeof input.odds !== "number" || typeof input.clv !== "number" || !Number.isFinite(input.clv)) return false;
  try {
    const quote = assertPriceProvenance(input);
    const exact = percentualContraFair(input.odds, quote.fair);
    const rounded = percentualContraFair(input.odds, input.fair!);
    if (exact === null || rounded === null) return false;
    // CLV em Decimal(12,4). A edição pode ter usado a fair persistida em seis
    // casas; aceite apenas o intervalo entre essas duas bases e meia última
    // casa do CLV, sem ampliar para uma cotação ou odd diferente.
    const tolerance = 5e-5 + 1e-10;
    return input.clv >= Math.min(exact, rounded) - tolerance &&
      input.clv <= Math.max(exact, rounded) + tolerance;
  } catch {
    return false;
  }
}
