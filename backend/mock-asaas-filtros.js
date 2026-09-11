#!/usr/bin/env node
/**
 * Mock standalone do Asaas para o teste E2E do brief "Repaginar filtros da
 * Taxa de Inadimplência" (backend/test-ajuste-filtros-inadimplencia.js).
 *
 * Roda como PROCESSO SEPARADO (spawn), no mesmo padrão de
 * mock-asaas-ajuste14.js — e não como servidor in-process no próprio
 * script de teste. Motivo: o teste chama o script de backfill
 * (scripts/backfill-pagamentos-asaas.js) via execSync (síncrono), que
 * BLOQUEIA o event loop do processo pai até o subprocesso terminar. Um
 * mock in-process (http.createServer no mesmo processo do teste) fica
 * incapaz de responder a qualquer requisição enquanto o event loop está
 * bloqueado por esse execSync — o subprocesso de backfill trava esperando
 * resposta do mock, e o mock trava esperando o processo pai devolver o
 * controle pro event loop, gerando um timeout de 15s (TIMEOUT_MS em
 * asaas.service.js) sem nenhum request de fato ter sido perdido. Rodando
 * o mock num processo do SO à parte, ele responde independente do que o
 * processo do teste estiver fazendo.
 *
 * Dataset idêntico (copiado verbatim) ao CLIENTES/montarPagamentos()
 * originalmente definidos inline em test-ajuste-filtros-inadimplencia.js
 * — ver docblock daquele arquivo para o "porquê" de cada linha do
 * dataset.
 */
require('dotenv').config();
const http = require('http');

const PORTA = Number(process.env.MOCK_ASAAS_FILTROS_PORT) || 4091;
const TOKEN = process.env.MOCK_ASAAS_FILTROS_TOKEN || 'mock-filtros-token';

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
function diasAFrente(n) {
  return diasAtras(-n);
}
// diaDoMes — ver docblock equivalente em test-ajuste-filtros-inadimplencia.js
// (este dataset precisa ficar IDÊNTICO ao de lá, já que o mock roda em
// processo separado e serve os mesmos ids/valores/datas que o teste espera).
function diaDoMes(offsetMeses, dia) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1);
  d.setMonth(d.getMonth() + offsetMeses);
  d.setDate(dia);
  return formatarISO(d);
}

const CLIENTES = {
  cus_a: { name: 'Associado A (ativo)', cpfCnpj: '90.000.001/0001-01' },
  cus_b: { name: 'Associado B (ativo)', cpfCnpj: '90.000.002/0001-02' },
  cus_c: { name: 'Associado C (jurídico)', cpfCnpj: '90.000.003/0001-03' },
  cus_d: { name: 'Associado D (ativo)', cpfCnpj: '90.000.004/0001-04' },
  cus_e: { name: 'Associado E (ativo, crítico só em histórico)', cpfCnpj: '90.000.005/0001-05' },
  cus_f: { name: 'Associado F (ativo, cruza mês)', cpfCnpj: '90.000.006/0001-06' },
};

function montarPagamentos() {
  return [
    // p_venc_atual — OVERDUE há ~10 dias (não crítico), sem pagamento.
    { id: 'p_venc_atual', customer: 'cus_a', value: 1000, dueDate: diasAtras(10), dateCreated: diasAtras(40), paymentDate: null, status: 'OVERDUE', description: 'venc atual' },
    // p_pago_recente — RECEIVED, pago há 5 dias (dueDate há 60 dias).
    { id: 'p_pago_recente', customer: 'cus_b', value: 500, dueDate: diasAtras(60), dateCreated: diasAtras(65), paymentDate: diasAtras(5), status: 'RECEIVED', description: 'pago recente' },
    // p_sem_pagamento_antigo — OVERDUE há ~200 dias (crítico em "aberto"), associado C é jurídico.
    { id: 'p_sem_pagamento_antigo', customer: 'cus_c', value: 2000, dueDate: diasAtras(200), dateCreated: diasAtras(210), paymentDate: null, status: 'OVERDUE', description: 'antigo sem pagamento' },
    // p_confirmed — CONFIRMED, a vencer daqui 5 dias.
    { id: 'p_confirmed', customer: 'cus_a', value: 300, dueDate: diasAFrente(5), dateCreated: diasAtras(2), paymentDate: null, status: 'CONFIRMED', description: 'confirmado' },
    // p_refunded — REFUNDED (status "exótico", fora de em_aberto E de pagas).
    { id: 'p_refunded', customer: 'cus_b', value: 150, dueDate: diasAtras(30), dateCreated: diasAtras(35), paymentDate: diasAtras(25), status: 'REFUNDED', description: 'estornado' },
    // p_pending_recent — PENDING, a vencer daqui 20 dias.
    { id: 'p_pending_recent', customer: 'cus_d', value: 400, dueDate: diasAFrente(20), dateCreated: diasAtras(1), paymentDate: null, status: 'PENDING', description: 'pendente' },
    // p_pago_com_atraso_grande — RECEIVED, pago 110 dias depois do vencimento
    // (dueDate 150 dias atrás, paymentDate 40 dias atrás) — crítico só em
    // "historico" (em "aberto" nem entra no cálculo, já que não é OVERDUE).
    { id: 'p_pago_com_atraso_grande', customer: 'cus_e', value: 700, dueDate: diasAtras(150), dateCreated: diasAtras(155), paymentDate: diasAtras(40), status: 'RECEIVED', description: 'pago com atraso grande' },
    // p_cruza_mes — dueDate no mês passado, paymentDate neste mês (sempre
    // meses civis adjacentes, relativo a "hoje") — prova que
    // /evolucao-mensal com filtro_periodo=pagamento bucketiza por
    // paymentDate, não por dueDate.
    { id: 'p_cruza_mes', customer: 'cus_f', value: 900, dueDate: diaDoMes(-1, 25), dateCreated: diaDoMes(-1, 20), paymentDate: diaDoMes(0, 5), status: 'RECEIVED', description: 'cruza mes' },
  ];
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const token = req.headers['access_token'];
  if (token !== TOKEN) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ description: 'chave invalida' }] }));
    return;
  }

  if (url.pathname === '/payments') {
    const ge = url.searchParams.get('dueDate[ge]');
    const le = url.searchParams.get('dueDate[le]');
    const limit = Number(url.searchParams.get('limit')) || 100;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const todos = montarPagamentos();
    const filtrados = todos.filter((p) => (!ge || p.dueDate >= ge) && (!le || p.dueDate <= le));
    const pagina = filtrados.slice(offset, offset + limit);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: pagina, hasMore: offset + limit < filtrados.length, totalCount: filtrados.length }));
    return;
  }

  const matchCliente = url.pathname.match(/^\/customers\/(.+)$/);
  if (matchCliente) {
    const cliente = CLIENTES[matchCliente[1]];
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
  console.log(`[mock-asaas-filtros] ouvindo em http://localhost:${PORTA}`);
});
