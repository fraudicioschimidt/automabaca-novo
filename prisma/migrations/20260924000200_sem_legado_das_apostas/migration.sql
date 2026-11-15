-- @migration-manual: apaga bet_closing.scoreCheckedAt (sem leitor) e exige evidenceKind nas sugestões do IA-Judge
-- Conferido em produção em 23/09/2026, só com SELECT: bet_closing e
-- ia_judge_suggestions sem nenhuma linha depois de o ensaio ser zerado.

-- Resto do antigo placar pela BridgeOdds; o código já não lê nem zera.
DROP INDEX "bet_closing_scoreCheckedAt_idx";
ALTER TABLE "bet_closing" DROP COLUMN "scoreCheckedAt";

-- Todo escritor grava a evidência; o null era de sugestão anterior a ela.
ALTER TABLE "ia_judge_suggestions" ALTER COLUMN "evidenceKind" SET NOT NULL;
