import type { BetStatus, Prisma, SharpMode } from "@/src/generated/prisma/client";
import type { BetLegsTicket } from "@/src/domain/bet-legs";
import { canonicalSha256 } from "@/src/domain/canonical-json";
import { spStartOfTodayUtc } from "@/src/domain/dates";
import { roundMoney } from "@/src/domain/money";
import { admitsAsianFractionalSettlement } from "@/src/domain/settlement/half-guard";
import { SPORT_RESOLVER_VERSION } from "@/src/domain/sports/detect";
import { telegramChannelSource } from "@/src/domain/telegram-source";
import { telegramOwnerId } from "@/src/infra/env";
import { prisma } from "@/src/infra/prisma";
import { resolvePinnacle17CurrentOdds } from "@/src/providers/pinnacle17/odds";
import { encodePinnacle17PriceReference, type Pinnacle17Market, type Pinnacle17Outcome } from "@/src/providers/pinnacle17/types";
import { criarBankroll, excluirBankroll } from "@/src/services/bankrolls/manage";
import { canonicalizeBetForRegistration } from "@/src/services/bets/canonicalize-registration";
import { applyManualBetStatusChangeTx } from "@/src/services/bets/settle";
import { handleChannelReaction } from "@/src/services/capture/channel/reactions";
import { registerCapturedBet } from "@/src/services/capture/register-captured-bet";
import { runSerializableTransaction } from "@/src/services/shared/transaction";
import {
  applyClosingQuote, closingBetEligible, finalizeClosingSeries, readClosingBet, resolveClosingMarkets,
} from "@/src/services/sharp/closing/series";
import { persistedPinnacle17Event } from "@/src/services/sharp/closing/pinnacle17-clv";
import { upsertSharp } from "@/src/services/sharp/enrich/upsert-sharp";
import { seedMercados } from "@/prisma/seed-mercados";

/**
 * Dados de exemplo do banco de desenvolvimento: bancas de canais fictícios com
 * ~60 dias de apostas, fechamentos e resultados, gravados pelos serviços da
 * captura, do fechamento e da liquidação. Quem chama confere antes que o banco
 * é o local (`recusaForaDoDev`).
 *
 * As bancas de exemplo são as dos canais `demoChannelId` criadas pelo
 * `DEMO_ACTOR`; nada mais é apagado. O resultado é o mesmo a cada execução
 * (semente fixa), com as datas relativas a `now`.
 */

export const DEMO_ACTOR = "agent:dev-demo:por:fabricio";
/** Canais fictícios, numa faixa de ids só dos exemplos (`-100999000000N`). */
const DEMO_CHANNEL_BASE = -1009990000000n;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const HISTORY_DAYS = 60;
/** Escolhida entre algumas pela cara do resultado: bancas no lucro, uma no prejuízo, uma no zero a zero. */
const SEMENTE = 2;

export function recusaForaDoDev(env: Readonly<Record<string, string | undefined>>): string | null {
  if (env.NODE_ENV === "production") return "NODE_ENV=production";
  if (env.AUTOMABACA_PROCESS) return `AUTOMABACA_PROCESS=${env.AUTOMABACA_PROCESS} (processo de produção)`;
  if (!env.DATABASE_URL) return "DATABASE_URL não configurada";
  let host: string;
  try {
    host = new URL(env.DATABASE_URL).hostname;
  } catch {
    return "DATABASE_URL inválida";
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return `DATABASE_URL aponta para "${host}", não para o PostgreSQL local`;
  return null;
}

// ─────────────────────────── Catálogo fictício ───────────────────────────

export type Esporte = "Soccer" | "Basketball" | "Tennis" | "eSports" | "Hockey" | "Volleyball";
export type Liga = { pais: string; competicao: string; times: readonly string[]; horas: readonly number[] };

export const LIGAS: Record<Esporte, Record<string, Liga>> = {
  Soccer: {
    premier: { pais: "England", competicao: "Premier League", horas: [8.5, 11, 13.5], times: ["Arsenal", "Chelsea", "Liverpool", "Manchester City", "Manchester United", "Tottenham Hotspur", "Newcastle United", "Aston Villa", "Brighton and Hove Albion", "West Ham United"] },
    laliga: { pais: "Spain", competicao: "La Liga", horas: [9, 11.25, 13.5, 16], times: ["Real Madrid", "Barcelona", "Atletico Madrid", "Athletic Bilbao", "Real Sociedad", "Villarreal", "Real Betis", "Sevilla"] },
    seriea: { pais: "Italy", competicao: "Serie A", horas: [10, 13, 15.75], times: ["Inter Milan", "AC Milan", "Juventus", "Napoli", "AS Roma", "Lazio", "Atalanta", "Fiorentina", "Bologna"] },
    bundesliga: { pais: "Germany", competicao: "Bundesliga", horas: [10.5, 13.5], times: ["Bayern Munich", "Borussia Dortmund", "Bayer Leverkusen", "RB Leipzig", "VfB Stuttgart", "Eintracht Frankfurt", "SC Freiburg"] },
    brasileirao: { pais: "Brazil", competicao: "Serie A", horas: [16, 18.5, 19.5, 21.5], times: ["Flamengo", "Palmeiras", "Sao Paulo", "Corinthians", "Botafogo", "Fluminense", "Gremio", "Internacional", "Atletico Mineiro", "Cruzeiro", "Bahia", "Fortaleza"] },
    argentina: { pais: "Argentina", competicao: "Liga Profesional", horas: [17, 19.25, 21.5], times: ["Boca Juniors", "River Plate", "Racing Club", "Independiente", "San Lorenzo", "Estudiantes", "Velez Sarsfield"] },
    portugal: { pais: "Portugal", competicao: "Primeira Liga", horas: [12.5, 14.5, 16.5], times: ["Benfica", "Porto", "Sporting CP", "Braga", "Vitoria Guimaraes", "Famalicao"] },
  },
  Basketball: {
    nba: { pais: "USA", competicao: "NBA", horas: [20, 21, 22.5], times: ["Boston Celtics", "New York Knicks", "Milwaukee Bucks", "Denver Nuggets", "Oklahoma City Thunder", "Dallas Mavericks", "Los Angeles Lakers", "Golden State Warriors", "Minnesota Timberwolves", "Phoenix Suns"] },
    euroleague: { pais: "Europe", competicao: "Euroleague", horas: [13.5, 14.75, 15.5], times: ["Real Madrid", "Olympiacos", "Fenerbahce", "Panathinaikos", "Barcelona", "AS Monaco", "Anadolu Efes", "Maccabi Tel Aviv"] },
    nbb: { pais: "Brazil", competicao: "NBB", horas: [18, 19.5, 20], times: ["Flamengo", "Franca", "Minas", "Sao Paulo", "Pinheiros", "Bauru"] },
  },
  Tennis: {
    atpBeijing: { pais: "China", competicao: "ATP Beijing", horas: [2, 4.5, 7], times: ["Jannik Sinner", "Carlos Alcaraz", "Daniil Medvedev", "Alex de Minaur", "Andrey Rublev", "Tommy Paul", "Ben Shelton", "Joao Fonseca"] },
    atpTokyo: { pais: "Japan", competicao: "ATP Tokyo", horas: [0.5, 3, 5.5], times: ["Taylor Fritz", "Holger Rune", "Casper Ruud", "Stefanos Tsitsipas", "Alexander Zverev", "Ugo Humbert", "Frances Tiafoe"] },
    wtaWuhan: { pais: "China", competicao: "WTA Wuhan", horas: [1, 3.5, 6], times: ["Aryna Sabalenka", "Iga Swiatek", "Coco Gauff", "Jessica Pegula", "Elena Rybakina", "Jasmine Paolini", "Qinwen Zheng", "Beatriz Haddad Maia", "Mirra Andreeva"] },
  },
  eSports: {
    cs2: { pais: "World", competicao: "CS2 - ESL Pro League", horas: [9, 11.5, 14], times: ["Natus Vincere", "FaZe Clan", "Team Vitality", "G2 Esports", "MOUZ", "Team Spirit", "FURIA", "Heroic", "The MongolZ", "Astralis"] },
    lol: { pais: "World", competicao: "League of Legends - World Championship", horas: [5, 8], times: ["T1", "Gen.G", "Bilibili Gaming", "Hanwha Life Esports", "Fnatic", "Team Liquid", "Top Esports"] },
  },
  Hockey: {
    nhl: { pais: "USA", competicao: "NHL", horas: [20, 21, 23], times: ["Edmonton Oilers", "Florida Panthers", "Dallas Stars", "Colorado Avalanche", "New York Rangers", "Vegas Golden Knights", "Toronto Maple Leafs", "Boston Bruins", "Winnipeg Jets", "Carolina Hurricanes"] },
  },
  Volleyball: {
    superliga: { pais: "Brazil", competicao: "Superliga", horas: [18, 19.5, 21.5], times: ["Sada Cruzeiro", "Minas", "Sesi Bauru", "Praia Clube", "Campinas", "Joinville"] },
    superlega: { pais: "Italy", competicao: "SuperLega", horas: [11, 14.5], times: ["Itas Trentino", "Sir Safety Perugia", "Cucine Lube Civitanova", "Gas Sales Piacenza"] },
  },
};

/** O livro da Pinnacle que a aposta procura: família, linha (a da casa no handicap) e lado. */
type Livro = { tipo: "moneyline" | "spread" | "total"; nome: string; linha: number | null; lado: Pinnacle17Outcome["designation"]; tresVias: boolean };
type Palpite = { mercado: string; selecao: string; odds: number; livro: Livro | null };

export type Perfil = {
  nome: string;
  canal: number;
  esportes: readonly Esporte[];
  ligas: readonly string[];
  sharpMode: SharpMode;
  valorUnidade: number;
  capitalInicial: number;
  casa: string;
  apostas: number;
  /** Vantagem sobre a probabilidade implícita da odd: positiva ganha, negativa perde. */
  edge: number;
  clvMedio: number;
  /** Peso de cada família de mercado do esporte, na ordem de `PALPITES`. */
  pesos?: readonly number[];
};

export const PERFIS: readonly Perfil[] = [
  { nome: "Green Europa", canal: 1, esportes: ["Soccer"], ligas: ["premier", "laliga", "seriea", "bundesliga"], sharpMode: "CLV_ONLY", valorUnidade: 50, capitalInicial: 2500, casa: "Bet365", apostas: 95, edge: 0.12, clvMedio: 3.1, pesos: [3, 4, 2.5, 0.5] },
  { nome: "Asiático do Léo", canal: 2, esportes: ["Soccer"], ligas: ["brasileirao", "argentina", "portugal"], sharpMode: "CLV_ONLY", valorUnidade: 100, capitalInicial: 5000, casa: "Betano", apostas: 80, edge: 0.1, clvMedio: 2.3, pesos: [1, 2, 6, 0] },
  { nome: "Cesta Certa", canal: 3, esportes: ["Basketball"], ligas: ["nba", "euroleague", "nbb"], sharpMode: "CLV_ONLY", valorUnidade: 40, capitalInicial: 2000, casa: "Pinnacle", apostas: 60, edge: 0.09, clvMedio: 1.2 },
  { nome: "Match Point Tips", canal: 4, esportes: ["Tennis"], ligas: ["atpBeijing", "atpTokyo", "wtaWuhan"], sharpMode: "CLV_ONLY", valorUnidade: 30, capitalInicial: 1500, casa: "Betfair", apostas: 55, edge: -0.15, clvMedio: -2.4 },
  { nome: "Clutch eSports", canal: 5, esportes: ["eSports"], ligas: ["cs2", "lol"], sharpMode: "CLV_ONLY", valorUnidade: 25, capitalInicial: 1000, casa: "Stake", apostas: 40, edge: 0.08, clvMedio: 1.9 },
  { nome: "Gelo Fino NHL", canal: 6, esportes: ["Hockey"], ligas: ["nhl"], sharpMode: "IDENTITY_ONLY", valorUnidade: 50, capitalInicial: 2000, casa: "Bet365", apostas: 30, edge: 0.07, clvMedio: 0 },
  { nome: "Rede Vôlei", canal: 7, esportes: ["Volleyball"], ligas: ["superliga", "superlega"], sharpMode: "OFF", valorUnidade: 20, capitalInicial: 500, casa: "Betano", apostas: 12, edge: 0.06, clvMedio: 0 },
  { nome: "Multi Tips", canal: 8, esportes: ["Soccer", "Basketball"], ligas: ["premier", "brasileirao", "nba", "euroleague"], sharpMode: "CLV_ONLY", valorUnidade: 60, capitalInicial: 3000, casa: "Bet365", apostas: 45, edge: 0.07, clvMedio: 0.8 },
];

export function demoChannelId(canal: number): bigint {
  return DEMO_CHANNEL_BASE - BigInt(canal);
}

// ─────────────────────────── Sorteio reproduzível ───────────────────────────

/** mulberry32: semente fixa, a mesma sequência a cada execução. */
export function gerador(semente: number) {
  let a = semente >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
  const between = (min: number, max: number) => min + (max - min) * next();
  const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)]!;
  const weighted = (weights: readonly number[]) => {
    let r = next() * weights.reduce((sum, w) => sum + w, 0);
    for (let i = 0; i < weights.length; i++) if ((r -= weights[i]!) < 0) return i;
    return weights.length - 1;
  };
  // Box-Muller: o CLV de um canal espalha em torno da média dele.
  const normal = (mean: number, sd: number) => mean + sd * Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, between, pick, weighted, normal };
}
export type Rng = ReturnType<typeof gerador>;

const odd = (rng: Rng, min: number, max: number) => roundMoney(rng.between(min, max), 2);
const signed = (line: number) => (line > 0 ? `+${line}` : String(line));

export type Jogo = { home: string; away: string };

/** Famílias de mercado por esporte, com os nomes do catálogo e a seleção no estilo da Pinnacle. */
const PALPITES: Record<Esporte, ReadonlyArray<(rng: Rng, jogo: Jogo, liga: Liga) => Palpite>> = {
  Soccer: [
    (rng, { home, away }) => {
      const lado = rng.weighted([5, 1.2, 3]);
      const selecao = [home, "Draw", away][lado]!;
      return { mercado: "Money Line – Match", selecao, odds: odd(rng, lado === 1 ? 2.9 : 1.55, lado === 1 ? 3.2 : 3.1),
        livro: { tipo: "moneyline", nome: "Money Line – Match", linha: null, lado: (["home", "draw", "away"] as const)[lado]!, tresVias: true } };
    },
    (rng) => {
      const linha = rng.pick([2.5, 2.5, 2.25, 2.75, 3, 1.5, 3.5]);
      const over = rng.next() < 0.6;
      return { mercado: "Total – Match", selecao: `${over ? "Over" : "Under"} ${linha}`, odds: odd(rng, 1.72, 2.12),
        livro: { tipo: "total", nome: "Total – Match", linha, lado: over ? "over" : "under", tresVias: false } };
    },
    (rng, { home, away }) => {
      const casa = rng.next() < 0.6;
      const linha = rng.pick([-0.5, -0.25, -0.75, -1, 0, 0.25, 0.5, -1.5, 0.75]);
      return { mercado: "Handicap – Match", selecao: `${casa ? home : away} ${linha === 0 ? "0" : signed(linha)}`, odds: odd(rng, 1.78, 2.15),
        livro: { tipo: "spread", nome: "Handicap – Match", linha: casa ? linha : -linha, lado: casa ? "home" : "away", tresVias: false } };
    },
    // A Pinnacle não tem este livro: a aposta fica sem fechamento, como na operação.
    (rng) => ({ mercado: "Both Teams to Score", selecao: rng.next() < 0.7 ? "Yes" : "No", odds: odd(rng, 1.65, 2.05), livro: null }),
  ],
  Basketball: [
    (rng, { home, away }) => {
      const casa = rng.next() < 0.55;
      return { mercado: "Money Line – Match", selecao: casa ? home : away, odds: odd(rng, 1.5, 2.9),
        livro: { tipo: "moneyline", nome: "Money Line – Match", linha: null, lado: casa ? "home" : "away", tresVias: false } };
    },
    (rng, { home, away }) => {
      const casa = rng.next() < 0.5;
      const linha = rng.pick([-1.5, -2.5, -3.5, -4.5, -5.5, -7.5, 2.5, 4.5, 6.5]);
      return { mercado: "Handicap – Match", selecao: `${casa ? home : away} ${signed(linha)}`, odds: odd(rng, 1.83, 2.02),
        livro: { tipo: "spread", nome: "Handicap – Match", linha: casa ? linha : -linha, lado: casa ? "home" : "away", tresVias: false } };
    },
    (rng, _jogo, liga) => {
      const base = liga.competicao === "NBA" ? 224 : 160;
      const linha = Math.round(rng.between(base - 9, base + 9)) + 0.5;
      const over = rng.next() < 0.5;
      return { mercado: "Total – Match", selecao: `${over ? "Over" : "Under"} ${linha}`, odds: odd(rng, 1.83, 2),
        livro: { tipo: "total", nome: "Total – Match", linha, lado: over ? "over" : "under", tresVias: false } };
    },
  ],
  Tennis: [
    (rng, { home, away }) => {
      const casa = rng.next() < 0.5;
      return { mercado: "Money Line – Match", selecao: casa ? home : away, odds: odd(rng, 1.5, 3.2),
        livro: { tipo: "moneyline", nome: "Money Line – Match", linha: null, lado: casa ? "home" : "away", tresVias: false } };
    },
    (rng, { home, away }) => {
      const casa = rng.next() < 0.5;
      const linha = rng.pick([-2.5, -3.5, -4.5, 2.5, 3.5, -1.5]);
      return { mercado: "Handicap (Games) – Match", selecao: `${casa ? home : away} ${signed(linha)}`, odds: odd(rng, 1.8, 2.05),
        livro: { tipo: "spread", nome: "Handicap (Games) – Match", linha: casa ? linha : -linha, lado: casa ? "home" : "away", tresVias: false } };
    },
    (rng) => {
      const linha = rng.pick([20.5, 21.5, 22.5, 23.5]);
      const over = rng.next() < 0.55;
      return { mercado: "Total (Games) – Match", selecao: `${over ? "Over" : "Under"} ${linha}`, odds: odd(rng, 1.8, 2.05),
        livro: { tipo: "total", nome: "Total (Games) – Match", linha, lado: over ? "over" : "under", tresVias: false } };
    },
  ],
  eSports: [
    (rng, { home, away }) => {
      const casa = rng.next() < 0.5;
      return { mercado: "Money Line – Match", selecao: casa ? home : away, odds: odd(rng, 1.5, 3),
        livro: { tipo: "moneyline", nome: "Money Line – Match", linha: null, lado: casa ? "home" : "away", tresVias: false } };
    },
    (rng, { home, away }) => {
      const casa = rng.next() < 0.5;
      const linha = rng.pick([-1.5, 1.5]);
      return { mercado: "Handicap – Match", selecao: `${casa ? home : away} ${signed(linha)}`, odds: odd(rng, linha < 0 ? 2.1 : 1.5, linha < 0 ? 3.1 : 1.95),
        livro: { tipo: "spread", nome: "Handicap – Match", linha: casa ? linha : -linha, lado: casa ? "home" : "away", tresVias: false } };
    },
  ],
  Hockey: [
    (rng, { home, away }) => {
      const casa = rng.next() < 0.55;
      return { mercado: "Money Line – Match", selecao: casa ? home : away, odds: odd(rng, 1.6, 2.6),
        livro: { tipo: "moneyline", nome: "Money Line – Match", linha: null, lado: casa ? "home" : "away", tresVias: false } };
    },
    (rng, { home, away }) => {
      const casa = rng.next() < 0.5;
      const linha = rng.pick([-1.5, 1.5]);
      return { mercado: "Puck Line", selecao: `${casa ? home : away} ${signed(linha)}`, odds: odd(rng, linha < 0 ? 2.2 : 1.5, linha < 0 ? 3.2 : 1.75),
        livro: { tipo: "spread", nome: "Puck Line", linha: casa ? linha : -linha, lado: casa ? "home" : "away", tresVias: false } };
    },
    (rng) => {
      const linha = rng.pick([5.5, 6.5]);
      const over = rng.next() < 0.5;
      return { mercado: "Total – Match", selecao: `${over ? "Over" : "Under"} ${linha}`, odds: odd(rng, 1.8, 2.1),
        livro: { tipo: "total", nome: "Total – Match", linha, lado: over ? "over" : "under", tresVias: false } };
    },
  ],
  Volleyball: [
    (rng, { home, away }) => {
      const casa = rng.next() < 0.55;
      return { mercado: "Money Line – Match", selecao: casa ? home : away, odds: odd(rng, 1.5, 2.8), livro: null };
    },
    (rng, { home, away }) => {
      const casa = rng.next() < 0.5;
      return { mercado: "Handicap (Sets) – Match", selecao: `${casa ? home : away} ${signed(rng.pick([-1.5, 1.5]))}`, odds: odd(rng, 1.6, 2.4), livro: null };
    },
  ],
};

/**
 * Livro da Pinnacle com a fair odd `fair` no lado apostado e margem de ~3%.
 * Dois lados: devig power (o do resolvedor); três: margem proporcional.
 */
function livroPinnacle(livro: Livro, jogo: Jogo, kickoff: Date, fair: number, rng: Rng): Pinnacle17Market {
  const pSel = 1 / fair;
  const lados = livro.tipo === "total" ? (["over", "under"] as const)
    : livro.tresVias ? (["home", "draw", "away"] as const) : (["home", "away"] as const);
  const resto = lados.filter((lado) => lado !== livro.lado);
  const split = rng.between(0.35, 0.65);
  const probs = lados.map((lado) => lado === livro.lado ? pSel
    : resto.length === 1 ? 1 - pSel : (1 - pSel) * (lado === resto[0] ? split : 1 - split));
  const raws = probs.map((p) => roundMoney(lados.length === 2 ? 1 / Math.pow(p, 1 / 1.045) : 1 / (p * 1.03), 3));
  const nomes: Record<string, string> = { home: jogo.home, away: jogo.away, draw: "Draw", over: "Over", under: "Under" };
  const linhaDo = (lado: string) => livro.tipo === "total" ? livro.linha : livro.tipo === "spread" ? (lado === "home" ? livro.linha : -livro.linha!) : null;
  return {
    name: livro.nome, type: livro.tipo, period: 0, periodName: "Match", team: null, units: "Regular", special: null,
    isLive: false, line: livro.linha, status: "open", cutoffAt: kickoff.toISOString(),
    limits: [{ amount: Math.round(rng.between(500, 5000)), type: "maxRiskStake" }],
    outcomes: lados.map((lado, i) => ({ designation: lado, name: nomes[lado]!, line: linhaDo(lado), oddsAmerican: null, oddsDecimal: raws[i]! })),
  };
}

// ─────────────────────────── Plano das apostas ───────────────────────────

type Momento = "historica" | "hoje" | "iniciada" | "futura";
type ApostaPlanejada = {
  perfil: Perfil;
  esporte: Esporte;
  liga: Liga;
  jogo: Jogo;
  palpite: Palpite;
  stake: number;
  kickoff: Date;
  postedAt: Date;
  momento: Momento;
  eventId: number;
};

function horarioSp(dayStart: Date, horas: number): Date {
  return new Date(dayStart.getTime() + horas * HOUR);
}

function planejarBanca(perfil: Perfil, indice: number, now: Date, rng: Rng, escala: number): ApostaPlanejada[] {
  const today = spStartOfTodayUtc(now);
  const n = Math.max(4, Math.round(perfil.apostas * escala));
  const futuras = Math.max(1, Math.round(n * 0.06));
  const iniciadas = Math.max(1, Math.round(n * 0.04));
  const hoje = perfil.apostas >= 30 ? Math.max(1, Math.round(n * 0.05)) : 0;
  const momentos: Momento[] = Array.from({ length: n }, (_, i) =>
    i < futuras ? "futura" : i < futuras + iniciadas ? "iniciada" : i < futuras + iniciadas + hoje ? "hoje" : "historica");
  return momentos.map((momento, i) => {
    const esporte = rng.pick(perfil.esportes);
    const ligasDoEsporte = perfil.ligas.filter((chave) => chave in LIGAS[esporte]);
    const liga = LIGAS[esporte][rng.pick(ligasDoEsporte)]!;
    const home = rng.pick(liga.times);
    const jogo = { home, away: rng.pick(liga.times.filter((t) => t !== home)) };
    const familias = PALPITES[esporte];
    const pesos = esporte === perfil.esportes[0] && perfil.pesos ? perfil.pesos : familias.map(() => 1);
    const palpite = familias[rng.weighted(pesos)]!(rng, jogo, liga);
    let kickoff: Date;
    let postedAt: Date;
    if (momento === "futura") {
      kickoff = new Date(now.getTime() + rng.between(40 * MINUTE, 30 * HOUR));
      postedAt = new Date(now.getTime() - rng.between(2 * MINUTE, 3 * HOUR));
    } else if (momento === "iniciada") {
      kickoff = new Date(now.getTime() - rng.between(15 * MINUTE, 95 * MINUTE));
      postedAt = new Date(kickoff.getTime() - rng.between(30 * MINUTE, 6 * HOUR));
    } else if (momento === "hoje") {
      kickoff = new Date(now.getTime() - rng.between(2.2 * HOUR, 5 * HOUR));
      postedAt = new Date(kickoff.getTime() - rng.between(30 * MINUTE, 7 * HOUR));
    } else {
      // Mais apostas perto de hoje: o canal cresceu nos últimos dois meses.
      const diasAtras = 1 + Math.floor((HISTORY_DAYS - 1) * (1 - Math.sqrt(rng.next())));
      kickoff = horarioSp(new Date(today.getTime() - diasAtras * DAY), rng.pick(liga.horas));
      postedAt = new Date(kickoff.getTime() - rng.between(25 * MINUTE, 9 * HOUR));
    }
    const stake = rng.pick([0.5, 0.75, 1, 1, 1, 1.25, 1.5, 1.5, 2, 2, 2.5, 3]);
    return { perfil, esporte, liga, jogo, palpite, stake, kickoff, postedAt, momento, eventId: 1_620_000_000 + indice * 10_000 + i };
  });
}

// ─────────────────────────── Resultado ───────────────────────────

function sortearResultado(aposta: ApostaPlanejada, mercado: string, selecao: string, rng: Rng): { status: BetStatus; cashoutLucro?: number } {
  const r = rng.next();
  if (r < 0.008) return { status: "CANCELED" };
  // Jogo adiado ou abandonado: a casa devolve a stake.
  if (r < 0.02) return { status: "VOID" };
  const p = Math.min(0.95, (1 / aposta.palpite.odds) * (1 + aposta.perfil.edge));
  if (r < 0.034) {
    // Cashout: parte do lucro possível, ou parte da stake de volta.
    const ganho = rng.next() < p;
    return { status: "CASHOUT", cashoutLucro: roundMoney(ganho ? aposta.stake * (aposta.palpite.odds - 1) * rng.between(0.3, 0.7) : -aposta.stake * rng.between(0.3, 0.7), 2) };
  }
  const linha = aposta.palpite.livro?.linha;
  const quarto = admitsAsianFractionalSettlement(mercado, selecao);
  const inteira = linha != null && Number.isInteger(linha) && aposta.palpite.livro?.tipo !== "moneyline";
  const s = rng.next();
  if (inteira && s < 0.12) return { status: "VOID" };
  const ganhou = rng.next() < p;
  if (quarto && s < 0.3) return { status: ganhou ? "HALF_WON" : "HALF_LOST" };
  return { status: ganhou ? "WON" : "LOST" };
}

// ─────────────────────────── Gravação ───────────────────────────

export type ResumoDemo = {
  bancas: number;
  apostas: number;
  liquidadas: number;
  liquidadasHoje: number;
  porStatus: Partial<Record<BetStatus, number>>;
  pendentesIniciadas: number;
  pendentesFuturas: number;
  pegas: number;
  comFechamento: number;
  comClvConfiavel: number;
  lucroUnidades: number;
  apagadas: { bancas: number; apostas: number };
};

/** Apaga as bancas de exemplo de execuções anteriores (e só elas), pelo mesmo serviço do painel. */
async function apagarDadosDemo(): Promise<{ bancas: number; apostas: number }> {
  const canais = PERFIS.map((perfil) => demoChannelId(perfil.canal));
  const bancas = await prisma.bankroll.findMany({
    where: { telegramChannelId: { in: canais } },
    select: { id: true, nome: true, _count: { select: { bets: true } } },
  });
  const criadas = new Set((await prisma.auditEvent.findMany({
    where: { action: "bankroll.create", actor: DEMO_ACTOR, resourceId: { in: bancas.map((b) => b.id) } },
    select: { resourceId: true },
  })).map((row) => row.resourceId));
  const alheia = bancas.find((banca) => !criadas.has(banca.id));
  if (alheia) throw new Error(`O tipster "${alheia.nome}" usa um canal de exemplo, mas não foi criado por ${DEMO_ACTOR}: nada foi apagado.`);
  let apostas = 0;
  for (const banca of bancas) {
    await excluirBankroll(banca.id, DEMO_ACTOR, { expectedBetCount: banca._count.bets });
    apostas += banca._count.bets;
  }
  // A exclusão aposenta as origens para o post editado não recriar a aposta; aqui o post é fictício e volta na próxima execução.
  await prisma.retiredBetSource.deleteMany({ where: { source: { in: canais.map((c) => telegramChannelSource(c)) } } });
  return { bancas: bancas.length, apostas };
}

async function criarBancas(now: Date): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const perfil of PERFIS) {
    const { id } = await criarBankroll({
      nome: perfil.nome, valorUnidade: perfil.valorUnidade, capitalInicial: perfil.capitalInicial, sharpMode: perfil.sharpMode,
      capturePolicy: "AUTO", stakePolicy: "MESSAGE", defaultStakeUnits: null, vincularContas: true,
      telegramChannelId: String(demoChannelId(perfil.canal)), defaultBookmaker: perfil.casa,
      channelSports: perfil.esportes.length === 1 ? perfil.esportes : [],
    }, DEMO_ACTOR);
    ids.set(perfil.canal, id);
  }
  // A banca "existe" desde antes da primeira aposta de exemplo.
  const desde = new Date(now.getTime() - (HISTORY_DAYS + 2) * DAY);
  await prisma.bankroll.updateMany({ where: { id: { in: [...ids.values()] } }, data: { createdAt: desde } });
  await prisma.auditEvent.updateMany({ where: { action: "bankroll.create", resourceId: { in: [...ids.values()] } }, data: { createdAt: desde } });
  return ids;
}

export type Gravada = { betId: string; mercado: string; selecao: string; evento: string };

const EMOJI: Record<Esporte, string> = { Soccer: "⚽", Basketball: "🏀", Tennis: "🎾", eSports: "🎮", Hockey: "🏒", Volleyball: "🏐" };

/**
 * O post do tipster como a captura o leu: o jogo, o palpite, o horário e o
 * esporte que o resolvedor decidiu.
 */
export type PostLido = {
  perfil: Perfil;
  esporte: Esporte;
  liga: Liga;
  jogo: Jogo;
  mercado: string;
  selecao: string;
  odds: number;
  stake: number;
  kickoff: Date;
  postedAt: Date;
  /** O post disse só o dia do jogo: o horário fica inferido. */
  kickoffDateOnly?: boolean;
  /** O resolvedor não confirmou o esporte (nome que existe em dois esportes do canal). */
  esporteNaoConfirmado?: boolean;
  legs?: BetLegsTicket;
};

/** O post gravado pelo registro único da captura. */
export async function registrar(post: PostLido, bankrollId: string, messageId: number): Promise<Gravada | null> {
  const { perfil, esporte, liga, jogo } = post;
  const canonical = await canonicalizeBetForRegistration({
    evento: `${jogo.home} vs ${jogo.away}`, esporte, competicao: liga.competicao, pais: liga.pais,
    mercado: post.mercado, selecao: post.selecao,
  });
  const umEsporte = perfil.esportes.length === 1;
  const source = umEsporte ? "CHANNEL" as const : "COMPETITION" as const;
  const sportResolution = post.esporteNaoConfirmado
    ? { sport: null, status: "CONFLICT" as const, confidence: 55, source, resolverVersion: SPORT_RESOLVER_VERSION,
        evidence: perfil.esportes.map((sport) => ({ source, sport, confidence: 55, value: `${jogo.home} vs ${jogo.away}` })) }
    : { sport: esporte, status: "CONFIRMED" as const, confidence: 100, source, resolverVersion: SPORT_RESOLVER_VERSION,
        evidence: [{ source, sport: esporte, confidence: 100, value: umEsporte ? perfil.nome : liga.competicao }] };
  const { result } = await registerCapturedBet({
    bankroll: { id: bankrollId, defaultBookmaker: perfil.casa },
    bet: {
      ...canonical, odds: post.odds, stake: post.stake, data: post.kickoff, kickoffDateOnly: post.kickoffDateOnly ?? false,
      casaDeAposta: perfil.casa, stakeSource: "caption", sportResolution,
      ...(post.legs ? { legs: post.legs } : {}),
    },
    origin: {
      source: telegramChannelSource(demoChannelId(perfil.canal)), sourceExternalId: String(messageId),
      enteredAt: post.postedAt, parser: "universal", actor: DEMO_ACTOR,
      caption: `${EMOJI[esporte]} ${jogo.home} x ${jogo.away}\n🏆 ${liga.competicao}\n📌 ${post.selecao}\n💰 @${post.odds.toFixed(2)} | ${post.stake}u`,
    },
  });
  if (!result.created) return null;
  const bet = await prisma.bet.findUniqueOrThrow({ where: { id: result.betId }, select: { mercado: true, selecao: true, evento: true } });
  return { betId: result.betId, ...bet };
}

/** Identidade casada na Pinnacle17, como o enrich grava: jogo e referência do preço. */
async function casarIdentidade(aposta: ApostaPlanejada, gravada: Gravada, rng: Rng): Promise<void> {
  if (aposta.perfil.sharpMode === "OFF") return;
  let priceReference: string | null = null;
  let noOddsReason: "identity_only" | "unsupported_market" | null = aposta.perfil.sharpMode === "IDENTITY_ONLY" ? "identity_only" : null;
  const event = persistedPinnacle17Event({ evento: gravada.evento, esporte: aposta.esporte, data: aposta.kickoff }, aposta.eventId);
  if (!noOddsReason && aposta.palpite.livro && event) {
    const book = livroPinnacle(aposta.palpite.livro, aposta.jogo, aposta.kickoff, aposta.palpite.odds, rng);
    const resolved = resolvePinnacle17CurrentOdds({ event, markets: [book], esporte: aposta.esporte, mercado: gravada.mercado,
      selecao: gravada.selecao, observedAt: aposta.postedAt, now: aposta.postedAt });
    if (resolved.ok) priceReference = encodePinnacle17PriceReference(resolved.value.reference);
    else noOddsReason = "unsupported_market";
  } else if (!noOddsReason) {
    noOddsReason = "unsupported_market";
  }
  await upsertSharp(gravada.betId, {
    identityStatus: "MATCHED", confidence: Math.round(rng.between(90, 100)), provider: "pinnacle17",
    providerMatchId: String(aposta.eventId), priceReference, noOddsReason,
  });
}

type Fechamento = "confiavel" | "cedo" | "sem_captura" | "nenhum";

/**
 * Fechamento pela série da Pinnacle17: a cotação dos minutos finais entra por
 * `applyClosingQuote` e o apito congela por `finalizeClosingSeries`, cada um
 * com o relógio daquele instante.
 */
async function fechar(aposta: ApostaPlanejada, gravada: Gravada, now: Date, rng: Rng): Promise<Fechamento> {
  if (aposta.perfil.sharpMode !== "CLV_ONLY" || aposta.momento === "futura" || !aposta.palpite.livro) return "nenhum";
  const r = rng.next();
  const tipo: Fechamento = r < 0.8 ? "confiavel" : r < 0.87 ? "cedo" : r < 0.94 ? "sem_captura" : "nenhum";
  if (tipo === "nenhum") return tipo;
  const kickoff = aposta.kickoff.getTime();
  if (tipo !== "sem_captura") {
    const bet = await readClosingBet(gravada.betId);
    if (!closingBetEligible(bet)) return "nenhum";
    const clv = Math.max(-15, Math.min(18, rng.normal(aposta.perfil.clvMedio, 4.2)));
    const fair = aposta.palpite.odds / (1 + clv / 100);
    if (fair <= 1.02) return "nenhum";
    const observedAt = new Date(kickoff - (tipo === "confiavel" ? rng.between(20_000, 9 * MINUTE) : rng.between(22 * MINUTE, 55 * MINUTE)));
    const quote = resolveClosingMarkets(bet, [livroPinnacle(aposta.palpite.livro, aposta.jogo, aposta.kickoff, fair, rng)], observedAt);
    if (!quote || !await applyClosingQuote(bet, quote, "primary", new Date(observedAt.getTime() + 4_000))) return "nenhum";
  }
  const apito = new Date(Math.min(kickoff + rng.between(2 * MINUTE, 12 * MINUTE), now.getTime() - 1_000));
  const bet = await readClosingBet(gravada.betId);
  if (!bet || apito.getTime() < kickoff || !await finalizeClosingSeries(bet, apito)) return "nenhum";
  return tipo;
}

/**
 * Resultado pela transação da liquidação manual (a do painel e do
 * `ops-settle`). Os efeitos pós-commit (`finishBetStatusChange`) ficam de
 * fora: mexeriam na fila do pg-boss, que no banco de desenvolvimento não tem
 * worker, e a ação "liquidada sem conta" não nasce sem contas cadastradas.
 */
export async function liquidar(gravada: Gravada, resultado: { status: BetStatus; cashoutLucro?: number }): Promise<number> {
  const applied = await runSerializableTransaction("dev.demo.settle", (tx) => applyManualBetStatusChangeTx(tx, {
    betId: gravada.betId, newStatus: resultado.status, cashoutLucro: resultado.cashoutLucro,
    source: `manual:${DEMO_ACTOR}`, requirePending: true,
  }));
  return applied.lucro;
}

/** 👍 anônimo no post do canal, pelo mesmo caminho do bot: a aposta fica marcada como pega. */
async function marcarPega(aposta: ApostaPlanejada, messageId: number, at: Date, updateId: number): Promise<boolean> {
  const outcome = await handleChannelReaction({
    chatId: demoChannelId(aposta.perfil.canal), messageId, emojis: ["👍"], thumbsDownPresent: false,
    occurredAt: at.toISOString(), updateId,
  });
  return outcome.kind === "taken";
}

/**
 * Os serviços gravam com o relógio de agora. A aposta de 40 dias atrás precisa
 * do registro e da liquidação no dia dela, porque o Dashboard e as curvas
 * contam por `registradoEm` e `settledAt`: só esses instantes (e os eventos da
 * própria aposta que os repetem) voltam no tempo, sem mexer em valor.
 */
export async function voltarNoTempo(betId: string, registradoEm: Date, settledAt: Date | null): Promise<void> {
  await prisma.$executeRaw`
    UPDATE bets SET "registradoEm" = ${registradoEm},
      "settledAt" = CASE WHEN status = 'PENDING' THEN NULL ELSE ${settledAt}::timestamptz END
    WHERE id = ${betId}`;
  await prisma.$executeRaw`
    UPDATE audit_events SET "createdAt" = ${registradoEm}
    WHERE resource = 'bet' AND "resourceId" = ${betId} AND action = 'bet.create'`;
  await prisma.$executeRaw`
    UPDATE audit_events SET "createdAt" = (details->>'observedAt')::timestamptz
    WHERE resource = 'bet' AND "resourceId" = ${betId} AND action = 'closing.series.price_applied'`;
  await prisma.$executeRaw`UPDATE bet_closing SET "updatedAt" = "fetchedAt" WHERE "betId" = ${betId} AND "fetchedAt" IS NOT NULL`;
  if (!settledAt) return;
  // A ficha mostra o `changedAt` do evento; o hash de idempotência acompanha o payload.
  for (const event of await prisma.settlementEvent.findMany({ where: { betId } })) {
    const payload = { ...(event.payload as Record<string, unknown>), changedAt: settledAt.toISOString() };
    await prisma.settlementEvent.update({
      where: { id: event.id },
      data: { payload: payload as Prisma.InputJsonObject, payloadHash: canonicalSha256(payload), createdAt: settledAt },
    });
  }
}

/**
 * `escala` reduz o volume de apostas de cada banca (o teste usa uma fração); o
 * padrão é o painel cheio. As datas saem do relógio real: o registro e a
 * liquidação recusam post no futuro e jogo que não começou.
 */
export async function gerarDadosDemo(options: { semente?: number; escala?: number } = {}): Promise<ResumoDemo> {
  const now = new Date();
  const rng = gerador(options.semente ?? SEMENTE);
  await seedMercados(prisma);
  const apagadas = await apagarDadosDemo();
  const bancas = await criarBancas(now);
  const today = spStartOfTodayUtc(now);
  const resumo: ResumoDemo = {
    bancas: bancas.size, apostas: 0, liquidadas: 0, liquidadasHoje: 0, porStatus: {}, pendentesIniciadas: 0,
    pendentesFuturas: 0, pegas: 0, comFechamento: 0, comClvConfiavel: 0, lucroUnidades: 0, apagadas,
  };
  const podeReagir = telegramOwnerId() !== null;
  let updateId = 1;

  for (const [indice, perfil] of PERFIS.entries()) {
    const bankrollId = bancas.get(perfil.canal)!;
    // O id da mensagem cresce com a hora do post, como no canal.
    const plano = planejarBanca(perfil, indice, now, rng, options.escala ?? 1).sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime());
    for (const [i, aposta] of plano.entries()) {
      const messageId = 1_000 + i * 3;
      const gravada = await registrar({ ...aposta, ...aposta.palpite }, bankrollId, messageId);
      if (!gravada) continue;
      // O registro real usa agora; o fechamento histórico precisa ver a aposta já existente no instante da cotação.
      const registeredAt = new Date(aposta.postedAt.getTime() + rng.between(4_000, 50_000));
      await prisma.bet.update({ where: { id: gravada.betId }, data: { registradoEm: registeredAt } });
      resumo.apostas++;
      await casarIdentidade(aposta, gravada, rng);
      const fechamento = await fechar(aposta, gravada, now, rng);
      if (fechamento !== "nenhum") resumo.comFechamento++;
      if (fechamento === "confiavel") resumo.comClvConfiavel++;

      let settledAt: Date | null = null;
      if (aposta.momento === "historica" || aposta.momento === "hoje") {
        const resultado = sortearResultado(aposta, gravada.mercado, gravada.selecao, rng);
        const lucro = await liquidar(gravada, resultado);
        const depoisDoJogo = aposta.kickoff.getTime() + rng.between(105 * MINUTE, 200 * MINUTE);
        const piso = aposta.momento === "hoje" ? today.getTime() + MINUTE : 0;
        settledAt = new Date(Math.min(Math.max(depoisDoJogo, piso), now.getTime() - MINUTE));
        resumo.liquidadas++;
        if (settledAt >= today) resumo.liquidadasHoje++;
        resumo.porStatus[resultado.status] = (resumo.porStatus[resultado.status] ?? 0) + 1;
        resumo.lucroUnidades = roundMoney(resumo.lucroUnidades + lucro);
      } else if (aposta.momento === "iniciada") {
        resumo.pendentesIniciadas++;
      } else {
        resumo.pendentesFuturas++;
      }
      const reagiu = aposta.momento !== "historica" && aposta.momento !== "hoje" && podeReagir && rng.next() < 0.4;
      if (reagiu) {
        const at = new Date(Math.min(aposta.postedAt.getTime() + rng.between(MINUTE, 20 * MINUTE), now.getTime() - 1_000));
        if (await marcarPega(aposta, messageId, at, updateId++)) resumo.pegas++;
      }
      await voltarNoTempo(gravada.betId, registeredAt, settledAt);
    }
  }
  return resumo;
}

