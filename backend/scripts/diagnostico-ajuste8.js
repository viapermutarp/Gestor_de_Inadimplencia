/**
 * Diagnóstico pontual (não roda em produção, não escreve nada no banco nem
 * no Asaas) para investigar duas divergências reportadas na tela "Taxa de
 * Inadimplência %":
 *
 *   1. "111 cobranças excluídas (R$ 150.489,54)" no sistema x "107 cobranças,
 *      R$ 142.865,93" reproduzidos manualmente pelo operador com a mesma
 *      lista de 22 palavras-chave/CPF/CNPJ. Este script reproduz EXATAMENTE
 *      a lógica de `separarExcluidos`/`buscarPagamentosValidos`
 *      (src/controllers/inadimplencia.controller.js, AJUSTE 7) e imprime a
 *      lista completa das cobranças excluídas, com o motivo de cada uma
 *      (manual, descrição, CPF/CNPJ ou nome — e qual termo configurado
 *      bateu), pra comparar linha a linha com a lista de 107 já levantada.
 *
 *   2. "Associados Inadimplentes: 16" no sistema x 89 (critério histórico)
 *      e 23 (critério "em aberto hoje", OVERDUE+CONFIRMED) reproduzidos
 *      manualmente. Este script reproduz a lógica EXATA de produção
 *      (`identificadoresInadimplentes` em `exports.resumo`): distintos por
 *      CPF/CNPJ (fallback pro ID do cliente no Asaas) com pelo menos 1
 *      cobrança `status === "OVERDUE"` cujo VENCIMENTO caia dentro de
 *      `--vencDe`/`--vencAte` — e imprime, lado a lado, 2 variações pra
 *      isolar cada hipótese: (i) mesmo período mas incluindo também
 *      CONFIRMED, e (ii) com `--historico-completo`, o mesmo critério mas
 *      SEM restringir por período (todo o histórico do Asaas) — pra
 *      confirmar se o card é "sempre hoje, ao vivo" ou preso ao período.
 *
 * IMPORTANTE — onde rodar:
 *   Este script precisa da MESMA DATABASE_URL e da MESMA chave do Asaas que
 *   o backend de PRODUÇÃO usa hoje (senão os números não vão bater com o
 *   que a tela mostra). Rode dentro do ambiente/container onde o backend
 *   real está implantado (ex.: um shell dentro do serviço no EasyPanel, ou
 *   `docker-compose exec backend sh` se a stack de produção rodar via
 *   docker-compose) — não faz sentido rodar contra um Postgres/chave de
 *   desenvolvimento vazios, o resultado não vai ter nada pra comparar.
 *
 * NÃO escreve nada: só GET na API do Asaas e SELECT no Postgres (via
 * Prisma). Seguro rodar quantas vezes quiser.
 *
 * Uso:
 *   node scripts/diagnostico-ajuste8.js --franquia=<id>
 *   node scripts/diagnostico-ajuste8.js --franquia=<id> --vencDe=2026-01-01 --vencAte=2026-08-31
 *   node scripts/diagnostico-ajuste8.js --franquia=<id> --historico-completo
 *   node scripts/diagnostico-ajuste8.js --listar-franquias   # não precisa de --franquia, só lista IDs/nomes
 *
 * Saída: um resumo no console (pra colar de volta na conversa) + 2 CSVs em
 * ./diagnostico-saida/ (exclusoes-detalhado.csv e
 * associados-inadimplentes-detalhado.csv) pra conferência linha a linha
 * contra a planilha exportada do Asaas.
 */
const fs = require('fs');
const path = require('path');

const { criarPrismaEscopado } = require('../src/config/prismaComEscopo');
const prismaBase = require('../src/config/prisma');
const { getAsaasApiKey, getPalavrasExcluidas, getDiasTolerancia } = require('../src/services/config.service');
const { listarPagamentos, obterClientesPorId } = require('../src/services/asaas.service');

function parseArgs(argv) {
  const args = { vencDe: '2026-01-01', vencAte: '2026-08-31', historicoCompleto: false, listarFranquias: false };
  for (const a of argv) {
    if (a === '--historico-completo') args.historicoCompleto = true;
    else if (a === '--listar-franquias') args.listarFranquias = true;
    else if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
    else if (a.startsWith('--vencDe=')) args.vencDe = a.slice('--vencDe='.length);
    else if (a.startsWith('--vencAte=')) args.vencAte = a.slice('--vencAte='.length);
  }
  return args;
}

function formatarDataISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function arredondar2(valor) {
  return Math.round((valor + Number.EPSILON) * 100) / 100;
}

function normalizarDocumento(valor) {
  return (valor || '').replace(/\D/g, '');
}

function csvEscape(valor) {
  const s = valor === null || valor === undefined ? '' : String(valor);
  if (/[",;\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function escreverCsv(caminho, colunas, linhas) {
  const conteudo = [colunas.join(';'), ...linhas.map((l) => colunas.map((c) => csvEscape(l[c])).join(';'))].join('\n');
  fs.mkdirSync(path.dirname(caminho), { recursive: true });
  fs.writeFileSync(caminho, conteudo, 'utf-8');
}

/** Reproduz resolverPagamento (controller) — nome/cpfCnpj resolvidos do associado local, com fallback pro Asaas. */
function resolverPagamento(pagamento, mapaClientes, associadoPorCpfCnpj) {
  const cliente = mapaClientes.get(pagamento.customer);
  const cpfCnpj = cliente?.cpfCnpj || null;
  const associado = cpfCnpj ? associadoPorCpfCnpj.get(cpfCnpj) : undefined;
  return { cpfCnpj, nome: associado?.nome || cliente?.nome || null };
}

/**
 * Reproduz separarExcluidos (AJUSTE 7), mas devolvendo o MOTIVO de cada
 * exclusão em vez de só quantidade/valor agregados — é a única diferença
 * em relação ao código real do controller.
 */
function classificarExclusao(pagamento, idsExcluidos, palavras, mapaClientes, associadoPorCpfCnpj) {
  if (idsExcluidos.has(pagamento.id)) {
    return { excluido: true, motivo: 'manual', termo: '(ID cadastrado em Gerenciar exclusões)' };
  }

  const palavrasValidas = palavras.filter(Boolean);
  if (palavrasValidas.length === 0) return { excluido: false };

  const descricao = (pagamento.description || '').toLowerCase();
  for (const original of palavrasValidas) {
    if (descricao.includes(original.toLowerCase())) {
      return { excluido: true, motivo: 'descricao', termo: original };
    }
  }

  const { cpfCnpj, nome } = resolverPagamento(pagamento, mapaClientes, associadoPorCpfCnpj);
  const cpfCnpjDocumento = normalizarDocumento(cpfCnpj);
  if (cpfCnpjDocumento) {
    for (const original of palavrasValidas) {
      const termoDocumento = normalizarDocumento(original);
      if (termoDocumento && cpfCnpjDocumento.includes(termoDocumento)) {
        return { excluido: true, motivo: 'cpf_cnpj', termo: original, cpfCnpj, nome };
      }
    }
  }

  const nomeMinusculo = (nome || '').toLowerCase();
  if (nomeMinusculo) {
    for (const original of palavrasValidas) {
      if (nomeMinusculo.includes(original.toLowerCase())) {
        return { excluido: true, motivo: 'nome', termo: original, cpfCnpj, nome };
      }
    }
  }

  return { excluido: false, cpfCnpj, nome };
}

/** Distintos por CPF/CNPJ (fallback pro ID do Asaas) entre pagamentos com status em `statusValidos`. */
function contarDistintosPorStatus(pagamentos, statusValidos, mapaClientes, associadoPorCpfCnpj) {
  const acumulado = new Map();
  for (const p of pagamentos) {
    if (!statusValidos.includes(p.status)) continue;
    const { cpfCnpj, nome } = resolverPagamento(p, mapaClientes, associadoPorCpfCnpj);
    const identificador = cpfCnpj || p.customer;
    const item = acumulado.get(identificador) || {
      identificador,
      cpf_cnpj: cpfCnpj || identificador,
      nome: nome || identificador,
      quantidade: 0,
      valor: 0,
    };
    item.quantidade += 1;
    item.valor += Number(p.value) || 0;
    acumulado.set(identificador, item);
  }
  return acumulado;
}

async function resolverTudo(prisma, franquiaId, pagamentos) {
  const idsUnicos = [...new Set(pagamentos.map((p) => p.customer).filter(Boolean))];
  const mapaClientes = await obterClientesPorId(idsUnicos, franquiaId);
  const cpfCnpjsResolvidos = [...new Set([...mapaClientes.values()].map((c) => c.cpfCnpj).filter(Boolean))];
  const associadosLocais = cpfCnpjsResolvidos.length
    ? await prisma.associado.findMany({
        where: { cpfCnpj: { in: cpfCnpjsResolvidos } },
        select: { cpfCnpj: true, nome: true, emNegociacao: true, emJuridico: true, bloqueado: true },
      })
    : [];
  const associadoPorCpfCnpj = new Map(associadosLocais.map((a) => [a.cpfCnpj, a]));
  return { mapaClientes, associadoPorCpfCnpj };
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

  const { franquiaId, vencDe, vencAte, historicoCompleto } = args;
  const prisma = criarPrismaEscopado(franquiaId);

  const chaveConfigurada = await getAsaasApiKey(franquiaId);
  if (!chaveConfigurada) {
    console.error(`Franquia ${franquiaId} não tem chave do Asaas configurada (PATCH /api/config/asaas-key). Abortando.`);
    process.exitCode = 1;
    return;
  }

  console.log(`\n=== Diagnóstico AJUSTE 8 — franquia ${franquiaId} — período ${vencDe} a ${vencAte} ===\n`);

  const [{ palavras }, diasTolerancia, registrosIgnorados] = await Promise.all([
    (async () => ({ palavras: await getPalavrasExcluidas(franquiaId) }))(),
    getDiasTolerancia(franquiaId),
    prisma.cobrancaIgnorada.findMany({ select: { asaasPaymentId: true } }),
  ]);
  const idsExcluidos = new Set(registrosIgnorados.map((r) => r.asaasPaymentId));

  console.log(`Palavras-chave/CPF/CNPJ configurados (${palavras.filter(Boolean).length}):`, palavras.filter(Boolean));
  console.log(`IDs na lista manual de exclusão: ${idsExcluidos.size}`);
  console.log(`Tolerância configurada: ${diasTolerancia} dia(s)\n`);

  console.log('Buscando pagamentos no Asaas (pode levar alguns segundos)...');
  const pagamentos = await listarPagamentos({ dueDateGe: vencDe, dueDateLe: vencAte }, franquiaId);
  console.log(`Total de cobranças no período (qualquer status): ${pagamentos.length}\n`);

  console.log('Resolvendo clientes/associados (nome, CPF/CNPJ)...');
  const { mapaClientes, associadoPorCpfCnpj } = await resolverTudo(prisma, franquiaId, pagamentos);
  console.log(`Clientes distintos resolvidos: ${mapaClientes.size}\n`);

  // ---------- PARTE 1: exclusões, com motivo ----------
  const linhasExcluidas = [];
  let somaExcluidos = 0;
  const pagamentosValidos = [];
  for (const p of pagamentos) {
    const resultado = classificarExclusao(p, idsExcluidos, palavras, mapaClientes, associadoPorCpfCnpj);
    if (resultado.excluido) {
      const valor = Number(p.value) || 0;
      somaExcluidos += valor;
      const { cpfCnpj, nome } = resolverPagamento(p, mapaClientes, associadoPorCpfCnpj);
      linhasExcluidas.push({
        asaas_payment_id: p.id,
        cpf_cnpj: resultado.cpfCnpj || cpfCnpj || '',
        nome: resultado.nome || nome || '',
        valor: arredondar2(valor),
        vencimento: p.dueDate,
        status: p.status,
        motivo: resultado.motivo,
        termo_que_bateu: resultado.termo || '',
      });
    } else {
      pagamentosValidos.push(p);
    }
  }

  console.log('=== PARTE 1 — Exclusões (manual + palavra-chave/CPF/CNPJ/nome) ===');
  console.log(`Reproduzido agora: ${linhasExcluidas.length} cobranças, R$ ${arredondar2(somaExcluidos).toFixed(2)}`);
  console.log('Compare com o que a tela reporta em "excluidos" pro MESMO período (deveria bater com "111 / R$ 150.489,54" se o período na tela for o mesmo).');
  const porMotivo = {};
  for (const l of linhasExcluidas) porMotivo[l.motivo] = (porMotivo[l.motivo] || 0) + 1;
  console.log('Por motivo:', porMotivo, '\n');

  const arquivoExclusoes = path.join(__dirname, '..', 'diagnostico-saida', 'exclusoes-detalhado.csv');
  escreverCsv(
    arquivoExclusoes,
    ['asaas_payment_id', 'cpf_cnpj', 'nome', 'valor', 'vencimento', 'status', 'motivo', 'termo_que_bateu'],
    linhasExcluidas
  );
  console.log(`Lista completa salva em: ${arquivoExclusoes}\n`);

  // ---------- PARTE 2: associados_inadimplentes ----------
  const hojeStr = formatarDataISO(new Date());
  console.log('=== PARTE 2 — "Associados Inadimplentes" ===');
  console.log(`(hoje = ${hojeStr}; sem nenhum filtro de renegociação/jurídico/bloqueado ativo — cenário "todos/todos/todos", o padrão da tela)\n`);

  const distintosProducao = contarDistintosPorStatus(pagamentosValidos, ['OVERDUE'], mapaClientes, associadoPorCpfCnpj);
  console.log(`(a) Reprodução EXATA da produção — OVERDUE hoje, só cobranças com vencimento em [${vencDe}, ${vencAte}]: ${distintosProducao.size} associados distintos`);

  const distintosAmploPeriodo = contarDistintosPorStatus(pagamentosValidos, ['OVERDUE', 'CONFIRMED'], mapaClientes, associadoPorCpfCnpj);
  console.log(`(b) Comparação — OVERDUE + CONFIRMED hoje, mesmo período [${vencDe}, ${vencAte}] (NÃO é o que a produção usa hoje): ${distintosAmploPeriodo.size} associados distintos`);

  const arquivoAssociados = path.join(__dirname, '..', 'diagnostico-saida', 'associados-inadimplentes-detalhado.csv');
  escreverCsv(
    arquivoAssociados,
    ['cpf_cnpj', 'nome', 'quantidade', 'valor'],
    [...distintosProducao.values()].map((v) => ({ ...v, valor: arredondar2(v.valor) }))
  );
  console.log(`Lista dos ${distintosProducao.size} associados (critério real de produção) salva em: ${arquivoAssociados}`);

  if (historicoCompleto) {
    console.log('\n--historico-completo: buscando TODO o histórico do Asaas (sem restringir por vencimento) — pode demorar bem mais...');
    const dataMuitoAntiga = '2015-01-01';
    const pagamentosTodoHistorico = await listarPagamentos({ dueDateGe: dataMuitoAntiga, dueDateLe: hojeStr }, franquiaId);
    console.log(`Total no histórico completo (qualquer status, até hoje): ${pagamentosTodoHistorico.length}`);

    const { mapaClientes: mapaClientes2, associadoPorCpfCnpj: associadoPorCpfCnpj2 } = await resolverTudo(
      prisma,
      franquiaId,
      pagamentosTodoHistorico
    );

    const pagamentosValidosTodoHistorico = pagamentosTodoHistorico.filter(
      (p) => !classificarExclusao(p, idsExcluidos, palavras, mapaClientes2, associadoPorCpfCnpj2).excluido
    );

    const distintosSemPeriodoOverdue = contarDistintosPorStatus(pagamentosValidosTodoHistorico, ['OVERDUE'], mapaClientes2, associadoPorCpfCnpj2);
    console.log(`(c) OVERDUE hoje, SEM restringir por período (todo o histórico): ${distintosSemPeriodoOverdue.size} associados distintos`);

    const distintosSemPeriodoAmplo = contarDistintosPorStatus(
      pagamentosValidosTodoHistorico,
      ['OVERDUE', 'CONFIRMED'],
      mapaClientes2,
      associadoPorCpfCnpj2
    );
    console.log(`(d) OVERDUE + CONFIRMED hoje, SEM restringir por período (todo o histórico): ${distintosSemPeriodoAmplo.size} associados distintos`);

    console.log(
      '\nSe (c) ou (d) baterem com os números que você levantou manualmente (89 ou 23), a causa da divergência é o card estar restrito ao período ' +
        'selecionado na tela (vencimento dentro de venc_de/venc_ate) em vez de ser "sempre hoje, independente do período" — apesar do comentário no ' +
        'código descrever a intenção como "snapshot de hoje, métrica operacional".'
    );
  } else {
    console.log('\n(Rode de novo com --historico-completo pra testar a hipótese de o card ser "sempre hoje", sem respeitar o período da tela.)');
  }

  await prismaBase.$disconnect();
}

main().catch((err) => {
  console.error('ERRO:', err);
  process.exitCode = 1;
});
