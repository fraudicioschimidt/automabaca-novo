import { describe, expect, it } from "vitest";
import { CapturePolicy } from "@/src/generated/prisma/enums";
import {
  captionCarriesAuthoritativeOdd,
  resolveCapturePolicy,
} from "@/src/domain/capture-policy";

/**
 * A política de captura é da banca, não do nome do canal (nada de
 * `slug.includes("will")`): canal novo não pode mudar de comportamento por
 * acidente de nome.
 */
describe("resolveCapturePolicy", () => {
  it("CAPTION_ODD: odd da legenda manda e é obrigatória quando há @", () => {
    const comArroba = resolveCapturePolicy(CapturePolicy.CAPTION_ODD, "Will / SL\n0.50u @1.925");
    expect(comArroba).toEqual({ captionOddAuthoritative: true, requireCaptionOdd: true });

    // Sem `@` não há o que exigir — o print/parser continua valendo.
    const semArroba = resolveCapturePolicy(CapturePolicy.CAPTION_ODD, "Will / SL\n0.50u");
    expect(semArroba).toEqual({ captionOddAuthoritative: true, requireCaptionOdd: false });
  });

  it("IMAGE_ODD: print manda, `min` da legenda nunca vira odd cravada", () => {
    const decision = resolveCapturePolicy(CapturePolicy.IMAGE_ODD, "Luis / SL\n1u\nmin 1,85");
    expect(decision).toEqual({ captionOddAuthoritative: false, requireCaptionOdd: false });
  });

  it("AUTO: legenda no formato stake@odd manda; legenda sem isso não", () => {
    expect(resolveCapturePolicy(CapturePolicy.AUTO, "1u @1.85").captionOddAuthoritative).toBe(true);
    expect(resolveCapturePolicy(CapturePolicy.AUTO, "slip").captionOddAuthoritative).toBe(false);
    // AUTO nunca REJEITA por falta de odd na legenda — isso é exclusivo do canal
    // que declarou a legenda como fonte da verdade.
    expect(resolveCapturePolicy(CapturePolicy.AUTO, "1u @").requireCaptionOdd).toBe(false);
  });

  it("reconhece o formato de legenda que antes era detectado pelo slug", () => {
    expect(captionCarriesAuthoritativeOdd("0.75u @1.850")).toBe(true);
    expect(captionCarriesAuthoritativeOdd("Will / SL @2.10")).toBe(true);
    expect(captionCarriesAuthoritativeOdd("min 1,85")).toBe(false);
    expect(captionCarriesAuthoritativeOdd("")).toBe(false);
  });
});
