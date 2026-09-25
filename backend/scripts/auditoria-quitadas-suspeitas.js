/**
 * ETAPA A (AJUSTE 22) — auditoria só leitura: mede quanto do que o sistema
 * hoje trata como "quitada" (dinheiro recebido) na tabela `cobrancas` na
 * verdade nunca entrou, porque a cobrança foi APAGADA no Asaas (geralmente
 * por renegociação) e o `updateMany` cego de `POST /api/sync` (antes do
 * AJUSTE 22 — ver docblock de `exports.sync` em sync.controller.js) marcou
 * como "quitada" só por ela ter sumido do payload, sem checar se o
 * pagamento tinha sido de fato recebido.
 *
 * IMPORTANTE — o que este script NÃO mede: o card "Total recebido" da tela
 * "Taxa de Inadimplência" (`GET /api/inadimplencia/resumo`,
 * `resumo.valor_adimplente`) é calculado inteiramente em cima de
 * `pagamentos_asaas.status` (RECEIVED/RECEIVED_IN_CASH) — NUNCA lê
 * `cobrancas.status`. Confirmado lendo `inadimplencia.controller.js` por
 * inteiro: nenhuma linha ali toca a tabela `cobrancas`. Ou seja, esse card
 * específico já está correto e não é afetado por nada abaixo. O que ESTE
 * script mede é o impacto dentro do outro pipeline (Dashboard de
 * associados, Kanban Jurídico, modal "Detalhe do associado" — todos
 * consomem `cobrancas.status`): quanto valor está marcado "quitada" (logo,
 * excluído de "em aberto" em todos esses lugares, como se tivesse sido
 * pago) quando na verdade a cobrança foi removida no Asaas sem nunca ter
 * sido paga.
 *
 * MÉTODO — para cada `Cobranca` com `status = 'quitada'`:
 *   1. Se `pagamentos_asaas` já tem esse `id_externo` como RECEIVED/
 *      RECEIVED_IN_CASH -> está correta (bate com o espelho local
 *      atualizado via webhook em tempo real, AJUSTE 14), NÃO entra na
 *      auditoria — é exatamente o comportamento esperado, maioria
 *      esmagadora dos casos.
 *   2. Senão (ausente ou outro status em `pagamentos_asaas` — suspeita),
 *      consulta a API do Asaas AO VIVO (`buscarPagamentoPorId`, mesma
 *      função do diagnóstico de PARTE 1) e classifica:
 *        - "removida_no_asaas": `deleted: true` -> CONFIRMADO: dinheiro
 *          nunca entrou, marcada "quitada" por engano.
 *        - "paga_de_verdade": existe, não deletada, status atual RECEIVED/
 *          RECEIVED_IN_CASH -> só o espelho local (`pagamentos_asaas`) que
 *          está desatualizado; a cobrança está corretamente "quitada".
 *        - "outro_status_no_asaas": existe, não deletada, mas nenhum status
 *          de pago (ex.: voltou a PENDING/OVERDUE por reversão) -> "quitada"
 *          está ERRADA, mas não pelo motivo "removida" — precisa de
 *          investigação individual à parte (não é o escopo do AJUSTE 22).
 *        - "nao_encontrada_no_asaas": 404 -> nunca existiu nesta conta —
 *          também não é "removida depois de existir"; investigar à parte.
 *        - "erro_consulta": falha ao consultar o Asaas (timeout/5xx/chave
 *          inválida) — sem classificação possível nesta rodada.
 *   3. Sem `id_externo` -> não dá pra confirmar nada -> categoria
 *      "sem_id_externo" separada.
 *
 * SÓ LEITURA — nenhuma escrita no banco nem no Asaas, nenhuma flag
 * --confirm. A decisão de CORRIGIR as cobranças já marcadas "quitada"
 * indevidamente (as "removida_no_asaas" abaixo) fica pra depois, por pedido
 * explícito — este script só mede o tamanho do problema.
 *
 * Uso:
 *   node scripts/auditoria-quitadas-suspeitas.js                  # todas as franquias
 *   node scripts/auditoria-quitadas-suspeitas.js --franquia=<id>  # restrito a uma franquia
 */
const prismaBase = require('../src/config/prisma');
const { STATUS_ADIMPLENTE_ASAAS } = require('../src/services/cobrancasPresas.service');
const { confirmarRemocaoViaAsaas } = require('../src/services/cobrancasRemovidas.service');

function parseArgs(argv) {
  const franquiaArg = argv.find((a) => a.startsWith('--franquia='));
  return { franquiaId: franquiaArg ? franquiaArg.slice('--franquia='.length) : null };
}

function formatarBRL(valor) {
  return `R$ ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtData(d) {
  if (!d) return '(null)';
  const dt = d instanceof Date ? d : new Date(d);
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toISOString().slice(0, 10);
}

async function main() {
  const { franquiaId } = parseArgs(process.argv.slice(2));
  console.log(
    `\n=== ETAPA A — auditoria de "quitada" suspeitas ${franquiaId ? `(franquia ${franquiaId})` : '(todas as franquias)'} ===`
  );
  console.log('Só leitura — nenhuma escrita no banco nem no Asaas, sem --confirm.\n');

  const cobrancasQuitadas = await prismaBase.cobranca.findMany({
    where: { status: 'quitada', ...(franquiaId ? { associado: { franquiaId } } : {}) },
    include: { associado: { select: { nome: true, cpfCnpj: true, franquiaId: true } } },
    orderBy: [{ associado: { nome: 'asc' } }, { quitadaEm: 'asc' }],
  });

  const idsExternos = cobrancasQuitadas.map((c) => c.idExterno).filter(Boolean);
  const pagamentosLocais = idsExternos.length
    ? await prismaBase.pagamentoAsaas.findMany({ where: { id: { in: idsExternos } } })
    : [];
  const pagamentoPorId = new Map(pagamentosLocais.map((p) => [p.id, p]));

  console.log(`${cobrancasQuitadas.length} cobrança(s) "quitada" encontrada(s) no total.\n`);

  // Categoria 0 — bate com pagamentos_asaas local (RECEIVED/RECEIVED_IN_CASH): confirmada, fora da auditoria.
  const confirmadasLocalmente = [];
  const suspeitas = [];
  const semIdExterno = [];

  for (const c of cobrancasQuitadas) {
    if (!c.idExterno) {
      semIdExterno.push(c);
      continue;
    }
    const local = pagamentoPorId.get(c.idExterno);
    if (local && STATUS_ADIMPLENTE_ASAAS.includes(local.status)) {
      confirmadasLocalmente.push(c);
    } else {
      suspeitas.push(c);
    }
  }

  console.log(`  ${confirmadasLocalmente.length} já confirmada(s) localmente (pagamentos_asaas = RECEIVED/RECEIVED_IN_CASH) — fora da auditoria.`);
  console.log(`  ${semIdExterno.length} sem id_externo — não dá pra confirmar, categoria à parte.`);
  console.log(`  ${suspeitas.length} suspeita(s) — sem correspondência RECEIVED local — consultando o Asaas ao vivo...\n`);

  const categorias = {
    removida_no_asaas: [],
    paga_de_verdade: [],
    outro_status_no_asaas: [],
    nao_encontrada_no_asaas: [],
    erro_consulta: [],
  };

  for (const c of suspeitas) {
    const franquiaDaCobranca = c.associado?.franquiaId;
    if (!franquiaDaCobranca) {
      categorias.erro_consulta.push({ cobranca: c, detalhe: 'associado sem franquiaId resolvível' });
      continue;
    }
    const confirmacao = await confirmarRemocaoViaAsaas(c.idExterno, franquiaDaCobranca);
    let categoria;
    if (confirmacao.classificacao === 'removida_confirmada') categoria = 'removida_no_asaas';
    else if (confirmacao.classificacao === 'existe_nao_deletada' && STATUS_ADIMPLENTE_ASAAS.includes(confirmacao.statusAsaas)) categoria = 'paga_de_verdade';
    else if (confirmacao.classificacao === 'existe_nao_deletada') categoria = 'outro_status_no_asaas';
    else if (confirmacao.classificacao === 'nao_encontrada') categoria = 'nao_encontrada_no_asaas';
    else categoria = 'erro_consulta';

    categorias[categoria].push({ cobranca: c, statusAsaas: confirmacao.statusAsaas, erro: confirmacao.erro });

    console.log(
      `  ${c.associado?.nome ?? '?'} (${c.associado?.cpfCnpj ?? '?'})  id_externo=${c.idExterno}  valor=${formatarBRL(c.valor)}  ` +
        `quitada_em=${fmtData(c.quitadaEm)}  → ${categoria}${confirmacao.statusAsaas ? ` (status Asaas: ${confirmacao.statusAsaas})` : ''}${confirmacao.erro ? ` (${confirmacao.erro})` : ''}`
    );
  }

  function somar(lista) {
    return lista.reduce((soma, item) => soma + Number(item.cobranca.valor), 0);
  }

  console.log('\n=== Resumo por categoria (contagem + soma em R$) ===\n');
  console.log(
    `  Confirmadas localmente (RECEIVED em pagamentos_asaas, fora da auditoria): ${confirmadasLocalmente.length}  —  ${formatarBRL(
      confirmadasLocalmente.reduce((s, c) => s + Number(c.valor), 0)
    )}`
  );
  console.log(`  Sem id_externo (não verificável): ${semIdExterno.length}  —  ${formatarBRL(semIdExterno.reduce((s, c) => s + Number(c.valor), 0))}`);
  console.log('');
  console.log(
    `  ⚠️  REMOVIDA NO ASAAS (marcada "quitada" por engano — dinheiro nunca entrou): ${categorias.removida_no_asaas.length}  —  ${formatarBRL(
      somar(categorias.removida_no_asaas)
    )}`
  );
  console.log(`  PAGA DE VERDADE (só o espelho local pagamentos_asaas estava desatualizado): ${categorias.paga_de_verdade.length}  —  ${formatarBRL(somar(categorias.paga_de_verdade))}`);
  console.log(`  Outro status no Asaas (nem paga nem removida — investigar à parte): ${categorias.outro_status_no_asaas.length}  —  ${formatarBRL(somar(categorias.outro_status_no_asaas))}`);
  console.log(`  Não encontrada no Asaas (404 — nunca existiu nesta conta): ${categorias.nao_encontrada_no_asaas.length}  —  ${formatarBRL(somar(categorias.nao_encontrada_no_asaas))}`);
  console.log(`  Erro de consulta: ${categorias.erro_consulta.length}  —  ${formatarBRL(somar(categorias.erro_consulta))}`);

  console.log(
    `\n  → ${categorias.removida_no_asaas.length} cobrança(s), totalizando ${formatarBRL(
      somar(categorias.removida_no_asaas)
    )}, estão marcadas "quitada" hoje mas foram REMOVIDAS no Asaas sem nunca terem sido pagas.`
  );
  console.log(
    '  Isso NÃO afeta o card "Total recebido" da tela de Inadimplência (que usa pagamentos_asaas, não cobrancas) — o impacto é\n' +
      '  no Dashboard/Jurídico/Detalhe do associado, que tratam essas cobranças como "resolvidas" quando na prática nunca foram pagas.\n' +
      '  Nenhuma correção foi aplicada — decisão de corrigir fica pra depois, por pedido explícito.'
  );

  console.log('\nDetalhe estruturado das "removida_no_asaas" (pra copiar/colar, se precisar decidir a correção depois):');
  console.log(
    JSON.stringify(
      categorias.removida_no_asaas.map(({ cobranca: c }) => ({
        cobrancaId: c.id,
        idExterno: c.idExterno,
        associado: c.associado?.nome,
        cpfCnpj: c.associado?.cpfCnpj,
        valor: Number(c.valor),
        quitadaEm: c.quitadaEm,
      })),
      null,
      2
    )
  );
}

main()
  .catch((err) => {
    console.error('Erro fatal ao rodar a auditoria:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaBase.$disconnect();
  });
