import { expect, it } from "vitest";
import { packPriceResponse, unpackPriceResponse, archiveHash } from "@/src/providers/price-archive/codec";
import { priceEnvelope } from "../helpers/price-archive-fixtures";

async function packedRow() {
  const e = priceEnvelope(); const packed = (await packPriceResponse(e))!;
  return { ...packed, provider: e.provider, endpoint: e.endpoint, eventIds: e.eventIds,
    requestedAt: new Date(e.requestedAt), observedAt: new Date(e.observedAt) };
}
it("preserva JSON completo e contexto, inclusive campos que o normalizador ignora", async () => {
  const row = await packedRow(); expect(await unpackPriceResponse(row)).toEqual(priceEnvelope());
  expect(row.payloadBytes).toBeLessThan(row.unpackedBytes);
});
it.each(["hash", "bytes", "context", "time", "provider", "corrupt"])("recusa prova incoerente: %s", async (field) => {
  const row = await packedRow();
  if (field === "hash") row.sha256 = "0".repeat(64);
  if (field === "bytes") row.unpackedBytes++;
  if (field === "context") row.eventIds = ["999"];
  if (field === "time") row.observedAt = new Date(row.observedAt.getTime() + 1);
  if (field === "provider") row.provider = "bridgeodds";
  if (field === "corrupt") { row.payload[0] = 0; row.sha256 = archiveHash(row.payload); }
  expect(await unpackPriceResponse(row)).toBeNull();
});
it("recusa segredo ecoado pelo fornecedor", async () => {
  const e = priceEnvelope(); e.body = { key: "synthetic-secret-token" };
  expect(await packPriceResponse(e, ["synthetic-secret-token"])).toBeNull();
});
it("limita o corpo antes de comprimir, mesmo sendo altamente compressível", async () => {
  const e = priceEnvelope(); e.body = { huge: "a".repeat(8 * 1024 * 1024) };
  expect(await packPriceResponse(e)).toBeNull();
});
it("não aceita relógio de consulta invertido", async () => {
  const e = priceEnvelope(); e.requestedAt = new Date(Date.parse(e.observedAt) + 1).toISOString();
  expect(await packPriceResponse(e)).toBeNull();
});
