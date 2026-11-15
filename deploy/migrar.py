"""Aplica em produção as migrations de uma release já preparada, se forem aditivas.

O `publish.py` recusa quando o banco e a release têm conjuntos de migrations
diferentes; este script é o caminho versionado para as aditivas (backup,
`prisma migrate deploy` com o papel administrativo, publicação). Chamado pelo
`publicar.sh --com-migration`:

    sudo python3 deploy/migrar.py --release-dir <dir> --plano     # só lê
    sudo python3 deploy/migrar.py --release-dir <dir> --ensaio    # caminho inteiro, só lê
    sudo python3 deploy/migrar.py --release-dir <dir> --aplicar
    sudo python3 deploy/migrar.py --release-dir <dir> --religar-worker  # publicar.sh, ao sair

Só passa migration **compatível com a versão anterior**: durante a aplicação o
código antigo continua rodando contra o schema novo, e o rollback automático do
`publish.py` volta as imagens, não o schema. Criar tabela, coluna anulável ou
com default, índice, tipo ou valor de enum é compatível. Apagar, renomear,
trocar tipo, exigir NOT NULL sem default ou reescrever dados não é: essas vão
pelo caminho manual, com o dono.

A régua é uma LISTA DE PERMITIDOS: cada comando precisa ter uma das formas de
`COMANDOS_ADITIVOS`, e o resto é recusado. Uma lista do que proibir sempre
esquece alguma forma (`UPDATE` dentro de `DO $$ ... $$`, `INSERT ... ON
CONFLICT DO UPDATE`, `MERGE`, `DROP "coluna"` sem a palavra COLUMN, `CREATE
RULE`, `DISABLE TRIGGER`, `COPY FROM PROGRAM`); a de permitidos, quando esquece,
recusa. Isso vale com duas condições. O leitor (`_parse`) lê o texto como o
PostgreSQL, e o que o PostgreSQL lê de outro jeito vira motivo de recusa. E a
expressão que uma forma permitida executa em cada linha que já existe (DEFAULT
e CHECK de coluna nova) só chama funções nativas que não escrevem. A régua não
confere as funções da expressão e do WHERE de um índice, que também rodam em
cada linha; ali o PostgreSQL só aceita função IMMUTABLE.

A CI roda a mesma régua em toda migration nova (`--classificar`). Migration que
vai pelo caminho manual declara isso com `-- @migration-manual: <motivo>`: a CI
aceita, e o deploy automático continua recusando.

Segurança do segredo: o `npm ci` que traz o CLI do Prisma roda num container SEM
nenhuma credencial (scripts de instalação de terceiros rodam ali). Só o
container da migração recebe o `DATABASE_URL_ADMIN`, por variável de ambiente,
nunca por argumento de linha de comando.

Worker: a web continua no ar durante a migração, mas o worker antigo para logo
antes do `prisma migrate deploy` (depois do backup e da instalação do CLI, sem
esperar jogo começar) e fica parado para o `publish.py` subir o novo. Rodando
contra o schema novo, ele falhava a cada job (22/09/2026: 17 min de erros). Se o
migrate falhar, passar do teto ou for interrompido, o antigo volta; se a
publicação não se completar, o `publicar.sh` o religa (`--religar-worker`).

Saída: 0 ok; 2 recusado (não aditiva, banco divergente, nada a aplicar, sem
papel administrativo ou worker já parado antes): o banco não mudou e este
script não parou nada; 1 falha, com o worker antigo religado.
"""
from pathlib import Path
import argparse, contextlib, datetime, hashlib, json, os, re, signal, subprocess, sys, urllib.parse

DB = 'automabaca-novo-db'
WORKER = 'automabaca-novo-worker'
USER = 'automabaca_novo'
REDE = 'automabaca-novo_default'
RUNTIME_ENV = Path('/etc/automabaca-novo/runtime.env')
# Mesma base do Dockerfile.worker: Node e npm da toolchain do projeto.
IMAGEM_NODE = 'node:24.20.0-bookworm-slim@sha256:ba849c60be29959425b8734d57b8b4b7d56f98edd9504c9af091d5281095a71e'
NPM = '11.19.0'

# O migrate roda com o worker parado, então tem limite. Lock: 15 s, como o
# pg_dump do backup diário; se outra sessão segura a tabela, ele desiste em vez
# de esperar sem fim (e segurar a fila de locks da web). Comando: 4 min, cortado
# pelo próprio PostgreSQL. Teto do container: 5 min, que o encerra junto com a
# sessão dele no banco. Uma migration aditiva leva segundos (banco de ~180 MB).
MIGRATE_LOCK_TIMEOUT = '15s'
MIGRATE_STATEMENT_TIMEOUT = '4min'
MIGRATE_TETO_S = 300
# Sinal no meio do migrate: espera ele acabar até isto antes de encerrá-lo.
MIGRATE_ESPERA_AO_INTERROMPER_S = 30

MARCA_MANUAL = '@migration-manual'

# Nome de objeto: `"x"`, `x` ou `esquema.x`.
_ID = r'(?:"[^"]+"|[A-Za-z_]\w*)'
_NOME = rf'{_ID}(?:\.{_ID})?'

# As ÚNICAS formas de comando que saem sem o dono. Casam com o comando inteiro,
# já sem comentários, com strings e corpos `$$` trocados por '' e espaços
# normalizados (`_parse`). Tudo o mais é recusado.
COMANDOS_ADITIVOS = [
    rf'CREATE TABLE (IF NOT EXISTS )?{_NOME} ?\(.*\)',
    rf'CREATE (UNIQUE )?INDEX (CONCURRENTLY )?(IF NOT EXISTS )?({_NOME} )?ON (ONLY )?{_NOME}( USING \w+)? ?\(.*',
    rf'CREATE TYPE {_NOME} AS ENUM ?\(.*\)',
    rf"ALTER TYPE {_NOME} ADD VALUE (IF NOT EXISTS )?''( (BEFORE|AFTER) '')?",
    r"COMMENT ON (TABLE|COLUMN|INDEX|TYPE|CONSTRAINT) [^;]* IS (''|NULL)",
    # Função nova é inerte: nada a chama (trigger e SELECT não passam aqui).
    # CREATE OR REPLACE não entra: troca o comportamento de quem já a usa.
    rf'CREATE FUNCTION {_NOME} ?\(.*',
    # O Prisma renomeia e apaga índice ao ajustar nomes; o código não usa nome
    # de índice. CASCADE levaria constraints junto, e fica de fora. Índice
    # único não se apaga por aqui (ver `_motivos_do_comando`).
    rf'ALTER INDEX (IF EXISTS )?{_NOME} RENAME TO {_ID}',
    rf'DROP INDEX (CONCURRENTLY )?(IF EXISTS )?{_NOME}',
    r'BEGIN|COMMIT',
]
_ALTER_TABLE = re.compile(rf'ALTER TABLE (IF EXISTS )?(ONLY )?(?P<tabela>{_NOME}) (?P<clausulas>.+)', re.IGNORECASE)
# Cláusulas de ALTER TABLE que só acrescentam. Constraint nova só passa em
# tabela criada na mesma migration (ver `_motivos_do_comando`).
CLAUSULAS_ADITIVAS = [
    rf'ADD (COLUMN )?(IF NOT EXISTS )?(?!(CONSTRAINT|PRIMARY|UNIQUE|CHECK|FOREIGN|EXCLUDE)\b){_ID} .+',
    rf'ADD (CONSTRAINT {_ID} )?(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)\b.*',
    rf'ALTER (COLUMN )?{_ID} SET DEFAULT .+',
    rf'ALTER (COLUMN )?{_ID} DROP NOT NULL',
]
# Um SELECT dentro de um comando permitido (CREATE TABLE ... AS SELECT f())
# executa código na migração.
PROIBIDO_EM_QUALQUER_COMANDO = r'\bSELECT\b'

# `ADD COLUMN ... DEFAULT f()` e coluna gerada executam a expressão em TODAS as
# linhas que já existem, com o código antigo no ar. Uma função criada na mesma
# migration ou numa anterior (o corpo `$$` sai da régua) faria um `UPDATE
# contas SET saldo = 0` passar como aditivo. No DEFAULT só entram as funções
# nativas que não escrevem nada, chamadas sem esquema: `(x).f` também chama
# `f`, e `public.now()` não é a nativa.
FUNCOES_DE_DEFAULT = {'now', 'gen_random_uuid', 'uuid_generate_v4', 'current_date', 'clock_timestamp',
                      'transaction_timestamp', 'statement_timestamp', 'timezone', 'lower', 'upper',
                      'coalesce', 'array', 'jsonb_build_object', 'json_build_object', 'to_jsonb', 'to_json',
                      'jsonb_build_array', 'json_build_array', 'nextval', 'interval'}
# Nome de função, com ou sem esquema. Entre aspas vale qualquer texto (`"1x"`,
# `"a b"`), e o nome sem aspas não começa colado a outro identificador.
_NAME_PART = r'(?:"(?:[^"]|"")+"|[A-Za-z_]\w*)'
_QUALIFIED_NAME = rf'(?:(?<![\w$."])[A-Za-z_]\w*|(?<![."])"(?:[^"]|"")+")(?:\s*\.\s*{_NAME_PART})*'
_CHAMADA = re.compile(rf'({_QUALIFIED_NAME})\s*\(')
_ATTRIBUTE_CALL = re.compile(rf'\.\s*({_NAME_PART})')
_FUNCAO_CRIADA = re.compile(rf'^CREATE (?:OR REPLACE )?FUNCTION ({_QUALIFIED_NAME})', re.IGNORECASE)


def _function_name(qualified):
    """O nome sem o esquema, como o PostgreSQL o procura: `"Now"` é Now, e `NOW` é now."""
    name = re.findall(_NAME_PART, qualified)[-1]
    return name[1:-1].replace('""', '"') if name.startswith('"') else name.lower()


# Coluna nova em tabela existente: a constraint escrita junto dela vale para o
# código antigo como a de `ADD CONSTRAINT`. A CHECK passa quando só lê a própria
# coluna, que o código antigo não escreve, e só chama funções nativas que não
# escrevem nada: o PostgreSQL a executa em cada linha que já existe. UNIQUE,
# PRIMARY KEY e REFERENCES ficam de fora: com DEFAULT, o código antigo os viola
# ao inserir.
CHECK_FUNCTIONS = FUNCOES_DE_DEFAULT - {'nextval'} | {'jsonb_typeof'}
# Palavras reservadas: antes de `(` não são função (`IN (...)`, `NOT (...)`).
_CHECK_RESERVED = {'and', 'or', 'not', 'in', 'any', 'all', 'some', 'array', 'null', 'true', 'false',
                   'between', 'distinct', 'from', 'case', 'when', 'then', 'else', 'end'}
_CHECK_KEYWORDS = _CHECK_RESERVED | {'is', 'like', 'ilike', 'similar', 'to', 'escape'}
_CHECK_TOKEN = re.compile(r'(?P<name>"(?:[^"]|"")+"|(?<![\w$])[A-Za-z_]\w*)(?P<call>\s*\()?')
_CAST = re.compile(r'::\s*(?:"(?:[^"]|"")+"|[A-Za-z_]\w*)(?:\s*\[\s*\])*')
_NEW_COLUMN = re.compile(rf'ADD (?:COLUMN )?(?:IF NOT EXISTS )?(?P<column>{_ID}) ', re.IGNORECASE)


def _check_expressions(clause):
    """O que está entre os parênteses de cada CHECK da cláusula (no texto limpo não há string)."""
    expressions = []
    for start in re.finditer(r'\bCHECK\s*\(', clause, re.IGNORECASE):
        depth, pieces = 1, []
        for token in re.finditer(r'"(?:[^"]|"")*"|[()]|[^"()]+', clause[start.end():]):
            depth += {'(': 1, ')': -1}.get(token.group(0), 0)
            if depth == 0:
                break
            pieces.append(token.group(0))
        expressions.append(''.join(pieces))
    return expressions


def _new_column_constraint_reasons(clause):
    """Por que a constraint escrita junto de uma coluna nova quebra o código antigo."""
    reasons = []
    if re.search(r'\b(UNIQUE|PRIMARY\s+KEY|REFERENCES)\b', re.sub(r'"(?:[^"]|"")*"', '""', clause), re.IGNORECASE):
        reasons.append('constraint nova em tabela existente')
    column = _function_name(_NEW_COLUMN.match(clause).group('column'))
    for expression in _check_expressions(clause):
        if re.search(r'\.(?!\d)', expression):
            reasons.append('CHECK chama função (executa nas linhas existentes)')
        for token in _CHECK_TOKEN.finditer(_CAST.sub(' ', expression)):
            name, bare = token.group('name'), not token.group('name').startswith('"')
            if token.group('call'):
                if not (bare and name.lower() in _CHECK_RESERVED) and _function_name(name) not in CHECK_FUNCTIONS:
                    reasons.append('CHECK chama função (executa nas linhas existentes)')
            elif not (bare and name.lower() in _CHECK_KEYWORDS) and _function_name(name) != column:
                reasons.append('constraint nova em tabela existente')
    return reasons


# Nomes para os casos mais comuns na mensagem de recusa. Não decidem nada: a
# decisão é da lista de permitidos acima.
MOTIVOS_CONHECIDOS = [
    (r'\bDROP\b', 'apaga objeto'),
    (r'\bTRUNCATE\b|\bDELETE\s+FROM\b', 'apaga dados'),
    (r'\bUPDATE\s+\S+(\s+(AS\s+)?\w+)?\s+SET\b|\bDO\s+UPDATE\b|\bMERGE\b|\bINSERT\b|\bCOPY\b', 'reescreve dados'),
    (r'^DO\b', 'bloco de código (DO)'),
    # Trigger e regra nova mudam o efeito das escritas do código que ainda está
    # no ar (a de revogação de alias, por exemplo, recusa gravações).
    (r'\bCREATE\s+(OR\s+REPLACE\s+)?(CONSTRAINT\s+)?TRIGGER\b|\bCREATE\s+(OR\s+REPLACE\s+)?RULE\b', 'cria trigger'),
    (r'\b(DISABLE|ENABLE)\s+(ALWAYS\s+|REPLICA\s+)?(TRIGGER|RULE)\b', 'liga ou desliga trigger'),
    (r'\bRENAME\b', 'renomeia'),
    (r'\bALTER\s+(COLUMN\s+)?\S+\s+(SET\s+DATA\s+)?TYPE\b', 'troca tipo de coluna'),
    (r'\bALTER\s+(COLUMN\s+)?\S+\s+SET\s+NOT\s+NULL\b', 'passa a exigir valor'),
]


class Recusa(Exception):
    """Uma guarda recusou: nada foi alterado por este script."""


# Um leitor só, da esquerda para a direita, como o do PostgreSQL: o pedaço que
# começa primeiro ganha (`$$` dentro de string não abre corpo, `'` dentro de
# corpo não abre string), e `$tag$` ou E'' colados a um nome são parte do nome
# (`a$q$`, `€$q$`: fora do ASCII, tudo é letra). O que o PostgreSQL lê de outro
# jeito vira motivo, sem ser interpretado: string E'' (o `\'` e a continuação
# em outra linha, que herda o modo E), comentário de bloco aninhado, `$` solto
# e caractere fora do ASCII no código, que `\w`, `\s` e maiúsculas do Python
# leem de outro jeito. O texto comum para antes do `E'`, senão a string E''
# passaria por comum.
_IDENTIFIER_CHAR = r'A-Za-z0-9_$\x80-\U0010ffff'
_PEDACOS = re.compile(
    r"(?P<comment>--[^\n\r]*|/\*.*?\*/)"
    rf"|(?P<escape>(?<![{_IDENTIFIER_CHAR}])[Ee]'(?:[^'\\]|\\.|'')*'?)"
    r"|(?P<string>'(?:[^']|'')*')"
    r'|(?P<identifier>"(?:[^"]|"")*")'
    rf"|(?P<body>(?<![{_IDENTIFIER_CHAR}])\$(?P<tag>(?:[A-Za-z_]\w*)?)\$.*?\$(?P=tag)\$)"
    r"|(?P<end>;)"
    r"|(?P<text>(?:[^-/'\"$;Ee]|[Ee](?!'))+|.)",
    re.DOTALL)

UNREADABLE_ESCAPE = "string com escape (E'') que a régua não lê"
UNREADABLE_NESTED_COMMENT = 'comentário aninhado que a régua não lê'
UNREADABLE_DOLLAR = '$ fora de corpo de função (nome com $ ou parâmetro)'
UNREADABLE_CHARACTER = 'caractere fora do ASCII fora de string, comentário ou nome entre aspas'
# O que o PostgreSQL lê igual às regras: ASCII visível e os espaços dele.
_READABLE_CODE = re.compile(r'[\t\n\r\f -~]*')


def _parse(sql):
    """Separa a migration em comandos, (texto sem comentários, texto limpo), e diz o que a régua não lê.

    O `;` dentro de string, identificador entre aspas ou corpo `$$` não separa.
    No limpo, strings e corpos de função viram '': um UPDATE dentro do corpo de
    uma função não roda na migração, e o corpo de um `DO $$ ... $$` roda; por
    isso o `DO` inteiro fica fora da lista de permitidos, em vez de o corpo ser
    lido.
    """
    commands, unreadable, raw, clean = [], set(), [], []
    for token in _PEDACOS.finditer(sql):
        kind, text = token.lastgroup, token.group(0)
        if kind == 'escape':
            unreadable.add(UNREADABLE_ESCAPE)
        elif kind == 'comment' and text.startswith('/*') and '/*' in text[2:]:
            unreadable.add(UNREADABLE_NESTED_COMMENT)
        elif kind == 'text':
            if '$' in text:
                unreadable.add(UNREADABLE_DOLLAR)
            if not _READABLE_CODE.fullmatch(text):
                unreadable.add(UNREADABLE_CHARACTER)
        if kind == 'end':
            commands.append((raw, clean)); raw, clean = [], []
        elif kind == 'comment':
            raw.append(' '); clean.append(' ')
        else:
            raw.append(text)
            clean.append("''" if kind in ('escape', 'string', 'body') else text)
    commands.append((raw, clean))
    return [(' '.join(''.join(r).split()), ' '.join(''.join(c).split())) for r, c in commands if ''.join(r).strip()], unreadable


def comandos(sql):
    """Os comandos da migration, sem comentários, como o plano os mostra ao dono."""
    return [text for text, _ in _parse(sql)[0]]


def _clausulas(texto):
    """Divide as cláusulas de um ALTER TABLE nas vírgulas de fora dos parênteses."""
    partes, atual, nivel, aspas = [], [], 0, False
    for letra in texto:
        if letra == '"':
            aspas = not aspas
        elif not aspas and letra == '(':
            nivel += 1
        elif not aspas and letra == ')':
            nivel -= 1
        elif not aspas and nivel == 0 and letra == ',':
            partes.append(''.join(atual).strip()); atual = []
            continue
        atual.append(letra)
    partes.append(''.join(atual).strip())
    return partes


def _tabela(nome):
    """`"public"."Bets"` e `bets` viram `bets`: o nome sem esquema nem aspas."""
    return nome.split('.')[-1].strip('"').lower()


_CONSTRAINT = re.compile(r'ADD (CONSTRAINT \S+ )?(PRIMARY KEY|FOREIGN KEY|UNIQUE|CHECK)\b', re.IGNORECASE)
_INDICE_UNICO = re.compile(rf'CREATE UNIQUE INDEX .*? ON (ONLY )?(?P<tabela>{_NOME})', re.IGNORECASE)
_UNIQUE_INDEX_CREATED = re.compile(rf'CREATE UNIQUE INDEX (CONCURRENTLY )?(IF NOT EXISTS )?(?P<index>{_NOME}) ON ', re.IGNORECASE)
_INDEX_RENAMED = re.compile(rf'ALTER INDEX (IF EXISTS )?(?P<index>{_NOME}) RENAME TO (?P<renamed>{_ID})', re.IGNORECASE)
_INDEX_DROPPED = re.compile(rf'DROP INDEX (CONCURRENTLY )?(IF EXISTS )?(?P<index>{_NOME})', re.IGNORECASE)
# Sufixos que o Prisma (`_key`) e as migrations escritas à mão (`_uidx`) dão a
# índice único: valem quando a régua não tem o histórico nem o banco à mão.
_UNIQUE_INDEX_SUFFIX = re.compile(r'_(key|uidx)$', re.IGNORECASE)
DROPS_UNIQUE_INDEX = 'apaga índice único (o código antigo perde a idempotência e o ON CONFLICT nele)'


def _track_unique_indexes(comando, unique_indexes):
    """Acompanha, comando a comando, os nomes dos índices únicos (criação, troca de nome, remoção)."""
    created, renamed, dropped = (p.match(comando) for p in (_UNIQUE_INDEX_CREATED, _INDEX_RENAMED, _INDEX_DROPPED))
    if created:
        unique_indexes.add(_function_name(created.group('index')))
    elif renamed and _function_name(renamed.group('index')) in unique_indexes:
        unique_indexes.discard(_function_name(renamed.group('index')))
        unique_indexes.add(_function_name(renamed.group('renamed')))
    elif dropped:
        unique_indexes.discard(_function_name(dropped.group('index')))


def unique_indexes_of(sqls):
    """Os índices únicos que sobram depois das migrations dadas, na ordem."""
    unique_indexes = set()
    for sql in sqls:
        for comando in (clean for _, clean in _parse(sql)[0]):
            _track_unique_indexes(comando, unique_indexes)
    return unique_indexes


def _motivos_do_comando(comando, criadas=frozenset(), unique_indexes=frozenset()):
    """Vazio se o comando é aditivo; senão, por que não é.

    `criadas` são as tabelas criadas na mesma migration: constraint e índice
    único nelas são seguros; numa tabela existente o código antigo pode violá-los.
    `unique_indexes` são os índices únicos que existem antes do comando: sem
    um deles, o código antigo grava duplicata e o `ON CONFLICT` nas colunas
    dele falha.
    """
    def conhecidos(texto):
        nomes = [motivo for padrao, motivo in MOTIVOS_CONHECIDOS if re.search(padrao, texto, re.IGNORECASE)]
        return nomes or ['fora da lista de comandos aditivos: ' + texto[:100]]

    if re.search(PROIBIDO_EM_QUALQUER_COMANDO, comando, re.IGNORECASE):
        return ['executa consulta (SELECT) na migração']
    if any(re.fullmatch(padrao, comando, re.IGNORECASE) for padrao in COMANDOS_ADITIVOS):
        unico = _INDICE_UNICO.match(comando)
        if unico and _tabela(unico.group('tabela')) not in criadas:
            return ['índice único em tabela existente']
        dropped = _INDEX_DROPPED.fullmatch(comando)
        if dropped:
            index = _function_name(dropped.group('index'))
            if index in unique_indexes or _UNIQUE_INDEX_SUFFIX.search(index):
                return [DROPS_UNIQUE_INDEX]
        return []
    alter = _ALTER_TABLE.fullmatch(comando)
    if not alter:
        return conhecidos(comando)
    motivos = []
    for clausula in _clausulas(alter.group('clausulas')):
        if not any(re.fullmatch(padrao, clausula, re.IGNORECASE) for padrao in CLAUSULAS_ADITIVAS):
            motivos += conhecidos(clausula)
            continue
        if _tabela(alter.group('tabela')) not in criadas:
            if _CONSTRAINT.match(clausula):
                motivos.append('constraint nova em tabela existente')
            elif _NEW_COLUMN.match(clausula):
                motivos += _new_column_constraint_reasons(clausula)
        if re.search(r'\bGENERATED\s+ALWAYS\s+AS\s*\(', clausula, re.IGNORECASE):
            motivos.append('coluna gerada executa expressão nas linhas existentes')
        default = re.search(r'\bDEFAULT\b(?P<expr>.*)', clausula, re.IGNORECASE)
        if default and (re.search(r'\.(?!\d)', default.group('expr'))
                        or any(_function_name(nome) not in FUNCOES_DE_DEFAULT
                               for nome in _CHAMADA.findall(default.group('expr')))):
            motivos.append('DEFAULT chama função (executa nas linhas existentes)')
        elif (re.match(r'ADD\b', clausula, re.IGNORECASE)
              and re.search(r'(?<!\bIS )\bNOT NULL\b', clausula, re.IGNORECASE)
              and not re.search(r'\bDEFAULT\b|\bPRIMARY\s+KEY\b|\bFOREIGN\s+KEY\b|\bUNIQUE\b', clausula, re.IGNORECASE)):
            motivos.append('coluna nova NOT NULL sem DEFAULT')
    return motivos


def motivos_incompativeis(sql, unique_indexes=frozenset()):
    """Lista o que impede aplicar esta migration com o código antigo no ar.

    `unique_indexes`: os índices únicos que existem antes dela (do banco, no
    deploy, e das migrations anteriores).
    """
    parsed, unreadable = _parse(sql)
    unique_indexes = set(unique_indexes)
    motivos = list(unreadable)
    limpos = [clean for _, clean in parsed]
    criadas = {_function_name(m.group(1)).lower() for c in limpos if (m := _FUNCAO_CRIADA.match(c))}
    tabelas = frozenset(_tabela(m.group(2)) for c in limpos
                        if (m := re.match(rf'CREATE TABLE (IF NOT EXISTS )?({_NOME})', c, re.IGNORECASE)))
    for comando in limpos:
        motivos += _motivos_do_comando(comando, tabelas, unique_indexes)
        _track_unique_indexes(comando, unique_indexes)
        # Função nova só é inerte enquanto nada a chama. Chamada na mesma
        # migration (DEFAULT, CHECK, índice) roda o corpo que a régua não lê;
        # `(x).f` chama `f(x)` sem parênteses.
        if criadas and not _FUNCAO_CRIADA.match(comando):
            calls = _CHAMADA.findall(comando) + _ATTRIBUTE_CALL.findall(comando)
            if any(_function_name(nome).lower() in criadas for nome in calls):
                motivos.append('chama função criada nesta migration')
    if MARCA_MANUAL in sql:
        motivos.append('marcada para o caminho manual (' + MARCA_MANUAL + ')')
    return sorted(set(motivos))


def classificar(arquivos):
    """Para a CI: toda migration nova é aditiva ou se declara manual.

    Devolve as linhas de erro (vazio = aprovado).
    """
    erros = []
    for arquivo in arquivos:
        sql = Path(arquivo).read_text()
        motivos = motivos_incompativeis(sql, unique_indexes_before(Path(arquivo).parent))
        if not motivos:
            print(f'{arquivo}: aditiva; sai pelo publicar.sh --com-migration')
        elif MARCA_MANUAL in sql:
            print(f'{arquivo}: caminho manual declarado; o deploy automático vai recusá-la')
        else:
            erros.append(f'{arquivo}: ' + '; '.join(motivos))
    return erros


def unique_indexes_before(migration_dir):
    """Os índices únicos deixados pelas migrations de nome anterior, na pasta `prisma/migrations`."""
    earlier = sorted(p for p in migration_dir.parent.glob('*/migration.sql') if p.parent.name < migration_dir.name)
    return unique_indexes_of(p.read_text() for p in earlier)


def pendentes(aplicadas, locais):
    """Decide o que falta aplicar, recusando qualquer divergência de histórico.

    `aplicadas` e `locais`: {nome: sha256 do migration.sql}. Nova com nome
    anterior à última aplicada não é divergência: dois PRs com migration entram
    na main sem rebase, e a de nome menor pode chegar depois da outra. O
    `prisma migrate deploy` aplica a pendente fora de ordem, e ela passa pela
    mesma régua (`plano` a marca como fora de ordem).
    """
    faltando = sorted(set(aplicadas) - set(locais))
    if faltando:
        raise Recusa('o banco tem migrations que esta release não conhece: ' + ', '.join(faltando))
    alteradas = sorted(n for n in aplicadas if aplicadas[n] != locais[n])
    if alteradas:
        raise Recusa('migrations já aplicadas mudaram de conteúdo: ' + ', '.join(alteradas))
    return sorted(set(locais) - set(aplicadas))


def sql(query):
    return subprocess.check_output(['docker', 'exec', DB, 'psql', '-U', USER, '-d', USER, '-At',
                                    '-v', 'ON_ERROR_STOP=1', '-c', query], text=True).strip()


def unique_indexes_in_database():
    """Os índices únicos do banco, pelo catálogo: o nome não diz se o índice é único."""
    return set(sql('SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indisunique').splitlines())


def aplicadas_no_banco():
    if sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL') != '0':
        raise Recusa('há migration inacabada no banco; resolva antes (prisma migrate resolve), com o dono')
    linhas = sql('SELECT migration_name, checksum FROM _prisma_migrations '
                 'WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').splitlines()
    return dict(linha.split('|') for linha in linhas if linha)


def migrations_em(pasta):
    return {p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest()
            for p in (pasta / 'prisma' / 'migrations').glob('*/migration.sql')}


def plano(work, repo):
    meta = json.loads((work / 'release.json').read_text())
    build = Path(meta['buildDir'])
    locais = migrations_em(build)
    aplicadas = aplicadas_no_banco()
    novas = pendentes(aplicadas, locais)
    if not novas:
        raise Recusa('nenhuma migration a aplicar: o banco já está como a release')
    last_applied = max(aplicadas, default='')
    in_database = unique_indexes_in_database()
    itens = []
    for nome in novas:
        pasta = build / 'prisma' / 'migrations' / nome
        texto = (pasta / 'migration.sql').read_text()
        # As anteriores também contam: uma pendente pode criar o índice único
        # que a seguinte apaga, e o banco ainda não o tem.
        motivos = motivos_incompativeis(texto, in_database | unique_indexes_before(pasta))
        # O dono aprova o SQL, não o nome da pasta.
        itens.append({'migration': nome, 'aditiva': not motivos, 'motivos': motivos, 'outOfOrder': nome < last_applied,
                      'comandos': [c if len(c) <= 200 else c[:200] + '…' for c in comandos(texto)]})
    return meta, build, locais, itens


def admin_url():
    for linha in RUNTIME_ENV.read_text().splitlines():
        if linha.startswith('DATABASE_URL_ADMIN='):
            valor = linha.split('=', 1)[1].strip().strip('"').strip("'")
            if valor:
                return valor
    raise Recusa('DATABASE_URL_ADMIN ausente em ' + str(RUNTIME_ENV))


class MigrateEstourou(Exception):
    """O migrate passou do teto e foi encerrado (container e sessão no banco)."""


def url_do_migrate(url, nome):
    """O URL administrativo com os limites da sessão do migrate e o nome dela.

    O Prisma passa `options` ao servidor na conexão (conferido com o Prisma 7.10
    e o PostgreSQL 17: o lock_timeout cancela com 55P03), e o `application_name`
    identifica a sessão para encerrá-la no teto.
    """
    partes = urllib.parse.urlsplit(url)
    parametros = urllib.parse.parse_qsl(partes.query, keep_blank_values=True)
    opcoes = ' '.join([valor for chave, valor in parametros if chave == 'options']
                      + [f'-c lock_timeout={MIGRATE_LOCK_TIMEOUT}', f'-c statement_timeout={MIGRATE_STATEMENT_TIMEOUT}'])
    parametros = [(chave, valor) for chave, valor in parametros if chave not in ('options', 'application_name')]
    parametros += [('options', opcoes), ('application_name', nome)]
    return urllib.parse.urlunsplit(partes._replace(query=urllib.parse.urlencode(parametros, quote_via=urllib.parse.quote)))


def encerrar_migrate(nome):
    """Remove o container do migrate e encerra a sessão dele no banco.

    O SQL em curso não para só porque o cliente sumiu: sem o
    pg_terminate_backend, o comando seguiria no servidor.
    """
    assert re.fullmatch(r'[a-z0-9][a-z0-9.-]*', nome), nome
    subprocess.run(['docker', 'rm', '-f', nome], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        sql(f"SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE application_name = '{nome}'")
    except subprocess.CalledProcessError:
        print(f'AVISO: não consegui encerrar a sessão {nome} no banco; confira pg_stat_activity.', file=sys.stderr, flush=True)


def _esperar_cliente(processo, segundos=30):
    try:
        processo.wait(timeout=segundos)
    except subprocess.TimeoutExpired:
        processo.kill()
        processo.wait()


def rodar_no_container(comando, nome, env, log, teto=MIGRATE_TETO_S):
    """Roda o `docker run` do migrate com nome e teto; devolve o código de saída.

    O cliente fica na própria sessão: o Ctrl-C do terminal não o derruba no
    meio. Passou do teto: encerra e levanta MigrateEstourou. Sinal no meio: o
    container seguiria sozinho, então espera ele acabar (até 30 s) ou o encerra
    antes de devolver o sinal, para ninguém religar o worker com o migrate
    ainda rodando.
    """
    subprocess.run(['docker', 'rm', '-f', nome], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    with log.open('w') as saida:
        processo = subprocess.Popen(comando, env=env, stdout=saida, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            return processo.wait(timeout=teto)
        except subprocess.TimeoutExpired:
            encerrar_migrate(nome)
            _esperar_cliente(processo)
            limite = f'{teto // 60} min' if teto % 60 == 0 else f'{teto} s'
            raise MigrateEstourou(f'o migrate passou de {limite} e foi encerrado (container e sessão no banco); '
                                  'a migration pode ter ficado aplicada em parte (confira _prisma_migrations)')
        except BaseException:
            try:
                processo.wait(timeout=MIGRATE_ESPERA_AO_INTERROMPER_S)
            except subprocess.TimeoutExpired:
                encerrar_migrate(nome)
                _esperar_cliente(processo)
            raise


@contextlib.contextmanager
def migrador(work, meta, locais, repo):
    """Instala o CLI do Prisma e devolve `rodar(comando, log)`, que roda `prisma migrate <comando>`.

    O papel administrativo e a instalação (a parte lenta, ~1 min) vêm na
    entrada, antes de o chamador parar o worker. `rodar` devolve o código de
    saída do Prisma; a saída vai para `log` na pasta da release.
    """
    url = admin_url()
    # Só os arquivos necessários, do commit da release. As migrations têm de ser
    # as mesmas do artefato conferido pela CI.
    fonte = work / 'migrador'
    fonte.mkdir(mode=0o700, exist_ok=True)
    arquivos = ['package.json', 'package-lock.json', '.npmrc', 'prisma.config.ts', 'prisma',
                'scripts/check-toolchain.mjs', 'scripts/postinstall.mjs']
    # Roda como root num checkout do usuário deploy: o Git recusaria por "dubious
    # ownership". A exceção vale só para este comando e este diretório.
    arquivo_tar = subprocess.run(['git', '-c', f'safe.directory={repo}', 'archive', meta['sha'], *arquivos],
                                 cwd=repo, stdout=subprocess.PIPE, check=True).stdout
    subprocess.run(['tar', '-x', '-C', str(fonte)], input=arquivo_tar, check=True)
    assert migrations_em(fonte) == locais, 'migrations do commit diferem das do artefato da CI'

    volume = 'automabaca-novo-migrador-' + meta['release']
    nome = 'automabaca-novo-migrate-' + meta['release']
    subprocess.run(['docker', 'volume', 'create', volume], stdout=subprocess.DEVNULL, check=True)
    try:
        base = ['docker', 'run', '--rm', '-v', f'{fonte}:/app', '-v', f'{volume}:/app/node_modules', '-w', '/app']
        # Instala o CLI do Prisma pelo lockfile, com integridade conferida, SEM
        # nenhum segredo no ambiente.
        with (work / 'migrador-npm.log').open('w') as saida:
            subprocess.run(base + [IMAGEM_NODE, 'sh', '-c',
                                   f'npm install -g npm@{NPM} --no-fund --no-audit && npm ci --no-audit --fund=false'],
                           stdout=saida, stderr=subprocess.STDOUT, check=True)

        def rodar(comando, log):
            # Só este container vê o papel administrativo, e só pelo ambiente.
            env = dict(os.environ, DATABASE_URL_ADMIN=url_do_migrate(url, nome))
            env['DATABASE_URL'] = env['DATABASE_URL_ADMIN']
            return rodar_no_container(base + ['--name', nome, '--network', REDE, '-e', 'DATABASE_URL_ADMIN',
                                              '-e', 'DATABASE_URL', IMAGEM_NODE, 'npx', 'prisma', 'migrate', comando],
                                      nome, env, work / log)
        yield rodar
    finally:
        subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def agora_iso():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def fazer_backup(work):
    """Backup com restauração conferida. O publish.py reaproveita este backup.log se tiver menos de 30 min."""
    with (work / 'backup.log').open('w') as saida:
        subprocess.run(['python3', str(Path(__file__).with_name('backup.py')), '--release-dir', str(work)],
                       stdout=saida, stderr=subprocess.STDOUT, check=True)
    backup = json.loads((work / 'backup.log').read_text().splitlines()[-1])
    assert backup['archiveListValidated'] and backup['disposableRestoreValidated'] and backup['bytes'] > 0
    return backup


def estado_do_worker():
    obj = json.loads(subprocess.check_output(['docker', 'inspect', WORKER]))[0]
    return {'id': obj['Id'], 'image': obj['Config']['Image'], 'running': obj['State']['Running']}


def parar_worker():
    """Para o worker antigo (shutdown gracioso, até o stop_grace_period do compose).

    Só o worker: a web continua no ar, o webhook do Telegram grava no pg-boss e
    o worker novo consome o que ficou na fila. Um sinal no meio não corta a
    parada: o daemon a completa de qualquer jeito, e um `docker start` antes
    disso seria ignorado, deixando o worker parado. Por isso o `docker stop`
    roda na própria sessão e, interrompido, este espera ele acabar.
    """
    processo = subprocess.Popen(['docker', 'stop', WORKER], stdout=subprocess.DEVNULL, start_new_session=True)
    try:
        codigo = processo.wait()
    except BaseException:
        processo.wait()
        raise
    if codigo != 0:
        raise subprocess.CalledProcessError(codigo, ['docker', 'stop', WORKER])


def religar_worker(work, relatorio, quem):
    """Sobe de novo o worker antigo que o migrar.py parou (código antigo contra o schema de agora)."""
    try:
        subprocess.run(['docker', 'start', WORKER], stdout=subprocess.DEVNULL, check=True)
        if not estado_do_worker()['running']:
            raise subprocess.CalledProcessError(0, ['docker', 'start', WORKER])
        relatorio.update(workerRestartedAt=agora_iso(), workerRestartedBy=quem)
        print(f'AVISO: o worker antigo voltou a rodar ({quem}). Se o migrate aplicou algo, ele roda contra o '
              'schema novo até uma publicação: acompanhe os erros do worker e decida com o dono.', file=sys.stderr, flush=True)
    except subprocess.CalledProcessError:
        relatorio['workerRestartFailed'] = agora_iso()
        print(f'ERRO: o worker continua PARADO. Suba-o à mão: sudo docker start {WORKER}', file=sys.stderr, flush=True)
    gravar_relatorio(work, relatorio)


def motivo_da_falha(log, codigo):
    """Por que o migrate falhou, pelo que o Prisma escreveu no log (sem ecoá-lo)."""
    texto = log.read_text(errors='replace') if log.is_file() else ''
    if codigo == 0:
        return 'o banco não ficou igual à release depois do migrate'
    if '55P03' in texto or 'lock timeout' in texto:
        motivo = (f'o migrate esperou mais de {MIGRATE_LOCK_TIMEOUT} por um lock (outra sessão segurava a tabela) '
                  'e desistiu')
    elif 'statement timeout' in texto:
        motivo = f'um comando do migrate passou de {MIGRATE_STATEMENT_TIMEOUT} e o PostgreSQL o cancelou'
    else:
        motivo = f'o prisma migrate falhou (saída {codigo})'
    # O Prisma não usa transação: os comandos antes do que falhou ficam.
    return motivo + '; a migration pode ter ficado aplicada em parte (confira _prisma_migrations)'


def gravar_relatorio(work, relatorio):
    (work / 'migration.json').write_text(json.dumps(relatorio, indent=2) + '\n')


def _interromper(sinal, _quadro):
    raise SystemExit(128 + sinal)


def aplicar(work, meta, locais, repo):
    """Backup conferido e CLI instalado; só então o worker para e o migrate roda.

    Sucesso deixa o worker antigo parado (`workerStopped` em `migration.json`):
    quem sobe o novo é o publish.py. Falha religa o antigo antes de sair.
    """
    backup = fazer_backup(work)
    relatorio = {'startedAt': agora_iso(), 'release': meta['release'], 'sha': meta['sha'],
                 'backup': backup['path'], 'exitCode': None, 'identicalToRelease': False}
    with migrador(work, meta, locais, repo) as prisma:
        worker = estado_do_worker()
        if not worker['running']:
            raise Recusa('o worker já estava parado antes da migração: produção não está saudável')
        # Gravado ANTES do stop: se a parada for interrompida, quem religa (este
        # script, ou o publicar.sh ao sair) sabe qual container é.
        relatorio.update(workerStopped=True, workerContainerId=worker['id'], workerImage=worker['image'],
                         workerStoppedAt=agora_iso())
        gravar_relatorio(work, relatorio)
        anteriores = {}
        try:
            # SIGTERM/SIGHUP da parada em diante também passam pelo religamento;
            # sinal ignorado de propósito (o publicador roda sob `nohup`) continua
            # ignorado. O Ctrl-C já chega como KeyboardInterrupt.
            anteriores = {s: signal.signal(s, _interromper) for s in (signal.SIGTERM, signal.SIGHUP)
                          if signal.getsignal(s) is not signal.SIG_IGN}
            parar_worker()
            codigo = prisma('deploy', 'migrate.log')
            depois = aplicadas_no_banco() if codigo == 0 else None
            relatorio.update(appliedAt=agora_iso(), exitCode=codigo, identicalToRelease=depois == locais)
            if codigo != 0 or depois != locais:
                raise RuntimeError(motivo_da_falha(work / 'migrate.log', codigo))
        except BaseException as erro:
            relatorio['error'] = f'{type(erro).__name__}: {erro}'[:300]
            religar_worker(work, relatorio, 'migrar.py, depois da falha')
            if isinstance(erro, Exception):
                worker_agora = ('o worker antigo voltou a rodar' if relatorio.get('workerRestartedAt')
                                else f'o worker está PARADO (sudo docker start {WORKER})')
                raise RuntimeError(f'{erro}. {worker_agora}; as imagens continuam na versão anterior. NÃO publique: '
                                   'veja migrate.log e decida com o dono. Backup de antes: ' + backup['path']) from erro
            raise
        finally:
            for sinal, tratador in anteriores.items():
                signal.signal(sinal, tratador)
    gravar_relatorio(work, relatorio)


def religar_se_parado(work):
    """Rede de segurança do publicar.sh ao sair: o worker que o migrar.py parou não fica parado.

    Só age se o container parado ainda é o mesmo (a publicação troca o
    container; o rollback também). Devolve se religou.
    """
    arquivo = work / 'migration.json'
    if not arquivo.is_file():
        return False
    relatorio = json.loads(arquivo.read_text())
    if not relatorio.get('workerStopped'):
        return False
    worker = estado_do_worker()
    if worker['id'] != relatorio.get('workerContainerId') or worker['running']:
        return False
    religar_worker(work, relatorio, 'publicar.sh, publicação não concluída')
    return True


def recusadas_sem_aprovacao(itens, aprovadas):
    """Migrations que não são aditivas e que o dono não aprovou pelo nome.

    Aprovar uma migration manual é decidir que ela pode rodar com a versão atual
    no ar (em geral porque uma release anterior já parou de usar o que ela
    apaga). O nome precisa bater exatamente: aprovar uma não libera outra.
    """
    return [i for i in itens if not i['aditiva'] and i['migration'] not in aprovadas]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--release-dir', type=Path)
    ap.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent,
                    help='checkout de onde sai o commit da release (padrão: o deste script)')
    modo = ap.add_mutually_exclusive_group(required=True)
    modo.add_argument('--plano', action='store_true', help='só lê e mostra o que seria aplicado')
    modo.add_argument('--aplicar', action='store_true')
    modo.add_argument('--ensaio', action='store_true',
                      help='percorre o caminho inteiro com `prisma migrate status`, que só lê; sem backup')
    modo.add_argument('--religar-worker', action='store_true',
                      help='sobe de novo o worker que o --aplicar parou, se a publicação não o trocou')
    modo.add_argument('--classificar', nargs='+', metavar='MIGRATION_SQL',
                      help='CI: recusa migration nova que não é aditiva nem se declara manual')
    ap.add_argument('--aprovada', action='append', default=[], metavar='MIGRATION',
                    help='nome da migration manual que o dono aprovou aplicar (repita para mais de uma)')
    args = ap.parse_args()
    if args.classificar:
        erros = classificar(args.classificar)
        for erro in erros:
            print('::error::' + erro, flush=True)
        if erros:
            print('Migration que não é aditiva vai pelo caminho manual (docs/RELEASE.md): declare com '
                  f'"-- {MARCA_MANUAL}: <motivo>" na primeira linha.', flush=True)
        raise SystemExit(1 if erros else 0)
    if not args.release_dir:
        ap.error('--release-dir é obrigatório fora do --classificar')
    os.umask(0o077)
    work = args.release_dir.resolve()
    try:
        if args.religar_worker:
            religar_se_parado(work)
            return
        if args.ensaio:
            # Prova rede, papel administrativo, CLI e conexão sem mudar o banco.
            meta = json.loads((work / 'release.json').read_text())
            locais = migrations_em(Path(meta['buildDir']))
            with migrador(work, meta, locais, args.repo.resolve()) as prisma:
                codigo = prisma('status', 'migrate-status.log')
            linhas = [l for l in (work / 'migrate-status.log').read_text().splitlines()
                      if l.strip() and not l.startswith('npm ')]
            print('\n'.join(linhas[-3:]), flush=True)
            print(json.dumps({'ensaio': 'ok' if codigo == 0 else 'falhou', 'prismaExit': codigo}), flush=True)
            raise SystemExit(0 if codigo == 0 else 1)
        meta, build, locais, itens = plano(work, args.repo.resolve())
        for item in itens:
            if item['aditiva']:
                estado = 'aditiva'
            elif item['migration'] in args.aprovada:
                estado = 'MANUAL, APROVADA PELO DONO: ' + '; '.join(item['motivos'])
            else:
                estado = 'RECUSADA: ' + '; '.join(item['motivos'])
            if item['outOfOrder']:
                estado += '; fora de ordem: o banco já tem uma de nome maior'
            print(f"\n{item['migration']} ({estado})", flush=True)
            for comando in item['comandos']:
                print('  ' + comando + ';', flush=True)
        print(json.dumps({'migrations': itens}, ensure_ascii=False), flush=True)
        recusadas = recusadas_sem_aprovacao(itens, args.aprovada)
        if recusadas:
            raise Recusa('migration incompatível com a versão no ar: ' + '; '.join(
                f"{i['migration']} ({', '.join(i['motivos'])})" for i in recusadas))
        if args.aplicar:
            aplicar(work, meta, locais, args.repo.resolve())
            print(json.dumps({'migrated': True, 'applied': [i['migration'] for i in itens],
                              'workerStopped': True}), flush=True)
    except Recusa as erro:
        print('RECUSADO: ' + str(erro), file=sys.stderr, flush=True)
        raise SystemExit(2)
    except RuntimeError as erro:
        print('FALHOU: ' + str(erro), file=sys.stderr, flush=True)
        raise SystemExit(1)


if __name__ == '__main__':
    main()
