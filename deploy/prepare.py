"""Monta uma release a partir do artefato verificado da CI.

Um arquivo só, versionado, que recebe o que muda por argumento. Nunca copie
este script para uma release: cópia editada à mão arrasta caminhos e etapas de
outra release e quebra a publicação no meio.

    python3 deploy/prepare.py --nome bilhete-unico --release-dir <dir>

O `--release-dir` já precisa conter `artifact/` (runtime.tar.gz +
release-manifest.json), baixado do job "release verificada" da CI.
"""
from pathlib import Path
import argparse, subprocess, json, shutil, re, sys

# O `publicar.sh` trata esta saída como causa passageira (rede, registry).
PULL_FAILED_EXIT = 75


def run(args, **kw):
    return subprocess.check_output(args, text=True, **kw).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--nome', required=True, help='prefixo da tag, ex. bilhete-unico')
    ap.add_argument('--release-dir', type=Path, default=Path.cwd())
    ap.add_argument('--repo', type=Path, default=Path(__file__).resolve().parent.parent)
    ap.add_argument('--data', help='AAAAMMDD; padrão é hoje')
    ap.add_argument('--registry', default='ghcr.io/fraudicioschimidt')
    # Saída de emergência: registry fora do ar, ou uma release que precisa sair
    # antes de a CI publicar. É explícito porque construir aqui desfaz a
    # garantia de que a imagem é a mesma que a CI produziu e conferiu.
    ap.add_argument('--build-local', action='store_true',
                    help='constrói localmente para diagnóstico; não é publicável sem digest do registry')
    args = ap.parse_args()

    w, repo = args.release_dir.resolve(), args.repo.resolve()

    # A release sai de um commit revisado e já integrado, com a árvore limpa.
    # Sem isto, publicaríamos trabalho em andamento sem ninguém perceber. Basta
    # estar na main: o publicador leva o mais novo com a CI verde, que pode não
    # ser o topo.
    sha = run(['git', 'rev-parse', 'HEAD'], cwd=repo)
    assert not run(['git', 'status', '--porcelain'], cwd=repo), 'worktree suja'
    assert subprocess.run(['git', 'merge-base', '--is-ancestor', sha, 'origin/main'],
                          cwd=repo).returncode == 0, 'HEAD não está na origin/main'

    manifest = json.loads((w / 'artifact/release-manifest.json').read_text())
    assert manifest['source']['commit'] == sha, 'artefato da CI é de outro commit'
    subprocess.run(['node', 'scripts/verify-release.mjs', str(w / 'artifact')], cwd=repo, check=True)

    import datetime
    dia = args.data or datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%d')
    release = f'{args.nome}-{dia}-{sha[:7]}'

    # A base é a release VIVA, lida do container — não uma anotação que envelhece.
    obj = json.loads(run(['sudo', '-n', 'docker', 'inspect', 'automabaca-novo-worker']))[0]
    env = dict(e.split('=', 1) for e in obj['Config']['Env'])
    base, base_sha = env['AUTOMABACA_RELEASE_ID'], env['AUTOMABACA_RELEASE_SHA']
    # A produção não volta para trás por aqui: desfazer uma release é revert na main.
    assert sha == base_sha or subprocess.run(
        ['git', 'merge-base', '--is-ancestor', sha, base_sha], cwd=repo, stderr=subprocess.DEVNULL,
    ).returncode != 0, 'commit anterior ao que está no ar'

    # As imagens vêm do registry, construídas pela CI a partir deste mesmo
    # commit. Construir aqui seria refazer, com o risco de o resultado diferir
    # do que a CI publicou e ninguém notar. O pull vem antes de montar as
    # camadas: se a rede falhar, a pasta fica como estava e a próxima tentativa
    # recomeça daqui.
    #
    # SEM sudo de propósito. A credencial do registry mora no ~/.docker do
    # usuário que fez `docker login`; sob sudo o daemon procuraria a do root e
    # devolveria "unauthorized". A imagem em si é do daemon, não do usuário,
    # então o inspect e o publish com sudo enxergam o que foi puxado aqui.
    remotes = {role: f'{args.registry}/automabaca-novo-{role}:{sha}' for role in ['web', 'worker']}
    if not args.build_local:
        for role, remoto in remotes.items():
            with (w / f'image-{role}.log').open('w') as out:
                if subprocess.run(['docker', 'pull', remoto], stdout=out, stderr=subprocess.STDOUT).returncode != 0:
                    print(f'docker pull falhou: {remoto} (saída em {out.name})', file=sys.stderr)
                    raise SystemExit(PULL_FAILED_EXIT)

    # A montagem das camadas é a MESMA que a CI usa para publicar as imagens no
    # registry. Duas implementações divergiriam com o tempo, e a divergência
    # entre o que o servidor monta e o que a CI monta seria invisível até o dia
    # em que as duas imagens deixassem de ser a mesma coisa.
    with (w / 'build-ops.log').open('w') as out:
        subprocess.run(['node', 'scripts/montar-camadas-de-imagem.mjs',
                        '--artifact', str(w / 'artifact'), '--out', str(w), '--repo', str(repo)],
                       cwd=repo, stdout=out, stderr=subprocess.STDOUT, check=True)
    build = w / 'verified-runtime'
    provenance = json.loads((w / 'ops-provenance.json').read_text())

    (w / 'release.json').write_text(json.dumps(
        {'release': release, 'baseRelease': base, 'sha': sha, 'baseSha': base_sha, 'buildDir': str(build)},
        indent=2) + '\n')

    # As duas receitas vêm do repositório, no commit publicado: uma cópia
    # guardada por release introduziria uma imagem que ninguém revisou.
    for role in ['web', 'worker']:
        shutil.copy2(repo / f'Dockerfile.{role}', w / f'Dockerfile.{role}')

    images, digests = {}, {}
    for role in ['web', 'worker']:
        tag = f'automabaca-novo-{role}:{release}'
        if args.build_local:
            with (w / f'image-{role}.log').open('w') as out:
                subprocess.run(['sudo', '-n', 'docker', 'build', '-f', str(w / f'Dockerfile.{role}'),
                                '-t', tag, str(w / f'{role}-layer')], stdout=out, stderr=subprocess.STDOUT, check=True)
        else:
            digests[role] = run(['docker', 'image', 'inspect', remotes[role],
                                 '--format', '{{index .RepoDigests 0}}'])
            # A tag local identifica a imagem preparada para conferência de
            # ID. O publish grava no Compose a referência imutável abaixo,
            # não essa tag mutável.
            subprocess.run(['docker', 'tag', remotes[role], tag], check=True)
        images[role] = run(['sudo', '-n', 'docker', 'image', 'inspect', tag, '--format', '{{.Id}}'])

    (w / 'images.json').write_text(json.dumps(images, indent=2) + '\n')
    origem = 'build-local' if args.build_local else 'registry'
    if digests:
        assert set(digests) == {'web', 'worker'}
        assert all(re.fullmatch(r'.+@sha256:[0-9a-f]{64}', value) for value in digests.values()), \
            'registry image digest missing; production publish cannot use a tag'
        (w / 'image-digests.json').write_text(json.dumps(
            {'commit': sha, 'registry': args.registry, 'digests': digests}, indent=2) + '\n')
    print(json.dumps({'prepared': True, 'release': release, 'base': base, 'sha': sha,
                      'origem': origem, 'images': images, 'digests': digests,
                      'opsBundles': provenance['bundles']}))


if __name__ == '__main__':
    main()
