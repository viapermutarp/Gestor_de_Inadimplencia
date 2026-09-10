/**
 * Reconciliação periódica da tabela local "pagamentos_asaas" — AJUSTE 14,
 * "Tabela local sincronizada via webhook do Asaas para Taxa de
 * Inadimplência" (ver README, seção "AJUSTE 14").
 *
 * O webhook (src/controllers/asaasWebhook.controller.js) mantém a tabela
 * local em dia em tempo real, mas o Asaas só garante entrega "at least
 * once" — não "exactly once", nem "sempre". Uma entrega perdida (webhook
 * fora do ar num momento, evento não reenviado, etc.) deixaria a tabela
 * local divergente da API do Asaas indefinidamente, sem nenhum sinal disso.
 * Este script é a rede de segurança: roda com frequência (ex: diária, via
 * agendador externo — ver docblock abaixo), busca no Asaas os pagamentos de
 * uma janela de vencimento RECENTE (não o histórico completo — isso é o
 * backfill, scripts/backfill-pagamentos-asaas.js) e corrige qualquer
 * divergência: cria o que falta, atualiza o que mudou, remove da tabela
 * local o que não existe mais no Asaas dentro dessa janela.
 *
 * Reaproveita inteiramente `sincronizarJanela` (src/services/
 * pagamentosAsaas.service.js) — a MESMA função usada pelo backfill e pelo
 * endpoint POST /api/inadimplencia/reconciliar-pagamentos —, só que com uma
 * janela SEMPRE FECHADA (vencDe E vencAte, os dois informados): é essa
 * janela fechada que habilita `sincronizarJanela` a também REMOVER
 * localmente o que não veio mais do Asaas (ver docblock da função para o
 * porquê disso ficar restrito a janelas fechadas — evitar apagar histórico
 * por causa de uma janela aberta/paginação incompleta).
 *
 * SEM agendador interno — este projeto não usa node-cron nem nenhum
 * mecanismo de agendamento próprio; o sync periódico do Dashboard (POST
 * /api/sync) já é disparado por um workflow EXTERNO (n8n, "Sync Horário"),
 * não por código daqui. Este script segue a mesma lógica: é feito pra ser
 * chamado por um agendador de fora (cron do host, n8n, etc.) — não agenda a
 * si mesmo. A MESMA lógica também está exposta como endpoint HTTP (POST
 * /api/inadimplencia/reconciliar-pagamentos, ver inadimplencia.controller.js)
 * pra quem preferir disparar via chamada HTTP em vez de rodar este script
 * diretamente no host — os dois caminhos convergem em `sincronizarJanela`,
 * nenhuma lógica duplicada.
 *
 * IMPORTANTE — leia antes de rodar:
 *   - Roda em modo DRY RUN por padrão — só consulta o Asaas e mostra o que
 *     seria criado/atualizado/removido, não escreve nada no banco. Passe
 *     --confirm para aplicar de verdade.
 *   - Janela padrão: 90 dias atrás até 30 dias à frente da data de hoje
 *     (--dias-atras / --dias-frente para ajustar). Cobre o período onde
 *     divergência é mais provável e mais importa (inadimplência recente),
 *     sem re-varrer o histórico inteiro toda vez (isso é o backfill).
 *   - Idempotente: pode rodar quantas vezes/quão frequentemente quiser —
 *     upsert por "payment.id", mesma base do webhook e do backfill.
 *   - Multi-franquia: por padrão processa TODAS as franquias com uma chave
 *     de API do Asaas configurada (franquias sem chave são listadas e
 *     puladas, não é erro). Use --franquia=<id> pra restringir a uma só.
 *
 * Uso (dentro do container/ambiente com DATABASE_URL apontando pro banco
 * certo, e com a(s) chave(s) de API do Asaas já configuradas):
 *   node scripts/reconciliar-pagamentos-asaas.js                       # dry run, janela padrão, todas as franquias
 *   node scripts/reconciliar-pagamentos-asaas.js --confirm             # aplica
 *   node scripts/reconciliar-pagamentos-asaas.js --franquia=<id> --confirm
 *   node scripts/reconciliar-pagamentos-asaas.js --dias-atras=30 --dias-frente=15 --confirm
 *   node scripts/reconciliar-pagamentos-asaas.js --listar-franquias
 */
const { PrismaClient } = require('@prisma/client');
const {
  sincronizarJanela,
  calcularJanelaReconciliacao,
  DIAS_ATRAS_PADRAO_RECONCILIACAO,
  DIAS_FRENTE_PADRAO_RECONCILIACAO,
} = require('../src/services/pagamentosAsaas.service');
const { getAsaasApiKey } = require('../src/services/config.service');
const { AsaasApiError } = require('../src/services/asaas.service');

const DIAS_ATRAS_PADRAO = DIAS_ATRAS_PADRAO_RECONCILIACAO;
const DIAS_FRENTE_PADRAO = DIAS_FRENTE_PADRAO_RECONCILIACAO;

function parseArgs(argv) {
  const confirm = argv.includes('--confirm');
  const listarFranquias = argv.includes('--listar-franquias');
  const franquiaArg = argv.find((a) => a.startsWith('--franquia='));
  const franquiaId = franquiaArg ? franquiaArg.slice('--franquia='.length) : null;
  const diasAtrasArg = argv.find((a) => a.startsWith('--dias-atras='));
  const diasAtras = diasAtrasArg ? Number(diasAtrasArg.slice('--dias-atras='.length)) : DIAS_ATRAS_PADRAO;
  const diasFrenteArg = argv.find((a) => a.startsWith('--dias-frente='));
  const diasFrente = diasFrenteArg ? Number(diasFrenteArg.slice('--dias-frente='.length)) : DIAS_FRENTE_PADRAO;
  return { confirm, listarFranquias, franquiaId, diasAtras, diasFrente };
}

async function main() {
  const { confirm, listarFranquias, franquiaId, diasAtras, diasFrente } = parseArgs(process.argv.slice(2));

  if (!listarFranquias && (!Number.isFinite(diasAtras) || diasAtras < 0 || !Number.isFinite(diasFrente) || diasFrente < 0)) {
    console.error('--dias-atras e --dias-frente precisam ser números >= 0.');
    process.exitCode = 1;
    return;
  }

  const prisma = new PrismaClient();

  try {
    const todasFranquias = await prisma.franquia.findMany({ select: { id: true, nome: true }, orderBy: { nome: 'asc' } });

    if (listarFranquias) {
      console.log('Franquias cadastradas:\n');
      for (const f of todasFranquias) console.log(`  ${f.id}  ${f.nome}`);
      return;
    }

    let franquiasAlvo = todasFranquias;
    if (franquiaId) {
      franquiasAlvo = todasFranquias.filter((f) => f.id === franquiaId);
      if (franquiasAlvo.length === 0) {
        console.error(`Franquia "${franquiaId}" não encontrada. Rode com --listar-franquias para ver os IDs válidos.`);
        process.exitCode = 1;
        return;
      }
    }

    const franquiasComChave = [];
    const franquiasSemChave = [];
    for (const franquia of franquiasAlvo) {
      const chave = await getAsaasApiKey(franquia.id);
      if (chave) franquiasComChave.push(franquia);
      else franquiasSemChave.push(franquia);
    }

    if (franquiasSemChave.length > 0) {
      console.log('Franquias SEM chave de API do Asaas configurada (puladas):');
      for (const f of franquiasSemChave) console.log(`  ${f.id}  ${f.nome}`);
      console.log('');
    }

    if (franquiasComChave.length === 0) {
      console.log('Nenhuma franquia com chave do Asaas configurada — nada a fazer.');
      return;
    }

    const { vencDe, vencAte } = calcularJanelaReconciliacao(diasAtras, diasFrente);

    console.log(
      `Janela: ${vencDe} até ${vencAte} (${diasAtras}d atrás até ${diasFrente}d à frente) — ${
        confirm ? 'APLICANDO (--confirm)' : 'DRY RUN'
      }.\n` + `Processando ${franquiasComChave.length} franquia(s): ${franquiasComChave.map((f) => f.nome).join(', ')}\n`
    );

    let totalCriados = 0;
    let totalAtualizados = 0;
    let totalRemovidos = 0;
    const falhas = [];

    for (const franquia of franquiasComChave) {
      try {
        const resultado = await sincronizarJanela(franquia.id, { vencDe, vencAte, dryRun: !confirm });
        console.log(
          `[${franquia.nome}] ${resultado.totalAsaas} pagamento(s) no Asaas na janela — ` +
            `${resultado.criados} novo(s), ${resultado.atualizados} já existente(s) (${
              confirm ? 'atualizados' : 'seriam atualizados'
            }), ${resultado.removidos} local(is) ${
              confirm ? 'removido(s)' : 'seria(m) removido(s)'
            } (não vieram mais do Asaas nessa janela).`
        );
        totalCriados += resultado.criados;
        totalAtualizados += resultado.atualizados;
        totalRemovidos += resultado.removidos;
      } catch (err) {
        const mensagem = err instanceof AsaasApiError ? err.message : err.message || String(err);
        console.error(`[${franquia.nome}] FALHA: ${mensagem}`);
        falhas.push({ franquia: franquia.nome, erro: mensagem });
      }
    }

    console.log('');
    if (!confirm) {
      console.log(
        `DRY RUN — ${totalCriados} seriam criados, ${totalAtualizados} seriam atualizados, ${totalRemovidos} seriam ` +
          'removidos. Nada foi alterado no banco. Rode de novo com --confirm para aplicar.'
      );
    } else {
      console.log(`✓ ${totalCriados} criado(s), ${totalAtualizados} atualizado(s), ${totalRemovidos} removido(s).`);
    }

    if (falhas.length > 0) {
      console.log(`\n✗ ${falhas.length} franquia(s) com falha:`);
      for (const f of falhas) console.log(`  [${f.franquia}] ${f.erro}`);
      process.exitCode = 1;
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Erro ao rodar a reconciliação de pagamentos do Asaas:', err);
  process.exit(1);
});
