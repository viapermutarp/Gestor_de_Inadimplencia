const prisma = require('../config/prisma');
const { listarPagamentos, obterClientesPorId } = require('./asaas.service');

/**
 * AJUSTE 14 — "Tabela local sincronizada via webhook do Asaas para Taxa de
 * Inadimplência". Lógica compartilhada de upsert/sincronização da tabela
 * "pagamentos_asaas" (ver docblock do model em schema.prisma), usada pelos
 * 3 caminhos que a alimentam:
 *   1. Webhook em tempo real (src/controllers/asaasWebhook.controller.js) —
 *      um evento de cada vez, upsert imediato + resolução de cliente em
 *      segundo plano.
 *   2. Backfill inicial (scripts/backfill-pagamentos-asaas.js) — histórico
 *      completo de uma franquia, de uma vez só.
 *   3. Reconciliação periódica (scripts/reconciliar-pagamentos-asaas.js e
 *      POST /api/inadimplencia/reconciliar-pagamentos) — uma janela recente,
 *      repetida com frequência, corrigindo qualquer divergência.
 *
 * Nenhum destes 3 caminhos reimplementa a lógica de upsert/diff — todos
 * chamam as funções daqui.
 */

/** Eventos do webhook do Asaas tratados como upsert (ver docblock do controller do webhook). */
const EVENTOS_WEBHOOK_UPSERT = new Set([
  'PAYMENT_CREATED',
  'PAYMENT_UPDATED',
  'PAYMENT_CONFIRMED',
  'PAYMENT_RECEIVED',
  'PAYMENT_OVERDUE',
  'PAYMENT_RESTORED',
  'PAYMENT_REFUNDED',
  'PAYMENT_CHARGEBACK_REQUESTED',
  'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_AWAITING_CHARGEBACK_REVERSAL',
]);
const EVENTO_WEBHOOK_DELETE = 'PAYMENT_DELETED';

/**
 * Upsert de UM pagamento (mesmo formato "cru" do Asaas — tanto o payload do
 * webhook quanto o retorno de `listarPagamentos` usam os mesmos nomes de
 * campo: id/customer/value/dueDate/paymentDate/status/description) na
 * tabela local. "id" é o próprio "pay_..." do Asaas — upsert por esse id é
 * o que torna isto naturalmente idempotente: aplicar o mesmo evento (ou
 * reprocessar o mesmo pagamento no backfill/reconciliação) 2x só upserta a
 * mesma linha pro mesmo estado final, nunca duplica.
 *
 * "clienteResolvido" ({cpfCnpj, nome} ou null): quando informado (backfill/
 * reconciliação, que já resolveram o cliente ANTES de chamar isto, em lote
 * — ver `sincronizarJanela` abaixo), grava cpfCnpj/nome junto. Quando
 * `null`/omitido (webhook — nunca espera a resolução de cliente antes de
 * responder 200, ver docblock do controller), NÃO altera cpfCnpj/nome de um
 * registro já existente (preserva o que já estava cacheado) e cria um
 * registro novo com os dois em branco, a serem preenchidos depois por
 * `resolverClienteEmSegundoPlano`.
 *
 * "franquiaId" é sempre passado explicitamente nos dados (nunca confiado só
 * à injeção automática da extension de escopo — ver prismaComEscopo.js),
 * então esta função funciona tanto com um client já escopado (webhook, via
 * `criarPrismaEscopado`) quanto com o client global sem escopo (scripts).
 */
async function upsertPagamento(prismaCliente, franquiaId, payment, clienteResolvido) {
  const dadosComuns = {
    franquiaId,
    customerId: payment.customer,
    value: payment.value,
    dueDate: payment.dueDate,
    paymentDate: payment.paymentDate || null,
    status: payment.status,
    description: payment.description || null,
  };

  await prismaCliente.pagamentoAsaas.upsert({
    where: { id: payment.id },
    create: {
      id: payment.id,
      ...dadosComuns,
      cpfCnpj: clienteResolvido?.cpfCnpj ?? null,
      nome: clienteResolvido?.nome ?? null,
    },
    update: {
      ...dadosComuns,
      ...(clienteResolvido ? { cpfCnpj: clienteResolvido.cpfCnpj, nome: clienteResolvido.nome } : {}),
    },
  });
}

/** Remove um pagamento da tabela local (evento PAYMENT_DELETED) — idempotente: remover algo que já não existe é um no-op silencioso. */
async function excluirPagamento(franquiaId, paymentId) {
  await prisma.pagamentoAsaas.deleteMany({ where: { id: paymentId, franquiaId } });
}

/**
 * Resolve (GET /v3/customers/{id} do Asaas) e grava cpfCnpj/nome de UM
 * pagamento — só quando ainda estão nulos (nunca sobrescreve um valor já
 * cacheado; mesmo padrão de `nome_asaas` do associado, AJUSTE 9). Chamada
 * pelo webhook em segundo plano, DEPOIS de já ter respondido 200 (nunca
 * "await"ada antes da resposta — ver docblock do controller do webhook,
 * "responder 200 rápido"). Uma falha aqui (Asaas fora do ar, cliente
 * removido, etc.) é só logada — o pagamento em si já foi salvo
 * corretamente, só fica sem cpfCnpj/nome até a próxima reconciliação
 * tentar de novo.
 */
async function resolverClienteEmSegundoPlano(franquiaId, paymentId, customerId) {
  try {
    if (!customerId) return;
    const mapaClientes = await obterClientesPorId([customerId], franquiaId);
    const cliente = mapaClientes.get(customerId);
    if (!cliente || (!cliente.cpfCnpj && !cliente.nome)) return;

    await prisma.pagamentoAsaas.updateMany({
      where: { id: paymentId, franquiaId, cpfCnpj: null },
      data: { cpfCnpj: cliente.cpfCnpj, nome: cliente.nome },
    });
  } catch (err) {
    console.error(
      `[pagamentosAsaas] Falha ao resolver cliente em segundo plano (pagamento "${paymentId}", franquia "${franquiaId}"):`,
      err.message
    );
  }
}

/**
 * Busca (API do Asaas) todos os pagamentos com vencimento em
 * [vencDe, vencAte] de uma franquia (ambos `undefined` = sem limite,
 * "histórico completo" — usado pelo backfill), resolve em lote os clientes
 * envolvidos (uma chamada por customerId ÚNICO, nunca por pagamento — mesmo
 * helper `obterClientesPorId` já usado pelo /resumo antigo) e faz upsert de
 * cada um na tabela local. Corrige, pelo caminho, qualquer divergência
 * entre o que está salvo localmente e o que o Asaas tem HOJE pra esse
 * período — a API do Asaas é sempre a fonte de verdade.
 *
 * Quando a janela é FECHADA (vencDe E vencAte informados), também apaga da
 * tabela local qualquer pagamento que exista localmente dentro dessa janela
 * mas que NÃO veio na resposta fresca do Asaas — cobre o caso de um evento
 * PAYMENT_DELETED perdido pelo webhook (rede de segurança da reconciliação
 * periódica). Com janela ABERTA (backfill sem `--desde`/`--ate`, "tudo"),
 * este passo é pulado de propósito — não há como comparar com segurança
 * contra "tudo que já existe localmente" sem arriscar apagar histórico
 * válido por causa de uma paginação incompleta; a exclusão fica reservada
 * pra chamadas com janela explícita, que sabem exatamente o que estão
 * comparando.
 *
 * `dryRun`: quando true, calcula e devolve os MESMOS números (quantos
 * seriam criados/atualizados/removidos) sem escrever nada no banco — usado
 * pelos scripts (dry run por padrão, mesma convenção do resto do projeto).
 */
async function sincronizarJanela(franquiaId, { vencDe, vencAte, dryRun = false } = {}) {
  const pagamentosAsaas = await listarPagamentos({ dueDateGe: vencDe, dueDateLe: vencAte }, franquiaId);

  const customerIds = [...new Set(pagamentosAsaas.map((p) => p.customer).filter(Boolean))];
  const mapaClientes = await obterClientesPorId(customerIds, franquiaId);

  const idsFrescos = pagamentosAsaas.map((p) => p.id);
  const locaisExistentes = idsFrescos.length
    ? await prisma.pagamentoAsaas.findMany({ where: { id: { in: idsFrescos }, franquiaId }, select: { id: true } })
    : [];
  const idsLocaisExistentes = new Set(locaisExistentes.map((r) => r.id));

  let criados = 0;
  let atualizados = 0;
  for (const payment of pagamentosAsaas) {
    if (idsLocaisExistentes.has(payment.id)) atualizados += 1;
    else criados += 1;

    if (!dryRun) {
      const cliente = mapaClientes.get(payment.customer) || null;
      await upsertPagamento(prisma, franquiaId, payment, cliente);
    }
  }

  let idsParaRemover = [];
  if (vencDe && vencAte) {
    const idsFrescosSet = new Set(idsFrescos);
    const locaisNaJanela = await prisma.pagamentoAsaas.findMany({
      where: { franquiaId, dueDate: { gte: vencDe, lte: vencAte } },
      select: { id: true },
    });
    idsParaRemover = locaisNaJanela.map((r) => r.id).filter((id) => !idsFrescosSet.has(id));

    if (!dryRun && idsParaRemover.length > 0) {
      await prisma.pagamentoAsaas.deleteMany({ where: { id: { in: idsParaRemover }, franquiaId } });
    }
  }

  return {
    totalAsaas: pagamentosAsaas.length,
    criados,
    atualizados,
    removidos: idsParaRemover.length,
    clientesResolvidos: mapaClientes.size,
  };
}

/** Janela padrão (em dias, a partir de hoje) usada pela reconciliação
 * periódica quando nenhuma janela explícita é informada — tanto por
 * scripts/reconciliar-pagamentos-asaas.js (flags --dias-atras/--dias-frente,
 * mesmo padrão se omitidas) quanto por
 * POST /api/inadimplencia/reconciliar-pagamentos (sem flags, sempre usa o
 * padrão). Único lugar onde esses dois números vivem — nenhum dos dois
 * caminhos duplica o valor. */
const DIAS_ATRAS_PADRAO_RECONCILIACAO = 90;
const DIAS_FRENTE_PADRAO_RECONCILIACAO = 30;

/** "YYYY-MM-DD" (UTC) para hoje + N dias (N negativo = passado) — mesma
 * convenção de string usada em dueDate/paymentDate no resto do projeto. */
function dataMaisDias(dias) {
  const data = new Date();
  data.setUTCDate(data.getUTCDate() + dias);
  return data.toISOString().slice(0, 10);
}

/** Calcula a janela [vencDe, vencAte] (ambos sempre presentes — janela
 * FECHADA, ver docblock de `sincronizarJanela` sobre por que isso importa
 * pra remoção de divergências) para a reconciliação periódica, a partir de
 * hoje. */
function calcularJanelaReconciliacao(diasAtras = DIAS_ATRAS_PADRAO_RECONCILIACAO, diasFrente = DIAS_FRENTE_PADRAO_RECONCILIACAO) {
  return { vencDe: dataMaisDias(-diasAtras), vencAte: dataMaisDias(diasFrente) };
}

/** Lista as franquias com uma chave de API do Asaas configurada (ver getAsaasApiKey) — usado pelos scripts pra iterar "todas as franquias" sem tentar sincronizar quem ainda não tem Asaas conectado. */
async function listarFranquiasComAsaasConfigurado() {
  const { getAsaasApiKey } = require('./config.service');
  const franquias = await prisma.franquia.findMany({ orderBy: { nome: 'asc' } });
  const comChave = [];
  for (const franquia of franquias) {
    const chave = await getAsaasApiKey(franquia.id);
    if (chave) comChave.push(franquia);
  }
  return comChave;
}

module.exports = {
  EVENTOS_WEBHOOK_UPSERT,
  EVENTO_WEBHOOK_DELETE,
  upsertPagamento,
  excluirPagamento,
  resolverClienteEmSegundoPlano,
  sincronizarJanela,
  listarFranquiasComAsaasConfigurado,
  calcularJanelaReconciliacao,
  DIAS_ATRAS_PADRAO_RECONCILIACAO,
  DIAS_FRENTE_PADRAO_RECONCILIACAO,
};
