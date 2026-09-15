/**
 * Auditoria (só leitura, NÃO corrige nada) — dimensiona o impacto real de
 * dois padrões antes de qualquer mudança no cálculo da Taxa de
 * Inadimplência:
 *
 *   1. Par "Negativada": o Asaas, ao mandar uma cobrança pra negativação,
 *      gera uma SEGUNDA cobrança (outro `id`), mesmo `customerId`, mesmo
 *      `value`, `due_date` igual ou muito próximo (±3 dias), com
 *      "(Negativada)" (ou variação, tipo "(Neg...") no final da
 *      `description`. As duas são sincronizadas como registros distintos em
 *      `pagamentos_asaas` — se as DUAS estiverem com status "em aberto"
 *      (OVERDUE/CONFIRMED/PENDING) ao mesmo tempo, a mesma dívida é somada
 *      2x em valor_total_aberto/valor_inadimplente/faixas/top_devedores.
 *
 *   2. Status `DUNNING_REQUESTED`: não aparece em NENHUMA das listas de
 *      status do controller (`STATUS_POR_SITUACAO.em_aberto`,
 *      `STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA`, `STATUS_ADIMPLENTE` — ver
 *      inadimplencia.controller.js linhas ~75-139; conferido também por
 *      grep: "DUNNING" não aparece em nenhum lugar do código-fonte). Ou
 *      seja: hoje, um pagamento com esse status É somado em
 *      `valor_total_faturado` (soma tudo, sem filtro de status — ver
 *      `exports.resumo`), mas NÃO aparece em valor_total_aberto,
 *      valor_inadimplente, faixas (visão "aberto") nem top_devedores — fica
 *      "invisível" como dívida em aberto, mesmo sendo, por definição, uma
 *      cobrança que já entrou em processo de cobrança/negativação (não
 *      paga). Isso é uma LACUNA DE CLASSIFICAÇÃO, estruturalmente diferente
 *      do padrão de par duplicado do item 1 — pode ou não estar
 *      acontecendo JUNTO com um par duplicado (só dados reais confirmam).
 *      Este script testa as duas hipóteses lado a lado, sem presumir
 *      qual é o caso.
 *
 * O que este script NÃO faz: não exclui nada, não decide qual cobrança é
 * "a original", não muda `exports.resumo`. Só mede e reporta, pra decidir
 * o desenho da correção com o tamanho real do problema em mãos.
 *
 * NÃO escreve nada no banco — só SELECT via Prisma (cliente NÃO escopado,
 * de propósito: a auditoria é cross-franquia por padrão, já que o objetivo
 * é dimensionar o problema no banco inteiro).
 *
 * Uso:
 *   node scripts/auditoria-duplicatas-negativada-dunning.js
 *   node scripts/auditoria-duplicatas-negativada-dunning.js --franquia=<id>
 *   node scripts/auditoria-duplicatas-negativada-dunning.js --venc-de=2026-01-01 --venc-ate=2026-09-30
 *   node scripts/auditoria-duplicatas-negativada-dunning.js --limite-exemplos=50
 *   node scripts/auditoria-duplicatas-negativada-dunning.js --nomes="Ligia,Simone,Carlos,Fablio"
 *
 * --franquia (opcional): restringe a UMA franquia. Por padrão audita TODAS.
 * --venc-de/--venc-ate (opcional): restringe due_date. Por padrão, TODO o
 *   histórico (a auditoria pede pra dimensionar o problema todo, não só um
 *   período de tela).
 * --limite-exemplos (opcional, default 30): quantos pares/linhas de exemplo
 *   imprimir em detalhe (os TOTAIS sempre cobrem 100% dos dados, o limite é
 *   só pra não afogar o console).
 * --nomes (opcional): além do apanhado geral de DUNNING_REQUESTED, destaca
 *   separadamente as linhas desses nomes (pra conferência pontual contra
 *   o caso relatado: Ligia/Simone/Carlos/Fablio).
 */
const prismaBase = require('../src/config/prisma');

const STATUS_EM_ABERTO = ['OVERDUE', 'CONFIRMED', 'PENDING'];

function parseArgs(argv) {
  const args = {
    franquiaId: null,
    vencDe: null,
    vencAte: null,
    limiteExemplos: 30,
    nomes: [],
  };
  for (const a of argv) {
    if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
    else if (a.startsWith('--venc-de=')) args.vencDe = a.slice('--venc-de='.length);
    else if (a.startsWith('--venc-ate=')) args.vencAte = a.slice('--venc-ate='.length);
    else if (a.startsWith('--limite-exemplos=')) args.limiteExemplos = Number(a.slice('--limite-exemplos='.length)) || 30;
    else if (a.startsWith('--nomes=')) {
      args.nomes = a
        .slice('--nomes='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return args;
}

function normalizarTexto(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function arredondar2(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function formatarBRL(valor) {
  return `R$ ${arredondar2(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** "(Negativada)", "(negativada", "(Neg...)", "(NEG)" etc. — sempre no FINAL da description, acento/caixa-insensível. */
function pareceDescricaoNegativada(description) {
  const normalizado = normalizarTexto(description).trimEnd();
  return /\(\s*neg[a-z]*\.{0,3}\)?\s*$/.test(normalizado);
}

function diasEntreDatas(dataA, dataB) {
  return Math.abs((new Date(dataA) - new Date(dataB)) / 86400000);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const where = {};
  if (args.franquiaId) where.franquiaId = args.franquiaId;
  if (args.vencDe || args.vencAte) {
    where.dueDate = {};
    if (args.vencDe) where.dueDate.gte = args.vencDe;
    if (args.vencAte) where.dueDate.lte = args.vencAte;
  }

  console.log('=== Auditoria — pares "Negativada" duplicados + status DUNNING_REQUESTED ===');
  console.log(`Escopo: ${args.franquiaId ? `franquia ${args.franquiaId}` : 'TODAS as franquias'}, período: ${args.vencDe || '(sem início)'} a ${args.vencAte || '(sem fim)'}\n`);

  const pagamentos = await prismaBase.pagamentoAsaas.findMany({
    where,
    select: {
      id: true,
      franquiaId: true,
      customerId: true,
      cpfCnpj: true,
      nome: true,
      value: true,
      dueDate: true,
      status: true,
      description: true,
    },
  });
  console.log(`Total de linhas em pagamentos_asaas no escopo: ${pagamentos.length}\n`);

  // ========== PARTE 1 — pares "Negativada" ==========
  console.log('########## PARTE 1 — pares de cobrança duplicados por negativação ##########\n');

  // Agrupa por (franquiaId, customerId) — mesmo cliente Asaas, mesma franquia.
  const porCliente = new Map();
  for (const p of pagamentos) {
    const chave = `${p.franquiaId}::${p.customerId}`;
    if (!porCliente.has(chave)) porCliente.set(chave, []);
    porCliente.get(chave).push(p);
  }

  const paresDetectados = [];
  for (const linhas of porCliente.values()) {
    for (let i = 0; i < linhas.length; i++) {
      for (let j = i + 1; j < linhas.length; j++) {
        const a = linhas[i];
        const b = linhas[j];
        const mesmoValor = arredondar2(a.value) === arredondar2(b.value);
        if (!mesmoValor) continue;
        if (diasEntreDatas(a.dueDate, b.dueDate) > 3) continue;

        const aNeg = pareceDescricaoNegativada(a.description);
        const bNeg = pareceDescricaoNegativada(b.description);
        if (aNeg === bNeg) continue; // ou os dois têm sufixo, ou nenhum — não bate no padrão pedido (exatamente 1 dos 2)

        const original = aNeg ? b : a;
        const negativada = aNeg ? a : b;
        const ambosEmAberto = STATUS_EM_ABERTO.includes(original.status) && STATUS_EM_ABERTO.includes(negativada.status);

        paresDetectados.push({ original, negativada, ambosEmAberto });
      }
    }
  }

  const clientesAfetados = new Set(paresDetectados.map((p) => `${p.original.franquiaId}::${p.original.cpfCnpj || p.original.customerId}`));
  const franquiasAfetadas = new Set(paresDetectados.map((p) => p.original.franquiaId));
  const somaTotalNegativadas = paresDetectados.reduce((soma, p) => soma + Number(p.negativada.value), 0);
  const paresDuplicandoHoje = paresDetectados.filter((p) => p.ambosEmAberto);
  const somaDuplicandoHoje = paresDuplicandoHoje.reduce((soma, p) => soma + Number(p.negativada.value), 0);

  console.log(`Pares detectados (mesmo customerId, mesmo value, due_date ±3 dias, 1 com sufixo "negativada" e o outro sem): ${paresDetectados.length}`);
  console.log(`  Associados distintos afetados (franquia+cpf_cnpj): ${clientesAfetados.size}`);
  console.log(`  Franquias distintas afetadas: ${franquiasAfetadas.size}`);
  console.log(`  Soma do value de TODAS as cópias "negativada" (independente do status atual): ${formatarBRL(somaTotalNegativadas)}`);
  console.log(`  Desses, pares onde AMBOS estão em status "em aberto" agora (OVERDUE/CONFIRMED/PENDING) — duplicando o cálculo HOJE: ${paresDuplicandoHoje.length} pares, soma ${formatarBRL(somaDuplicandoHoje)}\n`);

  if (paresDetectados.length > 0) {
    console.log(`Exemplos (até ${args.limiteExemplos}, priorizando os que duplicam HOJE):`);
    const ordenados = [...paresDetectados].sort((x, y) => (y.ambosEmAberto - x.ambosEmAberto) || (Number(y.negativada.value) - Number(x.negativada.value)));
    for (const p of ordenados.slice(0, args.limiteExemplos)) {
      console.log(`  franquia=${p.original.franquiaId}  ${p.original.nome || p.original.cpfCnpj || p.original.customerId}  value=${formatarBRL(p.original.value)}`);
      console.log(`    original:    id="${p.original.id}"  status=${p.original.status}  due_date=${p.original.dueDate}  desc="${p.original.description || ''}"`);
      console.log(`    negativada:  id="${p.negativada.id}"  status=${p.negativada.status}  due_date=${p.negativada.dueDate}  desc="${p.negativada.description || ''}"`);
      console.log(`    ${p.ambosEmAberto ? '⚠ DUPLICANDO HOJE (os 2 em aberto)' : '(não duplica hoje — um dos 2 não está em status em aberto)'}\n`);
    }
    if (paresDetectados.length > args.limiteExemplos) {
      console.log(`  ... (+${paresDetectados.length - args.limiteExemplos} pares não impressos — aumente --limite-exemplos pra ver todos)\n`);
    }
  }

  // ========== PARTE 2 — DUNNING_REQUESTED ==========
  console.log('\n########## PARTE 2 — status DUNNING_REQUESTED ##########\n');

  const linhasDunning = pagamentos.filter((p) => p.status === 'DUNNING_REQUESTED');
  const somaDunning = linhasDunning.reduce((soma, p) => soma + Number(p.value), 0);
  const clientesDunning = new Set(linhasDunning.map((p) => `${p.franquiaId}::${p.cpfCnpj || p.customerId}`));

  console.log(`Linhas com status DUNNING_REQUESTED no escopo: ${linhasDunning.length}`);
  console.log(`  Associados distintos: ${clientesDunning.size}`);
  console.log(`  Soma do value: ${formatarBRL(somaDunning)}`);
  console.log('  Lembrete: DUNNING_REQUESTED não está em STATUS_POR_SITUACAO.em_aberto nem em STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA nem em STATUS_ADIMPLENTE — hoje esse valor entra em valor_total_faturado (soma tudo, sem filtro de status) mas NÃO aparece em valor_total_aberto/valor_inadimplente/faixas(aberto)/top_devedores. Isso acontece MESMO SEM par duplicado — é lacuna de classificação, testada separadamente abaixo.\n');

  if (linhasDunning.length > 0) {
    console.log(`Detalhe de cada linha DUNNING_REQUESTED (até ${args.limiteExemplos}) — e se ela tem uma linha-irmã (mesmo customerId, mesmo value, due_date ±3 dias, id diferente, QUALQUER status/description):`);
    for (const d of linhasDunning.slice(0, args.limiteExemplos)) {
      const irmas = pagamentos.filter(
        (p) =>
          p.id !== d.id &&
          p.franquiaId === d.franquiaId &&
          p.customerId === d.customerId &&
          arredondar2(p.value) === arredondar2(d.value) &&
          diasEntreDatas(p.dueDate, d.dueDate) <= 3
      );
      console.log(`  franquia=${d.franquiaId}  ${d.nome || d.cpfCnpj || d.customerId}  id="${d.id}"  value=${formatarBRL(d.value)}  due_date=${d.dueDate}  desc="${d.description || ''}"`);
      if (irmas.length === 0) {
        console.log('    → NENHUMA linha-irmã (mesmo customerId/value/due_date próximo). Não é um par duplicado — é uma cobrança ISOLADA com status DUNNING_REQUESTED, invisível hoje na Taxa de Inadimplência por lacuna de classificação (não por duplicidade).');
      } else {
        for (const irma of irmas) {
          const ehNegativada = pareceDescricaoNegativada(irma.description);
          console.log(`    → linha-irmã: id="${irma.id}"  status=${irma.status}  desc="${irma.description || ''}"${ehNegativada ? '  [tem sufixo "negativada"]' : ''} — MESMO padrão de par do item 1, com um dos lados em DUNNING_REQUESTED em vez de OVERDUE.`);
        }
      }
    }
    if (linhasDunning.length > args.limiteExemplos) {
      console.log(`  ... (+${linhasDunning.length - args.limiteExemplos} linhas não impressas — aumente --limite-exemplos pra ver todas)`);
    }
  }

  if (args.nomes.length > 0) {
    console.log(`\n--- Conferência pontual por nome: ${args.nomes.join(', ')} ---`);
    const termos = args.nomes.map(normalizarTexto);
    const linhasNome = pagamentos.filter((p) => termos.some((t) => normalizarTexto(p.nome).includes(t)));
    if (linhasNome.length === 0) {
      console.log('  Nenhuma linha em pagamentos_asaas bateu com esses nomes (busca por p.nome, acento/caixa-insensível — confira se o nome está cacheado ou tente por outro termo).');
    } else {
      for (const l of linhasNome) {
        console.log(`  franquia=${l.franquiaId}  ${l.nome}  id="${l.id}"  status=${l.status}  value=${formatarBRL(l.value)}  due_date=${l.dueDate}  desc="${l.description || ''}"`);
      }
    }
  }

  console.log('\n=== Fim — cola este console inteiro de volta na conversa ===');
  await prismaBase.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
