#!/usr/bin/env node
/**
 * Mock inline do Asaas para o teste E2E do AJUSTE 14 (backend/test-ajuste14.js)
 * — "Tabela local sincronizada via webhook do Asaas para Taxa de
 * Inadimplência". Serve 3 "contas" Asaas diferentes, uma por
 * access_token, na MESMA porta (o app só suporta UM "ASAAS_API_BASE_URL"
 * por processo — ver asaas.service.js — então, pra testar múltiplas
 * franquias num único processo de app, o jeito é um mock multi-tenant por
 * token, não múltiplos mocks em portas diferentes):
 *
 *   - "asaas-mock-status-teste" (franquia "regressao"): o MESMO dataset
 *     (FIXTURES/CLIENTES, gerado com a MESMA lógica de offsets) do já
 *     validado backend/mock-asaas-inline.js (usado por
 *     test-status-ajustes.js) — copiado aqui verbatim, de propósito, pra
 *     que rodar as MESMAS asserções desse teste contra o novo caminho
 *     (Postgres local, via backfill) prove que o AJUSTE 14 não mudou
 *     nenhum resultado (ver seção "Teste: regressão" em test-ajuste14.js).
 *   - "ajuste14-mock-f1" / "ajuste14-mock-f2" (franquias "multi_f1"/
 *     "multi_f2"): dois datasets PEQUENOS e DISJUNTOS (nenhum id/customer em
 *     comum entre os dois — como aconteceria na vida real, cada franquia
 *     com sua própria conta Asaas) — usados pra testar que o backfill/
 *     reconciliação de múltiplas franquias não mistura dados (ver docblock
 *     do model PagamentoAsaas em schema.prisma: "id" é a chave primária
 *     GLOBAL da tabela local, então um id repetido entre duas franquias
 *     seria rejeitado como conflito pela extension de escopo — o dataset
 *     aqui é desenhado pra nunca colidir, do jeito que aconteceria de
 *     verdade).
 */
require('dotenv').config();
const http = require('http');

const PORTA = Number(process.env.MOCK_ASAAS_PORT) || 4057;

function formatarISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}
function diasAtras(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return formatarISO(d);
}

// ---------------------------------------------------------------------
// Conta "regressao" — CÓPIA VERBATIM da lógica de fixtures de
// mock-asaas-inline.js (mesmos ids/valores/offsets) — ver docblock acima.
// ---------------------------------------------------------------------
const CLIENTES_REGRESSAO = {
  cus_a: { name: 'Cliente A', cpfCnpj: '11.111.111/0001-11' },
  cus_b: { name: 'Cliente B', cpfCnpj: '22.222.222/0001-22' },
  cus_c: { name: 'Empresa Terceira', cpfCnpj: '33.333.333/0001-33' },
  cus_d: { name: 'Quarta Pessoa', cpfCnpj: '44.444.444/0001-44' },
};
const FIXTURES_REGRESSAO = [
  { id: 'a_overdue', customer: 'cus_a', value: 1000, dueOffset: 310, status: 'OVERDUE', payOffset: null },
  { id: 'a_confirmed', customer: 'cus_b', value: 700, dueOffset: 297, status: 'CONFIRMED', payOffset: null },
  { id: 'a_received_late', customer: 'cus_a', value: 900, dueOffset: 320, status: 'RECEIVED', payOffset: 305 },
  { id: 'a_received_cash', customer: 'cus_b', value: 300, dueOffset: 315, status: 'RECEIVED_IN_CASH', payOffset: 315 },
  { id: 'a_pending', customer: 'cus_a', value: 400, dueOffset: 290, status: 'PENDING', payOffset: null },
  { id: 'a_refunded', customer: 'cus_b', value: 200, dueOffset: 330, status: 'REFUNDED', payOffset: 330 },
  { id: 'b_atevenc', customer: 'cus_a', value: 111, dueOffset: 0, status: 'OVERDUE', payOffset: null },
  { id: 'b_1_20', customer: 'cus_a', value: 222, dueOffset: 15, status: 'OVERDUE', payOffset: null },
  { id: 'b_51_100', customer: 'cus_b', value: 333, dueOffset: 59, status: 'OVERDUE', payOffset: null },
  { id: 'b_acima100', customer: 'cus_a', value: 444, dueOffset: 101, status: 'OVERDUE', payOffset: null },
  { id: 'b_pago_21_30', customer: 'cus_a', value: 505, dueOffset: 25, status: 'RECEIVED', payOffset: 3 },
  { id: 'b_pago_31_40', customer: 'cus_b', value: 606, dueOffset: 45, status: 'RECEIVED', payOffset: 8 },
  { id: 'b_pago_41_50', customer: 'cus_a', value: 707, dueOffset: 48, status: 'RECEIVED', payOffset: 2 },
  { id: 'b_tolerancia', customer: 'cus_b', value: 777, dueOffset: 2, status: 'OVERDUE', payOffset: null },
  { id: 'b_pago_em_dia', customer: 'cus_a', value: 888, dueOffset: 70, status: 'RECEIVED', payOffset: 75 },
  { id: 'c_por_cpf', customer: 'cus_c', value: 1500, dueOffset: 405, status: 'OVERDUE', payOffset: null },
  { id: 'c_por_nome', customer: 'cus_d', value: 2500, dueOffset: 402, status: 'OVERDUE', payOffset: null },
];

// ---------------------------------------------------------------------
// Contas "multi_f1"/"multi_f2" — datasets pequenos e DISJUNTOS (ids e
// customers nunca se repetem entre os dois, nem com a conta "regressao"
// acima), pra testar isolamento entre franquias no backfill.
// ---------------------------------------------------------------------
const CLIENTES_F1 = {
  cus_f1_a: { name: 'F1 Associado A', cpfCnpj: '10.000.001/0001-01' },
  cus_f1_b: { name: 'F1 Associado B', cpfCnpj: '10.000.002/0001-02' },
};
const FIXTURES_F1 = [
  { id: 'f1_pay_1', customer: 'cus_f1_a', value: 1200, dueOffset: 10, status: 'OVERDUE', payOffset: null },
  { id: 'f1_pay_2', customer: 'cus_f1_b', value: 800, dueOffset: 20, status: 'RECEIVED', payOffset: 18 },
  { id: 'f1_pay_3', customer: 'cus_f1_a', value: 300, dueOffset: 5, status: 'PENDING', payOffset: null },
];

const CLIENTES_F2 = {
  cus_f2_a: { name: 'F2 Associado A', cpfCnpj: '20.000.001/0001-01' },
  cus_f2_b: { name: 'F2 Associado B', cpfCnpj: '20.000.002/0001-02' },
};
const FIXTURES_F2 = [
  { id: 'f2_pay_1', customer: 'cus_f2_a', value: 5000, dueOffset: 8, status: 'OVERDUE', payOffset: null },
  { id: 'f2_pay_2', customer: 'cus_f2_b', value: 2200, dueOffset: 30, status: 'RECEIVED', payOffset: 25 },
];

function montarPagamentos(fixtures) {
  return fixtures.map((f) => ({
    id: f.id,
    customer: f.customer,
    value: f.value,
    dueDate: diasAtras(f.dueOffset),
    status: f.status,
    description: f.id,
    paymentDate: f.payOffset === null ? null : diasAtras(f.payOffset),
  }));
}

const CONTAS = {
  'asaas-mock-status-teste': { clientes: CLIENTES_REGRESSAO, pagamentos: montarPagamentos(FIXTURES_REGRESSAO) },
  'ajuste14-mock-f1': { clientes: CLIENTES_F1, pagamentos: montarPagamentos(FIXTURES_F1) },
  'ajuste14-mock-f2': { clientes: CLIENTES_F2, pagamentos: montarPagamentos(FIXTURES_F2) },
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const token = req.headers['access_token'];
  const conta = CONTAS[token];
  if (!conta) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ description: 'chave invalida' }] }));
    return;
  }

  if (url.pathname === '/payments') {
    const ge = url.searchParams.get('dueDate[ge]');
    const le = url.searchParams.get('dueDate[le]');
    const limit = Number(url.searchParams.get('limit')) || 100;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const filtrados = conta.pagamentos.filter((p) => (!ge || p.dueDate >= ge) && (!le || p.dueDate <= le));
    const pagina = filtrados.slice(offset, offset + limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: pagina, hasMore: offset + limit < filtrados.length, totalCount: filtrados.length }));
    return;
  }

  const matchCliente = url.pathname.match(/^\/customers\/(.+)$/);
  if (matchCliente) {
    const cliente = conta.clientes[matchCliente[1]];
    if (!cliente) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ errors: [{ description: 'nao encontrado' }] }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ name: cliente.name, cpfCnpj: cliente.cpfCnpj }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'rota desconhecida no mock' }));
});

server.listen(PORTA, () => {
  console.log(`[mock-asaas-ajuste14] ouvindo em http://localhost:${PORTA} (contas: ${Object.keys(CONTAS).join(', ')})`);
});
