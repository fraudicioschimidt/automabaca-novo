import type { PriceSnapshot } from "./price-provenance";

export type SharpPhaseOdds = {
  raw: number;
  fair: number;
  maxBet: number | null;
  snapshot: PriceSnapshot;
};
