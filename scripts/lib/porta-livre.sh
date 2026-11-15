#!/usr/bin/env bash
# Portas TCP em loopback para os servidores efêmeros da suíte de navegador.

# Uma porta livre agora, pedida ao sistema (porta 0). Entre esta resposta e o
# `listen` de quem a usar, outro processo pode tomá-la: quem chama confere com
# `ab_porta_em_uso` e tenta de novo se o próprio servidor der EADDRINUSE.
ab_porta_livre() {
  node -e 'const s = require("node:net").createServer(); s.listen(0, "127.0.0.1", () => { process.stdout.write(String(s.address().port)); s.close(); });'
}

# `ss` faz parte do sistema base (lsof pode não estar instalado, e um guard que
# some junto com o binário não é guard).
ab_porta_em_uso() {
  ss -tlnH "sport = :$1" | grep -q .
}
