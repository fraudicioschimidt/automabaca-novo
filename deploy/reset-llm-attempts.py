#!/usr/bin/env python3
"""Zera o histórico de tentativas (`llm.attempt`) que alimenta o painel de modelos.

Por que apagar só `llm.attempt`: essa é a fonte exclusiva do card "Modelos de
OCR". O SLO NÃO depende dela — `src/services/ops/slo/slo.ts` ignora esse nome de
propósito ("aceitação histórica; consultar transporte, conteúdo e cascata") e
`src/services/ops/slo/slo.ts` o filtra da lista de violações. `llm.transport.*` e
`llm.content.*` continuam intactos, então o histórico de SLO sobrevive.

Apagar é irreversível pelo painel. A exportação das linhas afetadas é
obrigatória e acontece ANTES do DELETE, com contagem e SHA256 registrados, para
dar rollback sem depender do backup diário. O DELETE apaga só os ids que estão
no arquivo exportado: linha gravada depois da exportação fica no banco.

Uso (no host, com acesso ao Docker):
    sudo python3 deploy/reset-llm-attempts.py            # só relata (padrão)
    sudo python3 deploy/reset-llm-attempts.py --apply    # exporta e apaga
"""
from __future__ import annotations

import argparse
import csv
import gzip
import hashlib
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

CONTAINER = "automabaca-novo-db"
DB_USER = "automabaca_novo"
DB_NAME = "automabaca_novo"
EXPORT_DIR = Path("/srv/apps/automabaca-novo/exports")
METRIC_NAME = "llm.attempt"

EXPORT_COLUMNS = 'id, kind, name, outcome, "durationMs", "queueLagMs", "statusCode", labels, "occurredAt"'
WHERE = f"name = '{METRIC_NAME}'"


def psql(sql: str, *, tuples: bool = False) -> str:
    """Roda psql dentro do container. Conexão local do Postgres é confiável ali."""
    command = ["docker", "exec", "-i", CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME, "-X", "-q", "-v", "ON_ERROR_STOP=1"]
    if tuples:
        # `-t -A`: sem cabeçalho, sem borda — o que permite ler o valor direto.
        command += ["-t", "-A"]
    # Pela entrada padrão: a lista de ids do DELETE não cabe num argumento.
    result = subprocess.run(command, input=sql, capture_output=True, text=True)
    if result.returncode != 0:
        sys.stderr.write(result.stderr)
        raise SystemExit(f"psql falhou ({result.returncode})")
    return result.stdout


def scalar(sql: str) -> int:
    return int(psql(sql, tuples=True).strip() or 0)


def export_rows(destination: Path) -> str:
    """Exporta as linhas que serão apagadas. COPY TO STDOUT + gzip no host; devolve o SHA256 do CSV."""
    sql = f"COPY (SELECT {EXPORT_COLUMNS} FROM operational_metrics WHERE {WHERE} ORDER BY id) TO STDOUT WITH CSV HEADER"
    command = ["docker", "exec", "-i", CONTAINER, "psql", "-U", DB_USER, "-d", DB_NAME, "-X", "-q", "-c", sql]
    digest = hashlib.sha256()
    with gzip.open(destination, "wb") as sink:
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        assert process.stdout is not None
        for chunk in iter(lambda: process.stdout.read(1 << 16), b""):
            digest.update(chunk)
            sink.write(chunk)
        process.wait()
        if process.returncode != 0:
            sys.stderr.write((process.stderr.read() or b"").decode("utf-8", "replace"))
            raise SystemExit("COPY falhou; nada foi apagado")
    return digest.hexdigest()


def exported_ids(destination: Path) -> list[int]:
    """Os ids das linhas que chegaram ao arquivo: só essas podem ser apagadas."""
    with gzip.open(destination, "rt", encoding="utf-8", newline="") as source:
        return [int(row["id"]) for row in csv.DictReader(source)]


def delete_exported(ids: list[int]) -> int:
    if not ids:
        return 0
    id_list = ",".join(str(value) for value in ids)
    return scalar(f"WITH apagadas AS (DELETE FROM operational_metrics WHERE {WHERE} AND id = ANY('{{{id_list}}}'::bigint[]) "
                  "RETURNING 1) SELECT count(*) FROM apagadas")


def report(prefix: str) -> None:
    total = scalar(f"SELECT count(*) FROM operational_metrics WHERE {WHERE}")
    print(f"{prefix}: {total} linha(s) de {METRIC_NAME}")
    if total == 0:
        return
    by_model = psql(
        "SELECT (labels->>'provider') || '/' || (labels->>'model') AS modelo, count(*) "
        f"FROM operational_metrics WHERE {WHERE} GROUP BY 1 ORDER BY 2 DESC",
        tuples=True,
    ).strip()
    by_day = psql(
        "SELECT date_trunc('day', \"occurredAt\")::date AS dia, count(*) "
        f"FROM operational_metrics WHERE {WHERE} GROUP BY 1 ORDER BY 1 DESC LIMIT 10",
        tuples=True,
    ).strip()
    print("\n-- por modelo --\n" + by_model)
    print("\n-- por dia (10 mais recentes) --\n" + by_day)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="apaga de verdade (sem isto, apenas relata)")
    parser.add_argument("--export-dir", default=str(EXPORT_DIR))
    args = parser.parse_args()

    report("ANTES")

    if not args.apply:
        print("\nNada foi apagado. Rode com --apply para exportar e apagar.")
        return 0

    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    export_dir = Path(args.export_dir)
    export_dir.mkdir(parents=True, exist_ok=True)
    destination = export_dir / f"llm-attempt-reset-{stamp}.csv.gz"
    checksum = export_rows(destination)
    ids = exported_ids(destination)
    lines = len(ids)
    print(f"\nExportado: {destination} ({lines} linhas)")
    print(f"SHA256: {checksum}")

    removed = delete_exported(ids)
    manifest = {
        "removedAt": stamp, "metricName": METRIC_NAME, "rowsExported": lines,
        "rowsDeleted": removed, "export": destination.name, "sha256": checksum,
    }
    (export_dir / f"llm-attempt-reset-{stamp}.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"\nApagadas: {removed} linhas")
    print("O card 'Modelos de OCR' começa zerado; o SLO mantém o histórico.")
    report("DEPOIS")
    return 0 if removed == lines else 1


if __name__ == "__main__":
    raise SystemExit(main())
