/**
 * Varredura sistêmica — refinamento da seção 7 de
 * scripts/diagnostico-marcela-cobranca-presa.js — E remediação pontual do
 * caso já confirmado (AJUSTE 18).
 *
 * MOTIVO DO REFINAMENTO (mantido da versão original deste script): o
 * critério anterior ("todas as linhas do associado em pagamentos_asaas
 * estão RECEIVED") é POR ASSOCIADO, não por cobrança — e por isso não
 * pegaria nem a própria Marcela em produção, já que ela tem parcelas de
 * renegociação genuinamente em aberto misturadas com a cobrança velha
 * presa: uma linha em aberto em pagamentos_asaas já derrubava
 * "todasQuitadas" pro associado inteiro, escondendo a cobrança específica
 * presa. O critério certo é POR COBRANÇA: casar cada `Cobranca` com o
 * `PagamentoAsaas` que representa ELA MESMA (via id_externo === id, o id
 * do Asaas), não com o conjunto de pagamentos do associado. Toda a lógica
 * de busca/classificação vive agora em `src/services/cobrancasPresas.service.js`
 * — usada também pelo job periódico (`reconciliar-cobrancas-quitadas-no-asaas.js`)
 * e pelo endpoint HTTP (`POST /api/sync/reconciliar-cobrancas-quitadas`),
 * pra garantir que os três caminhos usem exatamente o mesmo critério.
 *
 * O QUE ESTE SCRIPT FAZ (tudo somente leitura por padrão):
 *   1. Busca toda `Cobranca` com status IN ('pending','overdue') e
 *      id_externo preenchido, em TODAS as franquias (ou só uma, com
 *      --franquia=).
 *   2. Pra cada uma, busca o `PagamentoAsaas` cujo id seja exatamente esse
 *      id_externo (é o mesmo pagamento no Asaas, não o conjunto do
 *      associado).
 *   3. Se esse pagamento específico está RECEIVED/RECEIVED_IN_CASH, a
 *      cobrança é uma "presa" de verdade.
 *   4. Agrupa o resultado por associado só pra leitura — a comparação em
 *      si é sempre por cobrança individual.
 *   5. Pra cada presa encontrada, calcula se o `vencimento` cai dentro ou
 *      fora da janela -53/+5 dias de hoje — confirma (ou refuta) a
 *      hipótese de causa raiz (janela rolante que só anda pra frente).
 *   6. Reporta separadamente, sem incluir nos números acima: cobranças
 *      abertas SEM id_externo, e cobranças com id_externo sem
 *      correspondência em pagamentos_asaas.
 *
 * MODO DE REMEDIAÇÃO (`--confirm`): pra cada presa encontrada, marca
 * `status = 'quitada'` e `quitadaEm = ` o `paymentDate` do
 * `pagamentos_asaas` correspondente (não a data de agora — ver docblock de
 * `aplicarQuitacao` no serviço). Sem `--confirm`, continua só reportando
 * (dry-run), mesmo padrão de todos os outros scripts do projeto. Tem
 * guardrail de segurança (recusa aplicar se o número de presas passar
 * muito do esperado, a não ser que você passe `--force` também), mesmo
 * padrão de `scripts/reconciliar-cobrancas-presas.js`.
 *
 * Uso:
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js                       # dry run
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js --franquia=<id>
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js --limite=50
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js --confirm             # aplica (com guardrail)
 *   node scripts/diagnostico-cobrancas-presas-sistemico.js --confirm --force     # aplica ignorando o guardrail
 *
 * --franquia (opcional): restringe a UMA franquia. Por padrão varre TODAS.
 * --limite (opcional, default 100): quantas cobranças presas de exemplo
 *   imprimir em detalhe (as CONTAGENS/SOMAS sempre cobrem 100% do
 *   resultado, o limite é só pra não afogar o console — não afeta quantas
 *   são efetivamente corrigidas com --confirm, que é sempre TODAS as
 *   encontradas).
 * --confirm (opcional): aplica a quitação de verdade. Rode primeiro sem
 *   esta flag pra conferir a lista, e só depois com ela.
 * --force (opcional): ignora o guardrail de segurança (> LIMITE_SEGURANCA_SEM_FORCE
 *   presas). Use só depois de já ter revisado a lista impressa.
 */
const { buscarCobrancasPresas, aplicarQuitacao } = require('../src/services/cobrancasPresas.service');

const JANELA_DIAS_TRAS = 53;
const JANELA_DIAS_FRENTE = 5;
const LIMITE_SEGURANCA_SEM_FORCE = 60;

function parseArgs(argv) {
  const args = { franquiaId: null, limite: 100, confirm: false, force: false };
  for (const a of argv) {
    if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
    else if (a.startsWith('--limite=')) args.limite = Number(a.slice('--limite='.length)) || 100;
    else if (a === '--confirm') args.confirm = true;
    else if (a === '--force') args.force = true;
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
  console.log(args.confirm ? 'Modo: APLICANDO (--confirm)' : 'Modo: DRY RUN (relatório apenas)');

  const { totalAbertas, semIdExterno, comIdExterno, presas, semCorrespondencia, naoQuitadasNoAsaas } =
    await buscarCobrancasPresas({ franquiaId: args.franquiaId });

  console.log(`\nCobranças pending/overdue encontradas: ${totalAbertas}`);
  console.log(`  com id_externo preenchido (elegíveis pra esta comparação): ${comIdExterno.length}`);
  console.log(`  SEM id_externo (fora do escopo deste método — ver seção final): ${semIdExterno.length}`);
  console.log(`  id_externo casou com um PagamentoAsaas: ${comIdExterno.length - semCorrespondencia.length}`);
  console.log(`    dessas, o PagamentoAsaas está RECEIVED/RECEIVED_IN_CASH (>>> PRESA de verdade): ${presas.length}`);
  console.log(`    dessas, o PagamentoAsaas AINDA não está quitado (cobrança em aberto legítima): ${naoQuitadasNoAsaas.length}`);
  console.log(`  id_externo SEM correspondência em pagamentos_asaas: ${semCorrespondencia.length}`);

  if (presas.length === 0) {
    console.log('\nNenhuma cobrança presa encontrada por este critério. Encerrando.');
    return;
  }

  // --- Agrupa por associado + checagem de janela ---
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

  for (const item of presas) {
    const { cobranca: c } = item;
    const key = c.associado?.id ?? '(associado desconhecido)';
    if (!porAssociado.has(key)) porAssociado.set(key, { associado: c.associado, itens: [] });
    const vencimento = new Date(c.vencimento);
    const dentroDaJanela = vencimento >= janelaInicio && vencimento <= janelaFim;
    if (dentroDaJanela) dentroDaJanelaCount += 1;
    else foraDaJanelaCount += 1;

    valorTotalPreso += Number(c.valor);
    porAssociado.get(key).itens.push({ ...item, dentroDaJanela });
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

  // --- Fora de escopo, reportado à parte ---
  if (semIdExterno.length > 0) {
    console.log(`\n--- Fora do escopo desta comparação: ${semIdExterno.length} cobrança(s) aberta(s) sem id_externo ---`);
    console.log('  (Não é possível casar com uma linha específica de pagamentos_asaas sem id_externo — precisariam de outro método, ex.: por associado+valor+vencimento aproximado.)');
  }
  if (semCorrespondencia.length > 0) {
    console.log(`\n--- ${semCorrespondencia.length} cobrança(s) com id_externo mas SEM correspondência em pagamentos_asaas ---`);
    console.log('  (Pode ser cobrança recente ainda não replicada pelo webhook/backfill novo, ou associado que nunca passou pelo AJUSTE 9/14 — não é possível concluir nada sobre elas por este cruzamento.)');
  }

  // --- Remediação ---
  if (!args.confirm) {
    console.log('\nDRY RUN — nada foi alterado no banco. Rode de novo com --confirm para aplicar.');
    return;
  }

  if (presas.length > LIMITE_SEGURANCA_SEM_FORCE && !args.force) {
    console.error(
      `\n⚠️  ${presas.length} presa(s) é bem mais que o esperado (caso confirmado até agora: 1, a Marcela). ` +
        'Recusando aplicar por segurança — revise a lista acima e, se estiver correta, rode de novo com --confirm --force.'
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nAplicando quitação em ${presas.length} cobrança(s)...`);
  const aplicados = await aplicarQuitacao(presas);
  const aproximadas = aplicados.filter((a) => a.quitadaEmAproximada);
  console.log(`\n✓ ${aplicados.length} cobrança(s) marcada(s) como "quitada" (quitada_em = data do pagamento no Asaas).`);
  if (aproximadas.length > 0) {
    console.log(
      `⚠️  ${aproximadas.length} delas não tinham paymentDate em pagamentos_asaas (inesperado) — quitada_em gravado como "agora" nesses casos.`
    );
  }
  console.log('Nenhum registro foi apagado — só mudou de status. Confira no Dashboard.');
}

main()
  .catch((err) => {
    console.error('Erro ao rodar a varredura/remediação:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    const prismaBase = require('../src/config/prisma');
    await prismaBase.$disconnect();
  });
