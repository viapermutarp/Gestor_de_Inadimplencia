/**
 * Diagnóstico pontual (setembro/2026) — confirma, DIRETO na API do Asaas,
 * se as cobranças "sem correspondência em pagamentos_asaas" (ver
 * `scripts/diagnostico-cobrancas-presas-sistemico.js`, seção
 * "semCorrespondencia") foram de fato REMOVIDAS lá, ou se nunca existiram /
 * ainda existem sob outro status.
 *
 * CONTEXTO: quando o Asaas apaga uma cobrança (evento `PAYMENT_DELETED`), a
 * linha correspondente é REMOVIDA por inteiro de `pagamentos_asaas`
 * (`excluirPagamento`, `src/services/pagamentosAsaas.service.js`) — não
 * sobra nenhum status local "deletado" pra comparar. Então uma `Cobranca`
 * local pending/overdue cujo `id_externo` não bate com NADA em
 * `pagamentos_asaas` é AMBÍGUA por comparação só local: pode ter sido
 * apagada no Asaas (hipótese de trabalho pros 9 casos confirmados em
 * produção — a maioria por renegociação, segundo o relato), pode ser uma
 * cobrança recente que ainda não foi replicada pelo webhook/backfill, ou
 * pode ser outra causa qualquer. Este script tira a dúvida consultando a
 * fonte de verdade diretamente: `GET /v3/payments/{id}` no Asaas
 * (`buscarPagamentoPorId`, `src/services/asaas.service.js`), com o token
 * DA FRANQUIA certa — resolvida via o associado dono da `Cobranca` local
 * (cada id pode pertencer a uma franquia diferente; a chave certa nunca é
 * assumida, sempre resolvida pelo banco antes de qualquer chamada).
 *
 * SÓ LEITURA — nenhuma escrita no banco nem no Asaas. Serve de insumo pra
 * decidir a implementação da PARTE 2 (novo status "removida" em
 * `cobrancas`) — aqui só confirma (ou refuta) a hipótese pra cada id, não
 * aplica nada.
 *
 * Uso:
 *   node scripts/diagnostico-cobrancas-removidas-asaas.js
 *   node scripts/diagnostico-cobrancas-removidas-asaas.js --ids=pay_a,pay_b
 *
 * --ids (opcional): lista separada por vírgula de id_externo do Asaas
 *   ("pay_..."). Sem essa flag, usa os 9 ids já reportados em produção como
 *   "sem correspondência em pagamentos_asaas" — mantidos aqui como default
 *   só pra não precisar redigitar toda vez; qualquer lista de ids pode ser
 *   passada (reaproveitável pra qualquer investigação futura do mesmo
 *   tipo, não só estes 9).
 */
const prismaBase = require('../src/config/prisma');
const { buscarPagamentoPorId, AsaasApiError } = require('../src/services/asaas.service');

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
  const args = { ids: IDS_PADRAO };
  for (const a of argv) {
    if (a.startsWith('--ids=')) {
      const lista = a
        .slice('--ids='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      if (lista.length > 0) args.ids = lista;
    }
  }
  return args;
}

function formatarBRL(valor) {
  if (valor === null || valor === undefined) return '(null)';
  return `R$ ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtData(d) {
  if (!d) return '(null)';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toISOString().slice(0, 10);
}

async function main() {
  const { ids } = parseArgs(process.argv.slice(2));
  console.log(`\n=== Confirmação direto no Asaas — ${ids.length} id(s) ===`);
  console.log('Só leitura — nenhuma escrita no banco nem no Asaas.\n');

  const resumo = {
    removidasConfirmadas: 0,
    existemSemFlagDeleted: 0,
    naoEncontradas404: 0,
    semCobrancaLocal: 0,
    erros: 0,
  };
  const detalhes = [];

  for (const id of ids) {
    console.log(`--- ${id} ---`);

    const cobranca = await prismaBase.cobranca.findUnique({
      where: { idExterno: id },
      include: { associado: { select: { nome: true, cpfCnpj: true, franquiaId: true } } },
    });

    if (!cobranca) {
      resumo.semCobrancaLocal += 1;
      console.log('  ⚠️  Nenhuma Cobranca local com este id_externo — não dá pra resolver a franquia/token certo, pulando a consulta ao Asaas.');
      detalhes.push({ id, veredito: 'sem_cobranca_local' });
      continue;
    }

    console.log(
      `  Cobranca local: id=${cobranca.id}  associado="${cobranca.associado?.nome ?? '?'}"  cpf_cnpj=${cobranca.associado?.cpfCnpj ?? '?'}  ` +
        `franquiaId=${cobranca.associado?.franquiaId ?? '?'}  status=${cobranca.status}  valor=${formatarBRL(cobranca.valor)}  ` +
        `vencimento=${fmtData(cobranca.vencimento)}  descricao="${cobranca.descricao || ''}"`
    );

    if (!cobranca.associado?.franquiaId) {
      resumo.erros += 1;
      console.log('  ⚠️  Cobranca sem franquiaId resolvível (associado ausente?) — pulando.');
      detalhes.push({ id, veredito: 'erro_sem_franquia' });
      continue;
    }

    try {
      const resultado = await buscarPagamentoPorId(id, cobranca.associado.franquiaId);

      if (!resultado.existe) {
        resumo.naoEncontradas404 += 1;
        console.log(
          '  → Asaas: 404 — este id NUNCA existiu (ou não pertence) nesta conta/franquia. ' +
            'NÃO é o caso "apagada depois de existir" — vale investigar à parte (id trocado? franquia errada?).'
        );
        detalhes.push({ id, veredito: '404_nao_encontrada' });
        continue;
      }

      const p = resultado.pagamento;
      console.log(
        `  → Asaas: existe=true  deleted=${resultado.deletado}  status=${p.status}  value=${formatarBRL(p.value)}  ` +
          `dueDate=${p.dueDate}  customer=${p.customer}  description="${p.description || ''}"`
      );

      if (resultado.deletado) {
        resumo.removidasConfirmadas += 1;
        console.log('  ✓ CONFIRMADO: removida no Asaas (deleted=true).');
        detalhes.push({ id, veredito: 'removida_confirmada', statusAsaas: p.status });
      } else {
        resumo.existemSemFlagDeleted += 1;
        console.log(
          `  ⚠️  Existe no Asaas e NÃO está marcada como deletada (status atual: ${p.status}) — NÃO é o caso "apagada"; ` +
            'vale investigar por que pagamentos_asaas não tem essa linha (webhook perdido? backfill nunca cobriu este período?).'
        );
        detalhes.push({ id, veredito: 'existe_nao_deletada', statusAsaas: p.status });
      }
    } catch (err) {
      resumo.erros += 1;
      console.log(`  ✗ Erro ao consultar o Asaas: ${err.message}`);
      detalhes.push({ id, veredito: 'erro_consulta', erro: err.message });
    }
  }

  console.log('\n=== Resumo ===');
  console.log(`  Removidas confirmadas (deleted=true no Asaas): ${resumo.removidasConfirmadas}`);
  console.log(`  Existem no Asaas, NÃO deletadas (outra causa, não "apagada"): ${resumo.existemSemFlagDeleted}`);
  console.log(`  Não encontradas no Asaas (404 — nunca existiram nesta conta): ${resumo.naoEncontradas404}`);
  console.log(`  Sem Cobranca local correspondente (id_externo não bate com nada): ${resumo.semCobrancaLocal}`);
  console.log(`  Erros de consulta: ${resumo.erros}`);

  if (resumo.removidasConfirmadas === ids.length) {
    console.log('\n  → TODAS confirmadas como removidas no Asaas — hipótese de trabalho totalmente confirmada.');
  } else if (resumo.removidasConfirmadas > 0) {
    console.log('\n  → PARTE confirmada como removida — vale olhar caso a caso os outros vereditos acima antes de implementar a correção.');
  } else {
    console.log('\n  → NENHUMA confirmada como removida — a hipótese de trabalho NÃO se sustenta pelos ids consultados; investigar de novo antes de prosseguir.');
  }

  console.log('\nDetalhe estruturado (pra copiar/colar em outro lugar, se precisar):');
  console.log(JSON.stringify(detalhes, null, 2));
}

main()
  .catch((err) => {
    console.error('Erro fatal ao rodar o diagnóstico:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaBase.$disconnect();
  });
