/**
 * Diagnóstico pontual (não escreve nada no banco) para investigar
 * associados que têm card real no quadro Jurídico mas somem dos totais da
 * tela "Taxa de Inadimplência" quando o filtro "Jurídico" está ativo (ex.:
 * Fernanda, R$ 42.455,77 no card, ausente dos totais no período
 * 01/01–31/08/2026).
 *
 * Achado de leitura de código (motivo deste script existir): o valor
 * mostrado no CARD do Jurídico ("valor_em_aberto", ver
 * `valorEmAberto`/`serializeCard` em juridico.controller.js) vem da tabela
 * `cobrancas` (sync antigo via n8n, `POST /api/sync`). Os totais da tela
 * "Taxa de Inadimplência" (`GET /resumo`) vêm de uma tabela DIFERENTE,
 * `pagamentos_asaas` (sync novo via webhook/backfill do Asaas, AJUSTE 14).
 * As duas nunca se tocam por FK — só por `cpf_cnpj` (string), cruzado em
 * tempo de consulta com IGUALDADE EXATA (`buscarCpfCnpjComCardJuridico` /
 * `resolverAssociadosPorCpfCnpj`, ambas em inadimplencia.controller.js).
 * Duas causas prováveis, nesta ordem:
 *   (a) o associado não tem NENHUMA linha em `pagamentos_asaas` ainda
 *       (nunca passou pelo backfill/webhook novo, só está em `cobrancas`
 *       via n8n) — o valor existe de verdade, mas nunca chegou na fonte
 *       que a tela nova usa, com ou sem o filtro Jurídico;
 *   (b) o associado TEM linhas em `pagamentos_asaas`, mas o `cpf_cnpj`
 *       gravado lá não bate, caractere por caractere, com o `cpf_cnpj`
 *       gravado em `associados` (ex.: "123.456.789-00" vs "12345678900" —
 *       o `/api/sync`, que alimenta `associados`, grava o valor como vier
 *       no payload, SEM normalizar; o backfill/webhook do Asaas, que
 *       alimenta `pagamentos_asaas`, grava como a API do Asaas devolve).
 *       Se for isso, o problema é mais amplo que só o filtro Jurídico —
 *       quebra também o cruzamento antigo (nome/em_juridico legado/
 *       bloqueado, `resolverAssociadosPorCpfCnpj` faz o mesmo match
 *       exato).
 *   (c) `dueDate` das cobranças reais cai fora de 01/01–31/08/2026
 *       (comportamento esperado, sem bug).
 *
 * IMPORTANTE — onde rodar:
 *   Este script precisa da MESMA DATABASE_URL que o backend de PRODUÇÃO
 *   usa hoje (senão não há dado real pra comparar). Rode dentro do
 *   ambiente/container onde o backend está implantado (ex.: um shell
 *   dentro do serviço no EasyPanel, ou `docker compose exec api sh` se a
 *   stack rodar via docker-compose local) — mesma orientação de
 *   diagnostico-ajuste8.js.
 *
 * NÃO escreve nada: só SELECT no Postgres via Prisma. Seguro rodar quantas
 * vezes quiser.
 *
 * Uso:
 *   node scripts/diagnostico-juridico-sumindo.js --listar-franquias
 *   node scripts/diagnostico-juridico-sumindo.js --franquia=<id>
 *   node scripts/diagnostico-juridico-sumindo.js --franquia=<id> --nomes="Fernanda,Nadia,Malu,Joyce"
 *   node scripts/diagnostico-juridico-sumindo.js --franquia=<id> --venc-de=2026-01-01 --venc-ate=2026-08-31
 *   node scripts/diagnostico-juridico-sumindo.js --franquia=<id> --nomes-controle="Nome que ainda aparece no filtro"
 *
 * --nomes-controle (opcional): roda a mesma comparação exato x normalizado
 * pra associados que CONTINUAM aparecendo no filtro, pra comparação lado a
 * lado (se eles derem match_exato === match_normalizado e os que somem
 * derem match_normalizado > match_exato, fecha a causa (b) por
 * comparação direta).
 */
const { criarPrismaEscopado } = require('../src/config/prismaComEscopo');
const prismaBase = require('../src/config/prisma');

const NOMES_PADRAO = ['fernanda', 'nadia', 'nádia', 'malu', 'joyce'];

function parseArgs(argv) {
  const args = {
    vencDe: '2026-01-01',
    vencAte: '2026-08-31',
    listarFranquias: false,
    nomes: NOMES_PADRAO,
    nomesControle: [],
  };
  for (const a of argv) {
    if (a === '--listar-franquias') args.listarFranquias = true;
    else if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
    else if (a.startsWith('--venc-de=')) args.vencDe = a.slice('--venc-de='.length);
    else if (a.startsWith('--venc-ate=')) args.vencAte = a.slice('--venc-ate='.length);
    else if (a.startsWith('--nomes=')) {
      args.nomes = a
        .slice('--nomes='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a.startsWith('--nomes-controle=')) {
      args.nomesControle = a
        .slice('--nomes-controle='.length)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    }
  }
  return args;
}

/** Remove acentos e normaliza caixa, pra "Nadia" bater com "Nádia" em qualquer direção sem depender de extensão do Postgres. */
function normalizarTexto(texto) {
  return (texto || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** Só dígitos — pra comparar cpf_cnpj ignorando pontuação/espaços (hipótese de causa (b)). */
function normalizarDocumento(valor) {
  return (valor || '').replace(/\D/g, '');
}

function arredondar2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function formatarBRL(valor) {
  return `R$ ${arredondar2(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Busca associados da franquia cujo nome contenha qualquer um dos termos (case/acento-insensível). */
async function buscarAssociadosPorNome(prisma, termos) {
  const todos = await prisma.associado.findMany({
    select: { id: true, franquiaId: true, nome: true, cpfCnpj: true, emJuridico: true },
    orderBy: { nome: 'asc' },
  });
  const termosNormalizados = termos.map(normalizarTexto);
  return todos.filter((a) => {
    const nomeNormalizado = normalizarTexto(a.nome);
    return termosNormalizados.some((t) => t && nomeNormalizado.includes(t));
  });
}

/**
 * Pra cada associado, roda a comparação exato x normalizado contra
 * `pagamentos_asaas` e devolve um resumo por associado + as linhas de
 * detalhe (só match normalizado) pra impressão.
 */
async function compararComPagamentosAsaas(prisma, associados, vencDe, vencAte) {
  // Todos os pagamentos com cpf_cnpj preenchido da franquia (a extension de
  // escopo já injeta franquiaId no where) — filtra em JS por associado, em
  // vez de N idas ao banco, pra permitir a comparação normalizada também.
  const pagamentos = await prisma.pagamentoAsaas.findMany({
    where: { cpfCnpj: { not: null } },
    select: { id: true, cpfCnpj: true, franquiaId: true, dueDate: true, value: true, status: true },
  });

  const resumos = [];
  const detalhesNormalizado = [];
  for (const associado of associados) {
    const cpfAssociadoNormalizado = normalizarDocumento(associado.cpfCnpj);

    const matchExato = pagamentos.filter((p) => p.cpfCnpj === associado.cpfCnpj);
    const matchNormalizado = pagamentos.filter((p) => normalizarDocumento(p.cpfCnpj) === cpfAssociadoNormalizado);

    const dentroDoPeriodo = (lista) => lista.filter((p) => p.dueDate >= vencDe && p.dueDate <= vencAte);

    resumos.push({
      associado,
      totalMatchExato: matchExato.length,
      totalMatchNormalizado: matchNormalizado.length,
      dentroDoPeriodoExato: dentroDoPeriodo(matchExato).length,
      dentroDoPeriodoNormalizado: dentroDoPeriodo(matchNormalizado).length,
      dueDateMin: matchNormalizado.length ? matchNormalizado.map((p) => p.dueDate).sort()[0] : null,
      dueDateMax: matchNormalizado.length ? matchNormalizado.map((p) => p.dueDate).sort().slice(-1)[0] : null,
    });

    // Só interessa mostrar detalhe quando o match normalizado achou algo
    // que o match exato NÃO achou — é exatamente a evidência da causa (b).
    if (matchNormalizado.length > matchExato.length) {
      const idsExatos = new Set(matchExato.map((p) => p.id));
      for (const p of matchNormalizado.filter((p) => !idsExatos.has(p.id))) {
        detalhesNormalizado.push({
          nome: associado.nome,
          cpfAssociadoBruto: associado.cpfCnpj,
          franquiaAssociado: associado.franquiaId,
          pagamentoId: p.id,
          cpfPagamentoBruto: p.cpfCnpj,
          franquiaPagamento: p.franquiaId,
          dueDate: p.dueDate,
          value: p.value,
          status: p.status,
        });
      }
    }
  }
  return { resumos, detalhesNormalizado };
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

  console.log(`\n=== Diagnóstico "Jurídico sumindo" — franquia ${franquiaId} — período ${vencDe} a ${vencAte} ===`);
  console.log(`Nomes procurados: ${args.nomes.join(', ')}\n`);

  // ---------- 0. Franquias, pra contexto rápido (multi-tenant?) ----------
  const franquias = await prismaBase.franquia.findMany({ select: { id: true, nome: true } });
  console.log(`=== 0 — Franquias cadastradas (${franquias.length}) ===`);
  for (const f of franquias) console.log(`  ${f.id}  ${f.nome}`);
  console.log('');

  // ---------- 1. Associados candidatos ----------
  const associados = await buscarAssociadosPorNome(prisma, args.nomes);
  console.log(`=== 1 — Associados encontrados (${associados.length}) ===`);
  if (associados.length === 0) {
    console.log('  Nenhum associado bateu com os nomes procurados nesta franquia — confira --nomes ou --franquia.');
  }
  for (const a of associados) {
    console.log(`  ${a.nome}`);
    console.log(`    id: ${a.id}  franquia_id: ${a.franquiaId}  em_juridico: ${a.emJuridico}`);
    console.log(`    cpf_cnpj: "${a.cpfCnpj}"  (${a.cpfCnpj.length} caracteres)`);
  }
  console.log('');

  if (associados.length === 0) {
    await prismaBase.$disconnect();
    return;
  }
  const idsAssociados = associados.map((a) => a.id);

  // ---------- 2. Cards reais no Jurídico ----------
  const cards = await prisma.cardJuridico.findMany({
    where: { associadoId: { in: idsAssociados } },
    include: { etapa: { select: { nome: true } } },
  });
  console.log(`=== 2 — Cards reais no quadro Jurídico (${cards.length}) ===`);
  const cardsPorAssociado = new Map();
  for (const c of cards) {
    if (!cardsPorAssociado.has(c.associadoId)) cardsPorAssociado.set(c.associadoId, []);
    cardsPorAssociado.get(c.associadoId).push(c);
  }
  for (const a of associados) {
    const cardsDele = cardsPorAssociado.get(a.id) || [];
    if (cardsDele.length === 0) {
      console.log(`  ${a.nome}: NENHUM card real encontrado (inesperado, confirme o nome/franquia)`);
    } else {
      for (const c of cardsDele) {
        console.log(`  ${a.nome}: card ${c.id}  etapa="${c.etapa?.nome ?? '?'}"  franquia_id=${c.franquiaId}  criado_em=${c.criadoEm.toISOString().slice(0, 10)}`);
      }
    }
  }
  console.log('');

  // ---------- 3. Cobranças (fonte do valor mostrado no CARD) ----------
  const cobrancas = await prisma.cobranca.findMany({
    where: { associadoId: { in: idsAssociados } },
    orderBy: [{ associadoId: 'asc' }, { vencimento: 'asc' }],
  });
  const COBRANCAS_ABERTAS = ['pending', 'overdue'];
  console.log(`=== 3 — Cobranças (tabela "cobrancas", sync n8n — é daqui que vem o valor do card) ===`);
  for (const a of associados) {
    const dele = cobrancas.filter((c) => c.associadoId === a.id);
    const abertas = dele.filter((c) => COBRANCAS_ABERTAS.includes(c.status));
    const valorEmAbertoCard = abertas.reduce((soma, c) => soma + Number(c.valor), 0);
    const vencimentos = abertas.map((c) => c.vencimento.toISOString().slice(0, 10)).sort();
    console.log(`  ${a.nome}:`);
    console.log(`    total de cobranças: ${dele.length}  (pending/overdue: ${abertas.length})`);
    console.log(`    valor_em_aberto (reproduz o valor do card): ${formatarBRL(valorEmAbertoCard)}`);
    if (vencimentos.length) {
      console.log(`    vencimento das cobranças em aberto: ${vencimentos[0]} a ${vencimentos[vencimentos.length - 1]}`);
    }
  }
  console.log('');

  // ---------- 4/5/6. pagamentos_asaas — match exato x normalizado ----------
  const { resumos, detalhesNormalizado } = await compararComPagamentosAsaas(prisma, associados, vencDe, vencAte);
  console.log('=== 4/5 — pagamentos_asaas: match exato de cpf_cnpj x match só-dígitos (normalizado) ===');
  console.log('    (se "normalizado" > "exato" pra algum associado, achamos a causa (b): formatação de cpf_cnpj divergente)\n');
  for (const r of resumos) {
    console.log(`  ${r.associado.nome}:`);
    console.log(`    match exato:       ${r.totalMatchExato} pagamento(s) no total, ${r.dentroDoPeriodoExato} dentro de ${vencDe}..${vencAte}`);
    console.log(`    match normalizado: ${r.totalMatchNormalizado} pagamento(s) no total, ${r.dentroDoPeriodoNormalizado} dentro de ${vencDe}..${vencAte}`);
    if (r.dueDateMin) console.log(`    due_date (match normalizado): ${r.dueDateMin} a ${r.dueDateMax}`);
    if (r.totalMatchExato === 0 && r.totalMatchNormalizado === 0) {
      console.log('    => CAUSA (a): nenhuma linha em pagamentos_asaas, nem por match exato nem normalizado — nunca passou pelo backfill/webhook novo.');
    } else if (r.totalMatchNormalizado > r.totalMatchExato) {
      console.log('    => CAUSA (b): existem linhas em pagamentos_asaas, mas só aparecem com o cpf_cnpj normalizado — formatação divergente entre associados.cpf_cnpj e pagamentos_asaas.cpf_cnpj.');
    } else if (r.dentroDoPeriodoExato === 0 && r.totalMatchExato > 0) {
      console.log('    => CAUSA (c): tem pagamento(s) com match exato, mas nenhum com due_date dentro do período pedido — comportamento esperado, sem bug.');
    } else {
      console.log('    => match exato já cobre tudo dentro do período — se ainda assim sumiu do filtro Jurídico, não é causa (a)/(b)/(c); precisa olhar o card em si (etapa/franquia do card).');
    }
  }
  console.log('');

  if (detalhesNormalizado.length) {
    console.log(`=== 6 — Detalhe das linhas que só aparecem com cpf_cnpj normalizado (evidência da causa (b), ${detalhesNormalizado.length} linha(s)) ===`);
    for (const d of detalhesNormalizado) {
      console.log(`  ${d.nome}`);
      console.log(`    associados.cpf_cnpj:       "${d.cpfAssociadoBruto}"  (franquia ${d.franquiaAssociado})`);
      console.log(`    pagamentos_asaas.cpf_cnpj: "${d.cpfPagamentoBruto}"  (franquia ${d.franquiaPagamento}, pagamento ${d.pagamentoId})`);
      console.log(`    due_date=${d.dueDate}  value=${formatarBRL(Number(d.value))}  status=${d.status}`);
    }
    console.log('');
  }

  // ---------- 7. Controle (opcional) — associados que ainda aparecem no filtro ----------
  if (args.nomesControle.length) {
    const controle = await buscarAssociadosPorNome(prisma, args.nomesControle);
    console.log(`=== 7 — Controle: associados que CONTINUAM aparecendo no filtro (${controle.length}) ===`);
    const { resumos: resumosControle } = await compararComPagamentosAsaas(prisma, controle, vencDe, vencAte);
    for (const r of resumosControle) {
      console.log(`  ${r.associado.nome}: match exato=${r.totalMatchExato}  match normalizado=${r.totalMatchNormalizado}  ${r.totalMatchExato === r.totalMatchNormalizado ? '(iguais, como esperado pra quem funciona)' : '(DIFERENTES — inesperado pra um associado que funciona)'}`);
    }
    console.log('');
  }

  console.log('=== Fim — cola este console inteiro de volta na conversa ===');
  await prismaBase.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
