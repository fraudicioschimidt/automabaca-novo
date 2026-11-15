-- Quem leu a aposta capturada (leitor por regra ou provedor, modelo, endpoint
-- e versão do contrato). Fica na própria aposta porque a evidência da captura
-- expira em 30 dias e a correção do dono pode vir depois.
ALTER TABLE "bets" ADD COLUMN "captureReader" JSONB;
