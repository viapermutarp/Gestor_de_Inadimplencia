/**
 * Varredura sistêmica (só leitura, NÃO corrige nada) — refinamento da
 * seção 7 de scripts/diagnostico-marcela-cobranca-presa.js.
 *
 * MOTIVO DO REFINAMENTO: o critério anterior ("todas as linhas do
 * associado em pagamentos_asaas estão RECEIVED") é POR ASSOCIADO, não por
 * cobrança — e por isso não pegaria nem a própria Marcela em produção nos
 * casos em que ela tem parcelas de renegociação genuinamente em aberto
 * misturadas com a cobrança velha presa: uma linha em aberto em
 * pagamentos_asaas já derruba "todasQuitadas" pro associado inteiro, escondendo
 * a cobrança específica que está presa. O critério certo é POR COBRANÇA:
 * casar cada `Cobranca` com o `PagamentoAsaas` que representa ELA MESMA
 * (via id_externo === id, o id do Asaas), não com o conjunto de pagamentos
 * do associado.
 *
 * O QUE ESTE SCRIPT FAZ (tudo somente leitura):
 *   1. Busca toda `Cobranca` com status IN ('pending','overdue') e
 *      id_externo preenchido, em TODAS as franquias.
 *   2. Pra cada uma, busca o `PagamentoAsaas` cujo id seja exatamente esse
 *      id_externo (é o mesmo pagamento no Asaas, não o conjunto do
 *      associado).
 *   3. Se esse pagamento específico está RECEIVED/RECEIVED_IN_CASH, a
 *      cobrança é uma "presa" de verdade — continua contando como em
 *      aberto no Dashboard, mas já foi paga no Asaas.
 *   4. Agrupa o resultado por associado só pra leitura — a comparação em
 *      si é sempre por cobrança individual.
 *   5. Pra cada presa encontrada, calcula se o `vencimento` cai dentro ou
 *      fora da janela -53/+5 dias de hoje — pra confirmar (ou refutar) a
 *      hipótese de causa raiz já levantada (janela rolante que só anda pra
 *      frente, nunca alcança de novo um vencimento que já ficou velho
 *      demais).
 *   6. Reporta separadamente, sem incluir nos números acima:
 *        - cobranças abertas SEM id_externo (não têm como ser casadas por
 *          este método — não é possível concluir nada sobre elas aqui);
 *        - cobranças com id_externo que não bateu com NENHUM PagamentoAsaas
 *          (pode ser que esse associado nunca passou pelo backfill/webhook
 *          novo, ou é uma cobrança recente ainda não replicada lá).
 *
 * Uso:
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js --franquia=<id>
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js --limite=50
 *
 * --franquia (opcional): restringe a UMA franquia. Por padrão varre TODAS.
 * --limite (opcional, default 100): quantas cobranças presas de exemplo
 *   imprimir em detalhe (as CONTAGENS/SOMAS sempre cobrem 100% do
 *   resultado, o limite é só pra não afogar o console).
 */
const prismaBase = require('../src/config/prisma');

const STATUS_ADIMPLENTE_ASAAS = ['RECEIVED', 'RECEIVED_IN_CASH'];
const STATUS_CONSIDERADOS_ABERTOS = ['pending', 'overdue'];
const JANELA_DIAS_TRAS = 53;
const JANELA_DIAS_FRENTE = 5;

function parseArgs(argv) {
  const args = { franquiaId: null, limite: 100 };
  for (const a of argv) {
    if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
    else if (a.startsWith('--limite=')) args.limite = Number(a.slice('--limite='.length)) || 100;
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

/** Meia-noite UTC de hoje, pra comparação de datas "puras" (Cobranca.vencimento é @db.Date). */
function hojeUTC() {
  const agora = new Date();
  return new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  console.log('\n=== Varredura sistêmica — cobranças presas (comparação por cobrança individual) ===\n');
  if (args.franquiaId) console.log(`Restrito à franquia: ${args.franquiaId}`);
  else console.log('Varrendo TODAS as franquias.');

  // --- 1. Cobranças abertas ---
  const cobrancasAbertas = await prismaBase.cobranca.findMany({
    where: {
      status: { in: STATUS_CONSIDERADOS_ABERTOS },
      ...(args.franquiaId ? { associado: { franquiaId: args.franquiaId } } : {}),
    },
    include: { associado: { select: { id: true, nome: true, cpfCnpj: true, franquiaId: true } } },
    orderBy: [{ associado: { nome: 'asc' } }, { vencimento: 'asc' }],
  });

  const comIdExterno = cobrancasAbertas.filter((c) => c.idExterno);
  const semIdExterno = cobrancasAbertas.filter((c) => !c.idExterno);

  console.log(`\nCobranças pending/overdue encontradas: ${cobrancasAbertas.length}`);
  console.log(`  com id_externo preenchido (elegíveis pra esta comparação): ${comIdExterno.length}`);
  console.log(`  SEM id_externo (fora do escopo deste método — ver seção final): ${semIdExterno.length}`);

  if (comIdExterno.length === 0) {
    console.log('\nNenhuma cobrança elegível para comparação por id_externo. Encerrando.');
    await prismaBase.$disconnect();
    return;
  }

  // --- 2. Busca em lote os PagamentoAsaas correspondentes (evita N+1) ---
  const idsExternos = comIdExterno.map((c) => c.idExterno);
  const pagamentosCorrespondentes = await prismaBase.pagamentoAsaas.findMany({
    where: { id: { in: idsExternos } },
  });
  const pagamentoPorId = new Map(pagamentosCorrespondentes.map((p) => [p.id, p]));

  // --- 3. Classifica cada cobrança ---
  const presas = [];
  const semCorrespondenciaEmPagamentosAsaas = [];
  const naoQuitadasNoAsaas = [];

  for (const c of comIdExterno) {
    const pagamento = pagamentoPorId.get(c.idExterno);
    if (!pagamento) {
      semCorrespondenciaEmPagamentosAsaas.push(c);
      continue;
    }
    if (STATUS_ADIMPLENTE_ASAAS.includes(pagamento.status)) {
      presas.push({ cobranca: c, pagamento });
    } else {
      naoQuitadasNoAsaas.push({ cobranca: c, pagamento });
    }
  }

  console.log(`  id_externo casou com um PagamentoAsaas: ${comIdExterno.length - semCorrespondenciaEmPagamentosAsaas.length}`);
  console.log(`    dessas, o PagamentoAsaas está RECEIVED/RECEIVED_IN_CASH (>>> PRESA de verdade): ${presas.length}`);
  console.log(`    dessas, o PagamentoAsaas AINDA não está quitado (cobrança em aberto legítima): ${naoQuitadasNoAsaas.length}`);
  console.log(`  id_externo SEM correspondência em pagamentos_asaas: ${semCorrespondenciaEmPagamentosAsaas.length}`);

  if (presas.length === 0) {
    console.log('\nNenhuma cobrança presa encontrada por este critério (id_externo específico já RECEIVED/RECEIVED_IN_CASH). Encerrando.');
    await prismaBase.$disconnect();
    return;
  }

  // --- 4/5. Agrupa por associado + checagem de janela ---
  const hoje = hojeUTC();
  const janelaInicio = new Date(hoje);
  janelaInicio.setUTCDate(janelaInicio.getUTCDate() - JANELA_DIAS_TRAS);
  const janelaFim = new Date(hoje);
  janelaFim.setUTCDate(janelaFim.getUTCDate() + JANELA_DIAS_FRENTE);

  console.log(
    `\nJanela hipotética de hoje (-${JANELA_DIAS_TRAS}/+${JANELA_DIAS_FRENTE} dias): [${fmtData(janelaInicio)} .. ${fmtData(janelaFim)}]`
  );

  const porAssociado = new Map();
  let valorTotalPreso = 0;
  let dentroDaJanelaCount = 0;
  let foraDaJanelaCount = 0;

  for (const { cobranca: c, pagamento: p } of presas) {
    const key = c.associado?.id ?? '(associado desconhecido)';
    if (!porAssociado.has(key)) {
      porAssociado.set(key, { associado: c.associado, itens: [] });
    }
    const vencimento = new Date(c.vencimento);
    const dentroDaJanela = vencimento >= janelaInicio && vencimento <= janelaFim;
    if (dentroDaJanela) dentroDaJanelaCount += 1;
    else foraDaJanelaCount += 1;

    valorTotalPreso += Number(c.valor);
    porAssociado.get(key).itens.push({ cobranca: c, pagamento: p, dentroDaJanela });
  }

  console.log(`\n>>> ${presas.length} cobrança(s) presa(s), de ${porAssociado.size} associado(s) distinto(s).`);
  console.log(`>>> Valor total congelado incorretamente como "em aberto": ${formatarBRL(valorTotalPreso)}`);
  console.log(
    `>>> Vencimento fora da janela de hoje: ${foraDaJanelaCount} de ${presas.length} ` +
      `(${((foraDaJanelaCount / presas.length) * 100).toFixed(1)}%) — dentro da janela: ${dentroDaJanelaCount}`
  );
  console.log(
    foraDaJanelaCount === presas.length
      ? '    → TODAS as presas têm vencimento fora da janela de hoje: forte confirmação da hipótese de causa raiz (janela rolante nunca mais alcança essas linhas).'
      : foraDaJanelaCount > 0
        ? '    → A MAIORIA (mas não todas) tem vencimento fora da janela — confirma a hipótese como causa predominante, mas sugere que outro fator também contribui pras demais (ex.: payload sem "janela", caindo no modo por-associado).'
        : '    → NENHUMA presa está fora da janela — a hipótese de envelhecimento da janela NÃO explica estes casos; a causa deve ser outra (ex.: falha no modo por-associado, ou payload malformado).'
  );

  // --- Detalhe por associado ---
  console.log('\n--- Detalhe por associado ---\n');
  let impressos = 0;
  for (const { associado, itens } of porAssociado.values()) {
    if (impressos >= args.limite) {
      console.log(`... limite de --limite=${args.limite} atingido, ${porAssociado.size - impressos} associado(s) restantes não impressos.`);
      break;
    }
    const totalAssociado = itens.reduce((soma, it) => soma + Number(it.cobranca.valor), 0);
    console.log(`${associado?.nome ?? '(desconhecido)'}  cpf_cnpj=${associado?.cpfCnpj ?? '?'}  franquiaId=${associado?.franquiaId ?? '?'}`);
    console.log(`  ${itens.length} cobrança(s) presa(s), total ${formatarBRL(totalAssociado)}`);
    for (const { cobranca: c, pagamento: p, dentroDaJanela } of itens) {
      console.log(
        `    cobranca id=${c.id}  id_externo=${c.idExterno}  valor=${formatarBRL(c.valor)}  vencimento=${fmtData(c.vencimento)}  ` +
          `dias_diferenca=${c.diasDiferenca}  status_cobranca=${c.status}  ` +
          `→ pagamentos_asaas: status=${p.status}  paymentDate=${p.paymentDate ?? '(null)'}  ` +
          `${dentroDaJanela ? '[DENTRO da janela de hoje]' : '[FORA da janela de hoje]'}`
      );
    }
    impressos += 1;
  }

  // --- 6. Fora de escopo, reportado à parte ---
  if (semIdExterno.length > 0) {
    console.log(`\n--- Fora do escopo desta comparação: ${semIdExterno.length} cobrança(s) aberta(s) sem id_externo ---`);
    console.log('  (Não é possível casar com uma linha específica de pagamentos_asaas sem id_externo — precisariam de outro método, ex.: por associado+valor+vencimento aproximado.)');
  }
  if (semCorrespondenciaEmPagamentosAsaas.length > 0) {
    console.log(`\n--- ${semCorrespondenciaEmPagamentosAsaas.length} cobrança(s) com id_externo mas SEM correspondência em pagamentos_asaas ---`);
    console.log('  (Pode ser cobrança recente ainda não replicada pelo webhook/backfill novo, ou associado que nunca passou pelo AJUSTE 9/14 — não é possível concluir nada sobre elas por este cruzamento.)');
  }

  console.log('\n=== Fim da varredura — nenhuma alteração foi feita no banco. ===\n');
  await prismaBase.$disconnect();
}

main().catch(async (err) => {
  console.error('Erro ao rodar a varredura sistêmica:', err);
  await prismaBase.$disconnect();
  process.exit(1);
});
