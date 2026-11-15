#!/usr/bin/env python3
"""O que o migrar.py deixa passar para produção sem o caminho manual."""
import contextlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.parse
from unittest import mock
from pathlib import Path


def carregar():
    caminho = Path(__file__).with_name("migrar.py")
    spec = importlib.util.spec_from_file_location("migrar", caminho)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


m = carregar()


class Compatibilidade(unittest.TestCase):
    def aditiva(self, sql):
        self.assertEqual(m.motivos_incompativeis(sql), [], sql)

    def incompativel(self, sql, motivo):
        self.assertIn(motivo, m.motivos_incompativeis(sql), sql)

    def test_o_que_o_codigo_antigo_aguenta(self):
        self.aditiva('CREATE TABLE "x" ("id" TEXT NOT NULL, CONSTRAINT "x_pkey" PRIMARY KEY ("id"));')
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "nota" TEXT;')
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "tentativas" INTEGER NOT NULL DEFAULT 0;')
        self.aditiva('CREATE INDEX "bets_nota_idx" ON "bets"("nota");')
        self.aditiva('CREATE TYPE "Estado" AS ENUM (\'A\', \'B\');')
        self.aditiva('ALTER TYPE "Estado" ADD VALUE \'C\';')
        self.aditiva('ALTER INDEX "velho_idx" RENAME TO "novo_idx";')
        self.aditiva('ALTER TABLE "bets" ALTER COLUMN "nota" DROP NOT NULL;')
        self.aditiva('DROP INDEX "redundante_idx";')

    def test_o_que_quebra_o_codigo_antigo_ou_o_rollback(self):
        self.incompativel('DROP TABLE "x";', 'apaga objeto')
        self.incompativel('ALTER TABLE "bets" DROP COLUMN "nota";', 'apaga objeto')
        self.incompativel('ALTER TABLE "bets" RENAME COLUMN "a" TO "b";', 'renomeia')
        self.incompativel('ALTER TYPE "Estado" RENAME VALUE \'A\' TO \'Z\';', 'renomeia')
        self.incompativel('ALTER TABLE "bets" ALTER COLUMN "v" SET DATA TYPE DECIMAL(10,4);', 'troca tipo de coluna')
        self.incompativel('ALTER TABLE "bets" ALTER COLUMN "v" TYPE TEXT;', 'troca tipo de coluna')
        self.incompativel('ALTER TABLE "bets" ALTER COLUMN "v" SET NOT NULL;', 'passa a exigir valor')
        self.incompativel('ALTER TABLE "bets" ADD COLUMN "v" TEXT NOT NULL;', 'coluna nova NOT NULL sem DEFAULT')
        self.incompativel('UPDATE "bets" SET "v" = 1;', 'reescreve dados')
        self.incompativel('UPDATE "bets" AS b SET "v" = 1;', 'reescreve dados')
        self.incompativel('DELETE FROM "bets" WHERE true;', 'apaga dados')
        self.incompativel('TRUNCATE "bets";', 'apaga dados')
        self.incompativel('CREATE TRIGGER t AFTER INSERT ON x FOR EACH ROW EXECUTE FUNCTION f();', 'cria trigger')

    def test_indice_unico_nao_se_apaga_sem_o_dono(self):
        # Sem ele o código antigo grava duplicata e o ON CONFLICT nas colunas falha.
        self.incompativel('DROP INDEX "bets_source_sourceExternalId_key";', m.DROPS_UNIQUE_INDEX)
        self.incompativel('DROP INDEX IF EXISTS "public"."team_cards_nome_uidx";', m.DROPS_UNIQUE_INDEX)
        # O nome não diz: quem sabe é o histórico ou o banco.
        self.assertEqual(m.motivos_incompativeis('DROP INDEX "bets_dedupe";', {'bets_dedupe'}), [m.DROPS_UNIQUE_INDEX])
        self.assertEqual(m.motivos_incompativeis('ALTER INDEX "bets_dedupe" RENAME TO "bets_d";\nDROP INDEX "bets_d";',
                                                 {'bets_dedupe'}), [m.DROPS_UNIQUE_INDEX])
        self.assertEqual(m.motivos_incompativeis('DROP INDEX "bets_nota_idx";', {'bets_dedupe'}), [])

    def test_indices_unicos_que_as_migrations_anteriores_deixaram(self):
        self.assertEqual(m.unique_indexes_of([
            'CREATE UNIQUE INDEX "a_one" ON "a"("x");\nCREATE UNIQUE INDEX "a_two" ON "a"("y");\nCREATE INDEX "a_z" ON "a"("z");',
            'ALTER INDEX "a_one" RENAME TO "a_uno";\nDROP INDEX "a_two";',
        ]), {'a_uno'})

    def test_comentario_string_e_corpo_de_funcao_nao_contam(self):
        self.aditiva('-- DROP TABLE "x";\nCREATE INDEX "i" ON "x"("a");')
        self.aditiva('/* DELETE FROM x */ CREATE INDEX "i" ON "x"("a");')
        self.aditiva('COMMENT ON TABLE "x" IS \'antes: DROP TABLE; UPDATE x SET\';')
        self.aditiva('CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$\n'
                     'BEGIN UPDATE contagem SET n = n + 1 WHERE id = 1; RETURN NEW; END;\n$$;')

    def test_manual_so_passa_aprovada_pelo_nome_exato(self):
        itens = [{'migration': '20260923_apaga', 'aditiva': False, 'motivos': ['apaga objeto']},
                 {'migration': '20260923_cria', 'aditiva': True, 'motivos': []},
                 {'migration': '20260924_outra', 'aditiva': False, 'motivos': ['renomeia']}]
        self.assertEqual([i['migration'] for i in m.recusadas_sem_aprovacao(itens, [])],
                         ['20260923_apaga', '20260924_outra'])
        self.assertEqual([i['migration'] for i in m.recusadas_sem_aprovacao(itens, ['20260923_apaga'])],
                         ['20260924_outra'])
        self.assertEqual(len(m.recusadas_sem_aprovacao(itens, ['20260923'])), 2)

    def test_constraint_so_passa_em_tabela_criada_na_mesma_migration(self):
        # O Prisma cria a tabela e depois liga as chaves com ALTER TABLE.
        self.aditiva('CREATE TABLE "a" ("id" TEXT NOT NULL, "b" TEXT);\n'
                     'CREATE UNIQUE INDEX "a_b_key" ON "a"("b");\n'
                     'ALTER TABLE "a" ADD CONSTRAINT "a_b_fkey" FOREIGN KEY ("b") REFERENCES "b"("id") '
                     'ON DELETE RESTRICT ON UPDATE CASCADE;')
        # Em tabela existente, o código antigo ainda no ar pode violar a regra nova.
        self.incompativel('ALTER TABLE "bets" ADD CONSTRAINT "f" FOREIGN KEY ("b") REFERENCES "b"("id");',
                          'constraint nova em tabela existente')
        self.incompativel('ALTER TABLE "bets" ADD CONSTRAINT "c" CHECK ("v" > 0);', 'constraint nova em tabela existente')
        self.incompativel('ALTER TABLE "bets" ADD CONSTRAINT "u" UNIQUE ("v");', 'constraint nova em tabela existente')
        self.incompativel('CREATE UNIQUE INDEX "bets_v_key" ON "bets"("v");', 'índice único em tabela existente')

    def test_constraint_written_with_a_new_column_of_an_existing_table(self):
        # A CHECK roda em cada linha que já existe, e a regra vale para o código antigo.
        self.incompativel("ALTER TABLE t ADD COLUMN x int CHECK (setval('s', 1) > 0);",
                          'CHECK chama função (executa nas linhas existentes)')
        for check in ('"wipe"("x")', 'public.now()', 'nextval(\'s\')', '("x").wipe'):
            self.incompativel(f'ALTER TABLE "bets" ADD COLUMN "x" INT CHECK ({check} IS NOT NULL);',
                              'CHECK chama função (executa nas linhas existentes)')
        for sql in ('ALTER TABLE "bets" ADD COLUMN "x" INT CHECK ("stake" > 0);',
                    'ALTER TABLE "bets" ADD COLUMN "x" INT CHECK ("x" IS NULL OR "X" > 0);',
                    'ALTER TABLE "bets" ADD COLUMN "x" INT DEFAULT 1 UNIQUE;',
                    'ALTER TABLE "bets" ADD COLUMN "x" INT DEFAULT 1 REFERENCES "bankrolls"("id");',
                    'ALTER TABLE "bets" ADD COLUMN "x" INT PRIMARY KEY;'):
            self.incompativel(sql, 'constraint nova em tabela existente')
        self.incompativel('ALTER TABLE "bets" ADD COLUMN "x" INT NOT NULL CHECK ("x" > 0);',
                          'coluna nova NOT NULL sem DEFAULT')
        # A que só lê a própria coluna, com função nativa que não escreve.
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "x" TEXT CHECK ("x" IS NULL OR "x" IN (\'a\', \'b\'));')
        self.aditiva('ALTER TABLE "bets" ADD COLUMN x TEXT CHECK (X IS NULL OR x ~ \'^[A-Z]{3}$\');')
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "x" TEXT CHECK ("x" = ANY (ARRAY[\'a\']::text[]));')
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "x" NUMERIC(10,2) CHECK (NOT ("x" BETWEEN 0.5 AND 1.5));')
        # Em tabela criada na mesma migration, nenhuma linha antiga nem código antigo.
        self.aditiva('CREATE TABLE "n" ("x" INT);\nALTER TABLE "n" ADD CONSTRAINT "c" CHECK ("x" IS NOT NULL);')
        self.aditiva('CREATE TABLE "n" ("id" TEXT);\nALTER TABLE "n" ADD COLUMN "x" INT DEFAULT 1 UNIQUE;')

    def test_as_ultimas_migrations_reais_sao_aditivas(self):
        raiz = Path(__file__).resolve().parent.parent / "prisma" / "migrations"
        for nome in ("20260915190000_telegram_bot_post_bookmaker_quotes",
                     "20260915200000_telegram_bot_post_bookmaker_status",
                     "20260916130000_training_identity_attempts", "20260916180000_telegram_post_sem_conferencia",
                     "20260921190000_comentarios_das_tabelas_centrais"):
            self.aditiva((raiz / nome / "migration.sql").read_text())

    def test_o_que_a_lista_negra_deixava_passar(self):
        # Comandos que uma lista negra de palavras deixaria passar.
        casos = [
            'DO $$ BEGIN UPDATE "bets" SET "lucro" = 0; END $$;',
            'DO $$ BEGIN DELETE FROM "bets"; END $$;',
            'INSERT INTO "x" ("id") VALUES (1) ON CONFLICT ("id") DO UPDATE SET "v" = 2;',
            'INSERT INTO "x" ("id") VALUES (1);',
            'MERGE INTO "x" USING "y" ON x.id = y.id WHEN MATCHED THEN UPDATE SET v = 1;',
            'ALTER TABLE "bets" DROP "nota";',
            'ALTER TABLE "bets" ADD COLUMN "a" TEXT, DROP "nota";',
            'CREATE RULE r AS ON INSERT TO "bets" DO INSTEAD NOTHING;',
            'ALTER TABLE "bets" DISABLE TRIGGER ALL;',
            "COPY \"x\" FROM PROGRAM 'curl http://exemplo';",
            'CREATE OR REPLACE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;',
            'CREATE TABLE "copia" ("id") AS SELECT f(1);',
            'CREATE TEMP TABLE t ("id" INT);',
            'DROP INDEX "i" CASCADE;',
            'ALTER TABLE "bets" ALTER COLUMN "v" DROP DEFAULT;',
            'SELECT pg_terminate_backend(1);',
        ]
        for sql in casos:
            self.assertNotEqual(m.motivos_incompativeis(sql), [], sql)

    def test_funcao_nova_chamada_na_mesma_migration(self):
        # O corpo $$ sai da régua, e o DEFAULT roda a função em todas as
        # linhas existentes com o código antigo no ar.
        wipe = ('CREATE FUNCTION wipe() RETURNS text LANGUAGE plpgsql AS $$\n'
                'BEGIN\n  UPDATE contas SET saldo = 0;\n  RETURN \'ok\';\nEND $$;\n')
        self.incompativel(wipe + 'ALTER TABLE bets ADD COLUMN x text DEFAULT wipe();',
                          'DEFAULT chama função (executa nas linhas existentes)')
        self.incompativel(wipe + 'ALTER TABLE bets ADD COLUMN x text DEFAULT wipe();',
                          'chama função criada nesta migration')
        self.incompativel(wipe + 'CREATE INDEX i ON bets ((wipe()));', 'chama função criada nesta migration')
        self.incompativel(wipe + 'ALTER TABLE bets ADD CONSTRAINT c CHECK (wipe() = \'ok\');',
                          'chama função criada nesta migration')
        self.incompativel('ALTER TABLE bets ADD COLUMN x text DEFAULT public.qualquer();',
                          'DEFAULT chama função (executa nas linhas existentes)')
        # Entre aspas o nome é qualquer texto, e `(x).f` chama `f(x)`.
        quoted = ('CREATE FUNCTION "1wipe"() RETURNS text LANGUAGE plpgsql AS $$ BEGIN UPDATE contas SET saldo = 0; '
                  'RETURN \'ok\'; END $$;\n')
        self.incompativel(quoted + 'ALTER TABLE bets ADD COLUMN x text DEFAULT "1wipe"();',
                          'DEFAULT chama função (executa nas linhas existentes)')
        self.incompativel(quoted + 'CREATE INDEX i ON bets (("1wipe"()));', 'chama função criada nesta migration')
        self.incompativel(wipe + 'ALTER TABLE t ADD COLUMN "q" JSONB CHECK (("q").wipe);',
                          'chama função criada nesta migration')
        self.incompativel('ALTER TABLE bets ADD COLUMN x int GENERATED ALWAYS AS (f(y)) STORED;',
                          'coluna gerada executa expressão nas linhas existentes')
        # O que continua passando.
        self.aditiva(wipe)
        self.aditiva(quoted)
        self.aditiva('ALTER TABLE bets ADD COLUMN "criadoEm" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;')
        self.aditiva('ALTER TABLE bets ADD COLUMN "id2" TEXT NOT NULL DEFAULT gen_random_uuid();')
        self.aditiva('ALTER TABLE bets ADD COLUMN "v" DECIMAL(10,2) DEFAULT 0;')

    def test_default_calls_only_native_functions_without_schema(self):
        # Uma função de migration anterior roda do mesmo jeito que uma desta.
        for default in ('"wipe"()', '"now "()', 'public.now()', "('(1)'::\"bets\").wipe"):
            self.incompativel(f'ALTER TABLE "bets" ADD COLUMN "x" TEXT DEFAULT {default};',
                              'DEFAULT chama função (executa nas linhas existentes)')
        self.incompativel('ALTER TABLE "bets" ALTER COLUMN "x" SET DEFAULT "wipe"();',
                          'DEFAULT chama função (executa nas linhas existentes)')
        for default in ('now()', '"now"()', 'CURRENT_TIMESTAMP', '0.5', "'{}'::jsonb", 'ARRAY[]::TEXT[]'):
            self.aditiva(f'ALTER TABLE "bets" ADD COLUMN "x" TEXT DEFAULT {default};')

    def test_ponto_e_virgula_dentro_de_string_ou_corpo_nao_esconde_comando(self):
        self.incompativel("COMMENT ON TABLE \"x\" IS 'a;b'; UPDATE \"x\" SET v = 1;", 'reescreve dados')
        self.incompativel('CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $f$ SELECT 1; $f$; DELETE FROM "x";',
                          'apaga dados')

    def test_escape_string_is_refused_without_being_read(self):
        # O \' da string E'' não fecha a string: o UPDATE depois dela aparece.
        escape = ("ALTER TABLE \"bets\" ADD COLUMN \"nota\" TEXT DEFAULT E'caixa d\\'agua'; "
                  "UPDATE \"bets\" SET \"nota\" = 'x' WHERE \"status\" = 'PENDING';")
        self.incompativel(escape, 'reescreve dados')
        self.assertEqual(len(m.comandos(escape)), 2)
        # A continuação em outra linha herda o modo E, e o \' ali esconderia o
        # `;` do UPDATE: toda string E'' é recusada.
        self.incompativel("ALTER TABLE \"bets\" ADD COLUMN \"a\" TEXT DEFAULT E'x'\n'a\\'';", m.UNREADABLE_ESCAPE)
        continuation = ("ALTER TABLE \"bets\" ADD COLUMN \"n\" TEXT DEFAULT E'a'\n'b\\' ; COMMENT ON TABLE \"bets\" IS ' ; "
                        "UPDATE \"contas\" SET \"saldoAtual\" = 0; -- '\n;")
        self.incompativel(continuation, m.UNREADABLE_ESCAPE)
        self.incompativel("COMMENT ON TABLE \"x\" IS E'linha\\nd\\'outra';", m.UNREADABLE_ESCAPE)
        # O E colado a um nome é parte do nome, e a string depois dele é comum.
        self.aditiva("CREATE TYPE \"Estado\" AS ENUM ('ACTIVE', 'INACTIVE');")

    def test_nested_block_comment_is_refused(self):
        # O PostgreSQL aninha comentário de bloco: o primeiro `*/` não fecha, e
        # o `'` que a régua leria como string é comentário.
        self.incompativel('ALTER TABLE "bets" ADD COLUMN "a" TEXT DEFAULT /* /* */ \' */ \'x\'; '
                          'UPDATE "contas" SET "saldoAtual" = 0; ALTER TABLE "bets" ADD COLUMN "b" TEXT DEFAULT \'y\';',
                          m.UNREADABLE_NESTED_COMMENT)
        self.incompativel('ALTER TABLE "bets" ADD COLUMN "y" TEXT /* /* */ \' */; '
                          'UPDATE "contas" SET "saldoAtual" = 0; -- \'', m.UNREADABLE_NESTED_COMMENT)
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "y" TEXT /* a * b / c */;')
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "y" TEXT /*/ fecha no */;')

    def test_line_comment_ends_at_carriage_return(self):
        sql = 'ALTER TABLE "bets" ADD COLUMN "z" TEXT; -- nota\rUPDATE "contas" SET "saldoAtual" = 0;\n'
        self.incompativel(sql, 'reescreve dados')
        self.assertEqual(m.comandos(sql), ['ALTER TABLE "bets" ADD COLUMN "z" TEXT', 'UPDATE "contas" SET "saldoAtual" = 0'])

    def test_dollar_glued_to_a_name_does_not_open_a_body(self):
        # `a$q$` e `€$q$` são nomes para o PostgreSQL (fora do ASCII, tudo é
        # letra); lidos como corpo $q$, esconderiam o UPDATE.
        for letter in ("a", "\u20ac", "\u00a0"):
            sql = (f'CREATE TABLE "t" ({letter}$q$ int); UPDATE "contas" SET "saldoAtual" = 0; '
                   f'CREATE TABLE "u" (x{letter}$q$ int);')
            self.incompativel(sql, 'reescreve dados')
            self.incompativel(sql, m.UNREADABLE_DOLLAR)
        # `$$` dentro de string não abre corpo de função.
        self.incompativel('ALTER TABLE "bets" ADD COLUMN "a" TEXT DEFAULT \'$$\', DROP COLUMN "stake", '
                          'ADD COLUMN "c" TEXT DEFAULT \'$$\';', 'apaga objeto')
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "a" TEXT DEFAULT \'custa $5\';')

    def test_non_ascii_only_in_strings_comments_and_quoted_names(self):
        # Fora do ASCII, `\w`, `\s` e maiúsculas do Python não leem como o
        # PostgreSQL: `lower\u00a0` é outro nome de função para ele.
        self.incompativel('ALTER TABLE "bets" ADD COLUMN "z" TEXT DEFAULT lower\u00a0(\'a\');', m.UNREADABLE_CHARACTER)
        self.incompativel('ALTER\u00a0TABLE "bets" ADD COLUMN "z" TEXT;', m.UNREADABLE_CHARACTER)
        self.aditiva('-- conferência das apostas\nCOMMENT ON TABLE "bets" IS \'apostas é ç\';\n'
                     'CREATE TABLE "sessões" ("código" TEXT) /* ção */;')

    def test_varias_clausulas_de_alter_table(self):
        self.aditiva('ALTER TABLE "bets" ADD COLUMN "a" TEXT, ADD COLUMN "b" DECIMAL(10,2) DEFAULT 0, '
                     'ALTER COLUMN "c" SET DEFAULT \'x\';')
        self.incompativel('ALTER TABLE "bets" ADD COLUMN "a" TEXT, ADD COLUMN "b" INT NOT NULL;',
                          'coluna nova NOT NULL sem DEFAULT')

    def test_marca_de_caminho_manual_nao_libera_o_deploy(self):
        sql = '-- @migration-manual: backfill com o dono\nUPDATE "bets" SET "v" = 1;'
        self.assertIn('marcada para o caminho manual (@migration-manual)', m.motivos_incompativeis(sql))
        self.assertNotEqual(m.motivos_incompativeis('-- @migration-manual: x\nCREATE INDEX "i" ON "x"("a");'), [])

    def test_plano_mostra_os_comandos(self):
        self.assertEqual(m.comandos("-- nota\nCREATE INDEX \"i\" ON \"x\"(\"a\");\n\nCOMMENT ON TABLE \"x\" IS 'a;b';"),
                         ['CREATE INDEX "i" ON "x"("a")', "COMMENT ON TABLE \"x\" IS 'a;b'"])


class Classificar(unittest.TestCase):
    """O modo da CI: migration nova é aditiva ou se declara manual."""

    def arquivo(self, sql, nome="20260924000000_nova"):
        if not hasattr(self, "migrations"):
            pasta = tempfile.TemporaryDirectory()
            self.addCleanup(pasta.cleanup)
            self.migrations = Path(pasta.name)
        caminho = self.migrations / nome / "migration.sql"
        caminho.parent.mkdir()
        caminho.write_text(sql)
        return str(caminho)

    def test_aditiva_passa(self):
        self.assertEqual(m.classificar([self.arquivo('CREATE INDEX "i" ON "x"("a");')]), [])

    def test_nao_aditiva_sem_marca_reprova(self):
        erros = m.classificar([self.arquivo('DO $$ BEGIN UPDATE "x" SET v = 1; END $$;')])
        self.assertEqual(len(erros), 1)

    def test_nao_aditiva_com_marca_passa_na_ci(self):
        self.assertEqual(m.classificar([self.arquivo('-- @migration-manual: backfill\nUPDATE "x" SET v = 1;')]), [])


    def test_apagar_indice_unico_de_migration_anterior_reprova(self):
        self.arquivo('CREATE UNIQUE INDEX "bets_dedupe" ON "bets"("source");', "20260901000000_antiga")
        erros = m.classificar([self.arquivo('DROP INDEX "bets_dedupe";')])
        self.assertEqual(len(erros), 1)
        self.assertIn(m.DROPS_UNIQUE_INDEX, erros[0])


class Historico(unittest.TestCase):
    def test_devolve_so_as_novas_em_ordem(self):
        self.assertEqual(m.pendentes({"1_a": "h1"}, {"1_a": "h1", "3_c": "h3", "2_b": "h2"}), ["2_b", "3_c"])

    def test_nada_a_aplicar(self):
        self.assertEqual(m.pendentes({"1_a": "h1"}, {"1_a": "h1"}), [])

    def test_banco_a_frente_da_release(self):
        with self.assertRaisesRegex(m.Recusa, "não conhece"):
            m.pendentes({"1_a": "h1", "9_z": "h9"}, {"1_a": "h1"})

    def test_migration_aplicada_mudou(self):
        with self.assertRaisesRegex(m.Recusa, "mudaram"):
            m.pendentes({"1_a": "h1"}, {"1_a": "OUTRO"})

    def test_new_migration_out_of_order_stays_pending(self):
        # Dois PRs com migration entram sem rebase: a de nome menor chega depois
        # de a maior já estar no banco. O `prisma migrate deploy` a aplica.
        self.assertEqual(m.pendentes({"1_a": "h1", "3_c": "h3"}, {"1_a": "h1", "2_b": "h2", "3_c": "h3"}), ["2_b"])


class OutOfOrderPlan(unittest.TestCase):
    """Migration nova com nome anterior à última aplicada segue a régua de sempre."""

    APPLIED = "20260924005000_y"

    def plan_items(self, name, sql, unique_indexes=()):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        build, work = Path(folder.name) / "build", Path(folder.name) / "work"
        for migration, text in [(self.APPLIED, 'CREATE INDEX "i" ON "x"("a");'), (name, sql)]:
            (build / "prisma" / "migrations" / migration).mkdir(parents=True)
            (build / "prisma" / "migrations" / migration / "migration.sql").write_text(text)
        work.mkdir()
        (work / "release.json").write_text(json.dumps({"buildDir": str(build)}))
        applied = {self.APPLIED: m.migrations_em(build)[self.APPLIED]}
        with mock.patch.object(m, "aplicadas_no_banco", return_value=applied), \
                mock.patch.object(m, "unique_indexes_in_database", return_value=set(unique_indexes)):
            return m.plano(work, Path("/repo"))[3]

    def test_unique_index_in_the_database_is_not_dropped_without_the_owner(self):
        items = self.plan_items("20260925000000_z", 'DROP INDEX "bets_dedupe";', {"bets_dedupe"})
        self.assertEqual([(i["aditiva"], i["motivos"]) for i in items], [(False, [m.DROPS_UNIQUE_INDEX])])

    def test_additive_out_of_order_goes_without_the_owner(self):
        items = self.plan_items("20260924004000_x", 'ALTER TABLE "bets" ADD COLUMN "nota" TEXT;')
        self.assertEqual([(i["migration"], i["aditiva"], i["outOfOrder"]) for i in items],
                         [("20260924004000_x", True, True)])
        self.assertEqual(m.recusadas_sem_aprovacao(items, []), [])

    def test_non_additive_out_of_order_needs_the_owner(self):
        items = self.plan_items("20260924004000_x", 'ALTER TABLE "bets" DROP COLUMN "nota";')
        self.assertEqual([i["migration"] for i in m.recusadas_sem_aprovacao(items, [])], ["20260924004000_x"])
        self.assertEqual(m.recusadas_sem_aprovacao(items, ["20260924004000_x"]), [])

    def test_in_order_is_not_marked(self):
        items = self.plan_items("20260924006000_z", 'ALTER TABLE "bets" ADD COLUMN "nota" TEXT;')
        self.assertFalse(items[0]["outOfOrder"])


class WorkerParadoNaMigracao(unittest.TestCase):
    """O worker antigo não roda contra o schema novo, e não fica parado à toa.

    O daemon do Docker é simulado: um `docker stop` começado termina mesmo que
    o cliente morra no meio, e um `docker start` durante a parada é ignorado.
    """

    LOCAIS = {"1_a": "h1", "2_b": "h2"}

    def setUp(self):
        self.work = Path(tempfile.mkdtemp())
        self.eventos = []
        self.worker = {"id": "w1", "image": "worker@sha256:antigo", "running": True}
        self.codigo_migrate = 0
        self.log_migrate = None
        self.depois = dict(self.LOCAIS)
        self.parada_pendente = False
        self.codigo_parada = 0
        self.interromper_parada = None
        self.na_parada = None
        teste = self

        @contextlib.contextmanager
        def migrador(work, meta, locais, repo):
            self.eventos.append("npm ci")

            def rodar(comando, log):
                self.eventos.append("migrate " + comando)
                if self.log_migrate:
                    (work / log).write_text(self.log_migrate)
                if isinstance(self.codigo_migrate, BaseException):
                    raise self.codigo_migrate
                return self.codigo_migrate
            yield rodar

        class DockerStop:
            """O `docker stop` numa sessão própria (código novo)."""

            def __init__(self, args, **kwargs):
                teste.assertEqual(args[:2], ["docker", "stop"])
                teste.inicio_da_parada()
                self.esperas = 0

            def wait(self, timeout=None):
                self.esperas += 1
                if self.esperas == 1 and teste.interromper_parada:
                    teste.interromper_parada()
                return teste.fim_da_parada()

        def docker(args, **kwargs):
            if args[:2] == ["docker", "stop"]:
                self.inicio_da_parada()
                if self.interromper_parada:
                    self.interromper_parada()
                if self.fim_da_parada():
                    raise subprocess.CalledProcessError(self.codigo_parada, args)
                return subprocess.CompletedProcess(args, 0)
            self.eventos.append(" ".join(args[:2]))
            if args[1] == "start" and not self.parada_pendente:
                self.worker["running"] = True
            return subprocess.CompletedProcess(args, 0)

        for nome, valor in [("migrador", migrador),
                            ("fazer_backup", lambda work: {"path": "/backups/antes"}),
                            ("estado_do_worker", lambda: dict(self.worker)),
                            ("aplicadas_no_banco", lambda: self.depois)]:
            self.patch(m, nome, valor)
        self.patch(m.subprocess, "run", docker)
        self.patch(m.subprocess, "Popen", DockerStop)

    def inicio_da_parada(self):
        self.eventos.append("docker stop")
        arquivo = self.work / "migration.json"
        self.na_parada = json.loads(arquivo.read_text()) if arquivo.exists() else None
        self.parada_pendente = True

    def fim_da_parada(self):
        """O daemon termina a parada que começou, com ou sem o cliente vivo."""
        if self.parada_pendente:
            self.parada_pendente = False
            self.worker["running"] = False
        return self.codigo_parada

    def patch(self, alvo, nome, valor):
        patcher = mock.patch.object(alvo, nome, valor)
        patcher.start()
        self.addCleanup(patcher.stop)

    def aplicar(self):
        m.aplicar(self.work, {"release": "r1", "sha": "abc"}, self.LOCAIS, Path("/repo"))

    def relatorio(self):
        return json.loads((self.work / "migration.json").read_text())

    def test_para_o_worker_so_depois_do_cli_e_deixa_parado(self):
        self.aplicar()
        self.assertEqual(self.eventos, ["npm ci", "docker stop", "migrate deploy"])
        self.assertFalse(self.worker["running"])
        relatorio = self.relatorio()
        self.assertTrue(relatorio["workerStopped"])
        self.assertEqual(relatorio["workerContainerId"], "w1")
        self.assertEqual(relatorio["exitCode"], 0)
        self.assertTrue(relatorio["identicalToRelease"])

    def test_worker_ja_parado_recusa_sem_migrar(self):
        self.worker["running"] = False
        with self.assertRaisesRegex(m.Recusa, "já estava parado"):
            self.aplicar()
        self.assertNotIn("docker stop", self.eventos)
        self.assertNotIn("migrate deploy", self.eventos)
        self.assertFalse((self.work / "migration.json").exists())

    def parada_interrompida(self, interromper, esperado):
        self.interromper_parada = interromper
        with self.assertRaises(esperado):
            self.aplicar()
        self.fim_da_parada()  # o daemon acaba a parada que já tinha começado
        self.assertTrue(self.worker["running"], "o worker não voltou")
        self.assertNotIn("migrate deploy", self.eventos)
        # Quem religa sabe qual container é: o registro veio antes do stop.
        self.assertEqual((self.na_parada or {}).get("workerContainerId"), "w1")
        self.assertIn("workerRestartedAt", self.relatorio())

    def test_ctrl_c_no_meio_do_docker_stop_religa_o_worker(self):
        def ctrl_c():
            raise KeyboardInterrupt
        self.parada_interrompida(ctrl_c, KeyboardInterrupt)

    def test_sigterm_no_meio_do_docker_stop_religa_o_worker(self):
        # Sinal de verdade: o tratador do migrar.py tem de valer já durante a parada.
        def sem_tratador(*_):
            raise AssertionError("SIGTERM durante a parada sem o tratador do migrar.py")
        anterior = m.signal.signal(m.signal.SIGTERM, sem_tratador)
        self.addCleanup(m.signal.signal, m.signal.SIGTERM, anterior)
        self.parada_interrompida(lambda: os.kill(os.getpid(), m.signal.SIGTERM), SystemExit)

    def test_erro_do_docker_stop_no_meio_religa_o_worker(self):
        self.codigo_parada = 1  # o daemon parou o container, mas o docker stop saiu com erro
        with self.assertRaisesRegex(RuntimeError, "voltou a rodar"):
            self.aplicar()
        self.assertTrue(self.worker["running"])
        self.assertNotIn("migrate deploy", self.eventos)

    def test_migrate_que_falha_religa_o_worker_antigo(self):
        self.codigo_migrate = 1
        with self.assertRaisesRegex(RuntimeError, "NÃO publique"):
            self.aplicar()
        self.assertEqual(self.eventos[-2:], ["migrate deploy", "docker start"])
        self.assertTrue(self.worker["running"])
        relatorio = self.relatorio()
        self.assertEqual(relatorio["exitCode"], 1)
        self.assertIn("workerRestartedAt", relatorio)

    def test_lock_timeout_no_migrate_religa_e_diz_o_motivo(self):
        self.codigo_migrate = 1
        self.log_migrate = ("Error: P3018\nDatabase error code: 55P03\n"
                            "ERROR: canceling statement due to lock timeout\n")
        with self.assertRaises(RuntimeError) as falha:
            self.aplicar()
        mensagem = str(falha.exception)
        self.assertIn("esperou mais de 15s por um lock", mensagem)
        self.assertIn("o worker antigo voltou a rodar", mensagem)
        self.assertIn("aplicada em parte", mensagem)
        self.assertTrue(self.worker["running"])

    def test_migrate_que_passa_do_teto_religa_o_worker(self):
        self.codigo_migrate = m.MigrateEstourou("o migrate passou de 5 min e foi encerrado")
        with self.assertRaisesRegex(RuntimeError, "passou de 5 min.*o worker antigo voltou a rodar"):
            self.aplicar()
        self.assertTrue(self.worker["running"])

    def test_banco_diferente_da_release_religa_o_worker_antigo(self):
        self.depois = {"1_a": "h1"}
        with self.assertRaises(RuntimeError):
            self.aplicar()
        self.assertTrue(self.worker["running"])
        self.assertFalse(self.relatorio()["identicalToRelease"])

    def test_erro_ou_interrupcao_no_migrate_religa_o_worker_antigo(self):
        for erro, esperado in [(subprocess.CalledProcessError(1, "docker"), RuntimeError), (SystemExit(143), SystemExit)]:
            self.worker["running"] = True
            self.codigo_migrate = erro
            with self.assertRaises(esperado):
                self.aplicar()
            self.assertTrue(self.worker["running"])

    def test_sinal_ignorado_de_proposito_continua_ignorado_no_migrate(self):
        vistos = {}

        @contextlib.contextmanager
        def migrador(work, meta, locais, repo):
            def rodar(comando, log):
                vistos.update(hup=m.signal.getsignal(m.signal.SIGHUP), term=m.signal.getsignal(m.signal.SIGTERM))
                return 0
            yield rodar
        self.patch(m, "migrador", migrador)
        antes = m.signal.signal(m.signal.SIGHUP, m.signal.SIG_IGN)
        try:
            termo = m.signal.getsignal(m.signal.SIGTERM)
            self.aplicar()
            self.assertIs(vistos["hup"], m.signal.SIG_IGN)
            self.assertIs(vistos["term"], m._interromper)
            self.assertIs(m.signal.getsignal(m.signal.SIGTERM), termo)
        finally:
            m.signal.signal(m.signal.SIGHUP, antes)

    def test_publicar_sh_religa_so_o_worker_que_o_migrar_parou(self):
        self.aplicar()
        self.assertTrue(m.religar_se_parado(self.work))
        self.assertTrue(self.worker["running"])
        self.assertEqual(self.relatorio()["workerRestartedBy"], "publicar.sh, publicação não concluída")
        # Já rodando, ou trocado pela publicação (ou pelo rollback): nada a fazer.
        self.assertFalse(m.religar_se_parado(self.work))
        self.worker.update(id="w2", running=False)
        self.assertFalse(m.religar_se_parado(self.work))
        self.assertFalse(m.religar_se_parado(Path(tempfile.mkdtemp())))


class ContainerDoMigrate(unittest.TestCase):
    """O migrate tem limite de lock, teto e nome, e não fica rodando atrás de um worker religado."""

    NOME = "automabaca-novo-migrate-r1"

    def setUp(self):
        self.eventos = []
        self.esperas = []
        self.log = Path(tempfile.mkdtemp()) / "migrate.log"
        teste = self

        class Cliente:
            def __init__(self, args, **kwargs):
                teste.eventos.append("docker run")
                teste.opcoes = kwargs

            def wait(self, timeout=None):
                teste.eventos.append(f"espera {timeout}")
                acao = teste.esperas.pop(0) if teste.esperas else "fim"
                if acao == "demora":
                    raise subprocess.TimeoutExpired("docker run", timeout)
                if acao == "sinal":
                    raise KeyboardInterrupt
                return 0

            def kill(self):
                teste.eventos.append("kill")

        def docker(args, **kwargs):
            self.eventos.append(" ".join(args))
            return subprocess.CompletedProcess(args, 0)

        def sql(consulta):
            self.eventos.append("sql " + consulta)
            return "1"

        for alvo, nome, valor in [(m.subprocess, "Popen", Cliente), (m.subprocess, "run", docker), (m, "sql", sql)]:
            patcher = mock.patch.object(alvo, nome, valor)
            patcher.start()
            self.addCleanup(patcher.stop)

    def rodar(self):
        return m.rodar_no_container(["docker", "run", "--name", self.NOME], self.NOME, {}, self.log, teto=300)

    def encerrou(self):
        return (f"docker rm -f {self.NOME}" in self.eventos[1:]
                and any("pg_terminate_backend" in e and self.NOME in e for e in self.eventos))

    def test_cliente_na_propria_sessao_devolve_o_codigo(self):
        self.assertEqual(self.rodar(), 0)
        self.assertTrue(self.opcoes["start_new_session"])
        self.assertFalse(self.encerrou())

    def test_teto_encerra_o_container_e_a_sessao_no_banco(self):
        self.esperas = ["demora"]
        with self.assertRaisesRegex(m.MigrateEstourou, "passou de 5 min"):
            self.rodar()
        self.assertTrue(self.encerrou())

    def test_sinal_espera_o_migrate_acabar_antes_de_devolver(self):
        self.esperas = ["sinal", "fim"]
        with self.assertRaises(KeyboardInterrupt):
            self.rodar()
        self.assertEqual(self.eventos[-2:], ["espera 300", f"espera {m.MIGRATE_ESPERA_AO_INTERROMPER_S}"])
        self.assertFalse(self.encerrou())

    def test_sinal_com_migrate_demorado_encerra_antes_de_devolver(self):
        self.esperas = ["sinal", "demora"]
        with self.assertRaises(KeyboardInterrupt):
            self.rodar()
        self.assertTrue(self.encerrou())

    def test_limites_e_nome_da_sessao_no_url(self):
        url = m.url_do_migrate("postgresql://admin:s%40nha@db:5432/automabaca_novo", self.NOME)
        partes = urllib.parse.urlsplit(url)
        parametros = dict(urllib.parse.parse_qsl(partes.query))
        self.assertEqual(partes.netloc, "admin:s%40nha@db:5432")
        self.assertEqual(parametros["application_name"], self.NOME)
        self.assertEqual(parametros["options"], "-c lock_timeout=15s -c statement_timeout=4min")
        self.assertNotIn("+", partes.query)  # espaço vai como %20, como o Prisma lê
        # O que o URL já tinha fica, e o `options` dele é somado.
        url = m.url_do_migrate("postgresql://a@db/x?sslmode=disable&options=-c%20search_path%3Dpublic", self.NOME)
        parametros = dict(urllib.parse.parse_qsl(urllib.parse.urlsplit(url).query))
        self.assertEqual(parametros["sslmode"], "disable")
        self.assertEqual(parametros["options"], "-c search_path=public -c lock_timeout=15s -c statement_timeout=4min")

    def test_motivo_do_statement_timeout(self):
        self.log.write_text("ERROR: canceling statement due to statement timeout\n")
        self.assertIn("passou de 4min", m.motivo_da_falha(self.log, 1))


class Saida(unittest.TestCase):
    def test_falha_do_aplicar_sai_com_1_sem_traceback(self):
        mascara = os.umask(0o022)
        self.addCleanup(os.umask, mascara)
        argv = ["migrar.py", "--release-dir", tempfile.mkdtemp(), "--aplicar"]
        with mock.patch.object(m, "plano", return_value=({}, Path("/b"), {}, [])), \
                mock.patch.object(m, "aplicar", side_effect=RuntimeError("o migrate esperou mais de 15s por um lock")), \
                mock.patch.object(sys, "argv", argv), \
                mock.patch.object(sys, "stdout", new=open(os.devnull, "w")) as nulo:
            self.addCleanup(nulo.close)
            with self.assertRaises(SystemExit) as saida:
                m.main()
        self.assertEqual(saida.exception.code, 1)

if __name__ == "__main__":
    unittest.main()
