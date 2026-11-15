"use client";
import "./players-card.css";
import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { getPlayersPanel, PlayerPanelCommand } from "@/src/services/players/panel";
import { errorMessage } from "../../toast";

type Panel = Awaited<ReturnType<typeof getPlayersPanel>>;
const REASONS: Record<string, string> = {
  jogador_ambiguo: "Escolher jogador", jogador_nao_encontrado: "Jogador não encontrado",
  jogador_fora_da_partida: "Jogador fora desta partida", stat_ausente: "Estatística ainda indisponível",
  regra_da_casa_nao_comprovada: "Conferir regra da casa", cobertura_nao_validada: "Cobertura em validação",
  titularidade_nao_comprovada: "Titularidade não confirmada", participacao_nao_comprovada: "Participação não confirmada",
  regra_de_substituicao_pendente: "Conferir substituição", validacao_do_grupo_pendente: "Conferir resultado da casa",
  provider_indisponivel: "Aguardando fonte de estatísticas", regra_da_competicao_nao_comprovada: "Conferir regra da competição", qualificador_ou_combinacao_sem_contrato: "Conferir condições do mercado",
  aguardando_confirmacao: "Aguardando confirmação", periodo_nao_suportado: "Período sem estatística",
};

export function PlayersCard({ onLoad, onCommand, canManage = false }: {
  onLoad?: (search?: string) => Promise<Panel>; onCommand?: (command: PlayerPanelCommand) => Promise<unknown>; canManage?: boolean;
}) {
  const [panel, setPanel] = useState<Panel | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const queryRef = useRef(query);
  const generation = useRef(0);
  const commandInFlight = useRef(false);
  useEffect(() => {
    queryRef.current = query;
    const current = ++generation.current;
    const timer = setTimeout(() => {
      onLoad?.(query)
        .then((data) => { if (generation.current === current) { setPanel(data); setLoadError(""); } })
        .catch((cause: unknown) => { if (generation.current === current) setLoadError(errorMessage(cause, "Falha ao carregar jogadores.")); });
    }, 250);
    return () => { generation.current += 1; clearTimeout(timer); };
  }, [onLoad, query]);
  async function run(command: PlayerPanelCommand) {
    if (!onCommand || commandInFlight.current) return;
    commandInFlight.current = true;
    setBusy(true); setError("");
    try {
      await onCommand(command);
      if (onLoad) {
        const current = ++generation.current;
        const updated = await onLoad(queryRef.current);
        if (generation.current === current) { setPanel(updated); setLoadError(""); }
      }
    }
    catch (e) { setError(errorMessage(e, "Não foi possível salvar.")); }
    finally { commandInFlight.current = false; setBusy(false); }
  }
  const box: CSSProperties = { border: "1px solid var(--border, #ddd)", borderRadius: 12, padding: 20, marginBottom: 16 };
  if (!onLoad) return <p>Jogadores disponíveis na configuração conectada.</p>;
  return <section className="players-panel" aria-label="Aliases de jogadores" aria-busy={busy}>
    <h2>Jogadores</h2>
    <p>Uma identidade por atleta, com os nomes usados em cada aposta.</p>
    {(error || loadError) && <p role="alert">{error || loadError}</p>}
    {!panel && <p>Carregando jogadores…</p>}
    {panel && <>
      <details style={box}><summary>Captura e liquidação por grupo</summary>
        {panel.bankrolls.filter((b) => b.sharpMode === "IDENTITY_ONLY" || b.imageStakeAsUnits).map((b) => <form key={`${b.id}:${b.imageStakeAsUnits}:${b.playerPropsAutoSettlement}`} style={{ marginTop: 16 }} onSubmit={async (event) => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          await run({ kind: "settings", bankrollId: b.id, imageStakeAsUnits: data.get("units") === "on", automatic: data.get("automatic") === "on" });
        }}><strong>{b.nome}</strong><br />
          <label><input name="units" type="checkbox" defaultChecked={b.imageStakeAsUnits} disabled={!canManage || busy} /> Valor do print representa unidades quando não há legenda</label><br />
          <label><input name="automatic" type="checkbox" defaultChecked={b.playerPropsAutoSettlement} disabled={!canManage || busy} /> Liquidar automaticamente os casos comprovados</label>
          <p>{b.validatedBets}/20 apostas conferidas · {b.validatedCompetitions}/3 competições</p>
          {canManage && <button disabled={busy}>Salvar grupo</button>}
        </form>)}
      </details>
      {panel.corrections.map((p) => <article key={p.betId} style={box}>
        <strong>Resultado com divergência para conferir</strong><p>{p.evento} · {p.selecao}</p>
        <p>O resultado registrado foi preservado. Confira a estatística e o bilhete na casa antes de alterar o histórico.</p>
        <details><summary>Evidência da conferência</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(p.evidence, null, 2)}</pre></details>
        {canManage && <form onSubmit={async (event) => { event.preventDefault(); await run({ kind: "acknowledge", betId: p.betId, evidence: String(new FormData(event.currentTarget).get("explanation") ?? "") }); }}>
          <label>Explicação da divergência <input name="explanation" required minLength={10} maxLength={1000} /></label> <button disabled={busy}>Registrar conferência</button>
        </form>}
      </article>)}
      <h3>Para conferir</h3>
      {!panel.pending.length && <p>Nenhuma aposta de jogador aguardando conferência.</p>}
      {panel.pending.map((p) => <article key={p.betId} style={box}>
        <strong>{p.evento}</strong><p>{p.selecao}</p>
        <span>{REASONS[String(p.evidence?.reason)] ?? "Aguardando dados da partida"}</span>
        <details><summary>Jogador e evidência</summary>
          <p>Nome recebido: {p.terms.jogador}</p>
          <p>Mercado: {p.terms.mercadoOriginal} · Seleção: {p.terms.selecaoOriginal}</p>
          {p.evidence?.proposedStatus != null && <p>Resultado calculado: {String(p.evidence.proposedStatus)}</p>}
          <p>{p.terms.evidencia}</p>
          <details><summary>Estatística e regra utilizadas</summary><pre style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{JSON.stringify(p.evidence, null, 2)}</pre></details>
          {canManage && <form onSubmit={async (event) => {
            event.preventDefault(); const id = String(new FormData(event.currentTarget).get("player") ?? "");
            if (id) await run({ kind: "link", betId: p.betId, playerIdentityId: id });
          }}><label>Jogador do Flashscore <select name="player" defaultValue={p.identityId ?? ""} required disabled={busy}>
            <option value="">Escolher jogador</option>
            {p.candidates.map((player) => <option key={player.id} value={player.id}>{player.name}</option>)}
          </select></label> <button disabled={busy}>Vincular e aprender nome</button></form>}
        </details>
        {canManage && <details><summary>Informar resultado da casa</summary><form onSubmit={async (event) => {
          event.preventDefault(); const data = new FormData(event.currentTarget);
          await run({ kind: "result", betId: p.betId, status: String(data.get("status")) as "WON" | "LOST" | "VOID", evidence: String(data.get("evidence") ?? "") });
        }}><label>Resultado <select name="status"><option value="WON">Ganha</option><option value="LOST">Perdida</option><option value="VOID">Anulada</option></select></label>
          <p><label>Referência do resultado <input name="evidence" required minLength={5} maxLength={1000} placeholder="Resultado do bilhete na casa" /></label></p>
          <button disabled={busy}>Confirmar resultado</button>
        </form></details>}
      </article>)}
      <h3>Nomes cadastrados</h3>
      <label>Buscar jogador <input maxLength={150} value={query} onChange={(e) => setQuery(e.target.value)} /></label>
      {panel.players.filter((p) => `${p.name} ${p.aliases.map((a) => a.name).join(" ")}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())).map((p) => <details key={p.id} style={{ ...box, marginTop: 12 }}>
        <summary>{p.name}</summary>
        <p>Flashscore: {p.providerPlayerId}</p>
        {p.aliases.map((a) => <div key={a.id}>{a.provider} · {a.name} {canManage && a.provider === "LOCAL" && <button disabled={busy} onClick={async () => { await run({ kind: "removeAlias", aliasId: a.id }); }}>Remover nome</button>}</div>)}
      </details>)}
    </>}
  </section>;
}
