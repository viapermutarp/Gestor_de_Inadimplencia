/**
 * ETAPA B, item 7 (AJUSTE 22) — correção pontual das cobranças presas
 * confirmadas em produção como removidas no Asaas (as mesmas investigadas em
 * `scripts/diagnostico-cobrancas-removidas-asaas.js`, PARTE 1 — 9 ids
 * default abaixo, a maioria por renegociação).
 *
 * NÃO reimplementa a confirmação — reaproveita
 * `src/services/cobrancasRemovidas.service.js` (mesma função usada pelo
 * webhook, por POST /api/sync e pela reconciliação diária): cada id é
 * re-consultado na API do Asaas ao vivo (nunca aplica só pela ausência
 * local) e SÓ marca "removida" (nunca "quitada" — dinheiro que nunca entrou
 * não pode contar como recebido) as que o Asaas confirma com `deleted:
 * true`. Uma Cobranca que já esteja "quitada" ou "removida" nunca é tocada
 * (o `updateMany` de `aplicarRemocao` já filtra por pending/overdue).
 *
 * MODO DE OPERAÇÃO (mesma convenção do resto do projeto):
 *   - Dry run por padrão — só mostra o que seria alterado, nada é escrito.
 *   - `--confirm` aplica de verdade.
 *   - Guardrail de segurança: se o número de candidatas CONFIRMADAS como
 *     removidas no Asaas passar de 20, o script RECUSA aplicar (só em modo
 *     `--confirm` — o dry-run sempre mostra o relatório completo, pra dar
 *     pra revisar o que travou o guardrail). Sem flag `--force` pra
 *     ignorar — é uma lista pontual de casos conhecidos, se aparecer mais
 *     de 20 candidatas é sinal de que algo mudou e merece revisão manual
 *     antes de rodar de novo (diferente do guardrail "diário" dos outros
 *     scripts, que tem --force pensado pra rotina automatizada).
 *
 * Uso:
 *   node scripts/corrigir-cobrancas-removidas-asaas.js                    # dry run, 9 ids default
 *   node scripts/corrigir-cobrancas-removidas-asaas.js --confirm          # aplica
 *   node scripts/corrigir-cobrancas-removidas-asaas.js --ids=pay_a,pay_b [--confirm]
 */
const prismaBase = require('../src/config/prisma');
const { confirmarRemocaoViaAsaas, aplicarRemocao } = require('../src/services/cobrancasRemovidas.service');

const LIMITE_SEGURANCA = 20;

const IDS_PADRAO = [
  'pay_9zt74mhemkbmgzwc',
  'pay_rranoxahyl15jeg5',
  'pay_awajnfu43hrbpbqe', // Fernanda
  'pay_ya2mt6iiucelk176', // Joyce
  'pay_d6e1aroguqxrau5d', // Malu
  'pay_u00r0hp5uu6n0eae',
  'pay_bv872u0ngsccshsq',
  'pay_nt8x65kg44uk1tof', // Nadia
  'pay_9idqrzwvd3yzsoy5', // Stefhany
];

function parseArgs(argv) {
  const confirm = argv.includes('--confirm');
  const idsArg = argv.find((a) => a.startsWith('--ids='));
  const ids = idsArg
    ? idsArg
        .slice('--ids='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : IDS_PADRAO;
  return { confirm, ids };
}

function formatarBRL(valor) {
  return `R$ ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main() {
  const { confirm, ids } = parseArgs(process.argv.slice(2));
  console.log(`\n=== Correção pontual — cobranças removidas no Asaas — ${confirm ? 'APLICANDO (--confirm)' : 'DRY RUN'} ===`);
  console.log(`${ids.length} id(s) a verificar.\n`);

  const candidatasConfirmadas = [];
  const naoAplicaveis = [];

  for (const id of ids) {
    console.log(`--- ${id} ---`);

    const cobranca = await prismaBase.cobranca.findUnique({
      where: { idExterno: id },
      include: { associado: { select: { nome: true, cpfCnpj: true, franquiaId: true } } },
    });

    if (!cobranca) {
      console.log('  ⚠️  Nenhuma Cobranca local com este id_externo — pulando.');
      naoAplicaveis.push({ id, motivo: 'sem_cobranca_local' });
      continue;
    }

    console.log(
      `  Cobranca local: id=${cobranca.id}  associado="${cobranca.associado?.nome ?? '?'}"  status=${cobranca.status}  valor=${formatarBRL(cobranca.valor)}`
    );

    if (!['pending', 'overdue'].includes(cobranca.status)) {
      console.log(`  ⚠️  Status atual "${cobranca.status}" não é pending/overdue — nada a corrigir aqui, pulando.`);
      naoAplicaveis.push({ id, motivo: `status_atual_${cobranca.status}` });
      continue;
    }

    if (!cobranca.associado?.franquiaId) {
      console.log('  ⚠️  Cobranca sem franquiaId resolvível — pulando.');
      naoAplicaveis.push({ id, motivo: 'sem_franquia' });
      continue;
    }

    const confirmacao = await confirmarRemocaoViaAsaas(id, cobranca.associado.franquiaId);
    console.log(`  → Asaas: ${confirmacao.classificacao}${confirmacao.statusAsaas ? ` (status: ${confirmacao.statusAsaas})` : ''}${confirmacao.erro ? ` (${confirmacao.erro})` : ''}`);

    if (confirmacao.classificacao === 'removida_confirmada') {
      candidatasConfirmadas.push({ cobranca, id });
    } else {
      naoAplicaveis.push({ id, motivo: confirmacao.classificacao });
    }
  }

  console.log(`\n=== Resumo ===`);
  console.log(`  Confirmadas como removidas no Asaas (candidatas a "removida"): ${candidatasConfirmadas.length}`);
  console.log(`  Não aplicáveis (sem cobrança local, já quitada/removida, não confirmada, ou erro): ${naoAplicaveis.length}`);
  if (naoAplicaveis.length > 0) {
    for (const item of naoAplicaveis) console.log(`    - ${item.id}: ${item.motivo}`);
  }

  if (candidatasConfirmadas.length === 0) {
    console.log('\nNenhuma candidata confirmada — nada a aplicar.');
    return;
  }

  const valorTotal = candidatasConfirmadas.reduce((soma, { cobranca }) => soma + Number(cobranca.valor), 0);
  console.log(`\n${candidatasConfirmadas.length} cobrança(s), totalizando ${formatarBRL(valorTotal)}, seria(m) marcada(s) como "removida":`);
  for (const { cobranca, id } of candidatasConfirmadas) {
    console.log(`  - ${cobranca.associado?.nome ?? '?'}  id_externo=${id}  valor=${formatarBRL(cobranca.valor)}`);
  }

  if (!confirm) {
    console.log('\nDRY RUN — nada foi alterado. Rode de novo com --confirm para aplicar.');
    return;
  }

  if (candidatasConfirmadas.length > LIMITE_SEGURANCA) {
    console.error(
      `\n⚠️  ${candidatasConfirmadas.length} candidata(s) confirmada(s) — acima do limite de segurança (${LIMITE_SEGURANCA}) ` +
        'para este script pontual. Recusando aplicar por segurança — revise a lista acima antes de prosseguir (sem --force: ' +
        'se apareceram mais de 20, algo mudou desde a investigação original e merece uma segunda checagem manual, não uma flag pra ignorar).'
    );
    process.exitCode = 1;
    return;
  }

  let aplicadas = 0;
  for (const { cobranca } of candidatasConfirmadas) {
    if (await aplicarRemocao(cobranca.id)) aplicadas += 1;
  }
  console.log(`\n✓ ${aplicadas} cobrança(s) marcada(s) como "removida".`);
  if (aplicadas < candidatasConfirmadas.length) {
    console.log(
      `⚠️  ${candidatasConfirmadas.length - aplicadas} não foram aplicadas (status mudou entre a leitura e a escrita — ` +
        're-rode o script pra ver o estado atual).'
    );
  }
}

main()
  .catch((err) => {
    console.error('Erro fatal ao rodar a correção pontual:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaBase.$disconnect();
  });
