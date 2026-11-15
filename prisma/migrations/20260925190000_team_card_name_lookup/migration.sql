-- A tradução do nome da aposta acha a ficha pelo nome do FlashScore e pelo
-- nome da Pinnacle17 das evidências. A coluna nova nasce vazia; a rodada do
-- pareamento a preenche. O índice do nome do FlashScore é sozinho: a pista de
-- esporte da captura procura em todos os esportes.
ALTER TABLE "team_cards" ADD COLUMN "flashscoreNameNorm" TEXT NOT NULL DEFAULT '';

CREATE INDEX "team_cards_flashscoreNameNorm_idx" ON "team_cards"("flashscoreNameNorm");

CREATE INDEX "team_card_evidence_nameNorm_idx" ON "team_card_evidence"("nameNorm");
