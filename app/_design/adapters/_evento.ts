import { splitEventoTeams } from "@/src/domain/text";

/**
 * "Home vs Away" → { home, away } para as telas que mostram mandante e
 * visitante separados. Delega a `splitEventoTeams`; sem confronto reconhecível,
 * o todo vira `home` (as telas esperam os dois campos não nulos).
 */
export function splitEvento(evento: string): { home: string; away: string } {
  return splitEventoTeams(evento) ?? { home: evento, away: "" };
}
