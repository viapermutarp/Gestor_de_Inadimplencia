#!/usr/bin/env node
/**
 * Mock inline do Asaas para o teste do AJUSTE CRÍTICO 3 / AJUSTE 4 /
 * AJUSTE 5 / AJUSTE 6 / AJUSTE 7 (backend/test-status-ajustes.js) — dataset
 * pequeno e desenhado caso a caso, em vez de reaproveitar o dataset grande e
 * antigo de scripts/mock-asaas-server.js (feito pro esquema de 6 faixas /
 * classificação por data que este ajuste substitui).
 */
require('dotenv').config();
const http = require('http');

const PORTA = Number(process.env.MOCK_ASAAS_PORT) || 4055;
const CHAVE_FICTICIA = 'asaas-mock-status-teste';

function formatarISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}
// n dias ANTES de hoje (n negativo = n dias no futuro) — mesma convenção do
// scripts/mock-asaas-server.js original.
function diasAtras(n) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return formatarISO(d);
}

const CLIENTES = {
  cus_a: { name: 'Cliente A', cpfCnpj: '11.111.111/0001-11' },
  cus_b: { name: 'Cliente B', cpfCnpj: '22.222.222/0001-22' },
  // Grupo C (AJUSTE 7 — exclusão por CPF/CNPJ e nome) — clientes próprios,
  // sem relação com cus_a/cus_b, pra isolar o teste de exclusão.
  cus_c: { name: 'Empresa Terceira', cpfCnpj: '33.333.333/0001-33' },
  cus_d: { name: 'Quarta Pessoa', cpfCnpj: '44.444.444/0001-44' },
};

// dueOffset/payOffset são "dias atrás" (ver diasAtras). diasAtraso de um
// pagamento PAGO = dueOffset - payOffset (invariante a deslocamento). Mas
// diasAtraso de um pagamento NÃO pago = hoje - dueDate = dueOffset
// diretamente (NÃO é invariante a deslocamento!) — por isso o Grupo A
// (cujo teste só liga pro "status", nunca pro diasAtraso) foi deslocado
// +300 dias pra não colidir com o período de consulta do Grupo B, e o
// Grupo B (cujo teste é exatamente sobre diasAtraso/faixas) manteve os
// offsets "naturais", iguais ao diasAtraso esperado de cada faixa. Ver
// backend/test-status-ajustes.js para o modelo "esperado".
const FIXTURES = [
  // ---- Grupo A: AJUSTE CRÍTICO 3 / AJUSTE 4 (status atual) — deslocado
  // +300 dias; só o status importa aqui, nunca o diasAtraso. ----
  { id: 'a_overdue', customer: 'cus_a', value: 1000, dueOffset: 310, status: 'OVERDUE', payOffset: null },
  { id: 'a_confirmed', customer: 'cus_b', value: 700, dueOffset: 297, status: 'CONFIRMED', payOffset: null },
  { id: 'a_received_late', customer: 'cus_a', value: 900, dueOffset: 320, status: 'RECEIVED', payOffset: 305 },
  { id: 'a_received_cash', customer: 'cus_b', value: 300, dueOffset: 315, status: 'RECEIVED_IN_CASH', payOffset: 315 },
  { id: 'a_pending', customer: 'cus_a', value: 400, dueOffset: 290, status: 'PENDING', payOffset: null },
  { id: 'a_refunded', customer: 'cus_b', value: 200, dueOffset: 330, status: 'REFUNDED', payOffset: 330 },

  // ---- Grupo B: AJUSTE 5 (faixas/criticos) — offsets "naturais" (não
  // deslocados): pra um pagamento não pago, dueOffset = diasAtraso hoje. ----
  { id: 'b_atevenc', customer: 'cus_a', value: 111, dueOffset: 0, status: 'OVERDUE', payOffset: null },
  { id: 'b_1_20', customer: 'cus_a', value: 222, dueOffset: 15, status: 'OVERDUE', payOffset: null },
  { id: 'b_51_100', customer: 'cus_b', value: 333, dueOffset: 59, status: 'OVERDUE', payOffset: null },
  { id: 'b_acima100', customer: 'cus_a', value: 444, dueOffset: 101, status: 'OVERDUE', payOffset: null },
  { id: 'b_pago_21_30', customer: 'cus_a', value: 505, dueOffset: 25, status: 'RECEIVED', payOffset: 3 },
  { id: 'b_pago_31_40', customer: 'cus_b', value: 606, dueOffset: 45, status: 'RECEIVED', payOffset: 8 },
  { id: 'b_pago_41_50', customer: 'cus_a', value: 707, dueOffset: 48, status: 'RECEIVED', payOffset: 2 },
  { id: 'b_tolerancia', customer: 'cus_b', value: 777, dueOffset: 2, status: 'OVERDUE', payOffset: null },
  // AJUSTE 6/CORREÇÃO — pago ANTES do vencimento (payOffset > dueOffset =>
  // diasAtraso = dueOffset - payOffset < 0 => cai em "ate_vencimento" no
  // modo "historico"). Faltava um caso assim no dataset original: todos os
  // outros pagamentos "pagos" do Grupo B foram pagos COM atraso, então a
  // faixa "ate_vencimento" nunca recebia nada além de OVERDUE ainda não
  // pago — exatamente o bug relatado (ver test-status-ajustes.js).
  { id: 'b_pago_em_dia', customer: 'cus_a', value: 888, dueOffset: 70, status: 'RECEIVED', payOffset: 75 },

  // ---- Grupo C: AJUSTE 7 (exclusão por CPF/CNPJ e nome) — período
  // próprio (400-410 dias atrás), bem afastado dos Grupos A (150-340) e B
  // (-5-140), pra não interferir nas somas deles quando a exclusão por
  // palavra-chave estiver configurada. ----
  { id: 'c_por_cpf', customer: 'cus_c', value: 1500, dueOffset: 405, status: 'OVERDUE', payOffset: null },
  { id: 'c_por_nome', customer: 'cus_d', value: 2500, dueOffset: 402, status: 'OVERDUE', payOffset: null },
];

const PAGAMENTOS = FIXTURES.map((f) => ({
  id: f.id,
  customer: f.customer,
  value: f.value,
  dueDate: diasAtras(f.dueOffset),
  status: f.status,
  description: f.id,
  paymentDate: f.payOffset === null ? null : diasAtras(f.payOffset),
}));

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const token = req.headers['access_token'];
  if (token !== CHAVE_FICTICIA) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ errors: [{ description: 'chave invalida' }] }));
    return;
  }

  if (url.pathname === '/payments') {
    const ge = url.searchParams.get('dueDate[ge]');
    const le = url.searchParams.get('dueDate[le]');
    const limit = Number(url.searchParams.get('limit')) || 100;
    const offset = Number(url.searchParams.get('offset')) || 0;
    const filtrados = PAGAMENTOS.filter((p) => (!ge || p.dueDate >= ge) && (!le || p.dueDate <= le));
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
  console.log(`[mock-asaas-inline] ouvindo em http://localhost:${PORTA}`);
});
