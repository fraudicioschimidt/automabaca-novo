-- Descrições das tabelas centrais, visíveis no próprio banco (\d+ no psql e
-- ferramentas de inspeção). O texto é o que o schema.prisma já documenta.
--
-- Primeira migration publicada pelo caminho automático (deploy/publicar.sh
-- --com-migration, 21/09/2026). Só metadado: nenhuma linha, coluna, índice ou
-- restrição muda, então é compatível com qualquer versão do código no ar.

COMMENT ON TABLE "team_identities" IS
  $$Identidade interna e estável de uma equipe, independente do nome usado por Pinnacle, BridgeOdds, FlashScore ou pela mensagem original do tipster.$$;

COMMENT ON TABLE "team_provider_aliases" IS
  $$Nome e identificador usados por um provider para uma team_identity. O escopo de competição ajuda a desambiguar, mas não faz parte da identidade do clube.$$;

COMMENT ON TABLE "operational_actions" IS
  $$Inbox operacional persistente: fonte de verdade para ownership, evidência e ciclo de resolução. Aponta evidência e, quando mutável, um comando permitido; nunca executa regra de domínio por conta própria.$$;

COMMENT ON TABLE "operational_metrics" IS
  $$Telemetria operacional persistente, append-only e sem payloads sensíveis: duração, atraso e resultado de filas e providers, para SLO e histórico.$$;
