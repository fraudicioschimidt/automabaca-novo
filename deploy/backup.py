"""Dump do banco antes de publicar, com restauração conferida em container isolado.

Um dump que ninguém tentou restaurar não é um backup — é um arquivo. Por isso
aqui o dump é restaurado num Postgres descartável, sem rede e sem porta, e só
então declarado válido.

O nome da pasta sai da release sendo publicada, nunca de texto fixo: um nome
escrito à mão fica para trás e o backup ganha o nome de outra release.

    python3 deploy/backup.py --release-dir <dir>
"""
from pathlib import Path
import argparse, subprocess, datetime, json, hashlib, os, sys, time

DB = 'automabaca-novo-db'
USER = 'automabaca_novo'


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--release-dir', type=Path, default=Path.cwd())
    ap.add_argument('--raiz', type=Path, default=Path('/srv/apps/automabaca-novo/backups'))
    args = ap.parse_args()
    os.umask(0o077)

    release = json.loads((args.release_dir / 'release.json').read_text())['release']
    carimbo = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    p = args.raiz / f'before-{release}-{carimbo}'
    p.mkdir(mode=0o700, parents=True)

    dump = p / 'database.dump'
    with dump.open('wb') as out:
        subprocess.run(['docker', 'exec', DB, 'pg_dump', '-U', USER, '-d', USER, '-Fc'], stdout=out, check=True)
    assert dump.stat().st_size > 0
    with dump.open('rb') as inp, (p / 'archive.list').open('w') as out:
        subprocess.run(['docker', 'exec', '-i', DB, 'pg_restore', '--list'], stdin=inp, stdout=out, check=True)
    assert (p / 'archive.list').stat().st_size > 0

    name = f'automabaca-restore-check-{carimbo}'
    # Os dados do descartável ficam num volume no disco, como no backup diário:
    # tmpfs conta no --memory do container, e dados mais WAL da restauração
    # estouram o limite com um banco de poucas centenas de MB. Sem swap
    # (--memory-swap igual), o resultado não depende de a VPS ter swap.
    volume = name + '-data'
    image = subprocess.check_output(['docker', 'inspect', DB, '--format', '{{.Image}}'], text=True).strip()
    subprocess.run(['docker', 'volume', 'create', '--label', 'automabaca.backup.restorecheck=true', volume],
                   check=True, stdout=subprocess.DEVNULL)
    try:
        subprocess.run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--memory', '512m',
                        '--memory-swap', '512m', '--cpus', '1',
                        '--mount', f'type=volume,src={volume},dst=/var/lib/postgresql/data',
                        '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', '-e', f'POSTGRES_USER={USER}',
                        '-e', f'POSTGRES_DB={USER}', image], check=True, stdout=subprocess.DEVNULL)
        for _ in range(60):
            if subprocess.run(['docker', 'exec', name, 'pg_isready', '-h', '127.0.0.1', '-U', USER],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Postgres descartável não subiu')
        with dump.open('rb') as inp, (p / 'restore.log').open('w') as out:
            subprocess.run(['docker', 'exec', '-i', name, 'pg_restore', '-U', USER, '-d', USER,
                            '--no-owner', '--no-privileges', '--exit-on-error'],
                           stdin=inp, stdout=out, stderr=subprocess.STDOUT, check=True)
        restored = subprocess.check_output(
            ['docker', 'exec', name, 'psql', '-U', USER, '-d', USER, '-At', '-v', 'ON_ERROR_STOP=1', '-c',
             'SELECT count(*) FROM _prisma_migrations WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL'],
            text=True).strip()
        assert int(restored) > 0
    finally:
        # A limpeza que falha vira aviso: não muda o resultado da conferência
        # nem esconde o erro dela. O volume nomeado tem comando próprio (o -v do
        # rm só leva volume anônimo), tentado mesmo quando o container não sai.
        for command in (['docker', 'rm', '-f', '-v', name], ['docker', 'volume', 'rm', volume]):
            if subprocess.run(command, stdout=subprocess.DEVNULL).returncode != 0:
                print('AVISO: falhou `' + ' '.join(command) + '`; tire à mão.', file=sys.stderr, flush=True)

    digest = hashlib.sha256(dump.read_bytes()).hexdigest()
    (p / 'database.dump.sha256').write_text(digest + '  database.dump\n')
    r = {'createdAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'release': release,
         'path': str(p), 'bytes': dump.stat().st_size, 'sha256': digest,
         'archiveListValidated': True, 'disposableRestoreValidated': True, 'restoredMigrations': int(restored)}
    (p / 'backup.json').write_text(json.dumps(r, indent=2) + '\n')
    print(json.dumps(r))


if __name__ == '__main__':
    main()
