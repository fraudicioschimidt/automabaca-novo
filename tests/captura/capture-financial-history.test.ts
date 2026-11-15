import { expect, it } from "vitest";
import { historicalStakeSettings, preserveCaptureStakeSnapshot, readDurableCaptureStakeSnapshot } from "@/src/domain/capture-financial-history";

const saved = { version: 1, basis: "CAPTURE", stakePolicy: "ALWAYS", defaultStakeUnits: 1, originalStake: 3, source: "bankroll_fixed" };
it("história durável prevalece sobre evidência temporária divergente", () => {
  const row = { captureStakeSnapshot: saved, captureEvidence: { parsedJson: { stakePolicySnapshot: { ...saved, defaultStakeUnits: 9 } } } };
  expect(historicalStakeSettings(row)).toEqual({ stakePolicy: "ALWAYS", defaultStakeUnits: 1 });
});
it.each([null, {}, { ...saved, version: 2 }, { ...saved, basis: "OUTRA" }, { ...saved, stakePolicy: undefined }, { ...saved, defaultStakeUnits: "1" }, { ...saved, originalStake: undefined }])("não fabrica história para JSON inválido: %j", (value) => {
  expect(readDurableCaptureStakeSnapshot(value)).toBeNull();
});
it("sem snapshot gravado não há história, mesmo com evidência temporária", () => {
  expect(preserveCaptureStakeSnapshot({})).toBeNull();
  const semSnapshot = { captureStakeSnapshot: null, captureEvidence: { parsedJson: { stakePolicySnapshot: saved } } };
  expect(historicalStakeSettings(semSnapshot)).toBeUndefined();
});
