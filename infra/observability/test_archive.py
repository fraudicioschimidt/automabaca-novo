import datetime as dt
import gzip
import importlib
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import unittest
from unittest.mock import patch
import archive_common as common
import archive_sanitize as sanitize
import collect
exporter = importlib.import_module('export')
import watchdog

class ArchiveTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        self.root, self.state, self.exports = [self.base / x for x in ('archive', 'state', 'exports')]
        for directory in (self.root, self.state, self.exports, self.root / 'bundles'):
            directory.mkdir()
        self.row = {'CONTAINER_NAME': 'automabaca-novo-worker', '__CURSOR': 'cursor-1', '__REALTIME_TIMESTAMP': '1789200000000000', 'MESSAGE': json.dumps({'eventCode': 'TEST_EVENT', 'token': 'PRIVATE', 'context': {'prompt': 'PRIVATE'}, 'message': 'token="PRIVATE" https://example.com/path?key=PRIVATE'})}

    def test_acknowledgment_preserves_cursor_and_rejects_changed_gap(self):
        import importlib.util
        spec = importlib.util.spec_from_file_location('ack_gap', Path(__file__).with_name('acknowledge-gap.py'))
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        state = {'cursor': 'keep-this-cursor', 'realtimeUsec': '123', 'gapDetectedAt': '2026-09-12T12:00:00Z'}
        updated = module.acknowledge(state, state['gapDetectedAt'], 'reviewed-with-metrics')
        self.assertEqual(updated['cursor'], state['cursor'])
        self.assertEqual(updated['realtimeUsec'], state['realtimeUsec'])
        self.assertNotIn('gapDetectedAt', updated)
        self.assertIn('gapDetectedAt', state)
        with self.assertRaises(ValueError): module.acknowledge(state, 'old-gap', 'reviewed-with-metrics')

    def test_privacy_and_join_fields(self):
        self.assertEqual(sanitize.route('/api/bankrolls/PRIVATE/version?token=PRIVATE'), '/api/bankrolls/[slug]/version')
        self.assertEqual(sanitize.route('/api/bankrolls/PRIVATE/other'), '/other')
        row = sanitize.normalize(self.row)
        self.assertNotIn('PRIVATE', json.dumps(row))
        self.assertEqual(row['entry']['eventCode'], 'TEST_EVENT')
        pg = sanitize.normalize({'CONTAINER_NAME': 'automabaca-novo-db', 'MESSAGE': '[12] 23505 ERROR: duplicate key PRIVATE'})
        self.assertEqual(pg['entry']['sqlState'], '23505')
        self.assertNotIn('PRIVATE', json.dumps(pg))
        self.assertIsNone(sanitize.normalize({'CONTAINER_NAME': 'automabaca-novo-db', 'MESSAGE': 'DETAIL: PRIVATE'}))
        edge = sanitize.normalize({'_SYSTEMD_UNIT': 'caddy.service', 'MESSAGE': json.dumps({'logger': 'http.log.access.automabaca_v2', 'status': 403, 'correlationId': 'corr-1', 'route': '/tipsters/PRIVATE?token=PRIVATE', 'request': {'headers': {'Cookie': 'PRIVATE'}}})})
        self.assertNotIn('PRIVATE', json.dumps(edge))
        self.assertEqual(edge['entry']['correlationId'], 'corr-1')

    def test_edge_routes_follow_the_panel_routes(self):
        cases = {
            '/': '/', '/login': '/login', '/aposta': '/aposta', '/tipsters/': '/tipsters',
            '/analyzer': '/analyzer',
            '/ferramentas': '/ferramentas', '/monitoramento/': '/monitoramento', '/operacoes': '/operacoes',
            '/tipsters/PRIVATE?x=PRIVATE': '/tipsters/[slug]', '/tipsters/PRIVATE/analyzer': '/tipsters/[slug]/analyzer',
            '/api/bankrolls/PRIVATE/version': '/api/bankrolls/[slug]/version',
            '/api/logos/PRIVATE.png': '/api/logos/[file]', '/pwa-icon-192.png': '/pwa-icon-[size].png',
            '/sports-icons/PRIVATE.svg': '/sports-icons/[file]', '/manifest.webmanifest': '/manifest.webmanifest',
            # Rotas que não existem (o endereço antigo /bankrolls só redireciona), e o
            # placeholder que o Caddy gravava sem expandir.
            '/players': '/other', '/historico': '/other', '/tipsters/a/b/c': '/other',
            '/bankrolls': '/other', '/bankrolls/PRIVATE': '/other',
            '{http.request.uri.path}': '/other',
        }
        for path, expected in cases.items():
            self.assertEqual(sanitize.route(path), expected, path)
        # O molde que o Caddy já gravou passa igual.
        for template in set(cases.values()):
            self.assertEqual(sanitize.route(template), template, template)

    def test_edge_next_headers_keep_only_their_format(self):
        def edge(extra):
            data = {'logger': 'http.log.access.automabaca_v2', 'status': 200, 'route': '/contas', 'method': 'POST', **extra}
            return sanitize.normalize({'_SYSTEMD_UNIT': 'caddy.service', 'MESSAGE': json.dumps(data)})['entry']
        action = '40b3f6837bcb8c25eb5c2259501aa6a0db89e16c26'
        entry = edge({'nextAction': action, 'rsc': '1', 'nextRouterPrefetch': '2'})
        self.assertEqual((entry['nextAction'], entry['rsc'], entry['nextRouterPrefetch']), (action, '1', '2'))
        entry = edge({'nextAction': 'PRIVATE', 'rsc': 'PRIVATE', 'nextRouterPrefetch': ''})
        self.assertEqual((entry['nextAction'], entry['rsc']), ('[invalid]', '[invalid]'))
        self.assertNotIn('nextRouterPrefetch', entry)
        # Log de erro do Caddy: a requisição inteira vem junto, e só o formato esperado sai dela.
        error = sanitize.normalize({'_SYSTEMD_UNIT': 'caddy.service', 'MESSAGE': json.dumps({
            'logger': 'http.log.error.automabaca_v2', 'level': 'error', 'status': 502,
            'request': {'host': 'v2.fraudicio.com.br', 'method': 'POST', 'uri': '/tipsters/PRIVATE/analyzer?token=PRIVATE',
                        'client_ip': 'PRIVATE', 'headers': {'Cookie': ['PRIVATE'], 'Next-Action': [action],
                                                            'Next-Router-State-Tree': ['PRIVATE']}}})})
        self.assertNotIn('PRIVATE', json.dumps(error))
        self.assertEqual(error['entry']['route'], '/tipsters/[slug]/analyzer')
        self.assertEqual(error['entry']['nextAction'], action)

    def test_postgres_slow_statement_and_continuation_lines(self):
        def pg(message):
            return sanitize.normalize({'CONTAINER_NAME': 'automabaca-novo-db', 'MESSAGE': message})
        prefix = '2026-09-23 12:00:00.123 UTC [45] 00000 '
        slow = pg(prefix + 'LOG:  duration: 612.345 ms  execute <unnamed>: SELECT "public"."bets"."id" FROM "public"."bets" WHERE "id" = $1')
        self.assertEqual(slow['entry'], {'eventCode': 'DATABASE_SLOW_STATEMENT', 'level': 40, 'durationMs': 612.3,
                                         'phase': 'execute', 'command': 'SELECT', 'relation': 'public.bets',
                                         'fingerprint': slow['entry']['fingerprint']})
        # Mesma consulta com outros valores literais: mesma impressão, nenhum valor no arquivo.
        first = pg(prefix + "LOG:  duration: 900 ms  statement: select * from bets where evento = 'PRIVATE from PRIVATE' and id = 42")
        second = pg(prefix + "LOG:  duration: 700 ms  statement: select * from bets where evento = 'outro' and id = 7")
        self.assertEqual(first['entry']['fingerprint'], second['entry']['fingerprint'])
        self.assertEqual(first['entry']['relation'], 'bets')
        opened = pg(prefix + "LOG:  duration: 800 ms  statement: select 1 where x = 'PRIVATE from PRIVATE")
        self.assertNotIn('relation', opened['entry'])
        for row in (first, second, opened):
            self.assertNotIn('PRIVATE', json.dumps(row))
        # As linhas seguintes de um SQL de várias linhas não têm o prefixo e trazem valores.
        self.assertIsNone(pg("\tselect count(*) from bets where chat = 'PRIVATE' and x like '%checkpoint%';"))
        self.assertIsNone(pg(prefix + 'DETAIL:  parameters: $1 = \'PRIVATE\''))
        self.assertEqual(pg(prefix + 'LOG:  checkpoint starting: time')['entry']['reason'], 'checkpoint')

    def test_collector_joins_multiline_slow_statement(self):
        def row(n, message, container='automabaca-novo-db'):
            return {'CONTAINER_NAME': container, '__CURSOR': f'c{n}', '__REALTIME_TIMESTAMP': str(1789200000000000 + n), 'MESSAGE': message}
        prefix = '2026-09-23 12:00:00.123 UTC [45] 00000 '
        rows = [row(1, prefix + 'LOG:  duration: 601.8 ms  execute <unnamed>: '),
                row(2, json.dumps({'eventCode': 'OTHER'}), 'automabaca-novo-worker'),
                row(3, "\t  SELECT id FROM pgboss.job WHERE name = 'PRIVATE'"),
                row(4, '\t    AND state < $1')]
        count, state = collect.persist_batch(rows, {}, self.root, self.state)
        self.assertEqual((count, state['cursor']), (2, 'c4'))
        records = [json.loads(line) for line in gzip.decompress(next(self.root.glob('*.gz')).read_bytes()).splitlines()]
        slow = next(r['entry'] for r in records if r['service'] == 'postgres')
        self.assertEqual((slow['command'], slow['relation']), ('SELECT', 'pgboss.job'))
        single = sanitize.normalize(row(5, prefix + "LOG:  duration: 900 ms  execute <unnamed>: SELECT id FROM pgboss.job WHERE name = 'x' AND state < $1"))
        self.assertEqual(slow['fingerprint'], single['entry']['fingerprint'])
        self.assertNotIn(b'PRIVATE', gzip.decompress(next(self.root.glob('*.gz')).read_bytes()))

    def test_crash_does_not_advance_cursor_and_replay_is_idempotent(self):
        original = common.atomic_json
        with patch.object(common, 'atomic_json', side_effect=OSError('disk error')):
            with self.assertRaises(OSError):
                collect.persist_batch([self.row], {}, self.root, self.state)
        self.assertFalse((self.state / 'cursor.json').exists())
        self.assertEqual(len(list(self.root.glob('*.gz'))), 1)
        count, state = collect.persist_batch([self.row], {}, self.root, self.state)
        self.assertEqual(count, 1)
        self.assertEqual(state['cursor'], 'cursor-1')
        self.assertEqual(len(list(self.root.glob('*.gz'))), 1)
        record = json.loads(gzip.decompress(next(self.root.glob('*.gz')).read_bytes()))
        self.assertEqual(record['cursor'], 'cursor-1')

    def test_encrypted_export_restore_and_retention(self):
        identity = self.base / 'test-key.txt'
        subprocess.run(['age-keygen', '-o', str(identity)], check=True, capture_output=True)
        public = subprocess.run(['age-keygen', '-y', str(identity)], check=True, capture_output=True).stdout
        recipient = self.base / 'recipient.txt'; recipient.write_bytes(public)
        collect.persist_batch([self.row], {}, self.root, self.state)
        index, count, backlog = exporter.export_pending(self.root, self.exports, recipient)
        self.assertEqual(count, 1); self.assertFalse(backlog)
        bundle = index['bundles'][0]
        encrypted = self.exports / bundle['name']
        self.assertEqual(common.digest(encrypted), bundle['sha256'])
        restored = self.base / 'restore.tar'
        subprocess.run(['age', '-d', '-i', str(identity), '-o', str(restored), str(encrypted)], check=True, capture_output=True)
        with tarfile.open(restored) as archive:
            manifest = json.load(archive.extractfile('manifest.json'))
            payload = archive.extractfile('segments/' + manifest['segments'][0]['name']).read()
            self.assertEqual(common.digest(next(self.root.glob('*.gz'))), manifest['segments'][0]['sha256'])
            self.assertNotIn(b'PRIVATE', gzip.decompress(payload))
        self.assertEqual(exporter.export_pending(self.root, self.exports, recipient)[1], 0)
        unexported = self.root / 'logs-20000101T000000-aaaaaaaaaaaaaaaa.jsonl.gz'
        unexported.write_bytes(b'unexported')
        old = (common.now() - dt.timedelta(days=31)).timestamp()
        for path in self.root.glob('*.gz'): os.utime(path, (old, old))
        metadata = self.root / 'bundles' / (bundle['name'] + '.json')
        record = common.read_json(metadata); record['createdAt'] = common.stamp(common.now() - dt.timedelta(days=31)); common.atomic_json(metadata, record)
        exporter.prune(self.root, self.exports)
        self.assertTrue(unexported.exists()); self.assertFalse(encrypted.exists())

    def test_encryption_failure_keeps_unexported_segment(self):
        collect.persist_batch([self.row], {}, self.root, self.state)
        with patch.object(exporter.subprocess, 'run', return_value=subprocess.CompletedProcess([], 1)):
            with self.assertRaisesRegex(RuntimeError, 'log_encryption_failed'):
                exporter.export_pending(self.root, self.exports, self.base / 'missing')
        self.assertEqual(len(list(self.root.glob('*.gz'))), 1)
        self.assertEqual(list((self.root / 'bundles').iterdir()), [])
        self.assertEqual(list(self.exports.iterdir()), [])

    def test_watchdog_requires_complete_fresh_verified_receipt(self):
        current = common.now()
        fresh = {'ok': True, 'observedAt': common.stamp(current)}
        bundles = [{'name': str(n), 'sha256': str(n), 'createdAt': common.stamp(current - dt.timedelta(hours=2-n))} for n in range(2)]
        index = {'bundles': bundles}
        receipt = {'schemaVersion': 1, 'project': 'automabaca-novo', 'verified': [{'name': b['name'], 'sha256': b['sha256']} for b in bundles]}
        backup_status = {'ok': True, 'observedAt': common.stamp(current)}
        backup_latest = {'createdAt': common.stamp(current - dt.timedelta(hours=8))}
        assess = lambda r, **kw: watchdog.assess(kw.get('collection', fresh), fresh, r, index, kw.get('mtime', current.timestamp()),
                                                 backup_status, backup_latest, self.backup_receipt(), current.timestamp(), current)
        self.assertEqual(assess(None)['reasons'], ['offsite_pending'])
        self.assertTrue(assess(receipt)['ok'])
        self.assertIn('offsite_incomplete', assess({**receipt, 'verified': receipt['verified'][1:]})['reasons'])
        self.assertIn('offsite_invalid', assess({**receipt, 'verified': [{'name': '1', 'sha256': 'bad'}]})['reasons'])
        self.assertIn('offsite_stale', assess(receipt, mtime=current.timestamp() - 27*3600)['reasons'])
        self.assertIn('collection_stale', assess(receipt, collection={**fresh, 'observedAt': common.stamp(current - dt.timedelta(minutes=4))})['reasons'])
        self.assertIn('journal_gap_detected', assess(receipt, collection={**fresh, 'gapDetectedAt': common.stamp(current)})['reasons'])
        self.assertTrue(assess({**receipt, 'verified': [*receipt['verified'], {'name': 'expired', 'sha256': 'expired'}]})['ok'])

    def test_watchdog_rejects_future_backup_and_copy_timestamps(self):
        current = common.now()
        future = current + dt.timedelta(minutes=2)
        latest = {'createdAt': common.stamp(future)}
        self.assertEqual(watchdog.assess_backup({'ok': True}, latest, current)['state'], 'stale')

    def test_watchdog_rejects_future_log_copy_evidence(self):
        current = common.now()
        fresh = {'ok': True, 'observedAt': common.stamp(current)}
        receipt = {'schemaVersion': 1, 'project': 'automabaca-novo', 'verified': [{'name': 'a', 'sha256': 'a'}]}
        latest = {'createdAt': common.stamp(current)}
        for future_arrival, future_bundle in ((True, False), (False, True)):
            with self.subTest(future_arrival=future_arrival, future_bundle=future_bundle):
                index = {'bundles': [{'name': 'a', 'sha256': 'a', 'createdAt': common.stamp(current + dt.timedelta(minutes=2) if future_bundle else current)}]}
                status = watchdog.assess(fresh, fresh, receipt, index, current.timestamp() + (120 if future_arrival else 0),
                                        {'ok': True}, latest, self.backup_receipt(), current.timestamp(), current)
                self.assertEqual(status['offsite'], 'stale')
                self.assertIn('offsite_stale', status['reasons'])

    def backup_receipt(self, **changes):
        return {'schemaVersion': 1, 'project': 'automabaca-novo', 'name': 'automabaca-novo-recovery-20261004T042159Z.tar.age',
                'sha256': 'a' * 64, 'sizeBytes': 16121880, 'verifiedAt': '2026-10-04T06:30:08Z', **changes}

    def test_backup_copy_outside_the_host_needs_a_recent_valid_receipt(self):
        current = common.now()
        arrived = current.timestamp() - 20 * 3600
        receipt = self.backup_receipt()
        latest = {'name': receipt['name'], 'sha256': receipt['sha256'], 'createdAt': common.stamp(current)}
        fresh = watchdog.assess_backup_offsite(receipt, arrived, latest, current)
        self.assertEqual(fresh, {'offsite': 'fresh', 'offsiteAt': common.stamp(dt.datetime.fromtimestamp(arrived, dt.timezone.utc))})
        # O pacote de hoje ainda não foi puxado: o comprovante de ontem segue valendo.
        newer = {'name': 'automabaca-novo-recovery-20261005T041700Z.tar.age', 'sha256': 'b' * 64}
        self.assertEqual(watchdog.assess_backup_offsite(receipt, arrived, newer, current)['offsite'], 'fresh')
        # A tarefa do Windows parou: o comprovante envelhece e o painel deixa de dizer "em dia".
        old = watchdog.assess_backup_offsite(receipt, current.timestamp() - 37 * 3600, latest, current)
        self.assertEqual(old['offsite'], 'stale')
        self.assertIsNotNone(old['offsiteAt'])
        self.assertEqual(watchdog.assess_backup_offsite(None, 0, latest, current), {'offsite': 'stale', 'offsiteAt': None})
        for broken in (self.backup_receipt(sha256='b' * 64), self.backup_receipt(name='../etc/passwd'),
                       self.backup_receipt(project='outro'), self.backup_receipt(schemaVersion=2), ['lista']):
            self.assertEqual(watchdog.assess_backup_offsite(broken, arrived, latest, current), {'offsite': 'stale', 'offsiteAt': None})

    def test_backup_receipt_is_read_with_its_arrival_time_and_never_through_a_link(self):
        path = self.base / 'windows-backup-receipt.json'
        self.assertEqual(watchdog.read_backup_receipt(path), (None, 0))
        path.write_text(json.dumps(self.backup_receipt()))
        receipt, arrived = watchdog.read_backup_receipt(path)
        self.assertEqual((receipt['name'], arrived), (self.backup_receipt()['name'], path.stat().st_mtime))
        (self.base / 'link.json').symlink_to(path)
        self.assertEqual(watchdog.read_backup_receipt(self.base / 'link.json'), (None, 0))
        path.write_text('{')
        self.assertEqual(watchdog.read_backup_receipt(path), (None, 0))

    def test_stopped_backup_copy_joins_the_host_status_without_touching_the_logs(self):
        current = common.now()
        fresh = {'ok': True, 'observedAt': common.stamp(current)}
        index = {'bundles': [{'name': 'a', 'sha256': 'a', 'createdAt': common.stamp(current)}]}
        receipt = {'schemaVersion': 1, 'project': 'automabaca-novo', 'verified': [{'name': 'a', 'sha256': 'a'}]}
        latest = {'createdAt': common.stamp(current - dt.timedelta(hours=2))}
        status = watchdog.assess(fresh, fresh, receipt, index, current.timestamp(), {'ok': True}, latest, current=current)
        self.assertEqual((status['ok'], status['reasons']), (False, ['backup_offsite_stale']))
        self.assertEqual((status['offsite'], status['backup']['state'], status['backup']['offsite']), ('fresh', 'fresh', 'stale'))

    def test_backup_verified_today_is_fresh_and_carries_what_it_holds(self):
        current = common.now()
        status = {'ok': True, 'observedAt': common.stamp(current - dt.timedelta(hours=8)), 'counts': {'bets': 1234, 'movements': 99}}
        latest = {'createdAt': common.stamp(current - dt.timedelta(hours=8))}
        self.assertEqual(watchdog.assess_backup(status, latest, current),
                         {'state': 'fresh', 'reasons': [], 'createdAt': latest['createdAt'], 'failedAt': None, 'bets': 1234})
        # O backup de antes da contagem existir continua em dia; só não diz quantas apostas tem.
        self.assertIsNone(watchdog.assess_backup({'ok': True}, latest, current)['bets'])
        self.assertIsNone(watchdog.assess_backup({**status, 'counts': {'bets': True}}, latest, current)['bets'])

    def test_failed_run_keeps_the_last_good_backup_and_pages_only_when_it_ages(self):
        current = common.now()
        failure = {'ok': False, 'observedAt': common.stamp(current - dt.timedelta(minutes=5))}
        yesterday = {'createdAt': common.stamp(current - dt.timedelta(hours=24))}
        failed = watchdog.assess_backup(failure, yesterday, current)
        self.assertEqual((failed['state'], failed['reasons']), ('failed', ['backup_failed']))
        self.assertEqual((failed['createdAt'], failed['failedAt'], failed['bets']), (yesterday['createdAt'], failure['observedAt'], None))
        # A noite inteira falhou: passa das 26 h sem pacote conferido.
        old = {'createdAt': common.stamp(current - dt.timedelta(hours=26, minutes=1))}
        stale = watchdog.assess_backup(failure, old, current)
        self.assertEqual((stale['state'], stale['reasons']), ('stale', ['backup_failed', 'backup_stale']))
        # Timer parado (nenhuma execução, nem falha) também atrasa.
        self.assertEqual(watchdog.assess_backup({'ok': True}, old, current)['reasons'], ['backup_stale'])

    def test_missing_or_broken_backup_files_mean_no_verified_backup(self):
        current = common.now()
        for latest in (None, {}, {'createdAt': 'ontem'}, ['not', 'an', 'object']):
            result = watchdog.assess_backup(None, latest, current)
            self.assertEqual((result['state'], result['reasons'], result['createdAt']), ('stale', ['backup_stale'], None))
        broken = self.base / 'latest.json'
        broken.write_text('{"createdAt": ')
        self.assertIsNone(watchdog.read_backup_file(broken))
        self.assertIsNone(watchdog.read_backup_file(self.base / 'absent.json'))
        (self.base / 'link.json').symlink_to(broken)
        self.assertIsNone(watchdog.read_backup_file(self.base / 'link.json'))

    def test_backup_reasons_join_the_host_status(self):
        current = common.now()
        fresh = {'ok': True, 'observedAt': common.stamp(current)}
        index = {'bundles': [{'name': 'a', 'sha256': 'a', 'createdAt': common.stamp(current - dt.timedelta(hours=1))}]}
        receipt = {'schemaVersion': 1, 'project': 'automabaca-novo', 'verified': [{'name': 'a', 'sha256': 'a'}]}
        offsite = (self.backup_receipt(), current.timestamp(), current)
        status = watchdog.assess(fresh, fresh, receipt, index, current.timestamp(), {'ok': False, 'observedAt': common.stamp(current)},
                                 {'createdAt': common.stamp(current - dt.timedelta(hours=2))}, *offsite)
        self.assertFalse(status['ok'])
        self.assertEqual(status['reasons'], ['backup_failed'])
        self.assertEqual((status['collection'], status['export'], status['offsite'], status['backup']['state']),
                         ('fresh', 'fresh', 'fresh', 'failed'))
        self.assertNotIn('reasons', status['backup'])

if __name__ == '__main__': unittest.main(verbosity=2)
