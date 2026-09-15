/**
 * Diagnóstico pontual — isola `aplicarFiltroTipoInadimplente` E o pipeline
 * inteiro que alimenta ela, pra achar o ponto EXATO onde a lista de
 * associados do Jurídico encolhe de 8 pra 4 quando `tipo_inadimplente=juridico`
 * está ativo.
 *
 * Correção de hipótese, ANTES de tudo: `aplicarFiltroTipoInadimplente` NÃO
 * monta nenhuma query Prisma com `where`/`in` — ela filtra em memória
 * (`Array.prototype.filter`) um array de pagamentos JÁ carregado, usando
 * `cpfCnpjComCardJuridico.has(cpfCnpj)` (método de `Set`, O(1), correto pra
 * checar pertencimento — nunca vira um `in:` do Prisma). Conferido por
 * grep no controller inteiro: a variável `cpfCnpjComCardJuridico` só
 * aparece nesse `.has(...)`, nunca dentro de um `where`. Então a hipótese
 * de "Set passado direto pro `in:` do Prisma sem `Array.from()`" não se
 * aplica a esta função — ela não toca o banco. Isso já foi confirmado
 * isoladamente em diagnostico-buscarcpfcnpj-juridico.js (a função que
 * MONTA o Set, buscarCpfCnpjComCardJuridico, devolve os 8 CPF/CNPJ certos).
 *
 * Então o encolhimento de 8 pra 4 só pode estar em UM destes 3 pontos —
 * todos ANTES ou DENTRO de aplicarFiltroTipoInadimplente, todos filtros em
 * memória sobre arrays já carregados:
 *   1. `separarExcluidos` (dentro de buscarPagamentosValidos, AJUSTE 7) —
 *      exclusão manual por ID OU por palavra-chave/CPF/CNPJ/nome
 *      configurada. Se alguma palavra-chave configurada bater com o nome
 *      ou CPF/CNPJ de um desses associados, o pagamento dele nunca chega
 *      nem em `pagamentosValidos`.
 *   2. `aplicarFiltroSituacao` + `aplicarFiltrosCrossReference` (situacao/
 *      renegociacao/em_juridico legado/bloqueado) — filtros de população
 *      ANTES de tipo_inadimplente. Um `em_juridico=nao` (parâmetro legado)
 *      enviado junto, por exemplo, derrubaria qualquer associado com
 *      `associados.em_juridico=true` ANTES do filtro novo rodar — mesmo
 *      que ele tenha card real.
 *   3. `aplicarFiltroTipoInadimplente` em si — já isolada e confirmada OK
 *      no diagnóstico anterior pro Set em si; este script confirma de novo
 *      olhando o pipeline inteiro.
 *
 * COMO garante que está rodando a lógica REAL (não uma cópia por memória):
 * este script NÃO reescreve as funções à mão. Ele lê `inadimplencia.controller.js`
 * de verdade, do disco, na hora que roda, insere 3 pontos de instrumentação
 * (`global.__DIAG__.stageN = {...}`) em locais EXATOS (ancorados por
 * substring literal do arquivo atual — se o controller mudou e a âncora não
 * bate mais, o script ABORTA em vez de instrumentar o lugar errado), escreve
 * o resultado num arquivo TEMPORÁRIO ao lado do controller real (mesma
 * pasta, pra `require('../services/...')` continuar resolvendo certo),
 * chama `exports.resumo` de dentro desse arquivo temporário com um
 * req/res falsos (mas um Prisma client REAL, escopado pra franquia
 * informada), e SEMPRE apaga o arquivo temporário no final (`finally`,
 * cobre erro também). Documento isso porque é o único jeito de instrumentar
 * o pipeline inteiro sem reescrever nada de memória e sem editar o
 * controller de produção.
 *
 * IMPORTANTE — onde rodar: mesma DATABASE_URL do backend de produção (ver
 * docblock de diagnostico-ajuste8.js). NÃO escreve nada no banco — só
 * SELECT via Prisma; o único arquivo escrito é o temporário descrito acima,
 * sempre apagado ao final.
 *
 * Uso:
 *   node scripts/diagnostico-pipeline-tipo-inadimplente.js --listar-franquias
 *   node scripts/diagnostico-pipeline-tipo-inadimplente.js --franquia=<id> --venc-de=2026-01-01 --venc-ate=2026-08-31
 *
 * Flags opcionais pra reproduzir EXATAMENTE a URL que a tela mandou (se o
 * resultado deste script não reproduzir o sumiço com os defaults, confira
 * a aba Network do navegador na chamada a /resumo e passe os mesmos
 * valores aqui):
 *   --situacao=em_aberto,pagas   (default: sem filtro, igual ausente na URL)
 *   --tipo-pendencia=todos       (default: todos)
 *   --renegociacao=todos         (default: todos — "sim" só se o checkbox "Em negociação" estiver marcado)
 *   --bloqueado=todos            (default: todos — idem "Bloqueado")
 *   --visao=aberto               (default: aberto)
 *   --filtro-periodo=vencimento  (default: vencimento)
 *
 * ATUALIZAÇÃO — pipeline de população confirmado limpo (nenhuma queda entre
 * RAW/STAGE0/STAGE1/STAGE2 nos casos investigados). Próxima hipótese: o
 * associado sobrevive até STAGE2 (conjuntoTrabalho) mas com TODOS os
 * pagamentos do período já em status RECEIVED/RECEIVED_IN_CASH — nesse caso
 * ele corretamente não entra em valor_total_aberto/valor_inadimplente/
 * top_devedores (que só somam OVERDUE/CONFIRMED/PENDING, ver
 * STATUS_POR_SITUACAO.em_aberto no controller), e o "sumiço" na Taxa de
 * Inadimplência está certo — a divergência real estaria entre o card do
 * Jurídico (lê de `cobrancas`, sync n8n) e `pagamentos_asaas` (fonte única
 * da Taxa de Inadimplência desde o AJUSTE 14), não neste pipeline. Por isso
 * a tabela agora também imprime, por associado, a soma de `value` de
 * STAGE2 separada por `status`.
 */
const fs = require('fs');
const path = require('path');

const prismaBase = require('../src/config/prisma');
const { criarPrismaEscopado } = require('../src/config/prismaComEscopo');

const CONTROLLER_PATH = path.join(__dirname, '..', 'src', 'controllers', 'inadimplencia.controller.js');
const CONTROLLER_DIR = path.dirname(CONTROLLER_PATH);
const TEMP_PATH = path.join(CONTROLLER_DIR, '_diagnostico_temp_instrumentado.controller.js');

function parseArgs(argv) {
  const args = {
    vencDe: '2026-01-01',
    vencAte: '2026-08-31',
    situacao: '',
    tipoPendencia: 'todos',
    renegociacao: 'todos',
    bloqueado: 'todos',
    visao: 'aberto',
    filtroPeriodo: 'vencimento',
    listarFranquias: false,
  };
  for (const a of argv) {
    if (a === '--listar-franquias') args.listarFranquias = true;
    else if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
    else if (a.startsWith('--venc-de=')) args.vencDe = a.slice('--venc-de='.length);
    else if (a.startsWith('--venc-ate=')) args.vencAte = a.slice('--venc-ate='.length);
    else if (a.startsWith('--situacao=')) args.situacao = a.slice('--situacao='.length);
    else if (a.startsWith('--tipo-pendencia=')) args.tipoPendencia = a.slice('--tipo-pendencia='.length);
    else if (a.startsWith('--renegociacao=')) args.renegociacao = a.slice('--renegociacao='.length);
    else if (a.startsWith('--bloqueado=')) args.bloqueado = a.slice('--bloqueado='.length);
    else if (a.startsWith('--visao=')) args.visao = a.slice('--visao='.length);
    else if (a.startsWith('--filtro-periodo=')) args.filtroPeriodo = a.slice('--filtro-periodo='.length);
  }
  return args;
}

function normalizarDocumento(valor) {
  return (valor || '').replace(/\D/g, '');
}

/**
 * Insere `trechoNovo` logo depois de `ancora` em `codigoFonte`. Exige que
 * `ancora` apareça EXATAMENTE 1 vez — se aparecer 0 ou 2+ vezes, o
 * controller mudou de um jeito que invalida a suposição deste script, e é
 * mais seguro abortar do que instrumentar o lugar errado (ou os dois).
 */
function inserirApos(codigoFonte, ancora, trechoNovo, rotulo) {
  const partes = codigoFonte.split(ancora);
  if (partes.length !== 2) {
    throw new Error(
      `Âncora "${rotulo}" encontrada ${partes.length - 1}x em inadimplencia.controller.js (esperado: exatamente 1x). ` +
        'O controller mudou desde que este script foi escrito — atualize a âncora antes de rodar de novo.\n' +
        `Âncora procurada:\n${ancora}`
    );
  }
  return partes[0] + ancora + trechoNovo + partes[1];
}

// `exports.resumo` e `exports.evolucaoMensal` reaproveitam literalmente o
// mesmo trecho de código pro pipeline de população (mesmas 3 âncoras abaixo
// aparecem nos dois) — por isso a instrumentação é aplicada só na FATIA do
// arquivo que vai de "exports.resumo = async" até "exports.evolucaoMensal = async"
// (exclusive), nunca no arquivo inteiro, senão cada âncora bateria 2x e o
// self-check (de propósito) abortaria em vez de adivinhar qual das duas
// instrumentar.
function instrumentarControllerEEscrever() {
  const codigoOriginal = fs.readFileSync(CONTROLLER_PATH, 'utf-8');

  const marcadorInicio = 'exports.resumo = async';
  const marcadorFim = 'exports.evolucaoMensal = async';
  const inicioResumo = codigoOriginal.indexOf(marcadorInicio);
  const inicioEvolucaoMensal = codigoOriginal.indexOf(marcadorFim);
  if (inicioResumo === -1 || inicioEvolucaoMensal === -1 || inicioEvolucaoMensal <= inicioResumo) {
    throw new Error(
      `Não consegui delimitar o corpo de "exports.resumo" (marcadores "${marcadorInicio}"/"${marcadorFim}" não encontrados na ordem esperada) — o controller mudou de estrutura, atualize este script.`
    );
  }

  const antes = codigoOriginal.slice(0, inicioResumo);
  let corpoResumo = codigoOriginal.slice(inicioResumo, inicioEvolucaoMensal);
  const depois = codigoOriginal.slice(inicioEvolucaoMensal);

  corpoResumo = inserirApos(
    corpoResumo,
    `    const [{ validos: pagamentosValidos, excluidos, associadoPorCpfCnpj }, diasTolerancia, cpfCnpjComCardJuridico] =
      await Promise.all([
        buscarPagamentosValidos(req.prisma, franquiaId, { vencDe, vencAte, filtroPeriodo }),
        getDiasTolerancia(franquiaId),
        buscarCpfCnpjComCardJuridico(req.prisma),
      ]);`,
    `

    if (global.__DIAG__) {
      global.__DIAG__.stage0 = { pagamentosValidos, excluidos, cpfCnpjComCardJuridico, associadoPorCpfCnpj };
    }`,
    'stage0 (pós Promise.all: pagamentosValidos/excluidos/cpfCnpjComCardJuridico)'
  );

  corpoResumo = inserirApos(
    corpoResumo,
    `    const populacaoAntesDoTipoInadimplente = aplicarFiltrosCrossReference(
      aplicarFiltroSituacao(pagamentosValidos, situacao),
      { renegociacao, emJuridico, bloqueado },
      associadoPorCpfCnpj
    );`,
    `

    if (global.__DIAG__) {
      global.__DIAG__.stage1 = { populacaoAntesDoTipoInadimplente };
    }`,
    'stage1 (pós situacao + cross-reference: populacaoAntesDoTipoInadimplente)'
  );

  corpoResumo = inserirApos(
    corpoResumo,
    `    const conjuntoTrabalho = aplicarFiltroTipoInadimplente(
      populacaoAntesDoTipoInadimplente,
      tipoInadimplente,
      criticoSet,
      associadoPorCpfCnpj,
      cpfCnpjComCardJuridico
    );`,
    `

    if (global.__DIAG__) {
      global.__DIAG__.stage2 = { conjuntoTrabalho };
    }`,
    'stage2 (pós tipo_inadimplente: conjuntoTrabalho)'
  );

  fs.writeFileSync(TEMP_PATH, antes + corpoResumo + depois, 'utf-8');
}

function limparArquivoTemp() {
  if (fs.existsSync(TEMP_PATH)) fs.unlinkSync(TEMP_PATH);
}

/** Roda exports.resumo do controller INSTRUMENTADO com req/res falsos, devolve { corpo, diag }. */
async function rodarResumoInstrumentado(prisma, franquiaId, query) {
  global.__DIAG__ = {};
  delete require.cache[require.resolve(TEMP_PATH)];
  const controllerInstrumentado = require(TEMP_PATH);

  let corpoCapturado = null;
  let statusCapturado = 200;
  let erroCapturado = null;
  const req = { prisma, franquiaId, query };
  const res = {
    status(codigo) {
      statusCapturado = codigo;
      return this;
    },
    json(corpo) {
      corpoCapturado = corpo;
    },
  };
  const next = (err) => {
    erroCapturado = err;
  };

  await controllerInstrumentado.resumo(req, res, next);
  if (erroCapturado) throw erroCapturado;

  const diag = global.__DIAG__;
  delete global.__DIAG__;
  return { status: statusCapturado, corpo: corpoCapturado, diag };
}

/** Conta, num array de "pagamentos" (formato já adaptado, com .cpfCnpj), quantos batem cada cpfCnpj informado. */
function contarPorCpfCnpj(pagamentos, cpfCnpjs) {
  const contagem = new Map(cpfCnpjs.map((c) => [c, 0]));
  for (const p of pagamentos) {
    if (p.cpfCnpj && contagem.has(p.cpfCnpj)) {
      contagem.set(p.cpfCnpj, contagem.get(p.cpfCnpj) + 1);
    }
  }
  return contagem;
}

// Ordem de exibição preferida — os 4 status que a Taxa de Inadimplência
// normalmente vê. Qualquer status fora desta lista (ex: um valor inesperado
// vindo do Asaas) ainda aparece, só que depois destes 4, marcado.
const STATUS_ORDEM_PADRAO = ['OVERDUE', 'CONFIRMED', 'PENDING', 'RECEIVED'];

/**
 * Soma `value` por status, por cpfCnpj alvo — pra testar a hipótese de que
 * um associado "some" da Taxa de Inadimplência não por bug de filtro, mas
 * porque TODOS os pagamentos dele no período já estão com status RECEIVED
 * (pago) — nesse caso o sumiço seria correto, e a divergência estaria no
 * card do Jurídico (que lê de `cobrancas`/sync n8n, uma fonte separada e
 * possivelmente desatualizada — ver docblock do controller sobre as duas
 * pipelines).
 */
function somarValorPorStatusPorCpf(pagamentos, cpfCnpjs) {
  const porCpf = new Map(cpfCnpjs.map((c) => [c, new Map()]));
  for (const p of pagamentos) {
    if (p.cpfCnpj && porCpf.has(p.cpfCnpj)) {
      const porStatus = porCpf.get(p.cpfCnpj);
      const statusChave = p.status || '(sem status)';
      porStatus.set(statusChave, (porStatus.get(statusChave) || 0) + (Number(p.value) || 0));
    }
  }
  return porCpf;
}

function formatarBRL(valor) {
  return (valor || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.listarFranquias) {
    const franquias = await prismaBase.franquia.findMany({ select: { id: true, nome: true, ativo: true } });
    console.log('Franquias cadastradas:');
    for (const f of franquias) console.log(`  ${f.id}  ${f.nome}${f.ativo ? '' : '  (INATIVA)'}`);
    await prismaBase.$disconnect();
    return;
  }

  if (!args.franquiaId) {
    console.error('Faltou --franquia=<id>. Rode com --listar-franquias pra ver os IDs disponíveis.');
    process.exitCode = 1;
    return;
  }

  const { franquiaId, vencDe, vencAte } = args;
  const prisma = criarPrismaEscopado(franquiaId);

  console.log(`=== Diagnóstico do pipeline tipo_inadimplente=juridico — franquia ${franquiaId} — período ${vencDe} a ${vencAte} ===\n`);

  // ---------- 0. Lista "de verdade": os 8 associados com card real ----------
  // Reproduz buscarCpfCnpjComCardJuridico (já confirmada correta no
  // diagnóstico anterior) só pra montar a lista de comparação com nome —
  // a mesma query, sem instrumentação (não precisa: já sabemos que essa
  // função está OK).
  const cardsComAssociado = await prisma.cardJuridico.findMany({
    where: { associadoId: { not: null } },
    select: { associado: { select: { id: true, nome: true, cpfCnpj: true } } },
  });
  const associadosComCard = [...new Map(cardsComAssociado.filter((c) => c.associado?.cpfCnpj).map((c) => [c.associado.cpfCnpj, c.associado])).values()];
  console.log(`=== 0 — Associados com card real no Jurídico (${associadosComCard.length}) ===`);
  for (const a of associadosComCard) console.log(`  ${a.nome}  cpf_cnpj="${a.cpfCnpj}"`);
  console.log('');

  if (associadosComCard.length === 0) {
    console.log('Nenhum associado com card real nesta franquia — nada pra comparar. Abortando.');
    await prismaBase.$disconnect();
    return;
  }
  const cpfCnpjsAlvo = associadosComCard.map((a) => a.cpfCnpj);
  const nomePorCpf = new Map(associadosComCard.map((a) => [a.cpfCnpj, a.nome]));

  // ---------- RAW — pagamentos_asaas direto, independente do pipeline ----------
  const camposData = { vencimento: 'dueDate', emissao: 'dateCreated', pagamento: 'paymentDate' };
  const campoData = camposData[args.filtroPeriodo] || 'dueDate';
  const rawPagamentos = await prisma.pagamentoAsaas.findMany({
    where: { cpfCnpj: { in: cpfCnpjsAlvo }, [campoData]: { gte: vencDe, lte: vencAte } },
    select: { id: true, cpfCnpj: true, dueDate: true, value: true, status: true },
  });
  const contagemRaw = contarPorCpfCnpj(rawPagamentos, cpfCnpjsAlvo);

  // ---------- Instrumenta o controller e roda o pipeline real ----------
  try {
    instrumentarControllerEEscrever();
    console.log('✓ Controller instrumentado com sucesso (3 âncoras bateram, 1x cada) — rodando o pipeline real...\n');

    const query = {
      venc_de: vencDe,
      venc_ate: vencAte,
      filtro_periodo: args.filtroPeriodo,
      situacao: args.situacao,
      tipo_pendencia: args.tipoPendencia,
      renegociacao: args.renegociacao,
      bloqueado: args.bloqueado,
      tipo_inadimplente: 'juridico',
      visao: args.visao,
      forcar: 'true',
    };
    console.log('Query usada (ajuste com as flags do docblock se sua URL real for diferente):');
    console.log(' ', JSON.stringify(query), '\n');

    const { status, corpo, diag } = await rodarResumoInstrumentado(prisma, franquiaId, query);

    if (status !== 200) {
      console.error(`GET /resumo instrumentado devolveu status ${status}:`, corpo);
      return;
    }

    const contagemStage0 = contarPorCpfCnpj(diag.stage0.pagamentosValidos, cpfCnpjsAlvo);
    const contagemStage1 = contarPorCpfCnpj(diag.stage1.populacaoAntesDoTipoInadimplente, cpfCnpjsAlvo);
    const contagemStage2 = contarPorCpfCnpj(diag.stage2.conjuntoTrabalho, cpfCnpjsAlvo);
    const valorPorStatusStage2 = somarValorPorStatusPorCpf(diag.stage2.conjuntoTrabalho, cpfCnpjsAlvo);

    console.log(`=== Set de buscarCpfCnpjComCardJuridico usado nesta chamada (via req.prisma real) ===`);
    console.log(`  tipo: ${diag.stage0.cpfCnpjComCardJuridico.constructor.name}  tamanho: ${diag.stage0.cpfCnpjComCardJuridico.size}`);
    console.log(`  contém todos os ${cpfCnpjsAlvo.length}? ${cpfCnpjsAlvo.every((c) => diag.stage0.cpfCnpjComCardJuridico.has(c)) ? 'SIM' : 'NÃO'}\n`);

    console.log(`=== Tabela: onde cada associado sobrevive/desaparece no pipeline (contagem de pagamentos no período) ===`);
    console.log('  RAW = direto em pagamentos_asaas, independente do pipeline (ground truth)');
    console.log('  STAGE0 = pagamentosValidos (pós separarExcluidos/AJUSTE 7)');
    console.log('  STAGE1 = populacaoAntesDoTipoInadimplente (pós situacao + cross-reference legado)');
    console.log('  STAGE2 = conjuntoTrabalho (pós tipo_inadimplente=juridico — resultado final)\n');

    let primeiraQuedaContagem = { excluido: 0, situacaoCrossRef: 0, tipoInadimplente: 0, ok: 0 };
    for (const cpf of cpfCnpjsAlvo) {
      const nome = nomePorCpf.get(cpf);
      const raw = contagemRaw.get(cpf);
      const s0 = contagemStage0.get(cpf);
      const s1 = contagemStage1.get(cpf);
      const s2 = contagemStage2.get(cpf);
      console.log(`  ${nome}  (cpf_cnpj="${cpf}")`);
      console.log(`    RAW=${raw}  STAGE0=${s0}  STAGE1=${s1}  STAGE2=${s2}`);

      if (s2 > 0) {
        const porStatus = valorPorStatusStage2.get(cpf);
        const statusPresentes = [...porStatus.keys()];
        const ordemExibicao = [
          ...STATUS_ORDEM_PADRAO.filter((s) => statusPresentes.includes(s)),
          ...statusPresentes.filter((s) => !STATUS_ORDEM_PADRAO.includes(s)),
        ];
        const somaTotal = [...porStatus.values()].reduce((a, b) => a + b, 0);
        console.log('    STAGE2 — value por status (pagamentos_asaas):');
        for (const status of ordemExibicao) {
          const pct = somaTotal > 0 ? ((porStatus.get(status) / somaTotal) * 100).toFixed(1) : '0.0';
          console.log(`      ${status.padEnd(18)} ${formatarBRL(porStatus.get(status)).padStart(18)}  (${pct}% do total deste associado)`);
        }
        console.log(`      ${'TOTAL'.padEnd(18)} ${formatarBRL(somaTotal).padStart(18)}`);

        // "em_aberto" = OVERDUE+CONFIRMED+PENDING (STATUS_POR_SITUACAO.em_aberto
        // no controller) — é o que conta pra valor_total_aberto/valor_inadimplente/
        // top_devedores. Se 100% do valor deste associado está fora dessa lista
        // (ou seja, só RECEIVED/RECEIVED_IN_CASH), ele nunca vai aparecer como
        // devedor na Taxa de Inadimplência NESTA chamada — não por bug de
        // filtro, mas porque já está pago segundo pagamentos_asaas.
        const statusEmAberto = ['OVERDUE', 'CONFIRMED', 'PENDING'];
        const valorEmAberto = [...porStatus.entries()].filter(([s]) => statusEmAberto.includes(s)).reduce((a, [, v]) => a + v, 0);
        if (valorEmAberto === 0 && somaTotal > 0) {
          console.log('      → 100% do valor em STAGE2 está fora de OVERDUE/CONFIRMED/PENDING (ou seja, já pago segundo pagamentos_asaas) — correto este associado não aparecer como devedor na Taxa de Inadimplência nesta chamada. Se o card do Jurídico ainda mostra valor em aberto pra ele, a divergência está entre `cobrancas` (sync n8n) e `pagamentos_asaas`, não neste pipeline.');
        } else if (valorEmAberto > 0 && s2 > 0) {
          console.log(`      → ${formatarBRL(valorEmAberto)} está em status "em aberto" (OVERDUE/CONFIRMED/PENDING) — deveria contar pra valor_total_aberto/valor_inadimplente/top_devedores nesta chamada. Se mesmo assim não aparece nos totais da tela, o próximo ponto a investigar é ali (agregação pós-STAGE2), não mais o pipeline de população.`);
        }
      }

      if (raw === 0) {
        console.log('    => sem pagamento no período, nem no raw — nada a ver com o pipeline (revisite o diagnóstico anterior, causa (a)/(c)).');
      } else if (s0 === 0) {
        console.log('    ✗ QUEDA em separarExcluidos (AJUSTE 7) — algum ID/palavra-chave/CPF/nome configurado está excluindo este associado. Rode diagnostico-ajuste8.js (seção de exclusões) pra achar QUAL termo bateu.');
        primeiraQuedaContagem.excluido += 1;
      } else if (s1 === 0) {
        console.log(`    ✗ QUEDA em situacao/cross-reference — com situacao="${args.situacao || '(sem filtro)'}", renegociacao="${args.renegociacao}", bloqueado="${args.bloqueado}". Se você não mandou esses parâmetros na URL real, ajuste as flags deste script e rode de novo.`);
        primeiraQuedaContagem.situacaoCrossRef += 1;
      } else if (s2 === 0) {
        console.log('    ✗ QUEDA em aplicarFiltroTipoInadimplente — sobreviveu até aqui, mas some no filtro "juridico" em si. Isso contradiz o diagnóstico anterior (Set confirmado correto) — investigar resolverPagamento/normalização de cpfCnpj entre pagamento e Set nesta chamada específica.');
        primeiraQuedaContagem.tipoInadimplente += 1;
      } else {
        console.log('    ✓ sobrevive em todas as etapas — aparece no resultado final.');
        primeiraQuedaContagem.ok += 1;
      }
      console.log('');
    }

    console.log('=== Resumo ===');
    console.log(`  ${primeiraQuedaContagem.ok} de ${cpfCnpjsAlvo.length} sobrevivem até o fim.`);
    console.log(`  ${primeiraQuedaContagem.excluido} caem em separarExcluidos (AJUSTE 7 — exclusão manual/palavra-chave).`);
    console.log(`  ${primeiraQuedaContagem.situacaoCrossRef} caem em situacao/cross-reference (renegociacao/em_juridico legado/bloqueado).`);
    console.log(`  ${primeiraQuedaContagem.tipoInadimplente} caem dentro de aplicarFiltroTipoInadimplente propriamente dita.`);
    console.log(`\n  valor_total_faturado desta chamada: ${corpo.valor_total_faturado}`);
  } finally {
    limparArquivoTemp();
  }

  console.log('\n=== Fim — cola este console inteiro de volta na conversa ===');
  await prismaBase.$disconnect();
}

main().catch(async (err) => {
  limparArquivoTemp();
  console.error(err);
  process.exitCode = 1;
});
