import { describe, expect, it } from "vitest";
import {
  hasTeamProviderContextConflict,
  hasTeamProviderCountryConflict,
  isRegiaoOuConfederacao,
} from "@/src/domain/team-provider-context";

describe("contexto de identidade por provider", () => {
  it("compartilha a mesma guarda de país entre resolução e aprendizado", () => {
    expect(hasTeamProviderCountryConflict({
      expectedCountry: "Brasil",
      providerCountry: "Brazil",
    })).toBe(false);
    expect(hasTeamProviderCountryConflict({
      expectedCountry: "Brazil",
      providerCountry: "Portugal",
    })).toBe(true);
    expect(hasTeamProviderCountryConflict({
      expectedCountry: "Brazil",
      providerCountry: "World",
    })).toBe(false);
  });

  it("aceita país traduzido e competição equivalente", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brasil",
        expectedCompetition: "Brazil - Serie B",
        providerCountry: "Brazil",
        providerCompetition: "Serie B Betano",
      }),
    ).toBe(false);
  });

  it("recusa países incompatíveis", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brazil",
        expectedCompetition: "Serie B",
        providerCountry: "Portugal",
        providerCompetition: "Liga Portugal 2",
      }),
    ).toBe(true);
  });

  it("recusa divisões incompatíveis da mesma competição", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brazil",
        expectedCompetition: "Serie B",
        providerCountry: "Brazil",
        providerCompetition: "Serie A",
      }),
    ).toBe(true);
  });

  it("aceita nomes traduzidos sem presumir que são competições diferentes", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brasil",
        expectedCompetition: "Copa do Brasil",
        providerCountry: "Brazil",
        providerCompetition: "Brazil Cup",
      }),
    ).toBe(false);
  });

  it.each(["Coppa Italia", "Coupe de France", "KNVB Beker", "Svenska Cupen", "Magyar Kupa"])(
    "copa em outra língua também é copa: %s contra a liga",
    (copa) => {
      expect(hasTeamProviderContextConflict({
        expectedCountry: "", expectedCompetition: "Serie A", providerCountry: "", providerCompetition: copa,
      })).toBe(true);
    },
  );

  it("recusa copa versus liga no mesmo país", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brazil",
        expectedCompetition: "Copa do Brasil",
        providerCountry: "Brazil",
        providerCompetition: "Serie B",
      }),
    ).toBe(true);
  });
});

/**
 * Região/confederação: um clube mexicano joga a Leagues Cup ("North & Central
 * America") e um finlandês a Europa League ("Europe"). A guarda trata região
 * como compatível com qualquer nação e só declara conflito quando os dois lados
 * são países específicos e diferentes.
 */
describe("região/confederação é compatível com qualquer nação", () => {
  it("lista as grafias do feed", () => {
    for (const regiao of [
      "World", "Europe", "Asia", "Africa", "Oceania",
      "North & Central America", "South America", "Australia & Oceania",
      "CONCACAF", "CONMEBOL", "UEFA", "AFC", "CAF", "OFC", "FIFA",
      "International", "Not specified",
    ]) {
      expect(isRegiaoOuConfederacao(regiao), `${regiao} é região`).toBe(true);
    }
    expect(isRegiaoOuConfederacao("Brazil")).toBe(false);
    expect(isRegiaoOuConfederacao("Argentina")).toBe(false);
  });

  it("aceita país traduzido e competição equivalente", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brasil",
        expectedCompetition: "Brazil - Serie B",
        providerCountry: "Brazil",
        providerCompetition: "Serie B Betano",
      }),
    ).toBe(false);
  });

  it("recusa países específicos incompatíveis", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brazil",
        expectedCompetition: "Serie B",
        providerCountry: "Portugal",
        providerCompetition: "Liga Portugal 2",
      }),
    ).toBe(true);
  });

  it("aceita clube em competição REGIONAL de outra confederação (Leagues Cup)", () => {
    // Pumas UNAM (México) na Leagues Cup — o "país" do torneio é a região.
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Mexico",
        expectedCompetition: "NORTH & CENTRAL AMERICA: Leagues Cup",
        providerCountry: "North & Central America",
        providerCompetition: "NORTH & CENTRAL AMERICA: Leagues Cup",
      }),
    ).toBe(false);
  });

  it("aceita clube em competição continental EUROPEIA (Europa League)", () => {
    // KuPS (UEFA) na Europa League — região vs confederação é compatível.
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "UEFA",
        expectedCompetition: "EUROPE: Europa League - Qualification",
        providerCountry: "Europe",
        providerCompetition: "EUROPE: Europa League - Qualification",
      }),
    ).toBe(false);
  });

  it("recusa clube de OUTRO país específico (Bahia vs Olimpo Bahia Blanca)", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Brazil",
        expectedCompetition: "BRAZIL: Serie B",
        providerCountry: "Argentina",
        providerCompetition: "ARGENTINA: Torneo Federal - Winners stage",
      }),
    ).toBe(true);
  });

  it("recusa Independiente (ARG) vs Independiente FBC (PAR)", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "Argentina",
        expectedCompetition: "ARGENTINA: Liga Profesional",
        providerCountry: "Paraguay",
        providerCompetition: "PARAGUAY: Division Intermedia",
      }),
    ).toBe(true);
  });

  it("contexto ausente nunca é inventado", () => {
    expect(
      hasTeamProviderContextConflict({
        expectedCountry: "",
        expectedCompetition: "",
        providerCountry: "Peru",
        providerCompetition: "PERU: Liga 1",
      }),
    ).toBe(false);
  });
});
