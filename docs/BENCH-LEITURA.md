# Bancada de leitura de apostas

Mede cada modelo do Gemini, da Groq e da Mistral lendo apostas reais, com o
mesmo prompt, schema, julgamento (`accept`) e porteiro (`finalizeParsedBetForCapture`)
da captura. É ferramenta de desenvolvimento: roda sob demanda, só com o `.env`
local, e não entra no worker nem nas imagens.

```bash
npm run bench:leitura -- catalogo        # modelos que as chaves enxergam; sonda visão
npm run bench:leitura -- gabarito        # rascunho do gabarito, lido pelos modelos em uso
npm run bench:leitura -- rodar           # 2 repetições por item, todos os modelos alcançáveis
npm run bench:leitura -- relatorio       # refaz a página depois de corrigir o gabarito
```

"Em uso" são os modelos do catálogo de produção
([`src/infra/llm/models.ts`](../src/infra/llm/models.ts)). Na bancada ele é só o
padrão: `rodar` testa todo modelo que as chaves enxergam, inclusive os que a
produção não usa, e `--modelos` escolhe outra lista.

Opções de `rodar`: `--repeticoes 1`, `--provedores gemini,groq`,
`--modelos gemini/gemini-3.5-flash,mistral/mistral-ocr-4-1`, `--por-provedor 3`,
`--itens a.png,b.txt`, `--intervalo gemini=7000,groq=4000,mistral=1500` (ms entre
chamadas ao mesmo modelo), `--timeout 60000`, `--refazer-falhas` (nova passada só nas leituras com 503, timeout ou 429, sem
os modelos sem acesso). Comuns:
`--pasta` (padrão `~/bench-leitura`) e `--saida` (padrão `<pasta>/resultado`).

- **Pasta**: `.jpg`, `.png`, `.webp` (prints) e `.txt` (post de texto). A legenda
  de um print vai em `<print>.legenda.txt` ou no campo `legenda` do gabarito.
- **Retomada**: cada leitura vira uma linha de `resultado/leituras.jsonl`; rodar
  de novo pula o que já foi feito. O que a cota do dia não deixou fazer fica
  pendente para a próxima rodada. Mudar a legenda ou o arquivo refaz o item;
  corrigir só a resposta esperada não gasta chamada (`relatorio` recalcula).
- **Saída**: `resultado/relatorio.html` (ranking ordenável, proposta de
  eliminação e erros por modelo), `relatorio.json`, `catalogo.json`, `plano.json`.

## Gabarito (`gabarito.json`)

Uma chave por arquivo; chaves com `_` são comentário. `gabarito` gera o
rascunho (em `gabarito.json`, se ainda não existir; senão em
`gabarito.rascunho.json`) com `"conferido": false` em todo item, e
`gabarito.exemplo.json` com os casos abaixo.

```json
{
  "bilhete-01.jpg": {
    "legenda": "Flamengo x Palmeiras over 2.5 gols 1u",
    "apostas": [{ "evento": "Flamengo vs Palmeiras", "mercado": "Total de Gols", "selecao": "Mais de 2.5",
                  "linha": 2.5, "odds": 1.9, "stake": 1, "esporte": "Soccer" }]
  },
  "resultado-03.png": { "resposta": "nao_e_aposta" },
  "bilhete-04.jpg": { "resposta": "incompleta", "faltando": ["stake"],
                      "apostas": [{ "evento": "Grêmio vs Inter", "selecao": "Grêmio", "odds": 2.1, "stake": null }] }
}
```

`resposta` vale `aposta` (padrão com apostas), `nao_e_aposta` ou `incompleta`.
Campo ausente não é conferido. Opcionais: `arquivos` (álbum), `leitor`
(`texto`, `bilhete`, `jogador`, `album`), `politica` (`AUTO`, `CAPTION_ODD`,
`IMAGE_ODD`), `banca` (`stakePolicy`, `defaultStakeUnits`), `dataPost`.

## Como a nota é dada

O **item** está certo quando o tipo bate e, se for aposta, a quantidade e todos
os campos de todas as apostas. Odd e linha são comparadas como número (a linha
sai da seleção pelo leitor de linhas da liquidação); o evento, pelo comparador
de confrontos; a seleção, por lado, direção e linha; o mercado, pelo catálogo de
mercados; o esporte, pelo registro de esportes (esporte não informado erra o
campo, mas não derruba a aposta inteira). Acerto conta só leituras respondidas; 429, cota e indisponibilidade
aparecem à parte, somando todas as passadas (`--refazer-falhas` refaz só as
leituras sem resposta). A latência é a da chamada que valeu, sem as esperas.
"Alcançável" é o acerto nos itens que algum modelo acertou.

A proposta da rodada elimina só por acerto alcançável abaixo de 60%, mais de
20% fora do contrato ou 20%+ das respostas acima do prazo de produção (com 5+
respostas). 503, timeout, 429 e cota do dia mandam reconfirmar; 404, cota zero e
Labs aparecem como "sem acesso nesta chave".

Diferenças da captura, de propósito: um modelo por vez (sem cascata nem
consenso entre provedores), sem cache, sem cooldown nem circuito no banco, e sem
as releituras de handicap e de mercado que a captura faz depois do porteiro. Um
post de texto vai direto à IA, sem o leitor por regra antes.

## Cotas grátis (observadas em 23/09/2026, chaves novas)

- **Gemini**: 20 requisições por dia por modelo e projeto (`gemini-3.5-flash`),
  zerando à meia-noite do Pacífico; modelos Pro, de imagem e Omni vêm com
  limite 0; `gemini-2.5-flash`, `-flash-lite` e `-pro` dão 404 para usuário
  novo. Com 20 por dia, 30 itens × 2 repetições pedem 3 dias por modelo (ou
  mais chaves em `GEMINI_API_KEYS`, de projetos diferentes).
- **Groq**: `qwen/qwen3.8-27b` tem 200 mil tokens por dia e 8 mil por minuto; um
  print com o prompt da captura gasta ~6,7 mil, então cabem ~29 leituras por
  dia, uma por minuto.
- **Mistral**: no plano grátis só os `ministral-*` e o `pixtral-12b-2409`
  respondem; `mistral-small`, `mistral-medium` e os OCR vêm com limite 0 por
  minuto, e o `labs-leanstral` exige habilitar Labs na organização.

A bancada para o modelo ao ver cota zero ou modelo inexistente, e deixa
pendente o que a cota do dia não cobriu; rodar de novo no dia seguinte completa.
