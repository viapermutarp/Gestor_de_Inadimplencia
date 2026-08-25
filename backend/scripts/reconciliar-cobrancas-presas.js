/**
 * Correção pontual (uma vez só) para o bug de reconciliação de POST /api/sync
 * corrigido nesta mesma versão (ver README, seção "Reconciliação (quitação
 * automática)"): antes do fix, uma cobrança paga no Asaas simplesmente
 * parava de aparecer nos próximos payloads do n8n — e como o sync só fazia
 * upsert (nunca removia nada), ela ficava "presa" no banco para sempre no
 * último status pending/overdue sincronizado, contando indevidamente como
 * "em aberto" no Dashboard.
 *
 * Este script varre a tabela `cobrancas` e marca como "quitada" (mesmo
 * status/campo que o fix novo usa em produção dali em diante) qualquer
 * cobrança pending/overdue cujo `sincronizado_em` esteja visivelmente
 * desatualizado em relação ao resto da base — exatamente o sintoma descrito
 * no bug report (~17 associados com `sincronizado_em` travado em 20/08/2026
 * enquanto o resto já estava em 25/08/2026).
 *
 * IMPORTANTE — leia antes de rodar:
 *   - Depois que o fix desta versão estiver em produção, a PRÓXIMA execução
 *     normal de POST /api/sync (seja pelo agendamento do n8n, seja clicando
 *     em "Atualizar" no Dashboard) já reconcilia essas cobranças presas
 *     automaticamente — este script só existe para quem quiser corrigir
 *     AGORA, sem esperar/disparar um sync completo.
 *   - Roda em modo DRY RUN por padrão — só lista os candidatos, não muda
 *     nada no banco. Passe --confirm para aplicar de verdade.
 *   - Não é hard delete: as cobranças continuam no banco, só mudam de
 *     status (mesmo comportamento do fix em POST /api/sync).
 *   - Confira a lista impressa contra o que você já validou manualmente na
 *     API do Asaas antes de rodar com --confirm.
 *
 * Uso (dentro do container/ambiente com DATABASE_URL apontando pro banco
 * certo):
 *   node scripts/reconciliar-cobrancas-presas.js                  # dry run
 *   node scripts/reconciliar-cobrancas-presas.js --confirm        # aplica
 *   node scripts/reconciliar-cobrancas-presas.js --cutoff=2026-08-21 --confirm
 *   node scripts/reconciliar-cobrancas-presas.js --confirm --force  # ver abaixo
 *
 * --cutoff=YYYY-MM-DD (opcional): considera "presa" toda cobrança
 *   pending/overdue com sincronizado_em ANTES dessa data. Sem essa opção, o
 *   script calcula um cutoff automático = a data (sem hora) do
 *   sincronizado_em mais recente encontrado na tabela inteira (ou seja,
 *   "hoje" na prática) — pega qualquer cobrança sincronizada num dia
 *   anterior a esse.
 *
 * --force (opcional): por segurança, o script recusa aplicar (--confirm)
 *   se o número de candidatos for muito maior que o esperado (> 60, bem
 *   acima dos ~17 relatados) — pode ser sinal de um cutoff errado pegando
 *   cobranças que não deveriam. Use --force pra aplicar mesmo assim, só se
 *   você já revisou a lista impressa e tem certeza.
 */
const { PrismaClient } = require('@prisma/client');

const LIMITE_SEGURANCA_SEM_FORCE = 60;

function parseArgs(argv) {
  const confirm = argv.includes('--confirm');
  const force = argv.includes('--force');
  const cutoffArg = argv.find((a) => a.startsWith('--cutoff='));
  const cutoff = cutoffArg ? cutoffArg.slice('--cutoff='.length) : null;
  return { confirm, force, cutoff };
}

async function main() {
  const { confirm, force, cutoff } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    let cutoffDate;
    if (cutoff) {
      cutoffDate = new Date(`${cutoff}T00:00:00.000Z`);
      if (Number.isNaN(cutoffDate.getTime())) {
        console.error(`--cutoff inválido: "${cutoff}" (use o formato YYYY-MM-DD).`);
        process.exitCode = 1;
        return;
      }
    } else {
      const [{ max_sincronizado_em: maxSincronizadoEm } = {}] = await prisma.$queryRaw`
        SELECT MAX(sincronizado_em) AS max_sincronizado_em FROM cobrancas
      `;
      if (!maxSincronizadoEm) {
        console.log('Tabela "cobrancas" está vazia — nada a reconciliar.');
        return;
      }
      const dataMaisRecente = new Date(maxSincronizadoEm);
      cutoffDate = new Date(
        Date.UTC(dataMaisRecente.getUTCFullYear(), dataMaisRecente.getUTCMonth(), dataMaisRecente.getUTCDate())
      );
      console.log(
        `--cutoff não informado — calculado automaticamente como ${cutoffDate.toISOString().slice(0, 10)} ` +
          `(data do sincronizado_em mais recente encontrado na base).`
      );
    }

    console.log(`\nBuscando cobranças pending/overdue com sincronizado_em ANTES de ${cutoffDate.toISOString().slice(0, 10)}...\n`);

    const candidatos = await prisma.cobranca.findMany({
      where: {
        status: { in: ['pending', 'overdue'] },
        sincronizadoEm: { lt: cutoffDate },
      },
      include: { associado: { select: { nome: true, cpfCnpj: true } } },
      orderBy: [{ associado: { nome: 'asc' } }, { vencimento: 'asc' }],
    });

    if (candidatos.length === 0) {
      console.log('Nenhuma cobrança "presa" encontrada com esse cutoff — nada a fazer.');
      return;
    }

    console.log(`Encontradas ${candidatos.length} cobranças candidatas a "quitada":\n`);
    console.log(
      'associado'.padEnd(28) +
        'cpf_cnpj'.padEnd(20) +
        'id_externo'.padEnd(22) +
        'descricao'.padEnd(28) +
        'valor'.padEnd(12) +
        'status'.padEnd(10) +
        'sincronizado_em'
    );
    for (const c of candidatos) {
      console.log(
        (c.associado?.nome ?? '?').slice(0, 26).padEnd(28) +
          (c.associado?.cpfCnpj ?? '?').padEnd(20) +
          (c.idExterno ?? '(sem id_externo)').padEnd(22) +
          (c.descricao ?? '').slice(0, 26).padEnd(28) +
          `R$ ${Number(c.valor).toFixed(2)}`.padEnd(12) +
          c.status.padEnd(10) +
          c.sincronizadoEm.toISOString()
      );
    }

    const associadosUnicos = new Set(candidatos.map((c) => c.associado?.cpfCnpj));
    console.log(`\n${candidatos.length} cobranças, de ${associadosUnicos.size} associados distintos.`);

    if (!confirm) {
      console.log('\nDRY RUN — nada foi alterado no banco. Rode de novo com --confirm para aplicar.');
      return;
    }

    if (candidatos.length > LIMITE_SEGURANCA_SEM_FORCE && !force) {
      console.error(
        `\n⚠️  ${candidatos.length} candidatos é bem mais que o esperado (~17 relatados no bug). ` +
          `Recusando aplicar por segurança — revise a lista acima e, se estiver correta, rode de novo com --confirm --force.`
      );
      process.exitCode = 1;
      return;
    }

    const ids = candidatos.map((c) => c.id);
    const resultado = await prisma.cobranca.updateMany({
      where: { id: { in: ids } },
      data: { status: 'quitada', quitadaEm: new Date() },
    });

    console.log(`\n✓ ${resultado.count} cobranças marcadas como "quitada" (quitada_em = agora).`);
    console.log('Nenhum registro foi apagado — só mudou de status. Confira no Dashboard.');
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Erro ao rodar a reconciliação pontual:', err);
  process.exit(1);
});
