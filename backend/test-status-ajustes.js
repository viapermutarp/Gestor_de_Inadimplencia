/**
 * Teste end-to-end (Postgres real via embedded-postgres + mock inline do
 * Asaas) do AJUSTE CRÍTICO 3 (valor_inadimplente/valor_adimplente por
 * status atual do Asaas), AJUSTE 4 (filtro tipo_pendencia) e AJUSTE 5
 * (faixa "ate_vencimento" + renomeação "acima_100"). Segue o mesmo padrão
 * de test-ajustes.js: sobe tudo num único processo Node, faz as chamadas
 * HTTP, valida, derruba no final.
 */
const { execSync, spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;

const BACKEND_DIR = __dirname;
const PG_PORT = 55463;
const APP_PORT = 3071;
const MOCK_PORT = 4055;
const API_KEY = 'test-api-key-status-ajustes';
const ASAAS_CHAVE = 'asaas-mock-status-teste';
const BASE = `http://localhost:${APP_PORT}/api`;
const HEADERS = { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}` };

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
  assert(atual === esperado, `${mensagem} (esperado=${JSON.stringify(esperado)}, obtido=${JSON.stringify(atual)})`);
}
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function esperarServidor(url, tentativas = 40) {
  for (let i = 0; i < tentativas; i += 1) {
    try {
      const resp = await fetch(url);
      if (resp.status) return true;
    } catch (err) {
      // ainda não subiu
    }
    await sleep(500);
  }
  throw new Error(`Servidor não respondeu a tempo: ${url}`);
}
async function get(caminho) {
  const resp = await fetch(`${BASE}${caminho}`, { headers: HEADERS });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
async function patch(caminho, dados) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'PATCH', headers: HEADERS, body: JSON.stringify(dados) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}

// ---------------------------------------------------------------------
// Modelo "esperado", derivado independentemente da mesma convenção de
// offsets usada em mock-asaas-inline.js (dueOffset/payOffset = dias atrás;
// diasAtraso de um pago = dueOffset - payOffset). Não importa nada do
// controller — é um cálculo em paralelo, pra comparar contra a resposta
// real da API.
// ---------------------------------------------------------------------
const arred2 = (v) => Math.round(v * 100) / 100;
const taxa = (total_, parcial) => (total_ > 0 ? arred2((parcial / total_) * 100) : 0);

async function main() {
  console.log('== Subindo Postgres embutido ==');
  const pg = new EmbeddedPostgres({
    databaseDir: '/tmp/pgdata-status-ajustes',
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
    createPostgresUser: true,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('gestor_test');

  const databaseUrl = `postgresql://postgres:postgres@localhost:${PG_PORT}/gestor_test?schema=public`;

  console.log('== Rodando prisma generate + migrate deploy ==');
  execSync('npx prisma generate', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' });
  execSync('npx prisma migrate deploy', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' });

  console.log('== Subindo mock do Asaas ==');
  const mock = spawn('node', ['mock-asaas-inline.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, MOCK_ASAAS_PORT: String(MOCK_PORT) },
    stdio: 'inherit',
  });

  console.log('== Subindo app ==');
  const app = spawn('node', ['src/server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      PORT: String(APP_PORT),
      API_KEY,
      ASAAS_API_BASE_URL: `http://localhost:${MOCK_PORT}`,
      JWT_SECRET: 'test-secret-status-ajustes',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'admin123',
    },
    stdio: 'inherit',
  });

  try {
    await sleep(2000);
    await esperarServidor(`http://localhost:${MOCK_PORT}/payments`);
    await esperarServidor(`http://localhost:${APP_PORT}/api/inadimplencia/resumo`);
    await sleep(300);

    console.log('\n== Setup: configurar chave do Asaas ==');
    {
      const r = await patch('/config/asaas-key', { chave: ASAAS_CHAVE });
      assertEqual(r.status, 200, 'PATCH /config/asaas-key -> 200');
    }

    // -----------------------------------------------------------------
    // GRUPO A — AJUSTE CRÍTICO 3 + AJUSTE 4 (status atual, tipo_pendencia)
    // Período: cobre dueOffset de 290 a 330 (Grupo A, deslocado), exclui o
    // Grupo B (offsets naturais 0-101) por uma folga de 40+ dias.
    // -----------------------------------------------------------------
    const hoje = new Date();
    function isoOffset(diasAtras) {
      const d = new Date(hoje);
      d.setDate(d.getDate() - diasAtras);
      return d.toISOString().slice(0, 10);
    }
    const periodoA = `venc_de=${isoOffset(340)}&venc_ate=${isoOffset(150)}`;

    console.log('\n== Teste: AJUSTE CRÍTICO 3 — valor_inadimplente/valor_adimplente por status atual ==');
    {
      const r = await get(`/inadimplencia/resumo?${periodoA}`);
      assertEqual(r.status, 200, 'GET resumo (Grupo A, tipo_pendencia=todos padrão) -> 200');

      // valor_total_faturado = soma de TODOS, qualquer status: 1000+700+900+300+400+200
      assertEqual(r.corpo.valor_total_faturado, 3500, 'valor_total_faturado = soma de todos os status (3500)');
      // valor_inadimplente (tipo_pendencia=todos) = OVERDUE(1000) + CONFIRMED(700)
      assertEqual(r.corpo.valor_inadimplente, 1700, 'valor_inadimplente = OVERDUE + CONFIRMED (1700)');
      // valor_adimplente = RECEIVED(900) + RECEIVED_IN_CASH(300), mesmo o RECEIVED tendo sido pago com atraso histórico
      assertEqual(r.corpo.valor_adimplente, 1200, 'valor_adimplente = RECEIVED + RECEIVED_IN_CASH (1200), mesmo com atraso histórico');
      assertEqual(r.corpo.taxa_inadimplencia_percentual, taxa(3500, 1700), 'taxa_inadimplencia_percentual bate com o cálculo manual');
      assertEqual(r.corpo.taxa_adimplencia_percentual, taxa(3500, 1200), 'taxa_adimplencia_percentual bate com o cálculo manual');
      assert(r.corpo.valor_total_faturado !== r.corpo.valor_inadimplente + r.corpo.valor_adimplente,
        'total != inadimplente + adimplente (terceiro grupo PENDING+REFUNDED existe, e está correto ficar de fora)');
    }

    console.log('\n== Teste: AJUSTE 4 — filtro tipo_pendencia ==');
    {
      const rInvalido = await get(`/inadimplencia/resumo?${periodoA}&tipo_pendencia=talvez`);
      assertEqual(rInvalido.status, 400, 'tipo_pendencia inválido -> 400');

      const rVencidas = await get(`/inadimplencia/resumo?${periodoA}&tipo_pendencia=vencidas`);
      assertEqual(rVencidas.corpo.valor_inadimplente, 1000, 'tipo_pendencia=vencidas: valor_inadimplente = só OVERDUE (1000)');
      assertEqual(rVencidas.corpo.valor_adimplente, 1200, 'tipo_pendencia=vencidas: valor_adimplente inalterado (1200)');
      assertEqual(rVencidas.corpo.valor_total_faturado, 3500, 'tipo_pendencia=vencidas: valor_total_faturado inalterado (3500)');

      const rConfirmadas = await get(`/inadimplencia/resumo?${periodoA}&tipo_pendencia=confirmadas`);
      assertEqual(rConfirmadas.corpo.valor_inadimplente, 700, 'tipo_pendencia=confirmadas: valor_inadimplente = só CONFIRMED (700)');
      assertEqual(rConfirmadas.corpo.valor_adimplente, 1200, 'tipo_pendencia=confirmadas: valor_adimplente inalterado (1200)');

      const rTodos = await get(`/inadimplencia/resumo?${periodoA}&tipo_pendencia=todos`);
      assertEqual(rTodos.corpo.valor_inadimplente, 1700, 'tipo_pendencia=todos explícito: valor_inadimplente = 1700 (mesmo do padrão)');
    }

    console.log('\n== Teste: evolucao-mensal usa o mesmo critério por status ==');
    {
      const r = await get(`/inadimplencia/evolucao-mensal?${periodoA}`);
      assertEqual(r.status, 200, 'GET evolucao-mensal (Grupo A) -> 200');
      const totalInadimplenteMeses = r.corpo.reduce((s, m) => s + m.valor_inadimplente, 0);
      const totalAdimplenteMeses = r.corpo.reduce((s, m) => s + m.valor_total_faturado * 0 + m.valor_inadimplente * 0, 0); // placeholder unused
      assertEqual(arred2(totalInadimplenteMeses), 1700, 'soma de valor_inadimplente por mês bate com o /resumo (1700)');

      const rVencidas = await get(`/inadimplencia/evolucao-mensal?${periodoA}&tipo_pendencia=vencidas`);
      const totalVencidas = arred2(rVencidas.corpo.reduce((s, m) => s + m.valor_inadimplente, 0));
      assertEqual(totalVencidas, 1000, 'evolucao-mensal?tipo_pendencia=vencidas: soma bate (1000)');
    }

    // -----------------------------------------------------------------
    // GRUPO B — AJUSTE 5 (faixas: ate_vencimento, renomeação acima_100)
    // Período: cobre dueOffset 0 a 101 (offsets "naturais" = diasAtraso),
    // bem afastado do Grupo A (290-330).
    // -----------------------------------------------------------------
    const periodoB = `venc_de=${isoOffset(140)}&venc_ate=${isoOffset(-5)}`;

    console.log('\n== Teste: AJUSTE 5 — faixas "aberto" (tolerancia=0) ==');
    {
      const r = await get(`/inadimplencia/resumo?${periodoB}&visao_faixas=aberto`);
      assertEqual(r.status, 200, 'GET resumo (Grupo B, aberto) -> 200');
      assertEqual(r.corpo.faixas.ate_vencimento, 111, 'aberto: ate_vencimento = b_atevenc (111)');
      assertEqual(r.corpo.faixas['1_20'], 222 + 777, 'aberto: 1_20 = b_1_20 + b_tolerancia (999)');
      assertEqual(r.corpo.faixas['21_30'], 0, 'aberto: 21_30 = 0 (nenhum OVERDUE nessa faixa)');
      assertEqual(r.corpo.faixas['51_100'], 333, 'aberto: 51_100 = b_51_100 (333)');
      assertEqual(r.corpo.faixas.acima_100, 444, 'aberto: acima_100 = b_acima100 (444, 101 dias)');
      assertEqual(r.corpo.criticos_90_dias, 444, 'aberto: criticos_90_dias = b_acima100 (444, 101 dias >= 90)');
    }

    console.log('\n== Teste: AJUSTE 5 — faixas "historico" (tolerancia=0) ==');
    {
      const r = await get(`/inadimplencia/resumo?${periodoB}&visao_faixas=historico`);
      assertEqual(r.status, 200, 'GET resumo (Grupo B, historico) -> 200');
      assertEqual(r.corpo.faixas.ate_vencimento, 111, 'historico: ate_vencimento = b_atevenc (111)');
      assertEqual(r.corpo.faixas['1_20'], 222 + 777, 'historico: 1_20 = b_1_20 + b_tolerancia (999)');
      assertEqual(r.corpo.faixas['21_30'], 505, 'historico: 21_30 = b_pago_21_30 (505, pago com 22d de atraso)');
      assertEqual(r.corpo.faixas['31_40'], 606, 'historico: 31_40 = b_pago_31_40 (606, pago com 37d de atraso)');
      assertEqual(r.corpo.faixas['41_50'], 707, 'historico: 41_50 = b_pago_41_50 (707, pago com 46d de atraso)');
      assertEqual(r.corpo.faixas['51_100'], 333, 'historico: 51_100 = b_51_100 (333)');
      assertEqual(r.corpo.faixas.acima_100, 444, 'historico: acima_100 = b_acima100 (444, 101 dias)');
      assertEqual(r.corpo.criticos_90_dias, 444, 'historico: criticos_90_dias = b_acima100 (444)');
    }

    console.log('\n== Teste: AJUSTE 5 + tolerância — "ate_vencimento" absorve cobrança dentro da janela ==');
    {
      const rTol = await patch('/config/tolerancia-dias', { dias: 3 });
      assertEqual(rTol.status, 200, 'PATCH tolerancia-dias=3 -> 200 (limpa cache automaticamente)');

      const r = await get(`/inadimplencia/resumo?${periodoB}&visao_faixas=aberto&forcar=true`);
      assertEqual(r.status, 200, 'GET resumo (Grupo B, aberto, tolerancia=3) -> 200');
      // b_atevenc (dueOffset 0-3=-3, efetivo <=0 igual) e b_tolerancia
      // (dueOffset 2-3=-1<=0) migram/ficam em ate_vencimento; b_acima100
      // (101-3=98) sai de acima_100 e entra em 51_100, mas continua em
      // criticos_90_dias (98>=90).
      assertEqual(r.corpo.faixas.ate_vencimento, 111 + 777, 'tolerancia=3: ate_vencimento = b_atevenc + b_tolerancia (888)');
      assertEqual(r.corpo.faixas['1_20'], 222, 'tolerancia=3: 1_20 = só b_1_20 (222, b_tolerancia saiu)');
      assertEqual(r.corpo.faixas['51_100'], 333 + 444, 'tolerancia=3: 51_100 = b_51_100 + b_acima100 deslocado (777)');
      assertEqual(r.corpo.faixas.acima_100, 0, 'tolerancia=3: acima_100 = 0 (b_acima100 deslocado pra 51_100)');
      assertEqual(r.corpo.criticos_90_dias, 444, 'tolerancia=3: criticos_90_dias ainda inclui b_acima100 (98 dias efetivos >= 90)');

      // devolve a tolerância a 0 para não vazar estado para outros testes.
      const rTolReset = await patch('/config/tolerancia-dias', { dias: 0 });
      assertEqual(rTolReset.status, 200, 'PATCH tolerancia-dias=0 (reset) -> 200');
    }

    console.log(`\n${'='.repeat(60)}\nResultado: ${total - falhas}/${total} passaram.`);
    if (falhas > 0) {
      console.error(`${falhas} ASSERÇÕES FALHARAM.`);
      process.exitCode = 1;
    } else {
      console.log('TODOS OS TESTES PASSARAM.');
    }
  } finally {
    mock.kill();
    app.kill();
    await sleep(300);
    await pg.stop();
  }
}

main().catch((err) => {
  console.error('Erro fatal no teste:', err);
  process.exit(1);
});
