/**
 * Backfill inicial (uma vez só, por franquia) da tabela local
 * "pagamentos_asaas" — AJUSTE 14, "Tabela local sincronizada via webhook do
 * Asaas para Taxa de Inadimplência" (ver README, seção "AJUSTE 14").
 *
 * A partir deste ajuste, GET /api/inadimplencia/resumo e /evolucao-mensal
 * passaram a ler da tabela local em vez de consultar a API do Asaas ao
 * vivo — mas a tabela só existe populada a partir do primeiro webhook
 * recebido (ou do primeiro evento novo criado no Asaas depois do deploy).
 * Antes disso, ou pra trazer o HISTÓRICO que já existia no Asaas antes do
 * webhook estar cadastrado, é preciso rodar este script — sem ele, a tela
 * fica vazia/incompleta até eventos novos irem chegando aos poucos.
 *
 * Reaproveita inteiramente `sincronizarJanela` (src/services/
 * pagamentosAsaas.service.js) — a MESMA função usada pela reconciliação
 * periódica (scripts/reconciliar-pagamentos-asaas.js) e pelo endpoint
 * POST /api/inadimplencia/reconciliar-pagamentos —, só que com uma janela
 * de vencimento BEM mais ampla (histórico completo, por padrão) e sem
 * comparar/apagar o que já existe localmente fora da janela (ver docblock
 * de `sincronizarJanela` para o porquê da exclusão de divergências ficar
 * restrita a janelas fechadas).
 *
 * IMPORTANTE — leia antes de rodar:
 *   - Roda em modo DRY RUN por padrão — só consulta o Asaas e mostra quantos
 *     pagamentos seriam criados/atualizados, não escreve nada no banco.
 *     Passe --confirm para aplicar de verdade.
 *   - Idempotente: pode rodar quantas vezes quiser (upsert por
 *     "payment.id") — rodar de novo só atualiza o que mudou desde a última
 *     vez, nunca duplica.
 *   - Multi-franquia: por padrão processa TODAS as franquias com uma chave
 *     de API do Asaas configurada (franquias sem chave são listadas e
 *     puladas, não é erro). Use --franquia=<id> pra restringir a uma só.
 *   - Sem --desde/--ate, busca o HISTÓRICO COMPLETO (sem filtro de
 *     vencimento) — pode ser uma quantidade grande de páginas na API do
 *     Asaas dependendo de há quanto tempo a franquia tem conta lá; sem
 *     pressa, sem timeout artificial aqui.
 *
 * Uso (dentro do container/ambiente com DATABASE_URL apontando pro banco
 * certo, e com a(s) chave(s) de API do Asaas já configuradas):
 *   node scripts/backfill-pagamentos-asaas.js                    # dry run, histórico completo, todas as franquias
 *   node scripts/backfill-pagamentos-asaas.js --confirm          # aplica
 *   node scripts/backfill-pagamentos-asaas.js --franquia=<id> --confirm
 *   node scripts/backfill-pagamentos-asaas.js --desde=2024-01-01 --ate=2026-12-31 --confirm
 *   node scripts/backfill-pagamentos-asaas.js --listar-franquias
 */
const { PrismaClient } = require('@prisma/client');
const { sincronizarJanela } = require('../src/services/pagamentosAsaas.service');
const { getAsaasApiKey } = require('../src/services/config.service');
const { AsaasApiError } = require('../src/services/asaas.service');

function parseArgs(argv) {
  const confirm = argv.includes('--confirm');
  const listarFranquias = argv.includes('--listar-franquias');
  const franquiaArg = argv.find((a) => a.startsWith('--franquia='));
  const franquiaId = franquiaArg ? franquiaArg.slice('--franquia='.length) : null;
  const desdeArg = argv.find((a) => a.startsWith('--desde='));
  const desde = desdeArg ? desdeArg.slice('--desde='.length) : undefined;
  const ateArg = argv.find((a) => a.startsWith('--ate='));
  const ate = ateArg ? ateArg.slice('--ate='.length) : undefined;
  return { confirm, listarFranquias, franquiaId, desde, ate };
}

async function main() {
  const { confirm, listarFranquias, franquiaId, desde, ate } = parseArgs(process.argv.slice(2));
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

    console.log(
      `Janela: ${desde || '(sem limite)'} até ${ate || '(sem limite)'} — ${confirm ? 'APLICANDO (--confirm)' : 'DRY RUN'}.\n` +
        `Processando ${franquiasComChave.length} franquia(s): ${franquiasComChave.map((f) => f.nome).join(', ')}\n`
    );

    let totalCriados = 0;
    let totalAtualizados = 0;
    let totalRemovidos = 0;
    const falhas = [];

    for (const franquia of franquiasComChave) {
      try {
        console.log(`[${franquia.nome}] Buscando pagamentos no Asaas...`);
        const resultado = await sincronizarJanela(franquia.id, { vencDe: desde, vencAte: ate, dryRun: !confirm });
        const removidosTexto =
          resultado.removidos > 0
            ? `, ${resultado.removidos} local(is) ${confirm ? 'removido(s)' : 'seria(m) removido(s)'} (não vieram mais do Asaas nessa janela)`
            : '';
        console.log(
          `[${franquia.nome}] ${resultado.totalAsaas} pagamento(s) no Asaas — ` +
            `${resultado.criados} novo(s), ${resultado.atualizados} já existente(s) (${
              confirm ? 'atualizados' : 'seriam atualizados'
            }), ${resultado.clientesResolvidos} cliente(s) distinto(s) resolvido(s)${removidosTexto}.\n`
        );
        totalCriados += resultado.criados;
        totalAtualizados += resultado.atualizados;
        totalRemovidos += resultado.removidos;
      } catch (err) {
        const mensagem = err instanceof AsaasApiError ? err.message : err.message || String(err);
        console.error(`[${franquia.nome}] FALHA: ${mensagem}\n`);
        falhas.push({ franquia: franquia.nome, erro: mensagem });
      }
    }

    if (!confirm) {
      console.log(
        `DRY RUN — ${totalCriados} seriam criados, ${totalAtualizados} seriam atualizados` +
          (totalRemovidos > 0 ? `, ${totalRemovidos} seriam removidos` : '') +
          '. Nada foi alterado no banco. Rode de novo com --confirm para aplicar.'
      );
    } else {
      console.log(
        `✓ ${totalCriados} pagamento(s) criado(s), ${totalAtualizados} atualizado(s)` +
          (totalRemovidos > 0 ? `, ${totalRemovidos} removido(s)` : '') +
          '.'
      );
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
  console.error('Erro ao rodar o backfill de pagamentos do Asaas:', err);
  process.exit(1);
});
