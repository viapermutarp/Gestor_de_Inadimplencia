/**
 * Diagnóstico pontual (só leitura) — investiga um par de linhas que parecem
 * duplicadas no Asaas pro mesmo associado (ex.: Nadia, duas linhas
 * "Renegociação Via Permuta 5,6..." de R$ 1.792,98 cada, vencimento
 * 09/09/2026, uma normal e outra provavelmente marcada como negativada).
 *
 * Pergunta a responder: são duas cobranças DIFERENTES no Asaas (dois
 * `id` distintos, ambas presentes em `pagamentos_asaas`) ou só uma
 * cobrança real que, por algum motivo, gerou duas linhas na nossa tabela
 * local?
 *
 * Achado de leitura de schema, ANTES de rodar: `pagamentos_asaas.id` é
 * `@id` (chave primária simples — ver prisma/schema.prisma, model
 * PagamentoAsaas) e, por convenção do projeto (AJUSTE 14,
 * `pagamentosAsaas.service.js`/`upsertPagamento`), esse `id` É o próprio
 * id da cobrança no Asaas (ex.: "pay_xxx"). Ou seja: duas linhas com o
 * MESMO `id` na nossa tabela é estruturalmente impossível (o Postgres não
 * deixaria inserir/duplicar uma PK) — se as duas linhas existem localmente,
 * elas OBRIGATORIAMENTE têm dois `id` diferentes, o que já significa duas
 * cobranças distintas reconhecidas pelo Asaas (ex.: cobrança original +
 * cobrança reemitida/negativada). A pergunta real que este script responde
 * não é "o id duplicou" (não duplica, por design do schema) e sim:
 *   (a) as DUAS cobranças que você vê no Asaas existem localmente (2 linhas,
 *       2 ids diferentes) — sync correto, o "duplicado" é legítimo (Asaas
 *       trata como 2 cobranças mesmo);
 *   (b) só UMA das duas existe localmente (1 linha) — a outra nunca chegou
 *       via webhook/backfill/reconciliação, e por isso está sendo
 *       subcontada na Taxa de Inadimplência;
 *   (c) nenhuma das duas existe localmente — associado nem aparece em
 *       pagamentos_asaas pra esse período (causa (a) do diagnóstico
 *       anterior, diagnostico-juridico-sumindo.js).
 *
 * NÃO escreve nada no banco — só SELECT via Prisma.
 *
 * Uso:
 *   node scripts/diagnostico-duplicidade-pagamento.js --listar-franquias
 *   node scripts/diagnostico-duplicidade-pagamento.js --franquia=<id> --nome=Nadia
 *   node scripts/diagnostico-duplicidade-pagamento.js --franquia=<id> --cpf=12345678900
 *   node scripts/diagnostico-duplicidade-pagamento.js --franquia=<id> --nome=Nadia --venc-de=2026-09-01 --venc-ate=2026-09-30
 *
 * --venc-de/--venc-ate são OPCIONAIS aqui (diferente do outro script) — por
 * padrão este script busca TODAS as linhas de pagamentos_asaas do
 * associado, sem filtro de período, porque o objetivo é achar duplicidade,
 * não reproduzir uma tela filtrada. Se informados, só afetam qual período é
 * destacado no resumo final (as linhas continuam todas impressas).
 */
const { criarPrismaEscopado } = require('../src/config/prismaComEscopo');
const prismaBase = require('../src/config/prisma');

function parseArgs(argv) {
  const args = {
    listarFranquias: false,
    nome: null,
    cpf: null,
    vencDe: null,
    vencAte: null,
  };
  for (const a of argv) {
    if (a === '--listar-franquias') args.listarFranquias = true;
    else if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
    else if (a.startsWith('--nome=')) args.nome = a.slice('--nome='.length);
    else if (a.startsWith('--cpf=')) args.cpf = a.slice('--cpf='.length);
    else if (a.startsWith('--venc-de=')) args.vencDe = a.slice('--venc-de='.length);
    else if (a.startsWith('--venc-ate=')) args.vencAte = a.slice('--venc-ate='.length);
  }
  return args;
}

/** Remove acentos e normaliza caixa, pra "Nadia" bater com "Nádia" em qualquer direção. */
function normalizarTexto(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Só dígitos — pra comparar cpf_cnpj ignorando pontuação/espaços. */
function normalizarDocumento(valor) {
  return (valor || '').replace(/\D/g, '');
}

function arredondar2(valor) {
  return Math.round((Number(valor) + Number.EPSILON) * 100) / 100;
}

function formatarBRL(valor) {
  return `R$ ${arredondar2(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
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
  if (!args.nome && !args.cpf) {
    console.error('Faltou --nome=<termo> ou --cpf=<cpf_cnpj>.');
    process.exitCode = 1;
    return;
  }

  const prisma = criarPrismaEscopado(args.franquiaId);

  console.log(`=== Diagnóstico de duplicidade — franquia ${args.franquiaId} ===\n`);

  // ---------- 1. Resolve cpfCnpj-alvo por dois caminhos independentes ----------
  // Caminho A: tabela `associado` (fonte de verdade do cadastro).
  // Caminho B: campo `nome`/`cpfCnpj` gravado na própria `pagamentos_asaas`
  // (pode divergir do associado se o Asaas tiver um cadastro de cliente
  // desalinhado — vale comparar os dois).
  const cpfCnpjsAlvo = new Set();
  const nomePorCpf = new Map();

  if (args.cpf) {
    const cpfNormalizado = normalizarDocumento(args.cpf);
    cpfCnpjsAlvo.add(args.cpf);
    console.log(`Buscando por --cpf="${args.cpf}" (normalizado: "${cpfNormalizado}") — usando o valor exato informado como cpfCnpj-alvo.`);
  }

  if (args.nome) {
    const termoNormalizado = normalizarTexto(args.nome);

    const associadosBatidos = await prisma.associado.findMany({
      where: {},
      select: { id: true, nome: true, cpfCnpj: true },
    });
    const associadosMatch = associadosBatidos.filter((a) => normalizarTexto(a.nome).includes(termoNormalizado));
    for (const a of associadosMatch) {
      if (a.cpfCnpj) {
        cpfCnpjsAlvo.add(a.cpfCnpj);
        nomePorCpf.set(a.cpfCnpj, a.nome);
      }
    }
    console.log(`Caminho A (tabela associado) — nome contém "${args.nome}": ${associadosMatch.length} associado(s).`);
    for (const a of associadosMatch) console.log(`    ${a.nome}  cpf_cnpj="${a.cpfCnpj || '(vazio)'}"`);

    const pagamentosBatidos = await prisma.pagamentoAsaas.findMany({
      where: {},
      select: { cpfCnpj: true, nome: true },
      distinct: ['cpfCnpj'],
    });
    const pagamentosMatch = pagamentosBatidos.filter((p) => normalizarTexto(p.nome).includes(termoNormalizado));
    for (const p of pagamentosMatch) {
      if (p.cpfCnpj) {
        cpfCnpjsAlvo.add(p.cpfCnpj);
        if (!nomePorCpf.has(p.cpfCnpj)) nomePorCpf.set(p.cpfCnpj, p.nome);
      }
    }
    console.log(`Caminho B (tabela pagamentos_asaas, campo nome) — nome contém "${args.nome}": ${pagamentosMatch.length} cpf_cnpj distinto(s).`);
    for (const p of pagamentosMatch) console.log(`    ${p.nome}  cpf_cnpj="${p.cpfCnpj || '(vazio)'}"`);
    console.log('');
  }

  if (cpfCnpjsAlvo.size === 0) {
    console.log('Nenhum cpf_cnpj-alvo encontrado (nem via associado, nem via pagamentos_asaas.nome). Nada pra investigar — confira o termo de busca.');
    await prismaBase.$disconnect();
    return;
  }

  // ---------- 2. Todas as linhas de pagamentos_asaas pra cada cpfCnpj-alvo (SEM filtro de período) ----------
  for (const cpf of cpfCnpjsAlvo) {
    const nomeConhecido = nomePorCpf.get(cpf) || '(nome não resolvido via associado/pagamento — só o cpf_cnpj informado)';
    console.log(`=== ${nomeConhecido}  (cpf_cnpj="${cpf}") ===`);

    const linhas = await prisma.pagamentoAsaas.findMany({
      where: { cpfCnpj: cpf },
      orderBy: { dueDate: 'asc' },
      select: {
        id: true,
        customerId: true,
        nome: true,
        value: true,
        status: true,
        dueDate: true,
        dateCreated: true,
        paymentDate: true,
        description: true,
        atualizadoEm: true,
      },
    });

    if (linhas.length === 0) {
      console.log('  Nenhuma linha em pagamentos_asaas pra este cpf_cnpj — causa (c): nunca sincronizou (ver diagnostico-juridico-sumindo.js).\n');
      continue;
    }

    console.log(`  ${linhas.length} linha(s) encontrada(s):`);
    for (const l of linhas) {
      console.log(`    id="${l.id}"`);
      console.log(`      customer_id="${l.customerId}"  nome="${l.nome || ''}"`);
      console.log(`      value=${formatarBRL(l.value)}  status=${l.status}`);
      console.log(`      due_date=${l.dueDate}  date_created=${l.dateCreated || '(nulo)'}  payment_date=${l.paymentDate || '(nulo)'}`);
      console.log(`      description="${l.description || ''}"`);
      console.log(`      atualizado_em=${l.atualizadoEm ? new Date(l.atualizadoEm).toISOString() : '(nulo)'}`);
    }

    // ---------- 3. Heurística de "par duplicado": mesmo value, due_date a até 3 dias de distância, id diferente ----------
    const pares = [];
    for (let i = 0; i < linhas.length; i++) {
      for (let j = i + 1; j < linhas.length; j++) {
        const a = linhas[i];
        const b = linhas[j];
        if (a.id === b.id) continue; // impossível (PK), só por garantia
        const mesmoValor = arredondar2(a.value) === arredondar2(b.value);
        const diffDias = Math.abs((new Date(a.dueDate) - new Date(b.dueDate)) / 86400000);
        if (mesmoValor && diffDias <= 3) {
          pares.push({ a, b, diffDias });
        }
      }
    }

    if (pares.length > 0) {
      console.log(`\n  → ${pares.length} par(es) com MESMO value e due_date próximo (≤3 dias), ids diferentes — provável o par que você viu no Asaas:`);
      for (const { a, b, diffDias } of pares) {
        console.log(`    id="${a.id}" (status=${a.status}, due_date=${a.dueDate}, desc="${a.description || ''}")`);
        console.log(`    id="${b.id}" (status=${b.status}, due_date=${b.dueDate}, desc="${b.description || ''}")`);
        console.log(`    → diferença de due_date: ${diffDias} dia(s). São 2 ids do Asaas distintos, AMBOS presentes em pagamentos_asaas — confirme no Asaas se são mesmo 2 cobranças (ex.: original + negativada) ou se uma delas é erro de emissão do lado de lá; do lado daqui, as 2 estão corretamente sincronizadas como 2 linhas separadas.`);
      }
    } else if (linhas.length === 1) {
      console.log('\n  → Só 1 linha local pra este cpf_cnpj. Se no Asaas você vê 2 cobranças (a "normal" e a "negativada"), a segunda NÃO chegou em pagamentos_asaas ainda — causa (b) acima: falta backfill/reconciliação ou o webhook dela não disparou. Rode scripts/reconciliar-pagamentos-asaas.js (ou confira os logs do webhook) pra esse cliente específico.');
    } else {
      console.log('\n  → Nenhum par com value/due_date compatível encontrado entre as linhas acima — se o par que você viu no Asaas não está aqui, confira se o cpf_cnpj gravado no Asaas pra essa cobrança bate exatamente com o gravado localmente (ver diagnostico-juridico-sumindo.js, causa (b): formatação).');
    }
    console.log('');
  }

  if (args.vencDe && args.vencAte) {
    console.log(`(Filtro --venc-de=${args.vencDe} --venc-ate=${args.vencAte} informado só pra referência — todas as linhas acima foram impressas independente do período.)`);
  }

  console.log('=== Fim — cola este console inteiro de volta na conversa ===');
  await prismaBase.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  process.exitCode = 1;
});
