import Link from "next/link";
import React, { useEffect, useId, useState } from "react";
import { useDesign } from "../../kit/context";
import { uiHexA } from "../../utils";
import { OpsCard } from "./ui-primitives";
import styles from "./operacoes.module.css";
import { contagem } from "../../lib/plural";
import { contagemDaAcao, formaDoHistorico } from "../../lib/reincidencia-de-acao";
import { ICONS, Icon } from "../../kit/icons";
import { toast } from "../../toast";
import {
  ACOES_POR_ABA,
  criterioDaAba,
  ORDEM_NA_TELA,
  type AbaDaCaixa,
} from "@/src/domain/recorte-da-caixa-de-acoes";
import type { MonitoramentoActions } from "../../action-contracts";
import type { MonitoramentoData } from "../../adapters/operacoes";
import type { CssVarsStyle } from "../../kit/css-vars";
import { riskLabel } from "@/src/domain/operational-action-status";

type Acao = MonitoramentoData["actions"][number];
type Leitura = Acao["reading"];
type AcaoDoOperador = "ack" | "resolve";

const DICA_DO_ENCERRAMENTO = 'Condições normalizadas encerram a ação automaticamente.';

const TABS: ReadonlyArray<{ key: AbaDaCaixa; label: string }> = [
  { key: 'OPEN', label: 'Abertas' },
  { key: 'ACKED', label: 'Assumidas' },
  { key: 'RESOLVED', label: 'Encerradas' },
];

/**
 * O rodapé de truncamento declara QUAIS linhas chegaram, não só quantas
 * ficaram de fora: sem o critério, um top-N por prioridade se lê como "o que
 * acabou de acontecer".
 */
export function textoDoRecorte(aba: string, mostradas: number, total: number) {
  if (!Number.isFinite(total) || total <= mostradas) return null;
  return `Exibindo ${mostradas} de ${total} · ${ORDEM_NA_TELA[criterioDaAba(aba)]}`;
}

function tabKey(status: string): AbaDaCaixa {
  return status === 'OPEN' || status === 'ACKED' ? status : 'RESOLVED';
}

function totalsFrom(actions: readonly Acao[], totals: MonitoramentoData["actionTotals"] | null): Record<AbaDaCaixa, number> {
  const total = (key: AbaDaCaixa) => totals?.[key] ?? actions.filter((item) => tabKey(item.status) === key).length;
  return { OPEN: total('OPEN'), ACKED: total('ACKED'), RESOLVED: total('RESOLVED') };
}

/**
 * As três abas de status, com o total de cada uma, num controle segmentado:
 * o trilho é o `inset` e a aba escolhida sobe em `surface`.
 */
function AbasDeStatus({ tab, counts, onTab }: {
  tab: AbaDaCaixa;
  counts: Record<AbaDaCaixa, number>;
  onTab: (key: AbaDaCaixa) => void;
}) {
  return (
    <div role="tablist" aria-label="Status das ações" className={styles.caixaAbas}>
      {TABS.map((item) => (
        <button key={item.key} type="button" role="tab" aria-selected={tab === item.key} onClick={() => onTab(item.key)}
          className={styles.caixaAba}>
          {item.label}
          <span className={styles.caixaAbaConta}>{counts[item.key]}</span>
        </button>
      ))}
    </div>
  );
}

const GRAVIDADE: Record<string, { tom: string; texto: string }> = {
  CRITICAL: { tom: 'alta', texto: 'Gravidade crítica' },
  HIGH: { tom: 'alta', texto: 'Gravidade alta' },
  MEDIUM: { tom: 'media', texto: 'Gravidade média' },
  LOW: { tom: 'baixa', texto: 'Gravidade baixa' },
};

function gravidadeDa(risk: string) {
  return GRAVIDADE[risk] ?? { tom: 'outra', texto: `Gravidade ${riskLabel(risk)}` };
}

/**
 * Uma linha por ação: gravidade, título, resumo e recência. Clicar na linha
 * abre o texto completo, o histórico e as evidências; os botões ficam num
 * irmão do botão da linha, nunca dentro dele.
 */
function LinhaDeAcao({ inc, aberta, corpoId, onAlternar, busy, run, onAcknowledge, onResolve }: {
  inc: Acao;
  aberta: boolean;
  corpoId: string;
  onAlternar: () => void;
  busy: boolean;
  run: (acao: Acao, action: AcaoDoOperador) => unknown;
  onAcknowledge: MonitoramentoActions["onAcknowledgeAction"];
  onResolve: MonitoramentoActions["onResolveAction"];
}) {
  const gravidade = gravidadeDa(inc.risk);
  const { reading } = inc;
  const soma = contagemDaAcao(inc);
  const historico = formaDoHistorico({
    vezesQueVoltou: soma.vezesQueVoltou,
    desdeRelativo: inc.desde,
    desdeAbsoluto: inc.desdeAbsoluto,
    ultimaVezRelativo: inc.whenRelativo,
  });
  return (
    <article className={styles.acao} data-aberta={aberta || undefined}>
      {/* `aria-controls` só com o corpo na tela: apontar para id que não
          existe é atributo inválido. */}
      <button type="button" className={styles.acaoLinha} aria-expanded={aberta}
        aria-controls={aberta ? corpoId : undefined} onClick={onAlternar}>
        <span role="img" aria-label={gravidade.texto} title={gravidade.texto}
          className={styles.acaoPonto} data-gravidade={gravidade.tom} />
        <span className={styles.acaoTexto}>
          <span className={styles.acaoTitulo}>{inc.title}</span>
          <span className={styles.acaoResumo}>{reading.summary}</span>
        </span>
        <span className={styles.acaoQuando} title={inc.when}>{inc.whenRelativo ?? inc.when}</span>
      </button>
      <div className={styles.acaoBotoes}>
        {inc.href ? <Link href={inc.href} prefetch={false} className={styles.acaoLink}>Abrir</Link> : null}
        {inc.status === 'OPEN' && onAcknowledge ? <button type="button" disabled={busy} onClick={() => run(inc, 'ack')}
          className={styles.acaoBotao}>Assumir</button> : null}
        {(inc.status === 'OPEN' || inc.status === 'ACKED') && onResolve ? <button type="button" disabled={busy} onClick={() => run(inc, 'resolve')}
          className={styles.acaoPrimario}>Resolver</button> : null}
      </div>
      {aberta ? (
        <div id={corpoId} className={styles.acaoCorpo}>
          <FichaDaAcao card={reading.card} />
          {reading.todo ? (
            <div className={styles.acaoFazer}><span className={styles.acaoFazerRotulo}>O que fazer</span><span>{reading.todo}</span></div>
          ) : null}
          {reading.links.length > 0 ? (
            <div className={styles.acaoLinks}>
              {reading.links.map((link) => link.external
                ? <a key={link.href} href={link.href} target="_blank" rel="noopener noreferrer" className={styles.acaoLinkBotao}>{link.label} ↗</a>
                : <Link key={link.href} href={link.href} prefetch={false} className={styles.acaoLinkBotao}>{link.label}</Link>)}
            </div>
          ) : null}
          <div className={styles.acaoMeta}>
            {/* A recência vem primeiro (é o que separa triagem de rolagem);
                o carimbo absoluto fica logo atrás, para conferir com o log. */}
            <span className={styles.acaoMetaQuando}>{inc.whenRelativo ?? inc.when}</span>
            {inc.whenRelativo ? <><span>·</span><span>{inc.when}</span></> : null}
            <span>·</span><span>{inc.area}</span><span>·</span>
            <span>{contagem(soma.ocorrencias, 'ocorrência', 'ocorrências')}</span>
            {/* A contagem vem com o período, e o incidente encerrado
                que VOLTOU não pode se parecer com um que nasceu agora. */}
            {historico.forma !== 'nada'
              ? <><span>·</span><span className={historico.forma === 'reincidente' ? styles.acaoReincidente : undefined}>{historico.texto}</span></> : null}
            {inc.owner ? <><span>·</span><span>responsável <b className={styles.acaoDono}>{inc.owner}</b></span></> : null}
          </div>
          {inc.resolutionNote ? <div className={styles.acaoDesfecho}>{inc.resolutionNote}</div> : null}
          {reading.technical.length > 0 ? (
            // Os códigos e ids servem para conferir com o log, não para decidir: ficam fechados.
            <details className={styles.acaoTecnico}>
              <summary>Dados técnicos</summary>
              <dl className={styles.evidencias} aria-label="Dados técnicos">
                {reading.technical.map((fact) => <React.Fragment key={fact.label}><dt className={styles.evidenciaChave}>{fact.label}</dt><dd className={styles.evidenciaValor}>{fact.value}</dd></React.Fragment>)}
              </dl>
            </details>
          ) : null}
        </div>
      ) : null}
    </article>
  );
}

/** O miolo da ação aberta: a ficha do tipo, ou o texto limpo quando o tipo não tem ficha. */
function FichaDaAcao({ card }: { card: Leitura["card"] }) {
  if (card.kind === 'writes') {
    return (
      <div className={styles.fichaBloco}>
        {card.authors.map((autor) => (
          <div key={autor.name} className={styles.fichaPainel}>
            <div className={styles.fichaAutor}>
              <b>{autor.name}</b>
              <span className={styles.fichaSelo} data-alerta={autor.unattributed || undefined}>{autor.badge}</span>
              <span className={styles.fichaConta}>{contagem(autor.changes, 'mudança', 'mudanças')}</span>
            </div>
            <ul className={styles.fichaLista}>
              {autor.actions.map((acao) => <li key={acao.code}><span>{acao.text} <code>{acao.code}</code></span></li>)}
            </ul>
          </div>
        ))}
        <p className={styles.fichaNota}>{card.closing}</p>
      </div>
    );
  }
  if (card.kind === 'refusals') {
    return (
      <div className={styles.fichaBloco}>
        <div className={styles.fichaNumero}>
          <span className={styles.fichaNumeroValor}>{card.posts}</span>
          <span>{card.posts === 1 ? 'post' : 'posts'} de <b>{card.tipster}</b> {card.posts === 1 ? 'recusado' : 'recusados'} em 24 h<br />pelo mesmo motivo: <b>{card.reason}</b></span>
        </div>
        {card.note ? <p className={styles.fichaNota}>{card.note}</p> : null}
      </div>
    );
  }
  if (card.kind === 'ticket') {
    return (
      <div className={styles.fichaDuas}>
        {card.post ? (
          <div className={styles.fichaPainel}>
            <h4 className={styles.fichaPainelTitulo}>Post original{card.postedAt ? ` · ${card.postedAt}` : ''}</h4>
            <div className={styles.fichaPost}>{card.post}</div>
          </div>
        ) : null}
        <div className={styles.fichaPainel}>
          <h4 className={styles.fichaPainelTitulo}>O que a leitura entendeu</h4>
          {card.legs.map((perna, i) => (
            <div key={i} className={styles.fichaPerna}><span>{perna.text}</span>{perna.missing ? <span className={styles.fichaFalta}>{perna.missing}</span> : null}</div>
          ))}
          {card.totals ? <div className={styles.fichaNota}>{card.totals}</div> : null}
        </div>
      </div>
    );
  }
  return card.paragraphs.length > 0 ? <p className={styles.acaoDescricao}>{card.paragraphs.join('\n')}</p> : null;
}

export function ActionsCard({ actions, actionTotals = null, available = true, onAcknowledge = null, onResolve = null }: {
  actions: Acao[];
  actionTotals?: MonitoramentoData["actionTotals"] | null;
  available?: boolean;
  onAcknowledge?: MonitoramentoActions["onAcknowledgeAction"];
  onResolve?: MonitoramentoActions["onResolveAction"];
}) {
  const { T } = useDesign();
  const [rows, setRows] = useState(actions);
  const [counts, setCounts] = useState(() => totalsFrom(actions, actionTotals));
  const [tab, setTab] = useState<AbaDaCaixa>('OPEN');
  const [processing, setProcessing] = useState(() => new Set<string>());
  // Uma linha aberta por vez; trocar de aba fecha a que estava aberta.
  const [aberta, setAberta] = useState<string | null>(null);
  const idBase = useId();
  const escolherAba = (key: AbaDaCaixa) => { setTab(key); setAberta(null); };

  useEffect(() => {
    setRows(actions);
    setCounts(totalsFrom(actions, actionTotals));
  }, [actions, actionTotals]);

  const inTab = (item: Acao, key: AbaDaCaixa) => key === 'RESOLVED' ? item.status !== 'OPEN' && item.status !== 'ACKED' : item.status === key;
  const matching = rows.filter((item) => inTab(item, tab));
  // Cada linha é exatamente um id e uma ação dos botões, sem agrupar por
  // texto: a fingerprint canônica já deduplica a mesma condição na origem, e
  // agrupar depois da paginação misturaria bases no "Exibindo N de T".
  const visible = matching.slice(0, ACOES_POR_ABA);
  const hintStyle: CssVarsStyle = { '--ops-hint-color': T.textFaint };
  const emptyStyle: CssVarsStyle = {
    '--ops-empty-bg': tab === 'OPEN' ? T.posSoft : T.surface2,
    '--ops-empty-border': tab === 'OPEN' ? uiHexA(T.pos, 0.25) : T.border,
  };

  const run = async (acao: Acao, action: AcaoDoOperador) => {
    const fn = action === 'ack' ? onAcknowledge : onResolve;
    if (!fn || processing.has(acao.id)) return;
    setProcessing((prev) => new Set(prev).add(acao.id));
    try {
      await fn(acao.id);
      const nextStatus = action === 'ack' ? 'ACKED' : 'RESOLVED';
      setRows((current) => current.map((item) => item.id === acao.id ? {
        ...item,
        status: nextStatus,
        owner: item.owner || 'Você',
        resolutionNote: action === 'resolve' ? 'Resolvida manualmente pelo operador.' : item.resolutionNote,
      } : item));
      setCounts((current) => {
        const from = tabKey(acao.status);
        const to = tabKey(nextStatus);
        if (from === to) return current;
        return {
          ...current,
          [from]: Math.max(0, current[from] - 1),
          [to]: current[to] + 1,
        };
      });
      toast(action === 'ack' ? 'Ação assumida' : 'Ação encerrada', 'ok');
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Falha ao atualizar a ação', 'warn');
    } finally {
      setProcessing((prev) => { const next = new Set(prev); next.delete(acao.id); return next; });
    }
  };

  const vazio = !available ? 'Leitura indisponível — não é possível afirmar que a fila está vazia.' : tab === 'OPEN' ? 'Nada aberto — o motor está consistente.' : `Nenhuma ação em “${TABS.find((item) => item.key === tab)?.label}”.`;
  const recorte = textoDoRecorte(tab, visible.length, counts[tab]);

  return (
    <OpsCard pad={null} className={`${styles.cardSpace} ${styles.caixa}`}>
      <div className={styles.caixaTopo} title={DICA_DO_ENCERRAMENTO}>
        <h2 className={styles.sectionTitle}>Caixa de ações</h2>
        <span className={styles.caixaDica}>{DICA_DO_ENCERRAMENTO}</span>
        <AbasDeStatus tab={tab} counts={counts} onTab={escolherAba} />
      </div>

      {visible.length === 0 ? (
        <div className={styles.caixaVazia}>
          <div className={styles.incidentEmpty} style={emptyStyle}>
            <span className={styles.incidentEmptyIcon}>
              <Icon d={ICONS.check} s={16} w={2} />
            </span>
            <div className={styles.incidentEmptyText}>{vazio}</div>
          </div>
        </div>
      ) : (
        <div className={styles.caixaLista}>
          {visible.map((inc) => (
            <LinhaDeAcao key={inc.id} inc={inc} aberta={aberta === inc.id} corpoId={`${idBase}-${inc.id}`}
              onAlternar={() => setAberta((atual) => atual === inc.id ? null : inc.id)}
              busy={processing.has(inc.id)} run={run} onAcknowledge={onAcknowledge} onResolve={onResolve} />
          ))}
          {recorte ? <div className={`${styles.sectionHint} ${styles.caixaRecorte}`} style={hintStyle}>{recorte}</div> : null}
        </div>
      )}
    </OpsCard>
  );
}
