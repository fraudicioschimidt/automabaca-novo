import "dotenv/config";

/**
 * Preenche o banco de desenvolvimento com bancas e apostas de exemplo, e com o
 * que Operações e Monitoramento leem, para navegar pelo painel com dados.
 * Re-rodável: apaga os exemplos anteriores (só eles) e grava de novo. Recusa
 * produção e banco fora desta máquina.
 *
 *   npm run dev:demo
 *
 * O que é gravado e como: `lib/dados-demo.ts` (bancas e apostas) e
 * `lib/dados-demo-operacao.ts` (filas, motor, métricas, releases e incidentes).
 */

// O ambiente é lido uma vez, no import dos serviços: ajuste antes dele.
// Nenhum aviso sai para o Telegram, mesmo com um bot de teste no .env, e
// nenhuma chamada vai a provider ou IA: o gerador não os chama, e sem chave
// nem modo ligado um descuido falharia em vez de gastar cota.
for (const key of [
  "TELEGRAM_NOTIFICATION_BOT_TOKEN", "TELEGRAM_NOTIFICATION_CHAT_ID", "TELEGRAM_TOKEN",
  "GEMINI_API_KEYS", "GROQ_API_KEY", "MISTRAL_API_KEY", "FLASHSCORE_API_KEY", "PINNACLE17_RAPIDAPI_KEY",
]) delete process.env[key];
process.env.FLASHSCORE_MODE = "off";
process.env.PINNACLE17_MODE = "off";
// O 👍 do canal vale do dono; sem ele no .env, um dono fictício marca as apostas pegas.
process.env.TELEGRAM_ALLOWED_CHATS ||= "900000001";

async function main(): Promise<void> {
  const { gerarDadosDemo, recusaForaDoDev } = await import("./lib/dados-demo");
  const { gerarOperacaoDemo } = await import("./lib/dados-demo-operacao");
  const { disconnectPrisma } = await import("@/src/infra/prisma");
  // O import cria o pool, mas nenhuma conexão sai antes desta recusa.
  const recusa = recusaForaDoDev(process.env);
  if (recusa) {
    process.stderr.write(`Dados de exemplo recusados: ${recusa}. Só rodam no banco de desenvolvimento local.\n`);
    process.exitCode = 1;
    return;
  }
  const inicio = Date.now();
  try {
    const r = await gerarDadosDemo();
    const o = await gerarOperacaoDemo();
    const status = Object.entries(r.porStatus).map(([s, n]) => `${s} ${n}`).join(", ");
    process.stdout.write([
      `Dados de exemplo gravados em ${((Date.now() - inicio) / 1000).toFixed(1)} s.`,
      `  apagados da execução anterior: ${r.apagadas.bancas} tipsters, ${r.apagadas.apostas} apostas`,
      `  tipsters: ${r.bancas}`,
      `  apostas: ${r.apostas}`,
      `  liquidadas: ${r.liquidadas} (${status}); hoje: ${r.liquidadasHoje}; lucro ${r.lucroUnidades.toFixed(2)} u`,
      `  pendentes: ${r.pendentesIniciadas} já começaram, ${r.pendentesFuturas} ainda não; ${r.pegas} marcadas como pegas`,
      `  com fechamento: ${r.comFechamento}; com CLV confiável: ${r.comClvConfiavel}`,
      `  operação: ${o.liquidarManual} para liquidar à mão, ${o.vincular} para vincular, ${o.homologar} sugestões do IA-Judge, ${o.sharpPendentes} sem par sharp, ${o.reliquidadas} reliquidadas`,
      `  canais: ${o.postsJulgados} posts lidos, ${o.descartados} descartados`,
      `  motor: heartbeat e ciclo de fechamento agora; ${o.jobsFalhos} jobs falhos (${o.jobsRetidos} retidos na dead-letter), ${o.metricas} métricas, ${o.releases} releases, ${o.acoes} ações`,
      `  apagados da operação anterior: ${o.apagados.jobs} jobs, ${o.apagados.metricas} métricas, ${o.apagados.acoes} ações, ${o.apagados.releases} eventos de release, ${o.apagados.orcamentos} gastos de provider`,
      "  O motor aparece vivo por 15 min (o heartbeat não se renova sem worker); rode de novo para renovar.",
      "",
    ].join("\n"));
  } finally {
    await disconnectPrisma();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`Dados de exemplo falharam: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exit(1);
});
