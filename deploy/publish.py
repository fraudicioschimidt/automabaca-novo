"""Publica uma release já preparada, com rollback automático.

Um arquivo só, versionado, que recebe o diretório da release por argumento.
Nunca copie este script para uma release: cópia editada à mão arrasta etapas
de outra release e quebra a publicação no meio.

    sudo python3 deploy/publish.py --release-dir <dir> --preflight
    sudo python3 deploy/publish.py --release-dir <dir>

A troca não espera jogo começar: reinicia o worker mesmo com jogo Pinnacle17
nos minutos finais antes do kickoff.

Numa release com migration o migrar.py deixa o worker antigo parado
(`workerStopped` em `migration.json`): o preflight aceita esse estado e a troca
sobe o worker novo. O rollback volta as imagens, não o schema: com migration,
ele sobe o worker antigo contra o schema novo.
"""
from pathlib import Path
import argparse, json, subprocess, datetime, time, hashlib, urllib.request, urllib.error, os, fcntl, re

COMPOSE = Path('/srv/apps/automabaca-novo/deploy/compose.yaml')
# O que esta tentativa fez com a troca, para o publicar.sh dizer em que estado a
# produção ficou: trocou o compose, reverteu, ou a reversão não saiu.
SWAP_MARKERS = ['swap-started.json', 'rollback.json', 'rollback-failed.json']


def now():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def compose_image_ref(contents, role):
    match = re.search(r'^\s*image:\s*(\S*automabaca-novo-' + re.escape(role) + r'(?:@|:)\S+)\s*$', contents, re.MULTILINE)
    assert match, 'missing application image in Compose: ' + role
    return match.group(1)


def worker_stopped_for_migration(migration, worker):
    """O worker está parado porque o migrar.py o parou para o migrate, e ninguém o mexeu depois.

    Só vale o mesmo container que ele parou (id em `migration.json`), com a
    migration concluída e sem ter sido religado depois. Qualquer outro worker
    parado é produção fora do ar.
    """
    return bool(migration and migration.get('workerStopped') and migration.get('exitCode') == 0
                and not migration.get('workerRestartedAt')
                and migration.get('workerContainerId') == worker['id'] and not worker['running'])


def preflight_problems(initial, base_images, stopped_for_migration, web_reaches_database):
    """O que impede publicar a partir do estado atual dos containers (vazio = pode).

    Com o worker parado pela migração, a web fica `unhealthy` em uns 2 min
    porque o healthcheck dela é o `/api/health`, que exige o worker. Nesse caso
    vale a web responder e alcançar o banco (`web_reaches_database`, chamada só
    se preciso). Fora dele, os três containers precisam estar healthy.
    """
    problems = []
    if any(initial[role]['image'] != base_images[role] for role in ['web', 'worker']):
        problems.append('production is not on base release')
    if not stopped_for_migration:
        if not all(s['health'] == 'healthy' for s in initial.values()):
            problems.append('production not healthy before publishing')
        return problems
    if initial['db']['health'] != 'healthy':
        problems.append('production not healthy before publishing: db')
    web = initial['web']
    if not (web['running'] and (web['health'] == 'healthy' or web_reaches_database())):
        problems.append('production not healthy before publishing: web')
    return problems


def roll_back(work, compose, before, updated, base, set_compose, restart_services):
    """Volta o compose e os serviços para a base e grava o desfecho na pasta da release.

    `rollback.json` só quando os serviços antigos subiram. Compose mexido por
    outro no meio (não é mais o que esta publicação gravou) ou reversão que
    falha vão para `rollback-failed.json`: aí a produção pode estar na release
    nova, na base ou misturada, e ninguém deve ler "continua na base".
    """
    try:
        if compose.read_text() != updated:
            raise RuntimeError('Compose changed during publish; not rolled back')
        set_compose(before)
        restart_services()
        (work / 'rollback.json').write_text(json.dumps({'rolledBackAt': now(), 'restored': base}, indent=2) + '\n')
        print('Previous application images restored: ' + base, flush=True)
    except Exception as error:
        reason = f'{type(error).__name__}: {error}'[:300]
        (work / 'rollback-failed.json').write_text(json.dumps({'failedAt': now(), 'error': reason}, indent=2) + '\n')
        print('ROLLBACK FAILED: ' + reason, flush=True)


def web_reaches_database():
    """A web responde e alcança o banco (o 503 sem worker é esperado aqui)."""
    try:
        with urllib.request.urlopen('http://127.0.0.1:3101/api/health', timeout=15) as response:
            data = json.load(response)
    except urllib.error.HTTPError as error:
        data = json.load(error)
    except (OSError, ValueError):
        return False
    return data.get('db') is True


def main():
    os.umask(0o077)
    _ap = argparse.ArgumentParser()
    _ap.add_argument('--release-dir', type=Path, default=Path.cwd())
    _ap.add_argument('--backup-script', type=Path, default=Path(__file__).resolve().parent / 'backup.py')
    # Flag, e não só variável de ambiente: `sudo` não repassa o ambiente por
    # padrão, então `PREFLIGHT_ONLY=1 sudo ...` publicaria de verdade em silêncio.
    _ap.add_argument('--preflight', action='store_true', help='só confere, não muda nada')
    _ap.add_argument('--com-backup', action='store_true',
                     help='faz o backup conferido mesmo sem migration (release arriscada para os dados)')
    _args = _ap.parse_args()
    work = _args.release_dir.resolve()
    preflight_only = _args.preflight or os.environ.get('PREFLIGHT_ONLY') == '1'
    if not preflight_only:
        # A pasta é reaproveitada numa nova tentativa: o marcador de uma anterior
        # faria uma falha antes da troca sair como "revertida".
        for name in SWAP_MARKERS:
            (work / name).unlink(missing_ok=True)
    meta = json.loads((work / 'release.json').read_text())
    release, base, sha, base_sha = meta['release'], meta['baseRelease'], meta['sha'], meta['baseSha']
    build = Path(meta['buildDir'])
    compose = COMPOSE
    before = (work / 'compose-before.yaml').read_bytes()
    text = before.decode()
    digest_file = work / 'image-digests.json'
    assert digest_file.is_file(), 'image-digests.json is required: production images must come from the registry with a digest'
    image_meta = json.loads(digest_file.read_text())
    assert image_meta.get('commit') == sha, 'image-digests.json belongs to another source commit'
    image_refs = image_meta.get('digests', {})
    assert set(image_refs) == {'web', 'worker'}, 'image-digests.json must contain web and worker'
    assert all(re.fullmatch(r'.+@sha256:[0-9a-f]{64}', value) for value in image_refs.values()), \
        'production image reference is not pinned by digest'

    base_images = {role: compose_image_ref(text, role) for role in ['web', 'worker']}
    updated = text
    for role in ['web', 'worker']:
        old_ref = base_images[role]
        assert updated.count(old_ref) == 1, 'unexpected ' + role + ' image occurrences'
        updated = updated.replace(old_ref, image_refs[role], 1)
    assert updated.count(base) == 2, 'unexpected base release occurrences after image pinning'
    assert text.count('AUTOMABACA_RELEASE_SHA: ' + base_sha) == 2, 'unexpected base sha occurrences'
    updated = updated.replace(base, release).replace('AUTOMABACA_RELEASE_SHA: ' + base_sha, 'AUTOMABACA_RELEASE_SHA: ' + sha)
    command = ['sudo', '-n', 'docker', 'compose', '-f', str(compose)]


    def step(name, args):
        print('STEP ' + name, flush=True)
        with (work / (name + '.log')).open('w') as output:
            subprocess.run(args, stdout=output, stderr=subprocess.STDOUT, check=True)


    def status(role):
        obj = json.loads(subprocess.check_output(['sudo', '-n', 'docker', 'inspect', 'automabaca-novo-' + role]))[0]
        return {'role': role, 'id': obj['Id'], 'image': obj['Config']['Image'], 'imageId': obj['Image'],
                'health': obj['State'].get('Health', {}).get('Status'), 'restarts': obj['RestartCount'],
                'startedAt': obj['State']['StartedAt'], 'running': obj['State']['Running']}


    def env_hash(role):
        obj = json.loads(subprocess.check_output(['sudo', '-n', 'docker', 'inspect', 'automabaca-novo-' + role]))[0]
        env = sorted(e for e in obj['Config']['Env'] if e.split('=', 1)[0] not in ['AUTOMABACA_RELEASE_ID', 'AUTOMABACA_RELEASE_SHA'])
        return hashlib.sha256(json.dumps(env).encode()).hexdigest()


    def sql(query):
        return subprocess.check_output(['sudo', '-n', 'docker', 'exec', 'automabaca-novo-db', 'psql', '-U', 'automabaca_novo',
                                        '-d', 'automabaca_novo', '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], text=True).strip()


    def wait_healthy(role, seconds=300):
        until = time.monotonic() + seconds
        while time.monotonic() < until:
            item = status(role)
            if item['image'] != image_refs[role]:
                raise RuntimeError('Release changed during validation: ' + role)
            if item['restarts'] > 0:
                raise RuntimeError('New service restarted: ' + role)
            if item['running'] and item['health'] == 'healthy':
                return item
            time.sleep(3)
        raise RuntimeError('Service not healthy: ' + role)


    def health(url):
        with urllib.request.urlopen(url, timeout=15) as response:
            data = json.load(response)
            assert response.status == 200 and data['ok'] and data['release'] == sha[:12], data
            return {'status': response.status, 'ok': data['ok'], 'db': data['db'], 'worker': data['worker'], 'release': data['release']}


    def set_compose(contents):
        # Nome derivado da release: dois publishes simultâneos não disputam o mesmo
        # temporário, e o arquivo largado por uma falha diz de quem era.
        temporary = compose.with_name('.compose-' + release + '-ready.yaml')
        temporary.write_bytes(contents)
        os.chmod(temporary, 0o600)
        os.replace(temporary, compose)


    lock = (compose.parent / '.deployment.lock').open('a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)

    # ---- Pre-flight (read-only) ----
    assert compose.read_bytes() == before, 'Compose changed since preparation'
    images = json.loads((work / 'images.json').read_text())
    for role in ['web', 'worker']:
        prepared_tag = 'automabaca-novo-' + role + ':' + release
        image_id = subprocess.check_output(['sudo', '-n', 'docker', 'image', 'inspect', prepared_tag, '--format', '{{.Id}}'], text=True).strip()
        assert image_id == images[role], 'image id mismatch: ' + role
        assert subprocess.check_output(['sudo', '-n', 'docker', 'image', 'inspect', 'automabaca-novo-' + role + ':' + base, '--format', '{{.Id}}'], text=True).strip(), 'rollback image missing'
        repo_digests = json.loads(subprocess.check_output(['sudo', '-n', 'docker', 'image', 'inspect', prepared_tag, '--format', '{{json .RepoDigests}}'], text=True))
        assert image_refs[role] in repo_digests, 'prepared image digest mismatch: ' + role
    initial = {r: status(r) for r in ['web', 'worker', 'db']}
    # `migration.json` só existe se o migrar.py aplicou migration nesta release;
    # ele para o worker antes do migrate e deixa para esta publicação subir o novo.
    migration_file = work / 'migration.json'
    migration_record = json.loads(migration_file.read_text()) if migration_file.is_file() else None
    worker_stopped = worker_stopped_for_migration(migration_record, initial['worker'])
    problems = preflight_problems(initial, base_images, worker_stopped, web_reaches_database)
    assert not problems, '; '.join(problems)
    env_before = {r: env_hash(r) for r in ['web', 'worker']}
    applied = dict(line.split('|') for line in sql('SELECT migration_name,checksum FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL').splitlines())
    local = {p.parent.name: hashlib.sha256(p.read_bytes()).hexdigest() for p in (build / 'prisma/migrations').glob('*/migration.sql')}
    assert applied == local, 'migration set differs; this release must not need migrations'
    assert sql('SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NULL AND rolled_back_at IS NULL') == '0'
    migration_applied = migration_record is not None
    migration = {'required': migration_applied, 'appliedMigrations': len(applied), 'identicalToRelease': True,
                 'workerStoppedForMigration': worker_stopped}
    if preflight_only:
        print(json.dumps({'preflight': 'passed', 'release': release, 'base': base, 'migrations': len(applied),
                          'workerStoppedForMigration': worker_stopped,
                          'initial': {r: [initial[r]['image'], initial[r]['health']] for r in initial}}), flush=True)
        raise SystemExit(0)

    started = now()
    mutated = False
    try:
        # Backup conferido só quando a release aplicou migration (o do migrar.py,
        # reaproveitado se tiver menos de 30 min) ou com --com-backup. Sem migration
        # a troca não toca o schema, e o que ela desfaz em caso de falha são as
        # imagens; o ponto de volta dos DADOS é o backup diário conferido (04:15–04:25 UTC).
        # Custava ~25 s por publicação e um dump em claro em backups/ a cada merge.
        backup = None
        if migration_applied or _args.com_backup:
            backup = json.loads((work / 'backup.log').read_text().splitlines()[-1]) if (work / 'backup.log').exists() else None
            if not backup or (datetime.datetime.now(datetime.timezone.utc) - datetime.datetime.fromisoformat(backup['createdAt'])).total_seconds() >= 1800:
                step('backup', ['sudo', '-n', 'python3', str(_args.backup_script), '--release-dir', str(work)])
                backup = json.loads((work / 'backup.log').read_text().splitlines()[-1])
            assert backup['archiveListValidated'] and backup['disposableRestoreValidated'] and backup['bytes'] > 0
            assert hashlib.sha256((Path(backup['path']) / 'database.dump').read_bytes()).hexdigest() == backup['sha256']
        assert compose.read_bytes() == before, 'Compose changed during preparation'
        set_compose(updated.encode())
        mutated = True
        (work / 'swap-started.json').write_text(json.dumps({'startedAt': now(), 'release': release, 'base': base}, indent=2) + '\n')
        step('publish-services', command + ['up', '-d', '--no-deps', 'worker', 'web'])
        worker = wait_healthy('worker')
        web = wait_healthy('web')
        worker_start = datetime.datetime.fromisoformat(worker['startedAt'].replace('Z', '+00:00'))
        for attempt in range(60):
            last = sql("SELECT max(completed_on) FROM pgboss.job WHERE name='health.heartbeat' AND state='completed'")
            if last and datetime.datetime.fromisoformat(last) > worker_start:
                break
            time.sleep(3)
        else:
            raise RuntimeError('No heartbeat after worker startup')
        step('current-instance-health', ['sudo', '-n', 'docker', 'exec', 'automabaca-novo-worker', 'node', 'dist/worker-healthcheck.mjs'])
        http = {url: health(url) for url in ['http://127.0.0.1:3101/api/health', 'https://v2.fraudicio.com.br/api/health']}
        # Log-archive freshness is host tooling, not this release: record, do not roll back on 503.
        try:
            with urllib.request.urlopen('http://127.0.0.1:3101/api/health/observability', timeout=15) as response:
                observability_status = response.status
        except urllib.error.HTTPError as error:
            observability_status = error.code
        assert observability_status in (200, 503), 'observability route unavailable'
        live_hash = subprocess.check_output(['sudo', '-n', 'docker', 'exec', 'automabaca-novo-worker', 'sha256sum', 'dist/worker.mjs'], text=True).split()[0]
        assert live_hash == hashlib.sha256((work / 'worker-layer/dist/worker.mjs').read_bytes()).hexdigest(), 'worker bundle mismatch'
        live_build = subprocess.check_output(['sudo', '-n', 'docker', 'exec', 'automabaca-novo-web', 'cat', '.next/BUILD_ID'], text=True).strip()
        assert live_build == (work / 'web-layer/.next/BUILD_ID').read_text().strip(), 'web build mismatch'
        states = {r: status(r) for r in ['web', 'worker', 'db']}
        assert states['db']['id'] == initial['db']['id'], 'Database container changed'
        assert all(s['health'] == 'healthy' and s['restarts'] == 0 for s in states.values())
        assert {r: env_hash(r) for r in ['web', 'worker']} == env_before, 'Runtime configuration changed'
        report = {'publishedAt': now(), 'startedAt': started, 'release': release, 'sha': sha, 'previousRelease': base,
                  'migration': migration, 'containers': states, 'http': http, 'observabilityHttp': observability_status,
                  'workerHeartbeatAfterStartup': True, 'currentInstanceHealthPassed': True, 'workerBundleMatches': True,
                  'webBuildMatches': True, 'webBuildId': live_build, 'runtimeConfigurationUnchanged': True,
                  'browserValidation': 'CI canonical suite', 'backup': backup, 'rollbackUsed': False}
        (work / 'publication.json').write_text(json.dumps(report, indent=2) + '\n')
        print(json.dumps({'published': True, 'release': release, 'services': 'healthy', 'ciBrowserPassed': True}), flush=True)
    except Exception as error:
        print(json.dumps({'published': False, 'errorType': type(error).__name__, 'error': str(error)[:300]}), flush=True)
        if mutated:
            roll_back(work, compose, before, updated, base, set_compose,
                      lambda: step('rollback-services', command + ['up', '-d', '--no-deps', 'worker', 'web']))
        raise


if __name__ == '__main__':
    main()
