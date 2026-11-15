"""Keep useful operational context without copying request bodies or SQL values."""
import hashlib
import json
import re
from urllib.parse import urlsplit

CONTAINERS = {"automabaca-novo-web": "web", "automabaca-novo-worker": "worker", "automabaca-novo-db": "postgres"}
PRIVATE_KEYS = re.compile(r"^(authorization|cookie|set-cookie|password|passwd|secret|token|api_?key|access_?token|refresh_?token|body|prompt|preview|sql|statement|headers|env|inlineData|chatId|username|actor|ip|remote_ip|client_ip)$", re.I)


def safe_text(value):
    value = re.sub(r'''(?i)((?:api[_-]?key|password|secret|token)\s*[=:]\s*)(["'])(.*?)\2''', r"\1[redacted]", value)
    value = re.sub(r"(?i)\bBearer\s+[^\s\"']+", "Bearer [redacted]", value)
    value = re.sub(r"(?i)(?:postgres(?:ql)?|redis)://[^\s\"']+", "[connection redacted]", value)
    value = re.sub(r"(https?://[^\s?\"']+)\?[^\s\"']+", r"\1?[redacted]", value)
    value = re.sub(r"(?i)((?:api[_-]?key|password|secret|token)\s*[=:]\s*)[^\s,;\"']+", r"\1[redacted]", value)
    return value[:16_384]


def redact(value, depth=0):
    if depth > 8:
        return "[depth limit]"
    if isinstance(value, dict):
        return {key: "[redacted]" if PRIVATE_KEYS.match(key) else redact(item, depth + 1) for key, item in list(value.items())[:100]}
    if isinstance(value, list):
        return [redact(item, depth + 1) for item in value[:100]]
    if isinstance(value, str):
        return safe_text(value)
    return value


# A mesma tabela do `map {path} {log_route}` do automabaca.caddy: casa tanto o
# caminho cru (log de erro do Caddy, Caddy com site antigo) quanto o molde que
# o Caddy já gravou, que casa consigo mesmo.
ROUTES = [(re.compile(pattern), name) for pattern, name in [
    (r"/", "/"),
    (r"/login", "/login"),
    *((rf"/{page}/?", "/" + page) for page in ("analyzer", "aposta", "config", "contas", "ferramentas",
                                                "monitoramento", "operacoes", "tipsters")),
    (r"/tipsters/[^/]+/analyzer/?", "/tipsters/[slug]/analyzer"),
    (r"/tipsters/[^/]+/?", "/tipsters/[slug]"),
    *((re.escape(path), path) for path in ("/api/auth/login", "/api/auth/logout", "/api/health",
                                           "/api/health/observability", "/api/telegram/webhook",
                                           "/api/telemetry/browser", "/manifest.webmanifest", "/robots.txt",
                                           "/icon.svg", "/favicon.ico", "/sw.js", "/_next/image")),
    (r"/api/bankrolls/[^/]+/version", "/api/bankrolls/[slug]/version"),
    (r"/api/logos/[^/]+", "/api/logos/[file]"),
    (r"/pwa-icon-[^/]+\.png", "/pwa-icon-[size].png"),
    (r"/_next/static/.+", "/_next/static/[asset]"),
    (r"/fonts/.+", "/fonts/[font]"),
    (r"/bookmakers/.+", "/bookmakers/[file]"),
    (r"/sports-icons/.+", "/sports-icons/[file]"),
]]
# Cabeçalhos do Next gravados pelo Caddy. Qualquer cliente manda o valor que
# quiser: só passa o formato que o Next usa.
NEXT_HEADERS = {"nextAction": ("Next-Action", re.compile(r"[0-9a-f]{40,64}")),
                "rsc": ("Rsc", re.compile(r"1")),
                "nextRouterPrefetch": ("Next-Router-Prefetch", re.compile(r"[0-9]"))}


def route(value):
    try:
        path = urlsplit(value).path
    except ValueError:
        return "/other"
    return next((name for pattern, name in ROUTES if pattern.fullmatch(path)), "/other")


def next_headers(data, request):
    """Os cabeçalhos do Next que vieram no formato esperado; o resto some."""
    headers = request.get("headers") if isinstance(request.get("headers"), dict) else {}
    fields = {}
    for field, (header, allowed) in NEXT_HEADERS.items():
        value = data.get(field)
        if not value and isinstance(headers.get(header), list) and headers[header]:
            value = headers[header][0]
        if isinstance(value, str) and value:
            fields[field] = value if allowed.fullmatch(value) else "[invalid]"
    return fields


POSTGRES_LINE = re.compile(r"(?:\d{4}-\d{2}-\d{2} \S+ \S+ )?\[\d+\]\s")
# `log_min_duration_statement`: "duration: 612.3 ms  statement: ..." (ou
# execute/parse/bind no protocolo estendido). Os parâmetros não vêm
# (log_parameter_max_length=0 no compose).
SLOW_STATEMENT = re.compile(r"\bLOG:\s+duration: (?P<ms>\d+(?:\.\d+)?) ms\s+(?P<phase>statement|execute|parse|bind)\b[^:]*:\s*(?P<sql>.*)",
                            re.S)


def join_postgres_lines(rows):
    """Junta ao cabeçalho as linhas seguintes de cada mensagem do PostgreSQL.

    Cada linha do stderr vira uma entrada do journal: sem juntar, a consulta
    lenta de um SQL de várias linhas (o pg-boss escreve assim) chegaria só com
    a primeira, vazia. As linhas seguintes continuam na lista, e `normalize`
    as descarta.
    """
    joined, header = [], None
    for raw in rows:
        message = raw.get("MESSAGE")
        if raw.get("CONTAINER_NAME") == "automabaca-novo-db" and isinstance(message, str):
            if POSTGRES_LINE.match(message):
                header = dict(raw)
                joined.append(header)
                continue
            if header is not None and len(header["MESSAGE"]) < 16_384:
                header["MESSAGE"] += "\n" + message
        joined.append(raw)
    return joined


def slow_statement(match):
    """Consulta lenta sem o texto: comando, primeira tabela e uma impressão digital.

    A impressão é o hash do SQL sem literais (strings e números viram `?`):
    agrupa a mesma consulta e acha o texto no journal da VPS, sem levar valor
    nenhum para o arquivo.
    """
    sql = re.sub(r"\$\w*\$.*?\$\w*\$|'(?:[^']|'')*'|\b\d+(?:\.\d+)?\b", "?", match["sql"], flags=re.S)
    # Literal que continua na linha seguinte fica aberto: corta dele em diante.
    sql = re.sub(r"(?:'|\$\w*\$).*", "?", sql, flags=re.S)
    shape = " ".join(sql.split()).lower()
    command = re.match(r"\s*([A-Za-z]+)", sql)
    relation = re.search(r'\b(?:from|into|update|join)\s+((?:"?[A-Za-z_][\w$]*"?\.)?"?[A-Za-z_][\w$]*"?)', sql, re.I)
    entry = {"eventCode": "DATABASE_SLOW_STATEMENT", "level": 40, "durationMs": round(float(match["ms"]), 1),
             "phase": match["phase"], "command": command[1].upper()[:16] if command else "OTHER",
             "fingerprint": hashlib.sha256(shape.encode()).hexdigest()[:16]}
    if relation:
        entry["relation"] = relation[1].replace('"', "")[:80]
    return entry


def normalize(raw):
    message = raw.get("MESSAGE", "")
    if not isinstance(message, str):
        return {"service": "journal", "entry": {"eventCode": "LOG_BINARY_ENTRY", "level": 40}}
    container = raw.get("CONTAINER_NAME")
    service = CONTAINERS.get(container)
    try:
        data = json.loads(message)
    except (ValueError, TypeError):
        data = None
    if service == "postgres":
        # Cada linha do stderr vira uma entrada do journal: a continuação de um
        # comando de várias linhas (o SQL, com valores literais) não traz o
        # prefixo `%m [%p] %e` e não entra.
        if not POSTGRES_LINE.match(message) or re.search(r"\b(?:STATEMENT|DETAIL|CONTEXT|HINT):", message):
            return None
        slow = SLOW_STATEMENT.search(message)
        if slow:
            return {"service": service, "entry": slow_statement(slow)}
        severity = re.search(r"\b(ERROR|FATAL|PANIC|WARNING|LOG):", message)
        # PostgreSQL exception text can contain literal values. SQLSTATE plus
        # a fixed reason is sufficient to join to the sanitized application error.
        state = re.search(r"\[\d+\]\s+([0-9A-Z]{5})\s", message)
        reason = next((name for pattern, name in [(r"deadlock", "deadlock"), (r"duplicate key", "unique_constraint"),
            (r"serializ", "serialization"), (r"connection|connect|terminating", "connection"),
            (r"syntax", "syntax"), (r"ready to accept", "ready"), (r"checkpoint", "checkpoint")] if re.search(pattern, message, re.I)), "database_event")
        entry = {"eventCode": "DATABASE_EVENT", "level": 50 if severity and severity[1] in {"ERROR", "FATAL", "PANIC"} else 30,
                 "severity": severity[1] if severity else "LOG", "reason": reason}
        if state:
            entry["sqlState"] = state[1]
        return {"service": service, "entry": entry}
    if service:
        entry = redact(data) if isinstance(data, dict) else {"eventCode": "PROCESS_OUTPUT", "message": safe_text(message), "level": 30}
        if raw.get("CONTAINER_PARTIAL_MESSAGE"):
            entry = {"eventCode": "LOG_PARTIAL_ENTRY", "level": 40, "bytes": len(message.encode())}
        return {"service": service, "image": raw.get("IMAGE_NAME"), "entry": entry}
    if raw.get("SYSLOG_IDENTIFIER") == "automabaca-log-archive" and isinstance(data, dict):
        return {"service": "log-archive", "entry": redact(data)}
    if raw.get("_SYSTEMD_UNIT") == "caddy.service" and isinstance(data, dict):
        request = data.get("request", {})
        if data.get("logger") != "http.log.access.automabaca_v2" and request.get("host") != "v2.fraudicio.com.br":
            return None
        entry = {key: data[key] for key in ("status", "duration", "size", "bytes_read", "correlationId") if key in data}
        entry.update(eventCode="EDGE_REQUEST_COMPLETED", level=50 if data.get("level") == "error" else 30,
                     route=route(data.get("route", request.get("uri", "/other"))),
                     method=data.get("method", request.get("method", "OTHER")))
        if entry["method"] not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}:
            entry["method"] = "OTHER"
        entry.update(next_headers(data, request))
        return {"service": "caddy", "entry": entry}
    if "Suppressed " in message and raw.get("SYSLOG_IDENTIFIER") == "systemd-journald":
        return {"service": "journal", "entry": {"eventCode": "LOG_JOURNAL_SUPPRESSED", "level": 50}}
    return None
