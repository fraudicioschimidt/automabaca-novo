import { expect, it, vi } from "vitest";
import type { OperationalSloRow } from "@/src/services/ops/slo/slo";
const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn() }));
vi.mock("@/src/infra/logger", () => ({ createLogger: () => log }));
import { createSloLogReporter } from "@/src/services/ops/slo/slo-log";

const row = { kind: "provider", name: "test", status: "breach", reasons: ["p95 16000ms > 15000ms"], samples: 20,
  errors: 0, retries: 0, successPct: 100, p95DurationMs: 16000 } as OperationalSloRow;

it("emite abertura, mudança de causa, resumo e recuperação sem repetir variação numérica", () => {
  vi.clearAllMocks();
  const report = createSloLogReporter();
  report([row], 0);
  report([{ ...row, reasons: ["p95 17000ms > 15000ms"] }], 1000);
  expect(log.warn).toHaveBeenCalledTimes(1);
  report([row], 3_600_000);
  expect(log.warn).toHaveBeenLastCalledWith(expect.objectContaining({ eventCode: "SLO_BREACH_SUMMARY", suppressed: 1 }), expect.any(String));
  report([{ ...row, reasons: ["sucesso 90% < 95%"] }], 3_601_000);
  expect(log.warn).toHaveBeenLastCalledWith(expect.objectContaining({ eventCode: "SLO_BREACH_CHANGED" }), expect.any(String));
  report([{ ...row, status: "healthy", reasons: [] }], 3_602_000);
  expect(log.info).toHaveBeenLastCalledWith(expect.objectContaining({ eventCode: "SLO_RECOVERED" }), expect.any(String));
  report([row], 3_603_000);
  expect(log.warn).toHaveBeenLastCalledWith(expect.objectContaining({ eventCode: "SLO_BREACH_DETECTED" }), expect.any(String));
});

it("amostra curta ou desaparecida não é recuperação", () => {
  vi.clearAllMocks();
  const report = createSloLogReporter();
  report([row]);
  report([{ ...row, status: "warning", reasons: ["amostra curta"] }]);
  expect(log.info).not.toHaveBeenCalled();
  report([]);
  expect(log.info).toHaveBeenLastCalledWith(expect.objectContaining({ eventCode: "SLO_NO_RECENT_SAMPLES" }), expect.any(String));
});

it("agravamento expressivo da mesma causa não espera o resumo horário", () => {
  vi.clearAllMocks();
  const report = createSloLogReporter();
  report([row], 0);
  report([{ ...row, reasons: ["p95 60000ms > 15000ms"], p95DurationMs: 60000 }], 1000);
  expect(log.warn).toHaveBeenCalledTimes(2);
  expect(log.warn).toHaveBeenLastCalledWith(expect.objectContaining({ eventCode: "SLO_BREACH_CHANGED" }), expect.any(String));
});

it("inclui sampleCorrelationIds no envelope do breach quando fornecidos", () => {
  vi.clearAllMocks();
  const report = createSloLogReporter();
  report([{ ...row, sampleCorrelationIds: ["job_a", "job_b"] }], 0);
  expect(log.warn).toHaveBeenCalledWith(
    expect.objectContaining({
      eventCode: "SLO_BREACH_DETECTED",
      sampleCorrelationIds: ["job_a", "job_b"],
    }),
    expect.any(String),
  );
});
