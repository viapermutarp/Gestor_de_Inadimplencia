/**
 * Teste end-to-end (Postgres real via embedded-postgres + mock do Asaas)
 * dos AJUSTES 1-4: exclusão combinada (manual + palavra-chave), filtro
 * em_juridico, campo "excluidos" no /resumo, e o novo endpoint
 * /evolucao-mensal. Roda tudo num único processo Node (sobe Postgres, roda
 * migrações, sobe o mock do Asaas e o app, faz as chamadas HTTP, valida, e
 * derruba tudo no final) — assim os processos filhos não somem entre
 * chamadas de shell separadas.
 */
const { execSync, spawn } = require('child_process');
const EmbeddedPostgres = require('embedded-postgres').default;

const BACKEND_DIR = '/sessions/keen-elegant-darwin/mnt/Gestor_de_Inadimplencia/backend';
const PG_PORT = 55447;
const APP_PORT = 3057;
const MOCK_PORT = 4001;
const API_KEY = 'test-api-key-ajustes-1234';
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

async function post(caminho, dados) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'POST', headers: HEADERS, body: JSON.stringify(dados) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}

async function patch(caminho, dados) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'PATCH', headers: HEADERS, body: JSON.stringify(dados) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}

async function del(caminho) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'DELETE', headers: HEADERS });
  const corpo = resp.status === 204 ? null : await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}

async function main() {
  console.log('== Subindo Postgres embutido ==');
  const pg = new EmbeddedPostgres({
    databaseDir: '/tmp/pgdata-ajustes-1-4',
    user: 'postgres',
    password: 'postgres',
    port: PG_PORT,
    persistent: false,
  });
  await pg.initialise();
  await pg.start();
  await pg.createDatabase('gestor_test');

  const databaseUrl = `postgresql://postgres:postgres@localhost:${PG_PORT}/gestor_test?schema=public`;

  console.log('== Rodando prisma generate + migrate deploy ==');
  execSync('npx prisma generate', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' });
  execSync('npx prisma migrate deploy', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL: databaseUrl }, stdio: 'inherit' });

  console.log('== Subindo mock do Asaas ==');
  const mock = spawn('node', ['scripts/mock-asaas-server.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, DATABASE_URL: databaseUrl, MOCK_ASAAS_PORT: String(MOCK_PORT) },
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
      ASAAS_API_BASE_URL: `http://localhost:${MOCK_PORT}/v3`,
      JWT_SECRET: 'test-secret-ajustes',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'admin123',
    },
    stdio: 'inherit',
  });

  try {
    await sleep(2500);
    await esperarServidor(`http://localhost:${MOCK_PORT}/v3/payments`);
    await esperarServidor(`http://localhost:${APP_PORT}/api/inadimplencia/resumo`);
    await sleep(500); // dá tempo do seed de associados do mock terminar

    // -----------------------------------------------------------------
    // 1) /api/config/palavras-excluidas — GET inicial, PATCH inválido, PATCH válido
    // -----------------------------------------------------------------
    console.log('\n== Teste: GET/PATCH /api/config/palavras-excluidas ==');
    {
      const r1 = await get('/config/palavras-excluidas');
      assertEqual(r1.status, 200, 'GET palavras-excluidas inicial -> 200');
      assert(Array.isArray(r1.corpo.palavras) && r1.corpo.palavras.length === 0, 'lista inicial vazia');

      const rInvalido = await patch('/config/palavras-excluidas', { palavras: 'não é array' });
      assertEqual(rInvalido.status, 400, 'PATCH com "palavras" não-array -> 400');

      const rValido = await patch('/config/palavras-excluidas', { palavras: ['não contabilizar'] });
      assertEqual(rValido.status, 200, 'PATCH palavras-excluidas válido -> 200');
      assertEqual(rValido.corpo.palavras.length, 1, 'lista salva tem 1 palavra');

      const r2 = await get('/config/palavras-excluidas');
      assertEqual(r2.corpo.palavras[0], 'não contabilizar', 'palavra persistida corretamente');
    }

    // -----------------------------------------------------------------
    // 2) /api/inadimplencia/exclusoes — CRUD manual
    // -----------------------------------------------------------------
    console.log('\n== Teste: GET/POST/DELETE /api/inadimplencia/exclusoes ==');
    let idExclusaoEpsilon;
    {
      const rVazia = await get('/inadimplencia/exclusoes');
      assertEqual(rVazia.status, 200, 'GET exclusoes inicial -> 200');
      assertEqual(rVazia.corpo.length, 0, 'lista de exclusões manuais inicial vazia');

      const rSemId = await post('/inadimplencia/exclusoes', { motivo: 'sem id' });
      assertEqual(rSemId.status, 400, 'POST sem asaas_payment_id -> 400');

      const rEpsilon = await post('/inadimplencia/exclusoes', {
        asaas_payment_id: 'pay_mock_005',
        motivo: 'excluído manualmente nos testes',
      });
      assertEqual(rEpsilon.status, 201, 'POST exclusao pay_mock_005 -> 201');
      idExclusaoEpsilon = rEpsilon.corpo.id;

      const rTheta = await post('/inadimplencia/exclusoes', { asaas_payment_id: 'pay_mock_008' });
      assertEqual(rTheta.status, 201, 'POST exclusao pay_mock_008 -> 201');

      const rDuplicada = await post('/inadimplencia/exclusoes', { asaas_payment_id: 'pay_mock_005' });
      assertEqual(rDuplicada.status, 409, 'POST duplicada (mesmo asaas_payment_id) -> 409');

      const rLista = await get('/inadimplencia/exclusoes');
      assertEqual(rLista.corpo.length, 2, 'lista de exclusões manuais agora tem 2 itens');
    }

    // -----------------------------------------------------------------
    // 3) /api/inadimplencia/resumo — exclusão combinada + campo "excluidos"
    //    (003 excluído só por palavra-chave, 005 só manual, 008 pelos dois)
    // -----------------------------------------------------------------
    console.log('\n== Teste: /api/inadimplencia/resumo — exclusão combinada (AJUSTE 1 + 3) ==');
    {
      const r = await get('/inadimplencia/resumo');
      assertEqual(r.status, 200, 'GET resumo -> 200');

      assertEqual(r.corpo.excluidos.quantidade, 3, 'excluidos.quantidade = 3 (003 palavra + 005 manual + 008 ambos, sem duplicar)');
      assertEqual(r.corpo.excluidos.valor, 1415.5, 'excluidos.valor = 430.5 + 675 + 310 = 1415.5');

      // valor_total_faturado/valor_inadimplente já sem os 3 excluídos
      assertEqual(r.corpo.valor_total_faturado, 24925, 'valor_total_faturado exclui os 3 pagamentos (26340.5 - 1415.5)');
      assertEqual(r.corpo.valor_inadimplente, 17530, 'valor_inadimplente exclui os 3 pagamentos (18945.5 - 1415.5)');

      const taxaEsperada = Math.round((17530 / 24925) * 100 * 100) / 100;
      assertEqual(r.corpo.taxa_inadimplencia_percentual, taxaEsperada, 'taxa_inadimplencia_percentual bate com o cálculo manual');
    }

    // -----------------------------------------------------------------
    // 4) Remove uma exclusão manual (pay_mock_005) e confirma que o cache
    //    foi invalidado — pay_mock_008 continua excluído só pela palavra.
    // -----------------------------------------------------------------
    console.log('\n== Teste: DELETE exclusão manual invalida o cache ==');
    {
      const rDelete = await del(`/inadimplencia/exclusoes/${idExclusaoEpsilon}`);
      assertEqual(rDelete.status, 204, 'DELETE exclusao pay_mock_005 -> 204');

      const rDeleteInexistente = await del(`/inadimplencia/exclusoes/${idExclusaoEpsilon}`);
      assertEqual(rDeleteInexistente.status, 404, 'DELETE de exclusão já removida -> 404');

      const rLista = await get('/inadimplencia/exclusoes');
      assertEqual(rLista.corpo.length, 1, 'lista de exclusões manuais agora tem 1 item (só pay_mock_008)');

      const r = await get('/inadimplencia/resumo');
      // agora só 003 (palavra) e 008 (palavra, já que a exclusão manual dele
      // foi removida mas a descrição ainda contém "não contabilizar") ficam
      // excluídos — pay_mock_005 volta a entrar no cálculo.
      assertEqual(r.corpo.excluidos.quantidade, 2, 'excluidos.quantidade = 2 após remover a exclusão manual de pay_mock_005 (cache foi invalidado)');
      assertEqual(r.corpo.excluidos.valor, 740.5, 'excluidos.valor = 430.5 + 310 = 740.5');
    }

    // Recoloca pay_mock_005 na lista manual para os testes seguintes
    // (em_juridico, evolucao-mensal) usarem o mesmo cenário de exclusão
    // documentado no README (3 excluídos: 003, 005, 008).
    await post('/inadimplencia/exclusoes', { asaas_payment_id: 'pay_mock_005', motivo: 'excluído manualmente nos testes' });

    // -----------------------------------------------------------------
    // 5) Filtro em_juridico (AJUSTE 2) — espelha renegociacao
    // -----------------------------------------------------------------
    console.log('\n== Teste: /api/inadimplencia/resumo?em_juridico=sim (AJUSTE 2) ==');
    {
      const rInvalido = await get('/inadimplencia/resumo?em_juridico=talvez');
      assertEqual(rInvalido.status, 400, 'em_juridico inválido -> 400');

      const r = await get('/inadimplencia/resumo?em_juridico=sim');
      assertEqual(r.status, 200, 'GET resumo?em_juridico=sim -> 200');

      // Beta (em_juridico=true, em_negociacao=true): pay_mock_002 (1200) + pay_mock_012 (890)
      // Delta (em_juridico=true, em_negociacao=false): pay_mock_004 (2100) + pay_mock_019 (1500, PENDING)
      assertEqual(r.corpo.valor_total_faturado, 5690, 'em_juridico=sim: valor_total_faturado = 1200+890+2100+1500');
      assertEqual(r.corpo.valor_inadimplente, 4190, 'em_juridico=sim: valor_inadimplente = 1200+890+2100 (só OVERDUE)');
      assertEqual(r.corpo.associados_inadimplentes, 2, 'em_juridico=sim: 2 associados inadimplentes (Beta e Delta)');
      assertEqual(r.corpo.criticos_90_dias, 890, 'em_juridico=sim: criticos_90_dias = pay_mock_012 (150 dias)');
      assertEqual(r.corpo.renegociacoes_abertas.quantidade, 2, 'em_juridico=sim: renegociacoes_abertas.quantidade = 2 (só Beta está em negociação)');
      assertEqual(r.corpo.renegociacoes_abertas.valor, 2090, 'em_juridico=sim: renegociacoes_abertas.valor = 1200+890');
      assertEqual(r.corpo.faixas['0_20'], 1200, 'em_juridico=sim: faixa 0_20 = pay_mock_002');
      assertEqual(r.corpo.faixas['20_30'], 2100, 'em_juridico=sim: faixa 20_30 = pay_mock_004');
      assertEqual(r.corpo.faixas['100_180'], 890, 'em_juridico=sim: faixa 100_180 = pay_mock_012');
      // exclusão combinada é independente do filtro em_juridico/renegociacao
      assertEqual(r.corpo.excluidos.quantidade, 3, 'em_juridico=sim: excluidos.quantidade continua 3 (exclusão é anterior ao cross-reference)');

      const rNao = await get('/inadimplencia/resumo?em_juridico=nao');
      // total geral (24925) menos o subconjunto em_juridico=sim (5690)
      assertEqual(rNao.corpo.valor_total_faturado, 24925 - 5690, 'em_juridico=nao: complementar de em_juridico=sim');
    }

    // -----------------------------------------------------------------
    // 6) evolucao-mensal (AJUSTE 4) — pelo menos 3 meses distintos
    // -----------------------------------------------------------------
    console.log('\n== Teste: /api/inadimplencia/evolucao-mensal (AJUSTE 4) ==');
    {
      const r = await get('/inadimplencia/evolucao-mensal?venc_de=2025-12-01&venc_ate=2026-09-05');
      assertEqual(r.status, 200, 'GET evolucao-mensal -> 200');
      assert(Array.isArray(r.corpo), 'resposta é um array');

      const porMes = Object.fromEntries(r.corpo.map((m) => [m.mes, m]));

      assert(Object.keys(porMes).length >= 3, `pelo menos 3 meses no resultado (obtido: ${Object.keys(porMes).length})`);
      assert('2025-12' in porMes, 'mês 2025-12 presente no intervalo pedido');
      assert('2026-04' in porMes, 'mês 2026-04 presente no intervalo pedido');
      assert('2026-07' in porMes, 'mês 2026-07 presente no intervalo pedido');
      assert('2026-08' in porMes, 'mês 2026-08 presente no intervalo pedido');

      // Dez/2025: só pay_mock_013 (4500, OVERDUE) — 100% inadimplência
      assertEqual(porMes['2025-12'].valor_total_faturado, 4500, 'Dez/2025: valor_total_faturado = 4500');
      assertEqual(porMes['2025-12'].valor_inadimplente, 4500, 'Dez/2025: valor_inadimplente = 4500');
      assertEqual(porMes['2025-12'].taxa_inadimplencia_percentual, 100, 'Dez/2025: taxa_inadimplencia = 100%');
      assertEqual(porMes['2025-12'].taxa_adimplencia_percentual, 0, 'Dez/2025: taxa_adimplencia = 0% (complementar)');

      // Jun/2026: só pay_mock_009 (1750, OVERDUE) — pay_mock_008 (310) excluído por palavra-chave
      assertEqual(porMes['2026-06'].valor_total_faturado, 1750, 'Jun/2026: valor_total_faturado = 1750 (008 excluído)');
      assertEqual(porMes['2026-06'].valor_inadimplente, 1750, 'Jun/2026: valor_inadimplente = 1750');

      // Jul/2026: 004(2100,OVERDUE)+006(1580,OVERDUE)+007(920,OVERDUE)+016(1200,RECEIVED)+017(990,CONFIRMED)
      // (003 e 005 excluídos)
      assertEqual(porMes['2026-07'].valor_total_faturado, 6790, 'Jul/2026: valor_total_faturado = 6790 (003 e 005 excluídos)');
      assertEqual(porMes['2026-07'].valor_inadimplente, 4600, 'Jul/2026: valor_inadimplente = 4600');

      // Ago/2026: 001(850,OVERDUE)+002(1200,OVERDUE)+014(450,PENDING)+015(680,PENDING)+020(275,CONFIRMED)
      assertEqual(porMes['2026-08'].valor_total_faturado, 3455, 'Ago/2026: valor_total_faturado = 3455');
      assertEqual(porMes['2026-08'].valor_inadimplente, 2050, 'Ago/2026: valor_inadimplente = 2050');

      // Mês sem nenhum pagamento no dataset (jan/2026) -> tudo zerado, 0% inadimplência, 100% adimplência
      if (porMes['2026-01']) {
        assertEqual(porMes['2026-01'].valor_total_faturado, 0, 'Jan/2026 (sem dados): valor_total_faturado = 0');
        assertEqual(porMes['2026-01'].taxa_inadimplencia_percentual, 0, 'Jan/2026 (sem dados): taxa_inadimplencia = 0%');
        assertEqual(porMes['2026-01'].taxa_adimplencia_percentual, 100, 'Jan/2026 (sem dados): taxa_adimplencia = 100%');
      }

      // Set/2026: só pay_mock_019 (1500, PENDING) -> 0% inadimplência
      if (porMes['2026-09']) {
        assertEqual(porMes['2026-09'].valor_total_faturado, 1500, 'Set/2026: valor_total_faturado = 1500 (só pendente)');
        assertEqual(porMes['2026-09'].valor_inadimplente, 0, 'Set/2026: valor_inadimplente = 0');
        assertEqual(porMes['2026-09'].taxa_adimplencia_percentual, 100, 'Set/2026: taxa_adimplencia = 100%');
      }

      // smoke test: evolucao-mensal com filtro combinado não deve quebrar
      const rFiltrado = await get('/inadimplencia/evolucao-mensal?venc_de=2025-12-01&venc_ate=2026-09-05&renegociacao=sim&em_juridico=nao');
      assertEqual(rFiltrado.status, 200, 'evolucao-mensal com renegociacao+em_juridico combinados -> 200');

      // cache: mesma combinação de parâmetros deve retornar exatamente igual (vindo do cache)
      const rCache = await get('/inadimplencia/evolucao-mensal?venc_de=2025-12-01&venc_ate=2026-09-05');
      assertEqual(JSON.stringify(rCache.corpo), JSON.stringify(r.corpo), 'segunda chamada idêntica volta do cache (mesmo resultado)');
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
