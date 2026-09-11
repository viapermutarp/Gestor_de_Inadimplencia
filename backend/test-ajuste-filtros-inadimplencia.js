/**
 * Teste end-to-end do brief "Repaginar filtros da Taxa de Inadimplência" —
 * Postgres real (serviço "postgresql" local, mesmo padrão de
 * test-ajuste14.js), servidor Express real, mock standalone do Asaas,
 * chamadas HTTP reais via fetch. Cobre só o que este ajuste mudou/adicionou
 * (não repete a cobertura já existente em test-ajuste14.js/
 * test-status-ajustes.js):
 *
 *   1. "dateCreated" (emissão) persistido via webhook e via backfill.
 *   2. "filtro_periodo" (vencimento|emissao|pagamento) — população correta
 *      em cada modo, incluindo cobranças sem paymentDate ficando de fora em
 *      "pagamento".
 *   3. "situacao" (em_aberto|pagas, combinável) — filtro de POPULAÇÃO (afeta
 *      valor_total_faturado, não só valor_inadimplente), incluindo o caso
 *      "os dois marcados juntos" != "sem filtro" (status fora dos dois
 *      buckets, ex. REFUNDED, continua de fora).
 *   4. "tipo_inadimplente" (ativo|juridico|critico, combinável por OU) —
 *      inclusive "critico" respeitando "visao" (aberto x historico) e o
 *      caso "jurídico E crítico ao mesmo tempo" sem duplicar valor.
 *   5. /evolucao-mensal bucketizando pelo MESMO campo de data selecionado em
 *      "filtro_periodo" (não sempre dueDate) — prova que um pagamento com
 *      dueDate fora da janela pedida, mas paymentDate dentro dela (modo
 *      "pagamento"), não desaparece silenciosamente do gráfico.
 *   6. Regressão — sem nenhum parâmetro novo, os números continuam
 *      exatamente os de antes (filtro_periodo=vencimento e situacao/
 *      tipo_inadimplente vazios são o default = comportamento antigo).
 */
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const BACKEND_DIR = __dirname;
const APP_PORT = 3091;
const MOCK_PORT = 4091;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_filtros_e2e_${Date.now()}`;
const DATABASE_URL = `postgresql://gestor:gestor@localhost:5432/${DB_NAME}?schema=public`;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}`;
const MOCK_TOKEN = 'mock-filtros-token';

let falhas = 0;
let total = 0;
function assert(condicao, mensagem) {
  total += 1;
  if (!condicao) {
    falhas += 1;
    console.error(`  ✗ FALHOU: ${mensagem}`);
  } else {
    console.log(`  ✓ ${mensagem}`);
  }
}
function assertEqual(atual, esperado, mensagem) {
  assert(JSON.stringify(atual) === JSON.stringify(esperado), `${mensagem} (esperado=${JSON.stringify(esperado)}, obtido=${JSON.stringify(atual)})`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function esperarServidor(url, tentativas = 40) {
  for (let i = 0; i < tentativas; i += 1) {
    try {
      const resp = await fetch(url);
      if (resp.status) return true;
    } catch (err) {}
    await sleep(500);
  }
  throw new Error(`Servidor não respondeu a tempo: ${url}`);
}
function gerarHashChave(chave) {
  return crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');
}
function headersPara(bearer) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` };
}
async function get(caminho, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { headers: headersPara(bearer) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
async function post(caminho, dados, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'POST', headers: headersPara(bearer), body: JSON.stringify(dados) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
async function postWebhook(franquiaId, dados, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token !== undefined) headers['asaas-access-token'] = token;
  const resp = await fetch(`${BASE}/asaas/webhook/${franquiaId}`, { method: 'POST', headers, body: JSON.stringify(dados) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}

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
// diaDoMes(offsetMeses, dia) — dia fixo de um mês relativo a "hoje" (ex.:
// diaDoMes(-1, 25) = dia 25 do mês passado). Usado só para p_cruza_mes:
// diferente de diasAtras/diasAFrente (deslocamento em DIAS, que não
// garante cair num mês civil específico), isso garante dueDate/
// paymentDate em meses civis ADJACENTES sempre, não importa quando o
// teste rodar — sem isso, datas fixas tipo "2026-07-25" quebrariam este
// teste (ou pior, passariam por coincidência) se rodado fora de 2026.
function diaDoMes(offsetMeses, dia) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(1); // evita overflow ao somar meses (ex.: 31/mar + 1 mês)
  d.setMonth(d.getMonth() + offsetMeses);
  d.setDate(dia);
  return formatarISO(d);
}

// ---------------------------------------------------------------------
// Dataset — ver docblock do arquivo para o "porquê" de cada linha.
// ---------------------------------------------------------------------
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
    // meses civis adjacentes, relativo a "hoje" — ver diaDoMes acima) —
    // prova que /evolucao-mensal com filtro_periodo=pagamento bucketiza por
    // paymentDate, não por dueDate (senão sumiria da janela do mês do pagamento).
    { id: 'p_cruza_mes', customer: 'cus_f', value: 900, dueDate: diaDoMes(-1, 25), dateCreated: diaDoMes(-1, 20), paymentDate: diaDoMes(0, 5), status: 'RECEIVED', description: 'cruza mes' },
  ];
}

// O mock do Asaas roda como PROCESSO SEPARADO (mock-asaas-filtros.js,
// spawn abaixo), não in-process aqui — ver docblock daquele arquivo pro
// motivo (execSync do backfill bloqueia o event loop deste processo).

async function main() {
  console.log(`== Criando banco de teste "${DB_NAME}" ==`);
  execSync(`sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER gestor;"`, { stdio: 'inherit' });

  console.log('\n== Rodando prisma migrate deploy ==');
  execSync('npx prisma migrate deploy', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL }, stdio: 'inherit' });

  process.env.DATABASE_URL = DATABASE_URL;
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  console.log('\n== Subindo mock do Asaas (processo separado) ==');
  const mock = spawn('node', ['mock-asaas-filtros.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, MOCK_ASAAS_FILTROS_PORT: String(MOCK_PORT), MOCK_ASAAS_FILTROS_TOKEN: MOCK_TOKEN },
    stdio: 'inherit',
  });

  console.log('\n== Subindo app ==');
  const app = spawn('node', ['src/server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(APP_PORT),
      API_KEY: 'nao-usada-neste-teste',
      ASAAS_API_BASE_URL: MOCK_BASE_URL,
      JWT_SECRET: 'test-secret-filtros',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'admin123',
      PUBLIC_BASE_URL: '',
    },
    stdio: 'inherit',
  });

  try {
    await sleep(1500);
    await esperarServidor(`${MOCK_BASE_URL}/payments`);
    await esperarServidor(`${BASE}/inadimplencia/resumo`);
    await sleep(300);

    console.log('\n== Setup: franquia + api key + associados locais + chave Asaas ==');
    const franquia = await db.franquia.create({ data: { nome: 'Filtros E2E' } });
    const chaveApi = crypto.randomBytes(24).toString('hex');
    await db.apiKey.create({
      data: {
        franquiaId: franquia.id,
        nome: 'teste-filtros',
        hash: gerarHashChave(chaveApi),
        tamanho: chaveApi.length,
        ultimosCaracteres: chaveApi.slice(-6),
      },
    });

    const rChave = await fetch(`${BASE}/config/asaas-key`, {
      method: 'PATCH',
      headers: headersPara(chaveApi),
      body: JSON.stringify({ chave: MOCK_TOKEN }),
    });
    assertEqual(rChave.status, 200, 'PATCH /config/asaas-key -> 200');

    for (const [customerId, cliente] of Object.entries(CLIENTES)) {
      await db.associado.create({
        data: {
          franquiaId: franquia.id,
          cpfCnpj: cliente.cpfCnpj,
          nome: cliente.name,
          telefone: '00000000000',
          emJuridico: customerId === 'cus_c',
        },
      });
    }

    // -------------------------------------------------------------
    // TESTE 1 — dateCreated persistido via webhook e via backfill.
    // -------------------------------------------------------------
    console.log('\n== Teste: dateCreated persistido ==');
    {
      const rWebhookToken = await post('/config/asaas-webhook/gerar', {}, chaveApi);
      assertEqual(rWebhookToken.status, 200, 'POST /config/asaas-webhook/gerar -> 200');
      const webhookToken = rWebhookToken.corpo.asaas_access_token;

      const payloadWebhook = montarPagamentos().find((p) => p.id === 'p_venc_atual');
      const rWebhook = await postWebhook(
        franquia.id,
        { id: 'evt_dateCreated', event: 'PAYMENT_CREATED', payment: payloadWebhook },
        webhookToken
      );
      assertEqual(rWebhook.status, 200, 'webhook PAYMENT_CREATED (p_venc_atual) -> 200');
      const linhaWebhook = await db.pagamentoAsaas.findUnique({ where: { id: 'p_venc_atual' } });
      assertEqual(linhaWebhook.dateCreated, payloadWebhook.dateCreated, 'dateCreated gravado corretamente via webhook');
    }

    console.log('\n== Backfill (dry-run + confirm) ==');
    function rodarBackfill(args) {
      return execSync(`node scripts/backfill-pagamentos-asaas.js --franquia=${franquia.id} ${args}`, {
        cwd: BACKEND_DIR,
        env: { ...process.env, DATABASE_URL, ASAAS_API_BASE_URL: MOCK_BASE_URL },
      }).toString();
    }
    const dryRunOut = rodarBackfill('');
    assert(/DRY RUN/i.test(dryRunOut), 'backfill sem --confirm roda em modo dry-run');
    const confirmOut = rodarBackfill('--confirm');
    assert(confirmOut.length > 0, 'backfill --confirm produziu saída');

    const todasLinhas = await db.pagamentoAsaas.findMany({ where: { franquiaId: franquia.id } });
    assertEqual(todasLinhas.length, montarPagamentos().length, `backfill populou as ${montarPagamentos().length} linhas do dataset`);
    for (const pagamentoMock of montarPagamentos()) {
      const linha = todasLinhas.find((l) => l.id === pagamentoMock.id);
      assert(!!linha, `linha "${pagamentoMock.id}" existe após o backfill`);
      assertEqual(linha.dateCreated, pagamentoMock.dateCreated, `dateCreated correto via backfill ("${pagamentoMock.id}")`);
    }

    // -------------------------------------------------------------
    // TESTE 2 — filtro_periodo.
    // -------------------------------------------------------------
    console.log('\n== Teste: filtro_periodo=vencimento (default, sem regressão) ==');
    {
      const r = await get(`/inadimplencia/resumo?venc_de=${diasAtras(15)}&venc_ate=${diasAtras(0)}`, chaveApi);
      assertEqual(r.status, 200, 'GET /resumo (vencimento, janela estreita) -> 200');
      assertEqual(r.corpo.valor_total_faturado, 1000, 'vencimento: só p_venc_atual (dueDate há 10 dias) no total');
    }

    console.log('\n== Teste: filtro_periodo=emissao ==');
    {
      const r = await get(`/inadimplencia/resumo?venc_de=${diasAtras(3)}&venc_ate=${diasAtras(0)}&filtro_periodo=emissao`, chaveApi);
      assertEqual(r.status, 200, 'GET /resumo (emissao) -> 200');
      assertEqual(r.corpo.valor_total_faturado, 700, 'emissao: p_confirmed(300, dateCreated há 2d) + p_pending_recent(400, dateCreated há 1d) = 700');
    }

    console.log('\n== Teste: filtro_periodo=pagamento (exclui quem nunca foi pago) ==');
    {
      const r = await get(`/inadimplencia/resumo?venc_de=${diasAtras(365)}&venc_ate=${diasAFrente(365)}&filtro_periodo=pagamento`, chaveApi);
      assertEqual(r.status, 200, 'GET /resumo (pagamento, janela ampla) -> 200');
      assertEqual(
        r.corpo.valor_total_faturado,
        2250,
        'pagamento: p_pago_recente(500) + p_refunded(150) + p_pago_com_atraso_grande(700) + p_cruza_mes(900) = 2250 — p_sem_pagamento_antigo (paymentDate null) fica de fora mesmo com janela ampla'
      );
    }

    // -------------------------------------------------------------
    // TESTE 3 — situacao (filtro de população, não só de valor_inadimplente).
    // -------------------------------------------------------------
    console.log('\n== Teste: situacao ==');
    const janelaAmpla = `venc_de=${diasAtras(365)}&venc_ate=${diasAFrente(365)}`;
    {
      const rTodas = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      assertEqual(rTodas.corpo.valor_total_faturado, 5950, 'sem situacao: soma de todos os 8 pagamentos do dataset (todos caem na janela ampla)');

      const rAberto = await get(`/inadimplencia/resumo?${janelaAmpla}&situacao=em_aberto`, chaveApi);
      assertEqual(rAberto.corpo.valor_total_faturado, 3700, 'situacao=em_aberto: OVERDUE+CONFIRMED+PENDING (1000+2000+300+400)');

      const rPagas = await get(`/inadimplencia/resumo?${janelaAmpla}&situacao=pagas`, chaveApi);
      assertEqual(
        rPagas.corpo.valor_total_faturado,
        2100,
        'situacao=pagas: só RECEIVED/RECEIVED_IN_CASH (p_pago_recente 500 + p_pago_com_atraso_grande 700 + p_cruza_mes 900 = 2100) — p_refunded (REFUNDED) fica de fora'
      );

      const rAmbas = await get(`/inadimplencia/resumo?${janelaAmpla}&situacao=em_aberto,pagas`, chaveApi);
      assertEqual(
        rAmbas.corpo.valor_total_faturado,
        5800,
        'situacao=em_aberto,pagas: união dos 2 buckets (3700+2100=5800) — DIFERENTE de "sem filtro" (5950): REFUNDED (150) continua de fora'
      );

      const rInvalida = await get(`/inadimplencia/resumo?${janelaAmpla}&situacao=inexistente`, chaveApi);
      assertEqual(rInvalida.status, 400, 'situacao com valor inválido -> 400');
    }

    // -------------------------------------------------------------
    // TESTE 4 — tipo_inadimplente (ativo/juridico/critico, combinável).
    // -------------------------------------------------------------
    console.log('\n== Teste: tipo_inadimplente ==');
    {
      const rAtivo = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=ativo`, chaveApi);
      assertEqual(
        rAtivo.corpo.valor_total_faturado,
        3950,
        'tipo_inadimplente=ativo: A+B+D+E+F (1000+300+500+150+400+700+900) — exclui só C (jurídico)'
      );

      const rJuridico = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=juridico`, chaveApi);
      assertEqual(rJuridico.corpo.valor_total_faturado, 2000, 'tipo_inadimplente=juridico: só C (2000)');

      // "Crítico" em visao=aberto (padrão): só considera pagamentos OVERDUE
      // — entre os OVERDUE, só p_sem_pagamento_antigo (C, ~200 dias) tem
      // diasAtraso >= 90; p_venc_atual (A, ~10 dias) não conta.
      const rCriticoAberto = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=critico`, chaveApi);
      assertEqual(rCriticoAberto.corpo.valor_total_faturado, 2000, 'tipo_inadimplente=critico (visao=aberto): só C (2000) — E não conta (não está OVERDUE)');

      // Jurídico E crítico ao mesmo tempo, mesmo associado (C) — não deve duplicar.
      const rJuridicoCritico = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=juridico,critico`, chaveApi);
      assertEqual(rJuridicoCritico.corpo.valor_total_faturado, 2000, 'juridico+critico (mesmo associado C nos dois) não duplica o valor');

      // "Crítico" em visao=historico: E entra (RECEIVED com paymentDate 110
      // dias depois do vencimento) e C se mantém (ainda INADIMPLENTE em
      // historico, nunca foi pago).
      const rCriticoHistorico = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=critico&visao=historico`, chaveApi);
      assertEqual(
        rCriticoHistorico.corpo.valor_total_faturado,
        2700,
        'tipo_inadimplente=critico (visao=historico): C(2000) + E(700, pago com 110 dias de atraso) = 2700'
      );

      const rInvalido = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=inexistente`, chaveApi);
      assertEqual(rInvalido.status, 400, 'tipo_inadimplente com valor inválido -> 400');
    }

    // -------------------------------------------------------------
    // TESTE 5 — /evolucao-mensal bucketiza pelo campo de filtro_periodo.
    // -------------------------------------------------------------
    console.log('\n== Teste: evolucao-mensal respeita filtro_periodo no agrupamento por mês ==');
    {
      // Janelas/valores esperados são CALCULADOS a partir do próprio dataset
      // (não hardcoded) porque p_cruza_mes usa diaDoMes (relativo a "hoje")
      // — ver docblock de diaDoMes. Isso também cobre, de forma correta,
      // qualquer outro pagamento do dataset que caia por coincidência no
      // mesmo mês civil (ex.: um diasAtras(N) que hoje caia no mesmo mês
      // que o dueDate de p_cruza_mes).
      const pagamentos = montarPagamentos();
      const cruzaMes = pagamentos.find((p) => p.id === 'p_cruza_mes');
      const mesVenc = cruzaMes.dueDate.slice(0, 7); // ex. "2026-08"
      const mesPag = cruzaMes.paymentDate.slice(0, 7); // ex. "2026-09" (mês seguinte)
      const primeiroDiaMes = (mes) => `${mes}-01`;
      const ultimoDiaMes = (mes) => {
        const [ano, m] = mes.split('-').map(Number);
        return `${mes}-${String(new Date(ano, m, 0).getDate()).padStart(2, '0')}`;
      };
      const somaPorCampo = (campo, mesAlvo) =>
        pagamentos.reduce((soma, p) => (p[campo] && p[campo].slice(0, 7) === mesAlvo ? soma + p.value : soma), 0);

      const rVencimento = await get(
        `/inadimplencia/evolucao-mensal?venc_de=${primeiroDiaMes(mesVenc)}&venc_ate=${ultimoDiaMes(mesVenc)}`,
        chaveApi
      );
      assertEqual(rVencimento.status, 200, `GET /evolucao-mensal (vencimento, ${mesVenc}) -> 200`);
      const bucketVenc = rVencimento.corpo.find((m) => m.mes === mesVenc);
      const esperadoVenc = somaPorCampo('dueDate', mesVenc);
      assertEqual(
        bucketVenc?.valor_total_faturado,
        esperadoVenc,
        `vencimento: soma de todos os pagamentos com dueDate em ${mesVenc} = ${esperadoVenc} (inclui p_cruza_mes e qualquer outro que caia no mesmo mês)`
      );

      const rPagamentoMesVenc = await get(
        `/inadimplencia/evolucao-mensal?venc_de=${primeiroDiaMes(mesVenc)}&venc_ate=${ultimoDiaMes(mesVenc)}&filtro_periodo=pagamento`,
        chaveApi
      );
      const bucketPagamentoMesVenc = rPagamentoMesVenc.corpo.find((m) => m.mes === mesVenc);
      const esperadoPagamentoMesVenc = somaPorCampo('paymentDate', mesVenc);
      assertEqual(
        bucketPagamentoMesVenc?.valor_total_faturado,
        esperadoPagamentoMesVenc,
        `pagamento: soma de todos os pagamentos com paymentDate em ${mesVenc} = ${esperadoPagamentoMesVenc} (p_cruza_mes foi pago em ${mesPag}, não em ${mesVenc}, então não conta aqui)`
      );

      const rPagamentoMesPag = await get(
        `/inadimplencia/evolucao-mensal?venc_de=${primeiroDiaMes(mesPag)}&venc_ate=${ultimoDiaMes(mesPag)}&filtro_periodo=pagamento`,
        chaveApi
      );
      assertEqual(rPagamentoMesPag.status, 200, `GET /evolucao-mensal (pagamento, ${mesPag}) -> 200`);
      const bucketPagamentoMesPag = rPagamentoMesPag.corpo.find((m) => m.mes === mesPag);
      const esperadoPagamentoMesPag = somaPorCampo('paymentDate', mesPag);
      assertEqual(
        bucketPagamentoMesPag?.valor_total_faturado,
        esperadoPagamentoMesPag,
        `pagamento: soma de todos os pagamentos com paymentDate em ${mesPag} = ${esperadoPagamentoMesPag} — p_cruza_mes (dueDate em ${mesVenc}) aparece aqui pelo mês do PAGAMENTO, sem sumir da janela`
      );
    }

    // -------------------------------------------------------------
    // TESTE 6 — regressão: sem nenhum parâmetro novo, número idêntico ao
    // comportamento de antes deste ajuste (filtro_periodo=vencimento e
    // situacao/tipo_inadimplente vazios são o default).
    // -------------------------------------------------------------
    console.log('\n== Teste: regressão (sem parâmetros novos) ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      const somaTotal = montarPagamentos().reduce((s, p) => s + p.value, 0);
      assertEqual(r.corpo.valor_total_faturado, somaTotal, `sem filtros novos: soma de todos os ${montarPagamentos().length} pagamentos (${somaTotal})`);
      // criticos_90_dias (visao=aberto, padrão) — lógica INALTERADA de
      // computarFaixasECriticos: só considera OVERDUE, e só C (~200 dias)
      // passa dos 90 dias — mesmo resultado do filtro tipo_inadimplente=critico
      // acima, confirmando que a função de cálculo em si não mudou.
      assertEqual(r.corpo.criticos_90_dias, 2000, 'criticos_90_dias (card, sem filtro) continua 2000 — mesma lógica de sempre');
    }

    console.log(`\n== Resultado: ${total - falhas}/${total} ==`);
    if (falhas > 0) process.exitCode = 1;
  } finally {
    app.kill('SIGKILL');
    mock.kill('SIGKILL');
    await db.$disconnect().catch(() => {});
    execSync(`sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME};"`, { stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
