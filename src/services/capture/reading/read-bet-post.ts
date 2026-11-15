import type { CaptureImage, ParsedBetPost } from "@/src/domain/bet-capture";
import type { CaptureOcrEvidence } from "@/src/domain/capture-ocr-evidence";
import type { CapturePolicy } from "@/src/domain/capture-policy";
import type { CaptureStakeSettings } from "@/src/domain/capture-stake-policy";
import { parseUniversalBetPost } from "@/src/domain/parse-bet-post";
import type { LlmProviderId, SourceMessageRef } from "@/src/infra/llm/cascade";
import { createLogger } from "@/src/infra/logger";
import type { PostImages } from "@/src/services/capture/preparation/parse-capture-handicap-retry";
import type { CaptureFixOption } from "@/src/services/capture/capture-fix";
import {
  extractBetFromImage,
  extractBetFromText,
  extractBetsFromImages,
  extractPlayerBetsFromImage,
  type ExtractBetResult,
} from "./extract-bet";
import { isIncompleteNumericDraft, isPhotoCaptionIncompleteDraft } from "./incomplete-draft";
import { isResultRecap, looksLikeChannelBetPost } from "./noise-filter";

/*
 * A leitura de um post de aposta, do canal ou da DM: a regra local primeiro,
 * os porteiros que poupam a IA (recapitulação, ruído, rascunho) e a cascata de
 * IA, com o desfecho numa união só. Quem chama decide o que cada desfecho
 * vira (aposta, post guardado, pergunta ao dono, resposta na conversa); aqui
 * nada é gravado nem avisado.
 */

const log = createLogger("capture-reading");

/** Quem leu a aposta: a regra local (`universal`) ou um provedor de IA, com `-vision` quando leu a imagem. */
export type CaptureVia = "universal" | LlmProviderId | `${LlmProviderId}-vision`;

/** O post como chegou. A foto só é baixada depois que os porteiros deixam a leitura seguir. */
export type BetPostSource =
  | {
      kind: "text";
      text: string;
      /**
       * Filtro anti-ruído: o texto que a regra não lê e não tem cara de aposta
       * não vai à IA. Só o texto do canal passa por ele, sem pedido do dono.
       * A cara de aposta é medida com a configuração da banca de agora; a
       * leitura que vale usa a presa ao post, e a regra só roda de novo
       * quando as duas diferem.
       */
      noiseFilter?: { stakeSettings: CaptureStakeSettings };
    }
  /** A foto não passa pelo filtro anti-ruído: o print é o bilhete. */
  | {
      kind: "photo";
      caption: string;
      fileId: string;
      /** Fotos do álbum com imagem, lidas juntas só pela banca que lê a stake da imagem. */
      albumFileIds?: readonly string[];
      loadImage: (fileId: string) => Promise<CaptureImage>;
    };

/** Configuração financeira presa ao post, com o que a leitura da imagem usa da banca. */
type ReadingStakeSettings = CaptureStakeSettings & { capturePolicy?: CapturePolicy; imageStakeAsUnits?: boolean };

export type ReadingContext = {
  /** Data do post: referência do kickoff lido. */
  now: Date;
  /** A configuração presa ao post (canal); a DM lê sem ela, porque a stake é a que o dono confirma. */
  stakeSettings?: ReadingStakeSettings;
  /** Post de origem, para as métricas dos modelos apontarem a mensagem. */
  itemRef?: SourceMessageRef;
  /**
   * Porteiros antes da IA, no texto e na foto: a recapitulação não é lida, e
   * o rascunho que espera a edição do tipster também não.
   */
  gates: { recap: boolean; draft: boolean };
  /**
   * O dono pediu a captura do post do canal ("Capturar mesmo assim", 👍): a
   * odd ou a stake que o texto não escreve entra como 0, para o guard recusar
   * e o conserto pela DM perguntar.
   */
  askMissingNumbers?: boolean;
};

type ExtractionReview = Extract<ExtractBetResult, { review: object }>["review"];

export type ReadingResult =
  /**
   * Apostas lidas, pela regra ou pela IA. `oddsMissing`: o post só traz a odd
   * mínima, e a odd não chega numa edição (as apostas vêm com a odd 0). Na
   * foto, `pages` são as páginas do post para as releituras do guard.
   */
  | {
      kind: "bets";
      /** A primeira aposta lida; `bets` traz todas (lote), na ordem da leitura. */
      bet: ParsedBetPost;
      bets: ParsedBetPost[];
      via: CaptureVia;
      oddsMissing?: true;
      pages?: PostImages;
      /** Páginas do álbum lidas juntas, que a evidência guarda. */
      albumFileIds?: string[];
    }
  /** Leitura incompleta: falta número ou há revisão pendente. `byRule`: o porteiro parou antes da IA. */
  | { kind: "draft"; missing: string[]; byRule: boolean; review?: ExtractionReview; ocrEvidence?: CaptureOcrEvidence }
  /** Um porteiro barrou o post antes de qualquer leitura por IA. */
  | { kind: "skipped"; reason: "resultado_ou_balanco" | "nao_parece_aposta" }
  /** A IA leu e entendeu que não é aposta. `missing`: o que a regra não achou no texto (na foto, a imagem). */
  | { kind: "not_bet"; missing: string[]; ocrEvidence?: CaptureOcrEvidence }
  /**
   * A leitura terminou sem aposta a registrar: todos os provedores recusaram,
   * a resposta aceita não virou aposta, ou a própria leitura ficou em dúvida
   * (`detail`). Com `bet`, a IA leu a aposta, e só falta o dono escolher entre
   * `options` (grade sem a marca do tipster).
   */
  | { kind: "refused"; reason: string; via: CaptureVia | "ia"; detail?: string; bet?: ParsedBetPost; options?: CaptureFixOption[] }
  /**
   * Algum provedor que leria não respondeu: outra tentativa pode ler.
   * `refusalWhenExhausted` é a recusa que vale se as tentativas acabarem.
   */
  | { kind: "unavailable"; missing: string[]; refusalWhenExhausted?: { reason: string } };

/** Dúvidas que a própria leitura declarou (lado ou mercado incerto, grade sem a opção marcada). */
const READING_DOUBTS: ReadonlySet<string> = new Set(["ambiguous_bet", "unmarked_selection", "unsupported_promotion_terms", "unsupported_trading_terms"]);

function sameStakeSettings(a: CaptureStakeSettings | undefined, b: CaptureStakeSettings | undefined): boolean {
  return (a?.stakePolicy ?? null) === (b?.stakePolicy ?? null) && (a?.defaultStakeUnits ?? null) === (b?.defaultStakeUnits ?? null);
}

export async function readBetPost(source: BetPostSource, context: ReadingContext): Promise<ReadingResult> {
  return source.kind === "text" ? readText(source, context) : readPhoto(source, context);
}

async function readText(source: Extract<BetPostSource, { kind: "text" }>, context: ReadingContext): Promise<ReadingResult> {
  const { now, stakeSettings, gates } = context;
  const { text, noiseFilter } = source;
  // Balanço ou recapitulação repete a tip inteira: a regra a leria como aposta nova.
  if (gates.recap && isResultRecap(text)) return { kind: "skipped", reason: "resultado_ou_balanco" };
  const probe = parseUniversalBetPost(text, { now, stakeSettings: noiseFilter?.stakeSettings ?? stakeSettings });
  if (noiseFilter && !probe.ok && !looksLikeChannelBetPost(text)) return { kind: "skipped", reason: "nao_parece_aposta" };
  const parsed = !noiseFilter || sameStakeSettings(noiseFilter.stakeSettings, stakeSettings)
    ? probe
    : parseUniversalBetPost(text, { now, stakeSettings });
  if (parsed.ok) return { kind: "bets", bet: parsed.bet, bets: [parsed.bet], via: "universal" };
  if (gates.draft && isIncompleteNumericDraft(text, parsed.missing)) {
    log.info({ messageId: context.itemRef?.messageId, missing: parsed.missing }, "rascunho sem stake/odd — espera o edit, sem cascata LLM");
    return { kind: "draft", missing: parsed.missing, byRule: true };
  }
  if (context.askMissingNumbers && !parsed.ok && isIncompleteNumericDraft(text, parsed.missing)) {
    const unwritten = parseUniversalBetPost(text, { now, stakeSettings, missingNumbersAsZero: true });
    if (unwritten.ok) return { kind: "bets", bet: unwritten.bet, bets: [unwritten.bet], via: "universal" };
  }
  const extracted = await extractBetFromText(text, now, stakeSettings, context.itemRef);
  return classifyExtraction(extracted, { photo: false, missingWithoutReading: parsed.missing });
}

async function readPhoto(source: Extract<BetPostSource, { kind: "photo" }>, context: ReadingContext): Promise<ReadingResult> {
  const { now, stakeSettings, gates } = context;
  const { caption } = source;
  if (gates.recap && isResultRecap(caption)) return { kind: "skipped", reason: "resultado_ou_balanco" };
  const captionParsed = parseUniversalBetPost(caption, { now, stakeSettings });
  if (gates.draft && !captionParsed.ok && isPhotoCaptionIncompleteDraft(caption, captionParsed.missing)) {
    log.info({ messageId: context.itemRef?.messageId, missing: captionParsed.missing }, "legenda sem stake/odd — espera o edit, sem Vision");
    return { kind: "draft", missing: captionParsed.missing, byRule: true };
  }

  const image = await source.loadImage(source.fileId);
  const albumImages: Array<CaptureImage & { fileId: string }> = [];
  if (stakeSettings?.imageStakeAsUnits) for (const fileId of source.albumFileIds ?? []) {
    albumImages.push({ ...(fileId === source.fileId ? image : await source.loadImage(fileId)), fileId });
  }
  // Banca que lê a stake da imagem em unidades usa o leitor de props/lotes.
  const { itemRef } = context;
  const extracted = albumImages.length && stakeSettings?.imageStakeAsUnits
    ? await extractBetsFromImages(albumImages, caption, now, stakeSettings, itemRef)
    : stakeSettings?.imageStakeAsUnits
      ? await extractPlayerBetsFromImage(image, caption, now, stakeSettings, itemRef)
      : await extractBetFromImage(image, caption, now, stakeSettings, itemRef);
  const reading = classifyExtraction(extracted, { photo: true, missingWithoutReading: ["imagem"] });
  if (reading.kind !== "bets") return reading;
  return {
    ...reading,
    pages: postPages({ image, albumImages, fileId: source.fileId, albumFileIds: source.albumFileIds }, source.loadImage),
    ...(albumImages.length ? { albumFileIds: albumImages.map((page) => page.fileId) } : {}),
  };
}

/**
 * As páginas que as releituras do guard olham: todas as do post. O álbum
 * que o leitor de lote já baixou vem pronto; nos outros, as irmãs da foto
 * lida só são baixadas aqui, quando uma releitura precisa delas.
 */
function postPages(
  read: { image: CaptureImage; albumImages: CaptureImage[]; fileId: string; albumFileIds?: readonly string[] },
  loadImage: (fileId: string) => Promise<CaptureImage>,
): PostImages {
  return async () => {
    if (read.albumImages.length) return read.albumImages;
    const fileIds = read.albumFileIds ?? [];
    if (fileIds.length < 2) return [read.image];
    return Promise.all(fileIds.map((fileId) => (fileId === read.fileId ? read.image : loadImage(fileId))));
  };
}

/** O desfecho da cascata de IA na leitura: cada desfecho da extração vira um só. */
function classifyExtraction(
  extracted: ExtractBetResult,
  source: { photo: boolean; missingWithoutReading: string[] },
): ReadingResult {
  const readBy = (provider: LlmProviderId): CaptureVia => (source.photo ? `${provider}-vision` : provider);
  // Sem um leitor, a recusa sai em nome da IA.
  const refusedBy = (provider: LlmProviderId | null) => (provider ? readBy(provider) : "ia");
  if (extracted.bet) {
    return { kind: "bets", bet: extracted.bet, bets: extracted.bets ?? [extracted.bet], via: readBy(extracted.provider) };
  }
  if (extracted.withoutOdds) {
    return { kind: "bets", bet: extracted.withoutOdds[0], bets: extracted.withoutOdds, via: readBy(extracted.provider), oddsMissing: true };
  }
  if (extracted.review) {
    const { review, gridChoice } = extracted;
    // Dúvida que a própria leitura declarou: recusa com a dúvida, não pendência muda.
    if (READING_DOUBTS.has(review.reason)) {
      return {
        kind: "refused", reason: review.reason, via: refusedBy(extracted.provider), detail: review.description,
        ...(gridChoice ? { bet: gridChoice.bet, options: gridChoice.options } : {}),
      };
    }
    return { kind: "draft", missing: extracted.missing, byRule: false, review };
  }
  if (extracted.incompleteDraft) {
    return { kind: "draft", missing: extracted.missing, byRule: false, ...(extracted.ocrEvidence ? { ocrEvidence: extracted.ocrEvidence } : {}) };
  }
  if (extracted.refused) return { kind: "refused", reason: extracted.refused.reason, via: refusedBy(extracted.refused.provider) };
  if (extracted.notBet) {
    return { kind: "not_bet", missing: source.missingWithoutReading, ...(extracted.ocrEvidence ? { ocrEvidence: extracted.ocrEvidence } : {}) };
  }
  return {
    kind: "unavailable", missing: source.missingWithoutReading,
    ...(extracted.refusalWhenExhausted ? { refusalWhenExhausted: extracted.refusalWhenExhausted } : {}),
  };
}
