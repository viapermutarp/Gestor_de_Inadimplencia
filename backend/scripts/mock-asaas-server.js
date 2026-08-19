#!/usr/bin/env node
/**
 * Mock standalone da API do Asaas, para testar a tela "Taxa de
 * Inadimplência" (GET /api/inadimplencia/resumo) manualmente no navegador,
 * sem precisar de uma chave real do Asaas.
 *
 * Sobe um servidor HTTP simulando:
 *   - GET /v3/payments?dueDate[ge]=...&dueDate[le]=...&limit=...&offset=...
 *     (paginação offset/limit igual à API real — ver src/services/asaas.service.js)
 *   - GET /v3/customers/:id
 *
 * Vem pré-populado com um dataset fictício (definido logo abaixo) desenhado
 * para cobrir as 6 faixas de atraso da tela, incluindo um caso de mais de
 * 180 dias, e pagamentos com status pago/confirmado para o cálculo de
 * "valor_total_faturado" fazer sentido (não é só a soma dos atrasados).
 *
 * Uso:
 *   node scripts/mock-asaas-server.js
 *
 * Ver README ("Como testar a tela de Inadimplência com dados fictícios")
 * para o passo a passo completo.
 */

require('dotenv').config();
const http = require('http');

const PORTA = Number(process.env.MOCK_ASAAS_PORT) || 4001;

// Chave fictícia que este mock aceita no header "access_token" (mesmo
// header que a API real do Asaas usa — ver src/services/asaas.service.js).
// Qualquer outro valor recebe 401, igual ao comportamento real.
const CHAVE_FICTICIA = 'asaas-mock-chave-de-teste-123456';

// ---------------------------------------------------------------------------
// Dataset fictício
// ---------------------------------------------------------------------------

function formatarISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

/**
 * Data de vencimento como string "YYYY-MM-DD", `n` dias antes de hoje
 * (negativo = `n` dias no futuro). Calculado em relação ao momento em que o
 * script roda, não uma data fixa — assim o dataset sempre cai nas faixas
 * certas, não importa quando você rodar o script.
 */
function diasAtras(n) {
  const data = new Date();
  data.setHours(0, 0, 0, 0);
  data.setDate(data.getDate() - n);
  return formatarISO(data);
}

// Clientes fictícios no Asaas. Os 4 primeiros têm cpfCnpj propositalmente
// repetido na lista de ASSOCIADOS_LOCAIS abaixo (3 com em_negociacao: true,
// 1 com em_negociacao: false) — para testar o cruzamento do filtro
// "Renegociação" (GET /api/inadimplencia/resumo?renegociacao=sim|nao). Os
// demais não têm registro local nenhum, para testar a regra "sem associado
// correspondente conta como não em negociação".
const CLIENTES = {
  cus_mock_alfa: { name: 'Alfa Comércio de Materiais LTDA', cpfCnpj: '12.345.678/0001-90' },
  cus_mock_beta: { name: 'Beta Distribuidora EIRELI', cpfCnpj: '23.456.789/0001-01' },
  cus_mock_gama: { name: 'Gama Construções e Serviços LTDA', cpfCnpj: '34.567.890/0001-12' },
  cus_mock_delta: { name: 'Delta Alimentos LTDA', cpfCnpj: '45.678.901/0001-23' },
  cus_mock_epsilon: { name: 'Epsilon Transportes LTDA', cpfCnpj: '56.789.012/0001-34' },
  cus_mock_zeta: { name: 'Zeta Tecnologia LTDA', cpfCnpj: '67.890.123/0001-45' },
  cus_mock_eta: { name: 'Eta Papelaria e Escritório LTDA', cpfCnpj: '78.901.234/0001-56' },
  cus_mock_theta: { name: 'Theta Confecções LTDA', cpfCnpj: '89.012.345/0001-67' },
  cus_mock_iota: { name: 'Iota Serviços Gerais LTDA', cpfCnpj: '90.123.456/0001-78' },
  cus_mock_kappa: { name: 'Kappa Farmácia e Cosméticos LTDA', cpfCnpj: '01.234.567/0001-89' },
};

// Associados que este script tenta upsertar na tabela local "associados"
// (best-effort — ver seedAssociadosLocais mais abaixo). Beta e Delta têm
// em_juridico=true (Beta também em_negociacao=true, para confirmar que os
// filtros "renegociacao" e "em_juridico" combinam com E e não se confundem
// um com o outro). Gama e Delta têm bloqueado=true, em combinações distintas
// das de em_negociacao/em_juridico, para o filtro "bloqueado" (AJUSTE 4)
// também ter o que cruzar de forma independente dos outros dois.
const ASSOCIADOS_LOCAIS = [
  { cpfCnpj: '12.345.678/0001-90', nome: 'Alfa Comércio de Materiais LTDA', telefone: '11988880001', emNegociacao: true, emJuridico: false, bloqueado: false },
  { cpfCnpj: '23.456.789/0001-01', nome: 'Beta Distribuidora EIRELI', telefone: '11988880002', emNegociacao: true, emJuridico: true, bloqueado: false },
  { cpfCnpj: '34.567.890/0001-12', nome: 'Gama Construções e Serviços LTDA', telefone: '11988880003', emNegociacao: true, emJuridico: false, bloqueado: true },
  { cpfCnpj: '45.678.901/0001-23', nome: 'Delta Alimentos LTDA', telefone: '11988880004', emNegociacao: false, emJuridico: true, bloqueado: true },
];

// 29 pagamentos fictícios. `dueDate` (e `paymentDate`, quando aplicável) são
// calculados dinamicamente (ver diasAtras); os 13 primeiros são OVERDUE e
// cobrem as 6 faixas da tela (0-20, 20-30, 30-40, 40-50, 50-100, 100-180 —
// a última com 2 casos, um deles com mais de 180 dias de atraso, para
// confirmar que a tela não "esconde" dívidas muito antigas). Os demais têm
// status pago/pendente, para valor_total_faturado ser maior que
// valor_inadimplente, e cobrem os cenários do AJUSTE CRÍTICO 1
// (classificação por data de pagamento, não por status atual):
//   - pagas EM DIA (paymentDate <= dueDate) -> ADIMPLENTE
//   - pagas COM ATRASO (paymentDate > dueDate) -> INADIMPLENTE mesmo já
//     estando com status RECEIVED/CONFIRMED hoje — é o cenário central do
//     ajuste: pay_mock_021 vence num mês e só é pago ~2 meses depois, e
//     precisa continuar aparecendo como inadimplente do mês de vencimento.
//   - ainda não pagas, mas com vencimento FUTURO (ex.: pay_mock_014/015/019)
//     -> "a vencer" (nem adimplente nem inadimplente ainda).
//
// `description`: pay_mock_003 e pay_mock_008 têm a frase "não contabilizar"
// na descrição (em caixas diferentes, para testar case-insensitive) — usada
// nos testes automatizados de exclusão por palavra-chave. pay_mock_005 e
// pay_mock_008 também são usados nos testes de exclusão manual por ID
// (pay_mock_008 cai nos dois mecanismos ao mesmo tempo, para testar que a
// exclusão combinada não conta ele em dobro). pay_mock_022 e pay_mock_023
// têm "Renegociação" na descrição e status em aberto (OVERDUE/PENDING) —
// usadas no teste de "renegociacoes_abertas" via descrição (AJUSTE 3);
// pay_mock_024 também tem "Renegociação" na descrição, mas já paga (RECEIVED)
// — não deve contar, para confirmar o filtro por status PENDING/OVERDUE.
// pay_mock_025 a 029 cobrem o período de tolerância
// (GET/PATCH /api/config/tolerancia-dias) — atrasos de 1-2 dias (pagos ou
// ainda em aberto) desenhados para migrar de classificação (ou de faixa,
// no caso de pay_mock_025, ou de criticos_90_dias, no caso de pay_mock_029)
// só quando a tolerância configurada é grande o bastante para absorvê-los
// — ver comentário ao lado de cada um.
const PAGAMENTOS = [
  // Faixa 0-20 dias
  { id: 'pay_mock_001', customer: 'cus_mock_alfa', value: 850.0, dueDate: diasAtras(5), status: 'OVERDUE', description: 'Mensalidade associativa - Alfa', paymentDate: null },
  { id: 'pay_mock_002', customer: 'cus_mock_beta', value: 1200.0, dueDate: diasAtras(12), status: 'OVERDUE', description: 'Mensalidade associativa - Beta', paymentDate: null },

  // Faixa 20-30 dias
  { id: 'pay_mock_003', customer: 'cus_mock_gama', value: 430.5, dueDate: diasAtras(22), status: 'OVERDUE', description: 'Cobrança de teste - NÃO CONTABILIZAR', paymentDate: null },
  { id: 'pay_mock_004', customer: 'cus_mock_delta', value: 2100.0, dueDate: diasAtras(27), status: 'OVERDUE', description: 'Mensalidade associativa - Delta', paymentDate: null },

  // Faixa 30-40 dias
  { id: 'pay_mock_005', customer: 'cus_mock_epsilon', value: 675.0, dueDate: diasAtras(33), status: 'OVERDUE', description: 'Mensalidade associativa - Epsilon (excluída manualmente nos testes)', paymentDate: null },
  { id: 'pay_mock_006', customer: 'cus_mock_zeta', value: 1580.0, dueDate: diasAtras(38), status: 'OVERDUE', description: 'Mensalidade associativa - Zeta', paymentDate: null },

  // Faixa 40-50 dias
  { id: 'pay_mock_007', customer: 'cus_mock_eta', value: 920.0, dueDate: diasAtras(42), status: 'OVERDUE', description: 'Mensalidade associativa - Eta', paymentDate: null },
  { id: 'pay_mock_008', customer: 'cus_mock_theta', value: 310.0, dueDate: diasAtras(47), status: 'OVERDUE', description: 'Cobrança interna - não contabilizar (também na lista manual)', paymentDate: null },

  // Faixa 50-100 dias
  { id: 'pay_mock_009', customer: 'cus_mock_iota', value: 1750.0, dueDate: diasAtras(60), status: 'OVERDUE', description: 'Mensalidade associativa - Iota', paymentDate: null },
  { id: 'pay_mock_010', customer: 'cus_mock_kappa', value: 540.0, dueDate: diasAtras(85), status: 'OVERDUE', description: 'Mensalidade associativa - Kappa', paymentDate: null },

  // Faixa 100-180 dias (+ um caso de mais de 180 dias, mesma faixa —
  // ver decisão de design no README/backend: essa faixa não tem teto)
  { id: 'pay_mock_011', customer: 'cus_mock_alfa', value: 3200.0, dueDate: diasAtras(120), status: 'OVERDUE', description: 'Mensalidade associativa - Alfa (atraso antigo)', paymentDate: null },
  { id: 'pay_mock_012', customer: 'cus_mock_beta', value: 890.0, dueDate: diasAtras(150), status: 'OVERDUE', description: 'Mensalidade associativa - Beta (atraso antigo)', paymentDate: null },
  { id: 'pay_mock_013', customer: 'cus_mock_gama', value: 4500.0, dueDate: diasAtras(250), status: 'OVERDUE', description: 'Mensalidade associativa - Gama (atraso muito antigo)', paymentDate: null },

  // Ainda não pagas, mas com vencimento FUTURO -> "a vencer" (AJUSTE
  // CRÍTICO 1): não contam nem como adimplentes nem como inadimplentes.
  { id: 'pay_mock_014', customer: 'cus_mock_zeta', value: 450.0, dueDate: diasAtras(-10), status: 'PENDING', description: 'Mensalidade associativa - Zeta', paymentDate: null },
  { id: 'pay_mock_015', customer: 'cus_mock_eta', value: 680.0, dueDate: diasAtras(-5), status: 'PENDING', description: 'Mensalidade associativa - Eta', paymentDate: null },
  { id: 'pay_mock_019', customer: 'cus_mock_delta', value: 1500.0, dueDate: diasAtras(-20), status: 'PENDING', description: 'Mensalidade associativa - Delta', paymentDate: null },

  // Pagas EM DIA (paymentDate <= dueDate) -> ADIMPLENTE
  { id: 'pay_mock_016', customer: 'cus_mock_theta', value: 1200.0, dueDate: diasAtras(15), status: 'RECEIVED', description: 'Mensalidade associativa - Theta', paymentDate: diasAtras(15) },
  { id: 'pay_mock_017', customer: 'cus_mock_iota', value: 990.0, dueDate: diasAtras(40), status: 'CONFIRMED', description: 'Mensalidade associativa - Iota', paymentDate: diasAtras(42) },
  { id: 'pay_mock_020', customer: 'cus_mock_alfa', value: 275.0, dueDate: diasAtras(3), status: 'CONFIRMED', description: 'Mensalidade associativa - Alfa', paymentDate: diasAtras(4) },

  // Paga COM ATRASO (paymentDate > dueDate), já com status atual
  // RECEIVED -> continua INADIMPLENTE (cenário "curto", ~40 dias de atraso
  // no pagamento, dentro do mesmo trimestre).
  { id: 'pay_mock_018', customer: 'cus_mock_kappa', value: 2300.0, dueDate: diasAtras(100), status: 'RECEIVED', description: 'Mensalidade associativa - Kappa (paga com atraso)', paymentDate: diasAtras(60) },

  // Cenário central do AJUSTE CRÍTICO 1: venceu há ~2,5 meses e só foi paga
  // há ~10 dias (~65 dias de atraso no pagamento, cruzando o limite de mês
  // civil) — status atual já é RECEIVED, mas o mês de VENCIMENTO precisa
  // continuar contando este valor como inadimplente na taxa histórica.
  { id: 'pay_mock_021', customer: 'cus_mock_zeta', value: 1300.0, dueDate: diasAtras(75), status: 'RECEIVED', description: 'Mensalidade associativa - Zeta (paga ~2 meses depois do vencimento)', paymentDate: diasAtras(10) },

  // "Renegociação" na descrição + status em aberto (OVERDUE/PENDING) ->
  // contam em renegociacoes_abertas (AJUSTE 3).
  { id: 'pay_mock_022', customer: 'cus_mock_iota', value: 800.0, dueDate: diasAtras(10), status: 'OVERDUE', description: 'Renegociação de dívida - acordo parcelado', paymentDate: null },
  { id: 'pay_mock_023', customer: 'cus_mock_kappa', value: 650.0, dueDate: diasAtras(-3), status: 'PENDING', description: 'Acordo de Renegociação - parcela 2/6', paymentDate: null },

  // "Renegociação" na descrição, mas já PAGA -> NÃO deve contar em
  // renegociacoes_abertas (status fora de PENDING/OVERDUE).
  { id: 'pay_mock_024', customer: 'cus_mock_theta', value: 500.0, dueDate: diasAtras(50), status: 'RECEIVED', description: 'Renegociação finalizada - parcela 6/6', paymentDate: diasAtras(48) },

  // ------------------------------------------------------------------------
  // Período de tolerância (GET/PATCH /api/config/tolerancia-dias) — casos
  // desenhados para migrar de classificação (ou de faixa) só quando a
  // tolerância configurada é grande o suficiente para "engolir" o atraso:
  // ------------------------------------------------------------------------

  // Ainda não paga, 1 dia em atraso (OVERDUE no Asaas, que não sabe de
  // tolerância nenhuma). Com tolerância 0: INADIMPLENTE, cai na faixa
  // 0_20 (modo aberto). Com tolerância >= 1: a "data limite efetiva" ainda
  // não chegou -> não é inadimplente (fica "a vencer" internamente) e some
  // de qualquer faixa no modo aberto (nem aparece em 0_20).
  { id: 'pay_mock_028', customer: 'cus_mock_zeta', value: 200.0, dueDate: diasAtras(1), status: 'OVERDUE', description: 'Mensalidade associativa - Zeta (1 dia de atraso, caso de tolerância)', paymentDate: null },

  // Ainda não paga, 21 dias em atraso (OVERDUE) -> cai na faixa 20_30 com
  // tolerância 0. Com tolerância 2, a "data limite efetiva" desloca o
  // atraso efetivo para 19 dias -> muda de faixa (20_30 -> 0_20), não só o
  // número dentro da mesma faixa. Usado no teste de "deslocamento de faixas".
  { id: 'pay_mock_025', customer: 'cus_mock_eta', value: 700.0, dueDate: diasAtras(21), status: 'OVERDUE', description: 'Mensalidade associativa - Eta (21 dias de atraso, caso de tolerância)', paymentDate: null },

  // Paga com 1 dia de atraso (paymentDate = dueDate + 1) -> INADIMPLENTE com
  // tolerância 0, mas ADIMPLENTE já a partir de tolerância 1 (o exemplo
  // "float bancário de fim de semana" do pedido).
  { id: 'pay_mock_026', customer: 'cus_mock_theta', value: 300.0, dueDate: diasAtras(10), status: 'RECEIVED', description: 'Mensalidade associativa - Theta (paga 1 dia em atraso, caso de tolerância)', paymentDate: diasAtras(9) },

  // Paga com EXATAMENTE 2 dias de atraso (paymentDate = dueDate + 2) ->
  // INADIMPLENTE com tolerância 0 ou 1, mas ADIMPLENTE com tolerância 2
  // (mesmo exemplo numérico usado no README: "paga com 2 dias de atraso e
  // tolerância de 2 dias não entra em nenhuma faixa, é adimplente").
  { id: 'pay_mock_027', customer: 'cus_mock_iota', value: 450.0, dueDate: diasAtras(15), status: 'RECEIVED', description: 'Mensalidade associativa - Iota (paga 2 dias em atraso, caso de tolerância)', paymentDate: diasAtras(13) },

  // Ainda não paga, 91 dias em atraso (OVERDUE) -> cai em criticos_90_dias
  // com tolerância 0 (91 >= 90) mas SAI de criticos_90_dias com tolerância
  // 2 (atraso efetivo de 89 dias, < 90) — SEM trocar de faixa (89 continua
  // na faixa 50_100, assim como 91): isola o efeito da tolerância sobre
  // criticos_90_dias do efeito sobre a escolha de faixa.
  { id: 'pay_mock_029', customer: 'cus_mock_kappa', value: 900.0, dueDate: diasAtras(91), status: 'OVERDUE', description: 'Mensalidade associativa - Kappa (91 dias de atraso, caso de críticos + tolerância)', paymentDate: null },
];

// ---------------------------------------------------------------------------
// Servidor HTTP
// ---------------------------------------------------------------------------

const LIMITE_PADRAO = 100;

function enviarJson(res, status, corpo) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(corpo));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORTA}`);
  const token = req.headers['access_token'];

  if (token !== CHAVE_FICTICIA) {
    enviarJson(res, 401, { errors: [{ code: 'invalid_access_token', description: 'access_token inválido.' }] });
    return;
  }

  if (url.pathname === '/v3/payments' && req.method === 'GET') {
    const ge = url.searchParams.get('dueDate[ge]');
    const le = url.searchParams.get('dueDate[le]');
    const limit = parseInt(url.searchParams.get('limit'), 10) || LIMITE_PADRAO;
    const offset = parseInt(url.searchParams.get('offset'), 10) || 0;

    const filtrados = PAGAMENTOS.filter((p) => (!ge || p.dueDate >= ge) && (!le || p.dueDate <= le));
    const pagina = filtrados.slice(offset, offset + limit);

    console.log(
      `[mock-asaas] GET /v3/payments dueDate[ge]=${ge} dueDate[le]=${le} offset=${offset} limit=${limit} -> ${pagina.length}/${filtrados.length}`
    );

    enviarJson(res, 200, {
      object: 'list',
      hasMore: offset + limit < filtrados.length,
      totalCount: filtrados.length,
      limit,
      offset,
      data: pagina,
    });
    return;
  }

  const matchCliente = url.pathname.match(/^\/v3\/customers\/(.+)$/);
  if (matchCliente && req.method === 'GET') {
    const id = matchCliente[1];
    const cliente = CLIENTES[id];
    console.log(`[mock-asaas] GET /v3/customers/${id} -> ${cliente ? 'ok' : '404'}`);

    if (!cliente) {
      enviarJson(res, 404, { errors: [{ code: 'not_found', description: 'Cliente não encontrado.' }] });
      return;
    }
    enviarJson(res, 200, { id, name: cliente.name, cpfCnpj: cliente.cpfCnpj });
    return;
  }

  enviarJson(res, 404, { errors: [{ code: 'not_found', description: 'Rota não simulada por este mock.' }] });
});

/**
 * Tenta criar/atualizar (upsert) os associados de ASSOCIADOS_LOCAIS na
 * tabela local "associados", para o filtro "Renegociação" já funcionar de
 * primeira ao testar. É best-effort: se o Postgres não estiver acessível
 * (ex.: DATABASE_URL não configurada, banco fora do ar), avisa no console
 * e segue em frente — o mock HTTP funciona normalmente de qualquer jeito,
 * só esse cruzamento com a base local que fica de fora.
 */
async function seedAssociadosLocais() {
  let prisma;
  try {
    prisma = require('../src/config/prisma');
    await Promise.all(
      ASSOCIADOS_LOCAIS.map((a) =>
        prisma.associado.upsert({
          where: { cpfCnpj: a.cpfCnpj },
          update: { emNegociacao: a.emNegociacao, emJuridico: a.emJuridico, bloqueado: a.bloqueado },
          create: {
            cpfCnpj: a.cpfCnpj,
            nome: a.nome,
            telefone: a.telefone,
            emNegociacao: a.emNegociacao,
            emJuridico: a.emJuridico,
            bloqueado: a.bloqueado,
          },
        })
      )
    );
    console.log(`\n✔ ${ASSOCIADOS_LOCAIS.length} associados fictícios criados/atualizados na tabela local "associados":`);
    for (const a of ASSOCIADOS_LOCAIS) {
      console.log(
        `  - ${a.nome} (${a.cpfCnpj}) — em_negociacao: ${a.emNegociacao}, em_juridico: ${a.emJuridico}, bloqueado: ${a.bloqueado}`
      );
    }
  } catch (err) {
    console.warn(
      '\n⚠ Não foi possível criar os associados fictícios na base local (o mock HTTP continua funcionando normalmente).'
    );
    console.warn(`  Motivo: ${err.message}`);
    console.warn(
      '  Se quiser testar o filtro "Renegociação", crie manualmente associados com os CPF/CNPJ acima, marcados em_negociacao=true.'
    );
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => {});
  }
}

server.listen(PORTA, async () => {
  console.log('='.repeat(70));
  console.log(`🟢 Mock da API do Asaas rodando em http://localhost:${PORTA}`);
  console.log('='.repeat(70));
  console.log(`\n${PAGAMENTOS.length} pagamentos fictícios carregados (13 em atraso hoje, cobrindo as 6`);
  console.log('faixas + um caso de mais de 180 dias; os demais cobrem pagos em dia, pagos com');
  console.log('atraso [inclusive um caso "pago 2 meses depois"], a vencer, 2 casos de');
  console.log('"Renegociação" na descrição, e 5 casos de período de tolerância [1-2 dias de');
  console.log('atraso, pagos ou ainda em aberto]).');

  console.log('\n1) Adicione ao .env do backend e reinicie o servidor (npm run dev / npm start):\n');
  console.log(`   ASAAS_API_BASE_URL=http://localhost:${PORTA}/v3`);

  console.log('\n2) Na tela de Configurações do Gestor, cole esta chave fictícia no campo');
  console.log('   "Chave de API do Asaas" e clique em Salvar:\n');
  console.log(`   ${CHAVE_FICTICIA}`);

  console.log('\n(Ctrl+C para encerrar este mock.)');
  console.log('='.repeat(70));

  await seedAssociadosLocais();
});

function encerrar() {
  console.log('\nEncerrando mock da API do Asaas...');
  server.close(() => process.exit(0));
}

process.on('SIGINT', encerrar);
process.on('SIGTERM', encerrar);
