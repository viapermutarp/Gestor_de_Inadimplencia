/**
 * Diagnóstico pontual (só leitura, NÃO corrige nada) — investiga por que um
 * associado que já quitou a dívida no Asaas continua aparecendo no
 * Dashboard com dias de atraso e valor em aberto congelados (caso relatado:
 * Marcela, CPF 27649948000129, "53d de atraso", sem efeito ao clicar
 * "Atualizar" ou reiniciar o servidor).
 *
 * CONTEXTO (achado de leitura de código, antes deste script existir):
 *   O Dashboard (frontend/app/dashboard/page.js, via GET /api/associados e
 *   GET /api/associados/resumo) lê da tabela `cobrancas` — alimentada pelo
 *   sync ANTIGO via n8n (POST /api/sync), NÃO pela `pagamentos_asaas`
 *   (webhook/backfill direto do Asaas, AJUSTE 14, usada pela tela "Taxa de
 *   Inadimplência"). São dois pipelines independentes, sem FK entre si — só
 *   cruzam por cpf_cnpj em tempo de consulta.
 *
 *   POST /api/sync JÁ implementa reconciliação por omissão (ver docblock de
 *   exports.sync em src/controllers/sync.controller.js) — não é um
 *   upsert-only. Dois modos:
 *     - "por_associado" (sem "janela" no corpo do payload): só reconcilia
 *       cobranças de associados que AINDA aparecem no payload — se o
 *       associado inteiro sumir (todas as cobranças dele pagas), nunca é
 *       examinado.
 *     - "global" (com "janela": {inicio, fim} no corpo): reconcilia a base
 *       inteira numa passada, cobrindo o caso acima — MAS só toca cobranças
 *       cujo `vencimento` caia DENTRO da janela informada. Cobranças com
 *       vencimento fora da janela nunca são tocadas por essa chamada.
 *
 *   O rótulo "Nd de atraso" exibido no Dashboard (frontend/lib/atraso.js,
 *   getPiorDiasDiferenca) é o campo `Cobranca.diasDiferenca` GRAVADO da
 *   última vez que aquela linha foi sincronizada — não é recalculado ao
 *   vivo a partir da data de hoje. Por isso "Atualizar" (que só dispara o
 *   mesmo pipeline de sync) e reiniciar o servidor não têm efeito nenhum
 *   se a cobrança específica não for tocada por nenhum sync.
 *
 * O QUE ESTE SCRIPT FAZ (nesta ordem, tudo somente leitura):
 *   1. Resolve o associado por cpf_cnpj (busca SEM escopo de franquia,
 *      já que cpf_cnpj é único globalmente — descobre a franquia sozinho).
 *   2. Lista as linhas dele em pagamentos_asaas (deveria mostrar
 *      RECEIVED/RECEIVED_IN_CASH se a dívida foi mesmo quitada no Asaas).
 *   3. Lista a(s) linha(s) dele em `cobrancas` — os campos exatos que
 *      alimentam o Dashboard, incluindo o `dias_diferenca` congelado.
 *   4. Checagem de "desatualização": compara `sincronizado_em` da linha dele
 *      com o mais recente `sincronizado_em` já visto na franquia inteira —
 *      mesma heurística usada por scripts/reconciliar-cobrancas-presas.js.
 *   5. Checagem de "envelhecimento de janela" (hipótese principal): calcula
 *      a janela -53/+5 dias de HOJE e reporta se o `vencimento` da cobrança
 *      dele cai dentro ou fora dela — se estiver fora, nenhuma reconciliação
 *      "global" (mesmo funcionando perfeitamente) alcançaria essa linha,
 *      porque o Asaas não seria nem consultado sobre esse intervalo.
 *   6. Últimos registros de sync_log da franquia (cadência/saúde do sync —
 *      não revela qual modo rodou, a tabela não guarda isso).
 *   7. Varredura sistêmica: associados da(s) franquia(s) verificada(s) com
 *      cobrança pending/overdue aberta em `cobrancas` MAS cujas linhas em
 *      pagamentos_asaas (quando existem) estão TODAS RECEIVED/RECEIVED_IN_CASH
 *      — candidatos a "outra Marcela". Reporta separadamente quem não tem
 *      nenhuma linha em pagamentos_asaas pra cruzar (não dá pra concluir
 *      nada sobre esses só com esse cruzamento).
 *
 * O QUE ESTE SCRIPT NÃO FAZ: não muda nada no banco, não decide se algo
 * deve ser marcado como quitado. scripts/reconciliar-cobrancas-presas.js já
 * existe pra isso (dry-run por padrão, --confirm pra aplicar) — mencionado
 * aqui só como segundo ponto de triangulação (mesma heurística de
 * desatualização), não como correção a aplicar agora.
 *
 * Uso:
 *   node scripts/diagnostico-marcela-cobranca-presa.js
 *   node scripts/diagnostico-marcela-cobranca-presa.js --cpf=27649948000129
 *   node scripts/diagnostico-marcela-cobranca-presa.js --cpf=... --limite-scan=50
 *   node scripts/diagnostico-marcela-cobranca-presa.js --cpf=... --todas-franquias
 *
 * --cpf (opcional, default 27649948000129): cpf_cnpj a investigar (só
 *   dígitos ou formatado — casa como veio gravado, sem normalizar, porque
 *   o objetivo aqui é ver exatamente o que está no banco).
 * --limite-scan (opcional, default 40): quantas linhas de exemplo imprimir
 *   na varredura sistêmica (item 7) — a CONTAGEM sempre cobre a franquia
 *   inteira, o limite é só pra não afogar o console.
 * --todas-franquias (opcional): roda a varredura sistêmica (item 7) em
 *   TODAS as franquias, não só na do associado investigado.
 */
const { criarPrismaEscopado } = require('../src/config/prismaComEscopo');
const prismaBase = require('../src/config/prisma');

const STATUS_ADIMPLENTE_ASAAS = ['RECEIVED', 'RECEIVED_IN_CASH'];
const STATUS_CONSIDERADOS_ABERTOS = ['pending', 'overdue'];
const JANELA_DIAS_TRAS = 53;
const JANELA_DIAS_FRENTE = 5;

function parseArgs(argv) {
  const args = {
    cpf: '27649948000129',
    limiteScan: 40,
    todasFranquias: false,
  };
  for (const a of argv) {
    if (a.startsWith('--cpf=')) args.cpf = a.slice('--cpf='.length);
    else if (a.startsWith('--limite-scan=')) args.limiteScan = Number(a.slice('--limite-scan='.length)) || 40;
    else if (a === '--todas-franquias') args.todasFranquias = true;
  }
  return args;
}

function formatarBRL(valor) {
  return `R$ ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtData(d) {
  if (!d) return '(null)';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toISOString().slice(0, 10);
}

function fmtDataHora(d) {
  if (!d) return '(null)';
  const dt = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return dt.toISOString();
}

function diasEntre(a, b) {
  return Math.round((a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

/** Meia-noite UTC de hoje, pra comparação de datas "puras" (Cobranca.vencimento é @db.Date). */
function hojeUTC() {
  const agora = new Date();
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  console.log(`\n=== Diagnóstico: cobrança presa após pagamento — cpf_cnpj=${args.cpf} ===\n`);

  // --- 1. Resolve o associado (sem escopo — cpf_cnpj é único globalmente) ---
  const associado = await prismaBase.associado.findUnique({
    where: { cpfCnpj: args.cpf },
  });

  if (!associado) {
    console.log(`Nenhum associado encontrado com cpf_cnpj="${args.cpf}" na tabela "associados".`);
    console.log('Confira se o valor está gravado com pontuação/formatação diferente (ex.: só dígitos vs. com máscara).');
    await prismaBase.$disconnect();
    return;
  }

  console.log(`Associado: ${associado.nome}  (id=${associado.id}, franquiaId=${associado.franquiaId})`);
  console.log(`  nomeAsaas: ${associado.nomeAsaas ?? '(null)'}`);
  console.log(`  bloqueado: ${associado.bloqueado}  em_juridico: ${associado.emJuridico}  em_negociacao: ${associado.emNegociacao}`);

  const prisma = criarPrismaEscopado(associado.franquiaId);

  // --- 2. pagamentos_asaas (fonte "de verdade" segundo o Asaas) ---
  console.log('\n--- pagamentos_asaas (pipeline novo, AJUSTE 14) ---');
  const pagamentosAsaas = await prismaBase.pagamentoAsaas.findMany({
    where: { cpfCnpj: args.cpf },
    orderBy: { dueDate: 'asc' },
  });

  if (pagamentosAsaas.length === 0) {
    console.log('  Nenhuma linha encontrada em pagamentos_asaas para este cpf_cnpj.');
    console.log('  (Pode ser que este associado nunca tenha passado pelo backfill/webhook novo — ver AJUSTE 9 no README.)');
  } else {
    for (const p of pagamentosAsaas) {
      const quitado = STATUS_ADIMPLENTE_ASAAS.includes(p.status);
      console.log(
        `  id=${p.id}  status=${p.status}${quitado ? ' (quitado)' : ' (EM ABERTO)'}  value=${formatarBRL(p.value)}  ` +
          `dueDate=${p.dueDate}  paymentDate=${p.paymentDate ?? '(null)'}  descricao="${p.description ?? ''}"`
      );
    }
    const algumEmAberto = pagamentosAsaas.some((p) => !STATUS_ADIMPLENTE_ASAAS.includes(p.status));
    console.log(
      algumEmAberto
        ? '\n  >>> ATENÇÃO: pelo menos uma linha em pagamentos_asaas NÃO está RECEIVED/RECEIVED_IN_CASH — a dívida pode não estar realmente quitada, ou há mais de uma cobrança e só parte foi paga.'
        : '\n  >>> Todas as linhas em pagamentos_asaas estão RECEIVED/RECEIVED_IN_CASH — confirma que, do lado do Asaas, a dívida está quitada.'
    );
  }

  // --- 3. cobrancas (pipeline antigo via n8n — o que alimenta o Dashboard) ---
  console.log('\n--- cobrancas (pipeline antigo via n8n — alimenta o Dashboard) ---');
  const cobrancas = await prisma.cobranca.findMany({
    where: { associadoId: associado.id },
    orderBy: { vencimento: 'asc' },
  });

  if (cobrancas.length === 0) {
    console.log('  Nenhuma linha encontrada em cobrancas para este associado — ele não deveria aparecer no Dashboard como inadimplente por essa via.');
  } else {
    for (const c of cobrancas) {
      const aberta = STATUS_CONSIDERADOS_ABERTOS.includes(c.status);
      console.log(
        `  id=${c.id}  status=${c.status}${aberta ? ' (ABERTA — conta no Dashboard)' : ''}  valor=${formatarBRL(c.valor)}  ` +
          `vencimento=${fmtData(c.vencimento)}  dias_diferenca=${c.diasDiferenca}  id_externo=${c.idExterno ?? '(null)'}`
      );
      console.log(`      sincronizado_em=${fmtDataHora(c.sincronizadoEm)}  quitada_em=${fmtDataHora(c.quitadaEm)}  descricao="${c.descricao ?? ''}"`);
    }
  }

  const cobrancasAbertas = cobrancas.filter((c) => STATUS_CONSIDERADOS_ABERTOS.includes(c.status));

  if (cobrancasAbertas.length === 0) {
    console.log('\n  Nenhuma cobrança aberta (pending/overdue) para este associado em `cobrancas` — ele NÃO deveria estar preso no Dashboard.');
    console.log('  Se ainda está aparecendo, o sintoma pode ter outra causa (cache no frontend, franquia errada, etc.) — vale conferir de novo pela tela.');
    await prismaBase.$disconnect();
    return;
  }

  // --- 4. Checagem de desatualização (mesma heurística de reconciliar-cobrancas-presas.js) ---
  console.log('\n--- Checagem de desatualização (sincronizado_em) ---');
  const [{ max_sincronizado_em: maxSincronizadoEmRaw } = {}] = await prismaBase.$queryRaw`
    SELECT MAX(c.sincronizado_em) AS max_sincronizado_em
    FROM cobrancas c
    JOIN associados a ON a.id = c.associado_id
    WHERE a.franquia_id = ${associado.franquiaId}
  `;
  const maxSincronizadoEm = maxSincronizadoEmRaw ? new Date(maxSincronizadoEmRaw) : null;

  if (!maxSincronizadoEm) {
    console.log('  Não há nenhuma cobrança sincronizada na franquia (inesperado, dado que este associado tem cobrança) — pulando esta checagem.');
  } else {
    console.log(`  sincronizado_em mais recente visto na franquia inteira: ${fmtDataHora(maxSincronizadoEm)}`);
    for (const c of cobrancasAbertas) {
      const gapDias = diasEntre(maxSincronizadoEm, c.sincronizadoEm);
      console.log(
        `  cobranca id=${c.id}: sincronizado_em=${fmtDataHora(c.sincronizadoEm)}  ` +
          `(${gapDias} dia(s) atrás do sync mais recente da franquia)` +
          (gapDias > 0 ? '  >>> DESATUALIZADA — não foi tocada pelos syncs mais recentes' : '  (em dia)')
      );
    }
  }

  // --- 5. Checagem de envelhecimento de janela (hipótese principal) ---
  console.log(`\n--- Checagem de envelhecimento de janela (-${JANELA_DIAS_TRAS}/+${JANELA_DIAS_FRENTE} dias de hoje) ---`);
  const hoje = hojeUTC();
  const janelaInicio = new Date(hoje);
  janelaInicio.setUTCDate(janelaInicio.getUTCDate() - JANELA_DIAS_TRAS);
  const janelaFim = new Date(hoje);
  janelaFim.setUTCDate(janelaFim.getUTCDate() + JANELA_DIAS_FRENTE);

  console.log(`  Hoje: ${fmtData(hoje)}  →  janela hipotética de hoje: [${fmtData(janelaInicio)} .. ${fmtData(janelaFim)}]`);
  console.log('  (Esta é a janela que o payload mais recente do n8n TERIA, calculada da mesma forma "-53/+5 dias de hoje" — não temos acesso ao payload real enviado, ver observação no relatório.)\n');

  for (const c of cobrancasAbertas) {
    const vencimento = new Date(c.vencimento);
    const dentroDaJanela = vencimento >= janelaInicio && vencimento <= janelaFim;
    const diasAntesDoInicioDaJanela = diasEntre(janelaInicio, vencimento);
    console.log(
      `  cobranca id=${c.id}: vencimento=${fmtData(vencimento)}  dias_diferenca_gravado=${c.diasDiferenca}  ` +
        `→ ${dentroDaJanela ? 'DENTRO da janela de hoje (uma reconciliação global rodada hoje alcançaria esta linha)' : 'FORA da janela de hoje'}`
    );
    if (!dentroDaJanela && vencimento < janelaInicio) {
      console.log(
        `      vencimento está ${Math.abs(diasAntesDoInicioDaJanela)} dia(s) ANTES do início da janela de hoje — ` +
          'se isso já era verdade nos últimos syncs também, nenhuma reconciliação "global" (mesmo funcionando perfeitamente) teria alcançado esta linha, ' +
          'porque o Asaas nunca foi consultado sobre esse intervalo de vencimento.'
      );
    }
  }

  // --- 6. sync_log recente da franquia ---
  console.log('\n--- Últimos registros de sync_log da franquia ---');
  const syncLogs = await prisma.syncLog.findMany({
    orderBy: { executadoEm: 'desc' },
    take: 10,
  });
  if (syncLogs.length === 0) {
    console.log('  Nenhum registro de sync_log para esta franquia.');
  } else {
    for (const s of syncLogs) {
      console.log(
        `  executadoEm=${fmtDataHora(s.executadoEm)}  totalAssociadosProcessados=${s.totalAssociadosProcessados}  sucesso=${s.sucesso}`
      );
    }
    console.log('  (sync_log NÃO registra qual modo de reconciliação rodou — "por_associado" ou "global" — só o campo de resposta HTTP do sync mostra isso, não persistido.)');
  }

  // --- 7. Varredura sistêmica: outros associados no mesmo padrão ---
  console.log('\n--- Varredura sistêmica: outros associados presos no mesmo padrão ---');
  const franquiaIdsParaScan = args.todasFranquias ? null : [associado.franquiaId];

  const cobrancasAbertasTodas = await prismaBase.cobranca.findMany({
    where: {
      status: { in: STATUS_CONSIDERADOS_ABERTOS },
      ...(franquiaIdsParaScan ? { associado: { franquiaId: { in: franquiaIdsParaScan } } } : {}),
    },
    include: { associado: { select: { id: true, nome: true, cpfCnpj: true, franquiaId: true } } },
  });

  // Agrupa por associado (um associado pode ter N cobranças abertas)
  const porAssociado = new Map();
  for (const c of cobrancasAbertasTodas) {
    if (!c.associado) continue;
    if (!porAssociado.has(c.associado.id)) porAssociado.set(c.associado.id, { associado: c.associado, cobrancas: [] });
    porAssociado.get(c.associado.id).cobrancas.push(c);
  }

  console.log(`  ${porAssociado.size} associado(s) com cobrança pending/overdue aberta em \`cobrancas\` (${franquiaIdsParaScan ? 'franquia do associado investigado' : 'todas as franquias'}).`);

  const candidatosPresos = [];
  const semDadosParaCruzar = [];

  for (const { associado: a, cobrancas: cs } of porAssociado.values()) {
    const pagAsaas = await prismaBase.pagamentoAsaas.findMany({
      where: { cpfCnpj: a.cpfCnpj },
      select: { status: true },
    });
    if (pagAsaas.length === 0) {
      semDadosParaCruzar.push({ associado: a, cobrancas: cs });
      continue;
    }
    const todasQuitadas = pagAsaas.every((p) => STATUS_ADIMPLENTE_ASAAS.includes(p.status));
    if (todasQuitadas) {
      candidatosPresos.push({ associado: a, cobrancas: cs, totalPagamentosAsaas: pagAsaas.length });
    }
  }

  console.log(
    `\n  >>> ${candidatosPresos.length} associado(s) têm cobrança ABERTA em \`cobrancas\` mas TODAS as linhas correspondentes em ` +
      `pagamentos_asaas estão RECEIVED/RECEIVED_IN_CASH — candidatos a "presos" no mesmo padrão da Marcela:\n`
  );
  const paraImprimir = candidatosPresos.slice(0, args.limiteScan);
  for (const { associado: a, cobrancas: cs } of paraImprimir) {
    const valorAberto = cs.reduce((soma, c) => soma + Number(c.valor), 0);
    console.log(
      `    ${a.nome}  cpf_cnpj=${a.cpfCnpj}  franquiaId=${a.franquiaId}  ` +
        `${cs.length} cobrança(s) aberta(s), total ${formatarBRL(valorAberto)}  pior dias_diferenca=${Math.min(...cs.map((c) => c.diasDiferenca))}`
    );
  }
  if (candidatosPresos.length > args.limiteScan) {
    console.log(`    ... e mais ${candidatosPresos.length - args.limiteScan} (aumente --limite-scan pra ver todos).`);
  }

  console.log(
    `\n  (${semDadosParaCruzar.length} associado(s) com cobrança aberta em \`cobrancas\` não têm NENHUMA linha em pagamentos_asaas ` +
      '— não é possível concluir nada sobre eles por este cruzamento; podem genuinamente estar em aberto, ou nunca ter passado pelo backfill/webhook novo.)'
  );

  console.log(
    '\n  Nota: scripts/reconciliar-cobrancas-presas.js já existe e usa uma heurística diferente (só desatualização de sincronizado_em, ' +
      'sem cruzar com pagamentos_asaas) — rodar seu modo dry-run (padrão, sem --confirm) é seguro e serve como segundo ponto de triangulação. ' +
      'Nenhum dos dois scripts deve rodar em modo de escrita (--confirm) até a correção ser combinada.'
  );

  console.log('\n=== Fim do diagnóstico — nenhuma alteração foi feita no banco. ===\n');
  await prismaBase.$disconnect();
}

main().catch(async (err) => {
  console.error('Erro ao rodar o diagnóstico:', err);
  await prismaBase.$disconnect();
  process.exit(1);
});
