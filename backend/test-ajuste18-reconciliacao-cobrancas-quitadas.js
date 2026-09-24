/**
 * Teste end-to-end do AJUSTE 18 — "Corrigir cobrança presa da Marcela +
 * fechar a lacuna estrutural da janela" (ver README, seção "AJUSTE 18", e
 * src/services/cobrancasPresas.service.js para o desenho completo). Mesmo
 * padrão das rodadas anteriores (test-ajuste14.js/test-ajuste17...): sobe
 * Postgres real (serviço local, não embutido) + servidor Express real,
 * chamadas HTTP reais via fetch, scripts rodados via execSync, tudo
 * validado consultando o banco direto no final, banco derrubado ao fim.
 *
 * Cobre:
 *   1. scripts/diagnostico-cobrancas-presas-sistemico.js — dry-run (dado
 *      NÃO alterado), --confirm (só as presas de verdade são quitadas,
 *      caso "misto" da Marcela — cobrança velha presa + parcela de
 *      renegociação genuinamente aberta — discriminado corretamente),
 *      quitada_em = paymentDate do Asaas (não "agora"), isolamento por
 *      --franquia, idempotência.
 *   2. scripts/reconciliar-cobrancas-quitadas-no-asaas.js — mesmo
 *      comportamento, dry-run/--confirm/--franquia.
 *   3. POST /api/sync/reconciliar-cobrancas-quitadas — mesma lógica via
 *      HTTP, escopado à franquia da API key usada, idempotência.
 *   4. Guardrail de segurança (> 60 presas) recusando aplicar sem --force
 *      nos dois scripts E no endpoint (409), aplicando corretamente com
 *      --force.
 *   5. Caso de borda: pagamento RECEIVED sem paymentDate — quitada_em cai
 *      pra "agora", sinalizado como aproximado.
 */
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const BACKEND_DIR = __dirname;
const APP_PORT = 3081;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_ajuste18_e2e_${Date.now()}`;
const DATABASE_URL = `postgresql://gestor:gestor@localhost:5432/${DB_NAME}?schema=public`;

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
  assert(
    JSON.stringify(atual) === JSON.stringify(esperado),
    `${mensagem} (esperado=${JSON.stringify(esperado)}, obtido=${JSON.stringify(atual)})`
  );
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
function headersPara(bearer) {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}` };
}
async function post(caminho, dados, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'POST', headers: headersPara(bearer), body: JSON.stringify(dados ?? {}) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
function gerarHashChave(chave) {
  return crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');
}
function diasAtras(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function dataISO(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}

async function main() {
  console.log(`== Criando banco de teste "${DB_NAME}" (Postgres real, serviço local) ==`);
  execSync(`sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER gestor;"`, { stdio: 'inherit' });

  console.log('\n== Rodando prisma migrate deploy ==');
  execSync('npx prisma migrate deploy', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL }, stdio: 'inherit' });

  process.env.DATABASE_URL = DATABASE_URL;
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  console.log('\n== Subindo app ==');
  const app = spawn('node', ['src/server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(APP_PORT),
      API_KEY: 'nao-usada-neste-teste',
      JWT_SECRET: 'test-secret-ajuste18',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'admin123',
      PUBLIC_BASE_URL: '',
    },
    stdio: 'inherit',
  });

  try {
    await sleep(1500);
    await esperarServidor(`${BASE}/inadimplencia/resumo`);
    await sleep(300);

    console.log('\n== Setup: franquias + api keys ==');
    const franquiaA = await db.franquia.create({ data: { nome: 'AJUSTE18 Franquia A' } });
    const franquiaB = await db.franquia.create({ data: { nome: 'AJUSTE18 Franquia B' } });

    async function criarApiKey(franquiaId, nome) {
      const chave = crypto.randomBytes(24).toString('hex');
      await db.apiKey.create({
        data: { franquiaId, nome, hash: gerarHashChave(chave), tamanho: chave.length, ultimosCaracteres: chave.slice(-6) },
      });
      return chave;
    }
    const bearerA = await criarApiKey(franquiaA.id, 'teste-a');
    const bearerB = await criarApiKey(franquiaB.id, 'teste-b');

    // -------------------------------------------------------------
    // Seed — franquia A: o caso "misto" da Marcela (o motivo do
    // refinamento por-cobrança) + controles.
    // -------------------------------------------------------------
    console.log('\n== Seed: franquia A (Marcela + controles) ==');

    async function criarAssociado(franquiaId, cpfCnpj, nome) {
      return db.associado.create({ data: { franquiaId, cpfCnpj, nome, telefone: '11999990000' } });
    }
    async function criarPar({ associadoId, franquiaId, cpfCnpj, nome, idExterno, valor, dueDate, paymentDate, statusAsaas, statusCobranca, diasDiferenca }) {
      await db.pagamentoAsaas.create({
        data: { id: idExterno, franquiaId, customerId: `cus_${idExterno}`, cpfCnpj, nome, value: valor, dueDate, paymentDate, status: statusAsaas, description: 'Mensalidade' },
      });
      return db.cobranca.create({
        data: { associadoId, idExterno, valor, vencimento: dataISO(dueDate), diasDiferenca, status: statusCobranca, descricao: 'Mensalidade', sincronizadoEm: new Date() },
      });
    }

    const marcela = await criarAssociado(franquiaA.id, '27649948000129', 'Marcela Teste');
    await criarPar({
      associadoId: marcela.id, franquiaId: franquiaA.id, cpfCnpj: marcela.cpfCnpj, nome: marcela.nome,
      idExterno: 'pay_marcela_velha', valor: 500, dueDate: diasAtras(60), paymentDate: diasAtras(5),
      statusAsaas: 'RECEIVED', statusCobranca: 'overdue', diasDiferenca: -53,
    });
    await criarPar({
      associadoId: marcela.id, franquiaId: franquiaA.id, cpfCnpj: marcela.cpfCnpj, nome: marcela.nome,
      idExterno: 'pay_marcela_reneg', valor: 150, dueDate: diasAtras(1), paymentDate: null,
      statusAsaas: 'PENDING', statusCobranca: 'pending', diasDiferenca: -1,
    });

    const paula = await criarAssociado(franquiaA.id, '22222222222', 'Paula Controle Devedora');
    await criarPar({
      associadoId: paula.id, franquiaId: franquiaA.id, cpfCnpj: paula.cpfCnpj, nome: paula.nome,
      idExterno: 'pay_paula_1', valor: 400, dueDate: diasAtras(15), paymentDate: null,
      statusAsaas: 'OVERDUE', statusCobranca: 'overdue', diasDiferenca: -15,
    });

    const rui = await criarAssociado(franquiaA.id, '44444444444', 'Rui Controle Presa Recente');
    await criarPar({
      associadoId: rui.id, franquiaId: franquiaA.id, cpfCnpj: rui.cpfCnpj, nome: rui.nome,
      idExterno: 'pay_rui_1', valor: 250, dueDate: diasAtras(10), paymentDate: diasAtras(2),
      statusAsaas: 'RECEIVED', statusCobranca: 'overdue', diasDiferenca: -10,
    });

    const ricardo = await criarAssociado(franquiaA.id, '33333333333', 'Ricardo Sem Id Externo');
    await db.cobranca.create({
      data: { associadoId: ricardo.id, idExterno: null, valor: 200, vencimento: dataISO(diasAtras(10)), diasDiferenca: -10, status: 'pending', descricao: 'Mensalidade', sincronizadoEm: new Date() },
    });

    const flavia = await criarAssociado(franquiaA.id, '55555555555', 'Flavia Sem Correspondencia');
    await db.cobranca.create({
      data: { associadoId: flavia.id, idExterno: 'pay_flavia_inexistente', valor: 300, vencimento: dataISO(diasAtras(5)), diasDiferenca: -5, status: 'pending', descricao: 'Mensalidade', sincronizadoEm: new Date() },
    });

    // Caso de borda: RECEIVED sem paymentDate (não deveria acontecer na
    // prática, mas o serviço precisa se comportar bem mesmo assim).
    const edu = await criarAssociado(franquiaA.id, '66666666666', 'Edu Sem PaymentDate');
    await criarPar({
      associadoId: edu.id, franquiaId: franquiaA.id, cpfCnpj: edu.cpfCnpj, nome: edu.nome,
      idExterno: 'pay_edu_1', valor: 100, dueDate: diasAtras(30), paymentDate: null,
      statusAsaas: 'RECEIVED', statusCobranca: 'overdue', diasDiferenca: -30,
    });

    // -------------------------------------------------------------
    // Seed — franquia B: 1 presa isolada, pra testar escopo por franquia.
    // -------------------------------------------------------------
    console.log('\n== Seed: franquia B (isolamento) ==');
    const bianca = await criarAssociado(franquiaB.id, '77777777777', 'Bianca Franquia B');
    await criarPar({
      associadoId: bianca.id, franquiaId: franquiaB.id, cpfCnpj: bianca.cpfCnpj, nome: bianca.nome,
      idExterno: 'pay_bianca_1', valor: 350, dueDate: diasAtras(40), paymentDate: diasAtras(3),
      statusAsaas: 'RECEIVED', statusCobranca: 'overdue', diasDiferenca: -40,
    });

    function rodarScript(nomeScript, args) {
      try {
        const saida = execSync(`node scripts/${nomeScript} ${args}`, { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL } }).toString();
        return { saida, codigo: 0 };
      } catch (err) {
        return { saida: (err.stdout?.toString() ?? '') + (err.stderr?.toString() ?? ''), codigo: err.status ?? 1 };
      }
    }

    // -------------------------------------------------------------
    // TESTE 1 — diagnostico-cobrancas-presas-sistemico.js, dry-run, todas
    // as franquias: deve achar 3 presas de verdade (Marcela velha, Rui,
    // Bianca) — Edu (sem paymentDate) também conta (status RECEIVED),
    // então 4 no total; nada alterado no banco.
    // -------------------------------------------------------------
    console.log('\n== Teste 1: diagnóstico, dry-run, todas as franquias ==');
    {
      const { saida, codigo } = rodarScript('diagnostico-cobrancas-presas-sistemico.js', '');
      console.log(saida);
      assertEqual(codigo, 0, 'diagnóstico dry-run sai com código 0');
      assert(saida.includes('4 cobrança(s) presa(s), de 4 associado(s) distinto(s)'), 'dry-run encontrou as 4 presas esperadas (Marcela velha, Rui, Bianca, Edu)');
      assert(saida.includes('Marcela Teste'), 'Marcela aparece no relatório');
      assert(!saida.includes('pay_marcela_reneg'), 'a parcela de renegociação da Marcela (ainda em aberto) NÃO aparece como presa');
      assert(saida.includes('DRY RUN'), 'confirma modo dry-run no relatório');

      const marcelaVelha = await db.cobranca.findUnique({ where: { idExterno: 'pay_marcela_velha' } });
      const marcelaReneg = await db.cobranca.findUnique({ where: { idExterno: 'pay_marcela_reneg' } });
      assertEqual(marcelaVelha.status, 'overdue', 'dry-run NÃO alterou a cobrança velha da Marcela');
      assertEqual(marcelaReneg.status, 'pending', 'dry-run NÃO alterou a parcela de renegociação da Marcela');
    }

    // -------------------------------------------------------------
    // TESTE 2 — reconciliar-cobrancas-quitadas-no-asaas.js, dry-run,
    // restrito à franquia A: deve achar 3 (Marcela velha, Rui, Edu) — sem
    // Bianca (franquia B).
    // -------------------------------------------------------------
    console.log('\n== Teste 2: job periódico, dry-run, --franquia=A ==');
    {
      const { saida, codigo } = rodarScript('reconciliar-cobrancas-quitadas-no-asaas.js', `--franquia=${franquiaA.id}`);
      console.log(saida);
      assertEqual(codigo, 0, 'job dry-run sai com código 0');
      assert(saida.includes('3 cobrança(s) presa(s) encontrada(s), de 1 franquia(s)'), 'restrito à franquia A encontra só as 3 presas dela (sem Bianca)');
      assert(!saida.includes('Bianca'), 'Bianca (franquia B) não aparece quando restrito à franquia A');
      assert(saida.includes('DRY RUN'), 'confirma modo dry-run');
    }

    // -------------------------------------------------------------
    // TESTE 3 — diagnóstico com --confirm, restrito à franquia A: aplica a
    // quitação só nas presas de verdade da franquia A (Marcela velha, Rui,
    // Edu) — quitada_em = paymentDate real, exceto Edu (sem paymentDate,
    // cai em "agora" e vem sinalizado). Paula/Ricardo/Flavia/reneg da
    // Marcela continuam intocados. Bianca (franquia B) continua intocada.
    // -------------------------------------------------------------
    console.log('\n== Teste 3: diagnóstico --confirm, --franquia=A ==');
    {
      const antes = new Date();
      const { saida, codigo } = rodarScript('diagnostico-cobrancas-presas-sistemico.js', `--franquia=${franquiaA.id} --confirm`);
      console.log(saida);
      assertEqual(codigo, 0, '--confirm sai com código 0');
      assert(saida.includes('3 cobrança(s) marcada(s) como "quitada"'), 'aplicou a quitação nas 3 presas da franquia A');
      assert(saida.includes('1 delas não tinham paymentDate'), 'sinalizou o caso do Edu (sem paymentDate) separadamente');

      const marcelaVelha = await db.cobranca.findUnique({ where: { idExterno: 'pay_marcela_velha' } });
      assertEqual(marcelaVelha.status, 'quitada', 'cobrança velha da Marcela agora quitada');
      assertEqual(marcelaVelha.quitadaEm.toISOString().slice(0, 10), diasAtras(5), 'quitada_em da Marcela = paymentDate real do Asaas (não "agora")');

      const marcelaReneg = await db.cobranca.findUnique({ where: { idExterno: 'pay_marcela_reneg' } });
      assertEqual(marcelaReneg.status, 'pending', 'parcela de renegociação da Marcela CONTINUA em aberto (não foi tocada)');

      const ruiRow = await db.cobranca.findUnique({ where: { idExterno: 'pay_rui_1' } });
      assertEqual(ruiRow.status, 'quitada', 'cobrança do Rui (controle "presa mas dentro da janela") também quitada — aplicação não depende da janela');
      assertEqual(ruiRow.quitadaEm.toISOString().slice(0, 10), diasAtras(2), 'quitada_em do Rui = paymentDate real');

      const eduRow = await db.cobranca.findUnique({ where: { idExterno: 'pay_edu_1' } });
      assertEqual(eduRow.status, 'quitada', 'cobrança do Edu (sem paymentDate) também quitada');
      assert(eduRow.quitadaEm.getTime() >= antes.getTime() - 5000, 'quitada_em do Edu caiu pra "agora" (aproximado), já que não havia paymentDate');

      const paulaRow = await db.cobranca.findUnique({ where: { idExterno: 'pay_paula_1' } });
      assertEqual(paulaRow.status, 'overdue', 'Paula (genuinamente devedora) continua intocada');

      const ricardoRow = await db.cobranca.findFirst({ where: { associadoId: ricardo.id } });
      assertEqual(ricardoRow.status, 'pending', 'Ricardo (sem id_externo) continua intocado');

      const flaviaRow = await db.cobranca.findUnique({ where: { idExterno: 'pay_flavia_inexistente' } });
      assertEqual(flaviaRow.status, 'pending', 'Flavia (sem correspondência em pagamentos_asaas) continua intocada');

      const biancaRow = await db.cobranca.findUnique({ where: { idExterno: 'pay_bianca_1' } });
      assertEqual(biancaRow.status, 'overdue', 'Bianca (franquia B) continua intocada — --franquia=A não vazou pra outra franquia');
    }

    // -------------------------------------------------------------
    // TESTE 4 — idempotência: rodar --confirm de novo na franquia A não
    // encontra mais nada.
    // -------------------------------------------------------------
    console.log('\n== Teste 4: idempotência (diagnóstico --confirm de novo) ==');
    {
      const { saida, codigo } = rodarScript('diagnostico-cobrancas-presas-sistemico.js', `--franquia=${franquiaA.id} --confirm`);
      console.log(saida);
      assertEqual(codigo, 0, 'segunda rodada sai com código 0');
      assert(saida.includes('Nenhuma cobrança presa encontrada'), 'segunda rodada não encontra mais nada (idempotente)');
    }

    // -------------------------------------------------------------
    // TESTE 5 — endpoint HTTP, franquia B: quita só a Bianca. Idempotência
    // via HTTP também.
    // -------------------------------------------------------------
    console.log('\n== Teste 5: POST /api/sync/reconciliar-cobrancas-quitadas (franquia B) ==');
    {
      const r1 = await post('/sync/reconciliar-cobrancas-quitadas', {}, bearerB);
      assertEqual(r1.status, 200, 'primeira chamada -> 200');
      assertEqual(r1.corpo.cobrancas_quitadas, 1, 'quitou exatamente 1 cobrança (a Bianca)');
      assertEqual(r1.corpo.valor_total_quitado, 350, 'valor_total_quitado bate com o valor da Bianca');

      const biancaRow = await db.cobranca.findUnique({ where: { idExterno: 'pay_bianca_1' } });
      assertEqual(biancaRow.status, 'quitada', 'Bianca quitada via endpoint');
      assertEqual(biancaRow.quitadaEm.toISOString().slice(0, 10), diasAtras(3), 'quitada_em da Bianca = paymentDate real');

      const r2 = await post('/sync/reconciliar-cobrancas-quitadas', {}, bearerB);
      assertEqual(r2.status, 200, 'segunda chamada -> 200');
      assertEqual(r2.corpo.cobrancas_quitadas, 0, 'segunda chamada idempotente — 0 quitadas');

      const rA = await post('/sync/reconciliar-cobrancas-quitadas', {}, bearerA);
      assertEqual(rA.status, 200, 'franquia A (já sem presas do teste 3) -> 200');
      assertEqual(rA.corpo.cobrancas_quitadas, 0, 'franquia A não tem mais presas — 0 quitadas via endpoint');
    }

    // -------------------------------------------------------------
    // TESTE 6 — guardrail de segurança: franquia com > 60 presas.
    // -------------------------------------------------------------
    console.log('\n== Teste 6: guardrail de segurança (> 60 presas) ==');
    {
      const franquiaC = await db.franquia.create({ data: { nome: 'AJUSTE18 Franquia C (guardrail)' } });
      const bearerC = await criarApiKey(franquiaC.id, 'teste-c');
      const massa = await criarAssociado(franquiaC.id, '88888888888', 'Massa Guardrail');
      for (let i = 0; i < 61; i += 1) {
        await criarPar({
          associadoId: massa.id, franquiaId: franquiaC.id, cpfCnpj: massa.cpfCnpj, nome: massa.nome,
          idExterno: `pay_massa_${i}`, valor: 10, dueDate: diasAtras(20), paymentDate: diasAtras(1),
          statusAsaas: 'RECEIVED', statusCobranca: 'overdue', diasDiferenca: -20,
        });
      }

      const { saida: saidaScript, codigo: codigoScript } = rodarScript('reconciliar-cobrancas-quitadas-no-asaas.js', `--franquia=${franquiaC.id} --confirm`);
      console.log(saidaScript);
      assertEqual(codigoScript, 1, 'script recusa aplicar sem --force (código de saída 1)');
      assert(saidaScript.includes('Recusando aplicar por segurança'), 'mensagem de guardrail no script');
      const countAntes = await db.cobranca.count({ where: { status: 'quitada', associadoId: massa.id } });
      assertEqual(countAntes, 0, 'nenhuma das 61 foi quitada sem --force');

      const rEndpoint = await post('/sync/reconciliar-cobrancas-quitadas', {}, bearerC);
      assertEqual(rEndpoint.status, 409, 'endpoint recusa com 409 quando acima do guardrail');
      const countDepoisEndpoint = await db.cobranca.count({ where: { status: 'quitada', associadoId: massa.id } });
      assertEqual(countDepoisEndpoint, 0, 'endpoint não aplicou nada acima do guardrail');

      const { saida: saidaForce, codigo: codigoForce } = rodarScript('reconciliar-cobrancas-quitadas-no-asaas.js', `--franquia=${franquiaC.id} --confirm --force`);
      console.log(saidaForce);
      assertEqual(codigoForce, 0, '--force aplica com sucesso (código 0)');
      const countDepoisForce = await db.cobranca.count({ where: { status: 'quitada', associadoId: massa.id } });
      assertEqual(countDepoisForce, 61, '--force aplicou as 61 quitações');
    }
  } finally {
    console.log('\n== Encerrando app e derrubando banco de teste ==');
    await db.$disconnect();
    app.kill('SIGTERM');
    await sleep(1000);
    try {
      execSync(`sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Falha ao derrubar banco de teste (verifique manualmente):', err.message);
    }
  }

  console.log(`\n== Resultado: ${total - falhas}/${total} asserções passaram ==`);
  if (falhas > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error('Erro fatal no teste:', err);
  process.exitCode = 1;
});
