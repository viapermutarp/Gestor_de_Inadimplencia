/**
 * Teste end-to-end do AJUSTE 22 — "removida": cobrança apagada no Asaas
 * nunca conta como recebida (ver README, seção "AJUSTE 22", e
 * src/services/cobrancasRemovidas.service.js para o desenho completo).
 * Mesmo padrão das rodadas anteriores (test-ajuste18.../test-ajuste14...):
 * Postgres real (serviço local) + servidor Express real + chamadas HTTP
 * reais via fetch + um mock HTTP standalone da API do Asaas (sem mock de
 * Prisma em lugar nenhum) — tudo validado consultando o banco direto no
 * final, banco derrubado ao fim.
 *
 * Cobre os 6 cenários pedidos:
 *   1. Webhook PAYMENT_DELETED marca "removida" (só se pending/overdue).
 *   2. PAYMENT_DELETED sobre cobrança "quitada" não altera nada.
 *   3. PAYMENT_RESTORED reverte corretamente (pending/overdue e, nos casos
 *      restaurados já RECEIVED/CONFIRMED, para "quitada").
 *   4. POST /api/sync marca "quitada" só com RECEIVED/CONFIRMED local,
 *      "removida" só com deleted=true confirmado ao vivo, e não mexe em
 *      mais nada (nem quando o Asaas falha) — nos dois modos (por associado
 *      e global).
 *   5. Totais (GET /api/associados/resumo) excluem "removida".
 *   6. Falha do Asaas durante a reconciliação de POST /api/sync não altera
 *      a cobrança candidata.
 *
 * Mais além do pedido mínimo, também exercita ponta a ponta (via HTTP/
 * scripts reais, não só leitura de código):
 *   7. Reappearance guard — cobrança "removida" que reaparece no payload do
 *      n8n não é sobrescrita automaticamente.
 *   8. POST /api/sync/reconciliar-cobrancas-quitadas — cobrancas_removidas.
 *   9. scripts/corrigir-cobrancas-removidas-asaas.js — dry-run, --confirm,
 *      guardrail de 20.
 *  10. scripts/auditoria-quitadas-suspeitas.js (ETAPA A) — classifica
 *      corretamente uma "quitada" indevida vs. uma "quitada" de verdade.
 *  11. Revisão pré-commit, item 1 — critério único CONFIRMED: script CLI
 *      (scripts/reconciliar-cobrancas-quitadas-no-asaas.js) e endpoint HTTP
 *      (POST /api/sync/reconciliar-cobrancas-quitadas) voltam a ser
 *      EQUIVALENTES pra CONFIRMED sem correspondência local (nenhuma
 *      divergência — os dois reaproveitam confirmarERemoverSemCorrespondencia).
 *  12. Revisão pré-commit, item 5 — reversão de "removida" reaparecida
 *      confirmada ao vivo no Asaas.
 *  13. Revisão pré-commit, item 4 — guardrail de remoção
 *      (LIMITE_GUARDRAIL_REMOVIDAS = 20): mais de 20 candidatas confirmadas
 *      como "removida" numa única execução de POST /api/sync -> nenhuma é
 *      aplicada, todas reportadas em removidas_bloqueadas_guardrail/erros.
 */
const http = require('http');
const crypto = require('crypto');
const { execSync, spawn } = require('child_process');
const { apenasDigitos } = require('./src/lib/cpfCnpj');

const BACKEND_DIR = __dirname;
const APP_PORT = 3082;
const MOCK_PORT = 4098;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_ajuste22_e2e_${Date.now()}`;
const DATABASE_URL = `postgresql://gestor:gestor@localhost:5432/${DB_NAME}?schema=public`;
const CHAVE_ASAAS_FICTICIA = 'asaas-mock-chave-ajuste22';

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
async function postWebhook(franquiaId, token, body) {
  const resp = await fetch(`${BASE}/asaas/webhook/${franquiaId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'asaas-access-token': token },
    body: JSON.stringify(body),
  });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
function dataISO(dateStr) {
  return new Date(`${dateStr}T00:00:00.000Z`);
}
function diasAtras(n) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}
function gerarHashChave(chave) {
  return crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');
}

// ---------------------------------------------------------------------------
// Mock HTTP standalone da API do Asaas — só GET /v3/payments/:id (o único
// endpoint que buscarPagamentoPorId usa), dataset mutável entre passos do
// teste (cada cenário configura só as entradas que precisa).
// ---------------------------------------------------------------------------
const mockPagamentos = {}; // id -> { deleted, status } | { erro: true } | (ausente = 404)

function criarMockAsaas() {
  const server = http.createServer((req, res) => {
    try {
      res.setHeader('Connection', 'close');
      const token = req.headers['access_token'];
      if (token !== CHAVE_ASAAS_FICTICIA) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ code: 'invalid_access_token' }] }));
        return;
      }
      const match = req.url.match(/^\/v3\/payments\/([^/?]+)/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ code: 'not_found' }] }));
        return;
      }
      const id = match[1];
      const entry = mockPagamentos[id];
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ code: 'not_found', description: 'Pagamento não encontrado.' }] }));
        return;
      }
      if (entry.erro) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ code: 'internal_error' }] }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          id,
          customer: entry.customer || `cus_${id}`,
          value: entry.value ?? 100,
          dueDate: entry.dueDate || diasAtras(10),
          // paymentDate — revisão pré-commit do AJUSTE 22 (item 3): agora
          // precisa aparecer na resposta ao vivo do mock também, não só nas
          // linhas locais de pagamentos_asaas, porque
          // reconciliarCandidataAusente pode aplicar "quitada" (RECEIVED/
          // RECEIVED_IN_CASH/CONFIRMED) a partir de uma resposta AO VIVO do
          // Asaas (confirmarRemocaoViaAsaas), não só a partir do match
          // local — sem este campo, esse caminho sempre cairia no fallback
          // "quitadaEmAproximada" (paymentDate ausente -> usa "agora").
          paymentDate: entry.paymentDate ?? null,
          status: entry.status,
          deleted: entry.deleted === true,
          description: entry.description || 'Mensalidade',
        })
      );
    } catch (err) {
      console.error('[mock-asaas] erro no handler:', err);
      try {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ errors: [{ code: 'internal_error' }] }));
      } catch (err2) {
        // resposta já pode ter sido iniciada — nada a fazer.
      }
    }
  });
  server.keepAliveTimeout = 1000;
  server.on('error', (err) => console.error('[mock-asaas] erro no server HTTP:', err));
  return server;
}

async function main() {
  console.log(`== Criando banco de teste "${DB_NAME}" (Postgres real, serviço local) ==`);
  execSync(`sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER gestor;"`, { stdio: 'inherit' });

  console.log('\n== Rodando prisma migrate deploy ==');
  execSync('npx prisma migrate deploy', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL }, stdio: 'inherit' });

  process.env.DATABASE_URL = DATABASE_URL;
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  console.log('\n== Subindo mock da API do Asaas ==');
  const mockServer = criarMockAsaas();
  await new Promise((resolve) => mockServer.listen(MOCK_PORT, '127.0.0.1', resolve));

  console.log('\n== Subindo app ==');
  const app = spawn('node', ['src/server.js'], {
    cwd: BACKEND_DIR,
    env: {
      ...process.env,
      DATABASE_URL,
      PORT: String(APP_PORT),
      API_KEY: 'nao-usada-neste-teste',
      JWT_SECRET: 'test-secret-ajuste22',
      ADMIN_USER: 'admin',
      ADMIN_PASSWORD: 'admin123',
      PUBLIC_BASE_URL: '',
      ASAAS_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v3`,
    },
    stdio: 'inherit',
  });

  try {
    await sleep(1500);
    await esperarServidor(`${BASE}/inadimplencia/resumo`);
    await sleep(300);

    console.log('\n== Setup: franquia + api key + chave Asaas fictícia ==');
    const franquia = await db.franquia.create({ data: { nome: 'AJUSTE22 Franquia' } });
    const chave = crypto.randomBytes(24).toString('hex');
    await db.apiKey.create({
      data: { franquiaId: franquia.id, nome: 'teste', hash: gerarHashChave(chave), tamanho: chave.length, ultimosCaracteres: chave.slice(-6) },
    });
    const bearer = chave;
    await db.configuracao.create({ data: { chave: 'asaas_api_key', franquiaId: franquia.id, valor: CHAVE_ASAAS_FICTICIA } });
    const webhookToken = crypto.randomBytes(16).toString('hex');
    await db.configuracao.create({ data: { chave: 'asaas_webhook_token', franquiaId: franquia.id, valor: webhookToken } });

    async function criarAssociado(cpfCnpj, nome) {
      return db.associado.create({ data: { franquiaId: franquia.id, cpfCnpj, cpfCnpjDigits: apenasDigitos(cpfCnpj), nome, telefone: '11999990000' } });
    }
    async function criarCobranca(associadoId, { idExterno, valor, vencimento, status, quitadaEm = null, removidaEm = null }) {
      return db.cobranca.create({
        data: {
          associadoId,
          idExterno,
          valor,
          vencimento: dataISO(vencimento),
          diasDiferenca: 0,
          status,
          quitadaEm,
          removidaEm,
          descricao: 'Mensalidade',
          sincronizadoEm: new Date(),
        },
      });
    }

    // =========================================================================
    // CENÁRIO 1 e 2 — Webhook PAYMENT_DELETED
    // =========================================================================
    console.log('\n== Cenário 1/2: webhook PAYMENT_DELETED ==');
    {
      const carla = await criarAssociado('11111111111', 'Carla Deleted Aberta');
      const cobAberta = await criarCobranca(carla.id, { idExterno: 'pay_del_aberta', valor: 100, vencimento: diasAtras(10), status: 'overdue' });

      const denise = await criarAssociado('22222222222', 'Denise Deleted Quitada');
      const cobQuitada = await criarCobranca(denise.id, { idExterno: 'pay_del_quitada', valor: 200, vencimento: diasAtras(20), status: 'quitada', quitadaEm: new Date() });

      // pagamentos_asaas também tem a linha (webhook vai excluir) — não afeta o teste de cobrancas, só realismo.
      await db.pagamentoAsaas.create({ data: { id: 'pay_del_aberta', franquiaId: franquia.id, customerId: 'cus_x', value: 100, dueDate: diasAtras(10), status: 'OVERDUE' } });

      const r1 = await postWebhook(franquia.id, webhookToken, { event: 'PAYMENT_DELETED', payment: { id: 'pay_del_aberta' } });
      assertEqual(r1.status, 200, 'webhook DELETED (cobrança aberta) -> 200');
      assertEqual(r1.corpo.cobranca_marcada_removida, true, 'webhook reporta cobranca_marcada_removida=true (estava aberta)');

      const cobAbertaDepois = await db.cobranca.findUnique({ where: { id: cobAberta.id } });
      assertEqual(cobAbertaDepois.status, 'removida', 'CENÁRIO 1: cobrança pending/overdue vira "removida" após PAYMENT_DELETED');
      assert(cobAbertaDepois.removidaEm !== null, 'removidaEm preenchido');

      const pagAindaExiste = await db.pagamentoAsaas.findUnique({ where: { id: 'pay_del_aberta' } });
      assertEqual(pagAindaExiste, null, 'pagamentos_asaas também foi excluído (excluirPagamento, comportamento já existente)');

      const r2 = await postWebhook(franquia.id, webhookToken, { event: 'PAYMENT_DELETED', payment: { id: 'pay_del_quitada' } });
      assertEqual(r2.status, 200, 'webhook DELETED (cobrança já quitada) -> 200');
      assertEqual(r2.corpo.cobranca_marcada_removida, false, 'webhook reporta cobranca_marcada_removida=false (já estava quitada)');

      const cobQuitadaDepois = await db.cobranca.findUnique({ where: { id: cobQuitada.id } });
      assertEqual(cobQuitadaDepois.status, 'quitada', 'CENÁRIO 2: cobrança já "quitada" NÃO é alterada por PAYMENT_DELETED');
      assertEqual(cobQuitadaDepois.removidaEm, null, 'removidaEm continua null na cobrança quitada');
    }

    // =========================================================================
    // CENÁRIO 3 — Webhook PAYMENT_RESTORED
    // =========================================================================
    console.log('\n== Cenário 3: webhook PAYMENT_RESTORED ==');
    {
      const elisa = await criarAssociado('33333333333', 'Elisa Restored Overdue');
      const cobRemovidaOverdue = await criarCobranca(elisa.id, { idExterno: 'pay_res_overdue', valor: 150, vencimento: diasAtras(15), status: 'removida', removidaEm: new Date() });

      const r1 = await postWebhook(franquia.id, webhookToken, {
        event: 'PAYMENT_RESTORED',
        payment: { id: 'pay_res_overdue', customer: 'cus_elisa', dueDate: diasAtras(15), value: 150, status: 'OVERDUE', description: 'Mensalidade' },
      });
      assertEqual(r1.status, 200, 'webhook RESTORED (volta overdue) -> 200');
      const cobDepois1 = await db.cobranca.findUnique({ where: { id: cobRemovidaOverdue.id } });
      assertEqual(cobDepois1.status, 'overdue', 'CENÁRIO 3a: "removida" reverte para "overdue" (status do payload)');
      assertEqual(cobDepois1.removidaEm, null, 'removidaEm limpo após reverter');

      const fabio = await criarAssociado('44444444444', 'Fabio Restored Received');
      const cobRemovidaReceived = await criarCobranca(fabio.id, { idExterno: 'pay_res_received', valor: 300, vencimento: diasAtras(40), status: 'removida', removidaEm: new Date() });

      const r2 = await postWebhook(franquia.id, webhookToken, {
        event: 'PAYMENT_RESTORED',
        payment: { id: 'pay_res_received', customer: 'cus_fabio', dueDate: diasAtras(40), paymentDate: diasAtras(2), value: 300, status: 'RECEIVED', description: 'Mensalidade' },
      });
      assertEqual(r2.status, 200, 'webhook RESTORED (volta já paga) -> 200');
      const cobDepois2 = await db.cobranca.findUnique({ where: { id: cobRemovidaReceived.id } });
      assertEqual(cobDepois2.status, 'quitada', 'CENÁRIO 3b: "removida" restaurada já RECEIVED vira "quitada" direto');
      assertEqual(cobDepois2.quitadaEm.toISOString().slice(0, 10), diasAtras(2), 'quitadaEm = paymentDate do payload');
      assertEqual(cobDepois2.removidaEm, null, 'removidaEm limpo');

      // 3c (revisão pré-commit, "CONFIRMED com critério único") — restaurado
      // já CONFIRMED (cartão de crédito aprovado, repasse ainda pendente):
      // o payload do webhook não traz "paymentDate" (mesmo comportamento
      // real do Asaas pra CONFIRMED), só "clientPaymentDate" — precisa cair
      // direto em "quitada" (critério único, mesma constante
      // STATUS_ADIMPLENTE_ASAAS) com quitadaEm = clientPaymentDate (fallback
      // do item 2, já que paymentDate está ausente).
      const wilson = await criarAssociado('21212121212', 'Wilson Restored Confirmed Cartao');
      const cobRemovidaConfirmed = await criarCobranca(wilson.id, { idExterno: 'pay_res_confirmed', valor: 275, vencimento: diasAtras(25), status: 'removida', removidaEm: new Date() });

      const r3 = await postWebhook(franquia.id, webhookToken, {
        event: 'PAYMENT_RESTORED',
        payment: { id: 'pay_res_confirmed', customer: 'cus_wilson', dueDate: diasAtras(25), value: 275, status: 'CONFIRMED', clientPaymentDate: diasAtras(6), description: 'Mensalidade' },
      });
      assertEqual(r3.status, 200, 'webhook RESTORED (volta já CONFIRMED) -> 200');
      const cobDepois3 = await db.cobranca.findUnique({ where: { id: cobRemovidaConfirmed.id } });
      assertEqual(cobDepois3.status, 'quitada', 'CENÁRIO 3c: "removida" restaurada já CONFIRMED vira "quitada" direto (critério único)');
      assertEqual(cobDepois3.quitadaEm.toISOString().slice(0, 10), diasAtras(6), 'quitadaEm = clientPaymentDate (paymentDate ausente no payload CONFIRMED)');
      assertEqual(cobDepois3.removidaEm, null, 'removidaEm limpo (CONFIRMED)');

      // Não deveria mexer numa cobrança que NÃO está "removida".
      const gilson = await criarAssociado('55555555555', 'Gilson Restored Noop');
      const cobPendingGilson = await criarCobranca(gilson.id, { idExterno: 'pay_res_noop', valor: 80, vencimento: diasAtras(5), status: 'pending' });
      await postWebhook(franquia.id, webhookToken, {
        event: 'PAYMENT_RESTORED',
        payment: { id: 'pay_res_noop', customer: 'cus_gilson', dueDate: diasAtras(5), value: 80, status: 'OVERDUE', description: 'x' },
      });
      const gilsonDepois = await db.cobranca.findUnique({ where: { id: cobPendingGilson.id } });
      assertEqual(gilsonDepois.status, 'pending', 'RESTORED não mexe numa cobrança que não estava "removida"');
    }

    // IMPORTANTE: `spawn` assíncrono, NUNCA `execSync` — o mock da API do
    // Asaas roda dentro DESTE MESMO processo (ver criarMockAsaas acima), e
    // `execSync` bloqueia sincronamente o event loop inteiro do processo
    // chamador enquanto espera o filho terminar. Com `execSync`, o processo
    // filho (o script) fica esperando uma resposta HTTP do mock, e o mock
    // nunca consegue processá-la porque o event loop que o hospeda está
    // congelado esperando o filho — deadlock garantido até o timeout de
    // 15s do asaas.service.js. `spawn` não bloqueia, então o event loop
    // continua livre para o mock responder normalmente.
    function rodarScript(nomeScript, args) {
      return new Promise((resolve) => {
        const child = spawn('node', ['scripts/' + nomeScript, ...args.split(' ').filter(Boolean)], {
          cwd: BACKEND_DIR,
          env: { ...process.env, DATABASE_URL, ASAAS_API_BASE_URL: `http://127.0.0.1:${MOCK_PORT}/v3` },
        });
        let saida = '';
        child.stdout.on('data', (d) => { saida += d.toString(); });
        child.stderr.on('data', (d) => { saida += d.toString(); });
        child.on('close', (codigo) => resolve({ saida, codigo: codigo ?? 0 }));
      });
    }

    // =========================================================================
    // CENÁRIO 4/6 — POST /api/sync, modo por associado
    // =========================================================================
    console.log('\n== Cenário 4/6: POST /api/sync (modo por associado) ==');
    {
      const helio = await criarAssociado('66666666666', 'Helio Sync Associado');

      // a) quitada via pagamentos_asaas local RECEIVED
      const cobQuitar = await criarCobranca(helio.id, { idExterno: 'pay_sync_quitar', valor: 500, vencimento: diasAtras(60), status: 'overdue' });
      await db.pagamentoAsaas.create({ data: { id: 'pay_sync_quitar', franquiaId: franquia.id, customerId: 'cus_helio', value: 500, dueDate: diasAtras(60), paymentDate: diasAtras(3), status: 'RECEIVED' } });

      // b) removida via Asaas ao vivo (sem pagamentos_asaas local)
      const cobRemover = await criarCobranca(helio.id, { idExterno: 'pay_sync_remover', valor: 300, vencimento: diasAtras(55), status: 'pending' });
      mockPagamentos.pay_sync_remover = { deleted: true, status: 'DELETED' };

      // c) existe no Asaas mas não deletada -> não mexe
      const cobOutro = await criarCobranca(helio.id, { idExterno: 'pay_sync_outro', valor: 90, vencimento: diasAtras(50), status: 'overdue' });
      mockPagamentos.pay_sync_outro = { deleted: false, status: 'OVERDUE' };

      // d) Asaas falha -> não mexe (CENÁRIO 6)
      const cobErro = await criarCobranca(helio.id, { idExterno: 'pay_sync_erro', valor: 70, vencimento: diasAtras(45), status: 'pending' });
      mockPagamentos.pay_sync_erro = { erro: true };

      // e) já "removida", reaparece no payload -> não sobrescreve
      const cobReaparece = await criarCobranca(helio.id, { idExterno: 'pay_sync_reaparece', valor: 40, vencimento: diasAtras(8), status: 'removida', removidaEm: new Date() });

      const payload = [
        {
          cpf_cnpj: helio.cpfCnpj,
          nome: helio.nome,
          telefone: helio.telefone,
          cobrancas: [
            {
              id_externo: 'pay_sync_reaparece',
              valor: 40,
              vencimento: diasAtras(8),
              dias_diferenca: -8,
              descricao: 'Mensalidade',
              status: 'pending',
            },
          ],
        },
      ];
      const r = await post('/sync', payload, bearer);
      assertEqual(r.status, 200, 'POST /api/sync (por associado) -> 200');
      assertEqual(r.corpo.cobrancas_quitadas, 1, 'cobrancas_quitadas = 1 (pay_sync_quitar, via pagamentos_asaas local)');
      assertEqual(r.corpo.cobrancas_removidas, 1, 'cobrancas_removidas = 1 (pay_sync_remover, confirmado ao vivo)');
      assertEqual(r.corpo.cobrancas_removida_reaparecida, 1, 'cobrancas_removida_reaparecida = 1 (pay_sync_reaparece)');
      assert(r.corpo.erros.some((e) => e.id_externo === 'pay_sync_outro'), 'pay_sync_outro reportado em erros (existe, não deletada)');
      assert(r.corpo.erros.some((e) => e.id_externo === 'pay_sync_erro'), 'pay_sync_erro reportado em erros (falha do Asaas)');
      assert(r.corpo.erros.some((e) => e.id_externo === 'pay_sync_reaparece'), 'pay_sync_reaparece reportado em erros (conflito removida)');

      const cobQuitarDepois = await db.cobranca.findUnique({ where: { id: cobQuitar.id } });
      assertEqual(cobQuitarDepois.status, 'quitada', 'CENÁRIO 4a: quitada só via RECEIVED local');
      assertEqual(cobQuitarDepois.quitadaEm.toISOString().slice(0, 10), diasAtras(3), 'quitadaEm = paymentDate real');

      const cobRemoverDepois = await db.cobranca.findUnique({ where: { id: cobRemover.id } });
      assertEqual(cobRemoverDepois.status, 'removida', 'CENÁRIO 4b: removida só via confirmação ao vivo no Asaas');
      assert(cobRemoverDepois.removidaEm !== null, 'removidaEm preenchido');

      const cobOutroDepois = await db.cobranca.findUnique({ where: { id: cobOutro.id } });
      assertEqual(cobOutroDepois.status, 'overdue', 'CENÁRIO 4c: existe no Asaas mas não deletada -> NÃO mexe');

      const cobErroDepois = await db.cobranca.findUnique({ where: { id: cobErro.id } });
      assertEqual(cobErroDepois.status, 'pending', 'CENÁRIO 6: falha do Asaas -> NÃO mexe');

      const cobReaparecerDepois = await db.cobranca.findUnique({ where: { id: cobReaparece.id } });
      assertEqual(cobReaparecerDepois.status, 'removida', 'CENÁRIO 7 (extra): "removida" reaparecendo no payload NÃO é sobrescrita');
    }

    // =========================================================================
    // CENÁRIO 4 (modo global/janela) — associado inteiro sumindo do payload
    // =========================================================================
    console.log('\n== Cenário 4 (modo global, janela) ==');
    {
      const iris = await criarAssociado('77777777777', 'Iris Sync Global');
      const cobGlobalRemover = await criarCobranca(iris.id, { idExterno: 'pay_global_remover', valor: 220, vencimento: diasAtras(20), status: 'overdue' });
      mockPagamentos.pay_global_remover = { deleted: true, status: 'DELETED' };

      // "registros.length === 0" é rejeitado com 400 por exports.sync (precisa de
      // ao menos 1 associado no payload, mesmo no modo global) — inclui um
      // associado qualquer, sem cobrancas, só pra não disparar essa validação;
      // Iris (cujas cobranças devem ser reconciliadas) propositalmente NÃO
      // aparece no payload, simulando o caso real (associado sumiu inteiro).
      const payloadGlobal = {
        janela: { inicio: diasAtras(53), fim: diasAtras(-5) },
        associados: [{ cpf_cnpj: '99999999900', nome: 'Associado Presente No Payload Global', telefone: '11900000000', cobrancas: [] }],
      };
      const r = await post('/sync', payloadGlobal, bearer);
      assertEqual(r.status, 200, 'POST /api/sync (global) -> 200');
      assertEqual(r.corpo.reconciliacao, 'global', 'modo reportado = global');
      assert(r.corpo.cobrancas_removidas >= 1, 'cobrancas_removidas >= 1 no modo global');

      const cobGlobalDepois = await db.cobranca.findUnique({ where: { id: cobGlobalRemover.id } });
      assertEqual(cobGlobalDepois.status, 'removida', 'modo global: associado sumiu do payload, cobrança removida confirmada via Asaas');
    }

    // =========================================================================
    // CENÁRIO 5 — totais excluem "removida"
    // =========================================================================
    console.log('\n== Cenário 5: totais excluem "removida" ==');
    {
      const julia = await criarAssociado('88888888888', 'Julia So Removida');
      await criarCobranca(julia.id, { idExterno: 'pay_julia_removida', valor: 999, vencimento: diasAtras(5), status: 'removida', removidaEm: new Date() });

      const resp = await fetch(`${BASE}/associados/resumo`, { headers: headersPara(bearer) });
      const resumo = await resp.json();

      const listaResp = await fetch(`${BASE}/associados?busca=${encodeURIComponent(julia.nome)}`, { headers: headersPara(bearer) });
      const lista = await listaResp.json();
      const juliaNaLista = (lista.dados || []).find((a) => a.nome === julia.nome);
      assert(!juliaNaLista, 'Julia (só cobrança "removida") NÃO aparece na listagem (aba "Todos" exige cobrança pending/overdue)');

      console.log(`  (resumo geral: com_cobranca_aberto=${resumo.com_cobranca_aberto}, valor_total_aberto=${resumo.valor_total_aberto} — R$999 da Julia não deve estar somado)`);
    }

    // =========================================================================
    // CENÁRIO 8 — job diário via HTTP: cobrancas_removidas
    // =========================================================================
    console.log('\n== Cenário 8: POST /api/sync/reconciliar-cobrancas-quitadas ==');
    {
      const karin = await criarAssociado('99999999999', 'Karin Job Diario');
      const cobJob = await criarCobranca(karin.id, { idExterno: 'pay_job_remover', valor: 175, vencimento: diasAtras(70), status: 'overdue' });
      mockPagamentos.pay_job_remover = { deleted: true, status: 'DELETED' };

      const r = await post('/sync/reconciliar-cobrancas-quitadas', {}, bearer);
      assertEqual(r.status, 200, 'endpoint do job diário -> 200');
      assertEqual(r.corpo.cobrancas_removidas, 1, 'cobrancas_removidas = 1 no job diário');

      const cobJobDepois = await db.cobranca.findUnique({ where: { id: cobJob.id } });
      assertEqual(cobJobDepois.status, 'removida', 'job diário marcou "removida" após confirmar via Asaas');
    }

    // =========================================================================
    // CENÁRIO 9 — script pontual (item 7)
    // =========================================================================
    console.log('\n== Cenário 9: scripts/corrigir-cobrancas-removidas-asaas.js ==');
    {
      const leo = await criarAssociado('10101010101', 'Leo Script Pontual');
      const cobFix1 = await criarCobranca(leo.id, { idExterno: 'pay_fix_1', valor: 60, vencimento: diasAtras(90), status: 'overdue' });
      const cobFix2 = await criarCobranca(leo.id, { idExterno: 'pay_fix_2', valor: 61, vencimento: diasAtras(91), status: 'overdue' });
      mockPagamentos.pay_fix_1 = { deleted: true, status: 'DELETED' };
      mockPagamentos.pay_fix_2 = { deleted: false, status: 'OVERDUE' };

      const { saida: saidaDry, codigo: codigoDry } = await rodarScript('corrigir-cobrancas-removidas-asaas.js', '--ids=pay_fix_1,pay_fix_2');
      console.log(saidaDry);
      assertEqual(codigoDry, 0, 'dry-run sai com código 0');
      assert(saidaDry.includes('DRY RUN'), 'confirma modo dry-run');
      assert(saidaDry.includes('1 cobrança(s), totalizando'), 'dry-run identificou 1 candidata confirmada (pay_fix_1)');

      const fix1AntesDepois = await db.cobranca.findUnique({ where: { id: cobFix1.id } });
      assertEqual(fix1AntesDepois.status, 'overdue', 'dry-run não alterou nada');

      const { saida: saidaConfirm, codigo: codigoConfirm } = await rodarScript('corrigir-cobrancas-removidas-asaas.js', '--ids=pay_fix_1,pay_fix_2 --confirm');
      console.log(saidaConfirm);
      assertEqual(codigoConfirm, 0, '--confirm sai com código 0');
      assert(saidaConfirm.includes('1 cobrança(s) marcada(s) como "removida"'), '--confirm aplicou exatamente 1');

      const fix1Depois = await db.cobranca.findUnique({ where: { id: cobFix1.id } });
      assertEqual(fix1Depois.status, 'removida', 'pay_fix_1 (confirmada removida) foi corrigida');
      const fix2Depois = await db.cobranca.findUnique({ where: { id: cobFix2.id } });
      assertEqual(fix2Depois.status, 'overdue', 'pay_fix_2 (não confirmada) continua intocada');

      // Guardrail: 21 candidatas confirmadas.
      const massa = await criarAssociado('12121212121', 'Massa Guardrail Pontual');
      const idsMassa = [];
      for (let i = 0; i < 21; i += 1) {
        const id = `pay_massa_fix_${i}`;
        idsMassa.push(id);
        await criarCobranca(massa.id, { idExterno: id, valor: 10, vencimento: diasAtras(30), status: 'overdue' });
        mockPagamentos[id] = { deleted: true, status: 'DELETED' };
      }
      const { saida: saidaGuard, codigo: codigoGuard } = await rodarScript('corrigir-cobrancas-removidas-asaas.js', `--ids=${idsMassa.join(',')} --confirm`);
      console.log(saidaGuard);
      assertEqual(codigoGuard, 1, 'guardrail (>20) recusa aplicar, código de saída 1');
      assert(saidaGuard.includes('Recusando aplicar por segurança'), 'mensagem de guardrail no script pontual');
      const countMassaRemovida = await db.cobranca.count({ where: { associadoId: massa.id, status: 'removida' } });
      assertEqual(countMassaRemovida, 0, 'nenhuma das 21 foi aplicada por causa do guardrail');
    }

    // =========================================================================
    // CENÁRIO 10 — ETAPA A: scripts/auditoria-quitadas-suspeitas.js
    // =========================================================================
    console.log('\n== Cenário 10: scripts/auditoria-quitadas-suspeitas.js (ETAPA A) ==');
    {
      const mara = await criarAssociado('13131313131', 'Mara Quitada De Verdade');
      await db.pagamentoAsaas.create({ data: { id: 'pay_audit_paga', franquiaId: franquia.id, customerId: 'cus_mara', value: 500, dueDate: diasAtras(30), paymentDate: diasAtras(2), status: 'RECEIVED' } });
      await criarCobranca(mara.id, { idExterno: 'pay_audit_paga', valor: 500, vencimento: diasAtras(30), status: 'quitada', quitadaEm: new Date() });

      const nara = await criarAssociado('14141414141', 'Nara Quitada Indevida');
      await criarCobranca(nara.id, { idExterno: 'pay_audit_removida', valor: 640, vencimento: diasAtras(35), status: 'quitada', quitadaEm: new Date() });
      mockPagamentos.pay_audit_removida = { deleted: true, status: 'DELETED' };

      const { saida, codigo } = await rodarScript('auditoria-quitadas-suspeitas.js', `--franquia=${franquia.id}`);
      console.log(saida);
      assertEqual(codigo, 0, 'auditoria sai com código 0');
      assert(saida.includes('REMOVIDA NO ASAAS'), 'relatório menciona a categoria "removida no Asaas"');
      assert(/REMOVIDA NO ASAAS.*: 1/.test(saida), 'exatamente 1 "removida_no_asaas" identificada (Nara)');
      assert(saida.includes('R$ 640,00'), 'valor da Nara (R$640) aparece no relatório');
      assert(
        !saida.includes('pay_audit_paga'),
        'Mara (pay_audit_paga, RECEIVED local) nunca aparece nas linhas "suspeita" — filtrada antes de qualquer consulta ao Asaas'
      );

      // Confirma que a auditoria é só leitura — nada mudou no banco.
      const naraDepois = await db.cobranca.findFirst({ where: { idExterno: 'pay_audit_removida' } });
      assertEqual(naraDepois.status, 'quitada', 'ETAPA A é só leitura — não corrigiu a cobrança da Nara');
    }

    // =========================================================================
    // CENÁRIO 11 — Revisão pré-commit, item 3: CONFIRMED tratado como
    // "quitada" na reconciliação de "ausente do payload" (local E ao vivo).
    // =========================================================================
    console.log('\n== Cenário 11: item 3 — CONFIRMED como "quitada" (ausente do payload) ==');
    {
      // 11a) pagamentos_asaas local já tem CONFIRMED -> quitada sem precisar
      // consultar o Asaas ao vivo (branch mais barato, mesmo padrão de RECEIVED).
      const oscar = await criarAssociado('15151515151', 'Oscar Cartao Confirmed Local');
      const cobOscar = await criarCobranca(oscar.id, { idExterno: 'pay_oscar_confirmed_local', valor: 250, vencimento: diasAtras(40), status: 'overdue' });
      await db.pagamentoAsaas.create({
        data: { id: 'pay_oscar_confirmed_local', franquiaId: franquia.id, customerId: 'cus_oscar', value: 250, dueDate: diasAtras(40), paymentDate: diasAtras(1), status: 'CONFIRMED' },
      });

      // 11b) sem correspondência local -> confirmado AO VIVO como CONFIRMED -> quitada.
      const paula = await criarAssociado('16161616161', 'Paula Cartao Confirmed Live');
      const cobPaula = await criarCobranca(paula.id, { idExterno: 'pay_paula_confirmed_live', valor: 310, vencimento: diasAtras(35), status: 'pending' });
      mockPagamentos.pay_paula_confirmed_live = { deleted: false, status: 'CONFIRMED', paymentDate: diasAtras(2) };

      const payloadOscarPaula = [
        { cpf_cnpj: oscar.cpfCnpj, nome: oscar.nome, telefone: oscar.telefone, cobrancas: [] },
        { cpf_cnpj: paula.cpfCnpj, nome: paula.nome, telefone: paula.telefone, cobrancas: [] },
      ];
      const r = await post('/sync', payloadOscarPaula, bearer);
      assertEqual(r.status, 200, 'POST /api/sync (item 3, CONFIRMED) -> 200');
      assertEqual(r.corpo.cobrancas_quitadas, 2, 'cobrancas_quitadas = 2 (Oscar via local CONFIRMED + Paula via Asaas ao vivo CONFIRMED)');

      const cobOscarDepois = await db.cobranca.findUnique({ where: { id: cobOscar.id } });
      assertEqual(cobOscarDepois.status, 'quitada', 'CENÁRIO 11a: CONFIRMED local -> quitada (não fica mais "em aberto")');
      assertEqual(cobOscarDepois.quitadaEm.toISOString().slice(0, 10), diasAtras(1), 'quitadaEm = paymentDate real (local)');

      const cobPaulaDepois = await db.cobranca.findUnique({ where: { id: cobPaula.id } });
      assertEqual(cobPaulaDepois.status, 'quitada', 'CENÁRIO 11b: CONFIRMED confirmado ao vivo no Asaas -> quitada');
      assertEqual(cobPaulaDepois.quitadaEm.toISOString().slice(0, 10), diasAtras(2), 'quitadaEm = paymentDate real (via Asaas ao vivo)');

      // Revisão pré-commit, item 1 — a divergência que existia aqui (script
      // CLI do job diário não tratava CONFIRMED "sem correspondência" como
      // quitada) foi corrigida: o script agora reaproveita a MESMA
      // confirmarERemoverSemCorrespondencia do endpoint HTTP, dry-run
      // primeiro (mostra o que --confirm faria, sem escrever nada), depois
      // --confirm aplicando de verdade — igual ao endpoint.
      const quintino = await criarAssociado('17171717171', 'Quintino Confirmed Script Diario');
      const cobQuintino = await criarCobranca(quintino.id, { idExterno: 'pay_quintino_confirmed_script', valor: 88, vencimento: diasAtras(80), status: 'overdue' });
      mockPagamentos.pay_quintino_confirmed_script = { deleted: false, status: 'CONFIRMED', paymentDate: diasAtras(1) };

      const { saida: saidaScriptDry } = await rodarScript('reconciliar-cobrancas-quitadas-no-asaas.js', `--franquia=${franquia.id}`);
      assert(
        /pay_quintino_confirmed_script[\s\S]*?→ quitada/.test(saidaScriptDry),
        'script CLI (dry-run) já classifica Quintino como "quitada" (equivalente ao endpoint, critério único CONFIRMED)'
      );
      const cobQuintinoAposDry = await db.cobranca.findUnique({ where: { id: cobQuintino.id } });
      assertEqual(cobQuintinoAposDry.status, 'overdue', 'script CLI em dry-run NÃO escreve nada — Quintino continua "overdue" até --confirm');

      const { saida: saidaScriptConfirm, codigo: codigoScriptConfirm } = await rodarScript(
        'reconciliar-cobrancas-quitadas-no-asaas.js',
        `--franquia=${franquia.id} --confirm`
      );
      console.log(saidaScriptConfirm);
      assertEqual(codigoScriptConfirm, 0, 'script CLI --confirm (CONFIRMED sem correspondência) sai com código 0');
      const cobQuintinoDepois = await db.cobranca.findUnique({ where: { id: cobQuintino.id } });
      assertEqual(
        cobQuintinoDepois.status,
        'quitada',
        'EQUIVALÊNCIA CLI/HTTP (revisão pré-commit): script CLI do job diário agora também quita CONFIRMED sem correspondência, igual ao endpoint HTTP'
      );
      assertEqual(cobQuintinoDepois.quitadaEm.toISOString().slice(0, 10), diasAtras(1), 'quitadaEm = paymentDate confirmado ao vivo pelo script CLI');

      // O ENDPOINT HTTP irmão do job diário reaproveita a MESMA função —
      // idempotência: Quintino já foi quitado pelo script acima, então o
      // endpoint não encontra mais nada pra ele.
      const rJobHttp = await post('/sync/reconciliar-cobrancas-quitadas', {}, bearer);
      assertEqual(rJobHttp.status, 200, 'endpoint do job diário -> 200');
      const cobQuintinoDepoisHttp = await db.cobranca.findUnique({ where: { id: cobQuintino.id } });
      assertEqual(cobQuintinoDepoisHttp.status, 'quitada', 'endpoint HTTP do job diário concorda com o resultado do script CLI (equivalentes)');
    }

    // =========================================================================
    // CENÁRIO 12 — Revisão pré-commit, item 5: "removida" reaparece no
    // payload -> consulta Asaas ao vivo -> reverte só se deleted=false.
    // =========================================================================
    console.log('\n== Cenário 12: item 5 — reversão de "removida" reaparecida (Asaas ao vivo) ==');
    {
      // 12a) Asaas confirma deleted=false -> reverte pro status do payload.
      const renata = await criarAssociado('18181818181', 'Renata Removida Reverte');
      const cobRenata = await criarCobranca(renata.id, { idExterno: 'pay_renata_reverte', valor: 120, vencimento: diasAtras(12), status: 'removida', removidaEm: new Date() });
      mockPagamentos.pay_renata_reverte = { deleted: false, status: 'OVERDUE' };

      const payloadRenata = [
        {
          cpf_cnpj: renata.cpfCnpj,
          nome: renata.nome,
          telefone: renata.telefone,
          cobrancas: [
            { id_externo: 'pay_renata_reverte', valor: 120, vencimento: diasAtras(12), dias_diferenca: -12, descricao: 'Mensalidade', status: 'overdue' },
          ],
        },
      ];
      const r1 = await post('/sync', payloadRenata, bearer);
      assertEqual(r1.status, 200, 'POST /api/sync (item 5, reversão confirmada) -> 200');
      assertEqual(r1.corpo.cobrancas_removida_revertida, 1, 'cobrancas_removida_revertida = 1 (Renata)');
      assert(!r1.corpo.erros.some((e) => e.id_externo === 'pay_renata_reverte'), 'Renata NÃO entra em "erros" (reversão aplicada com sucesso)');

      const cobRenataDepois = await db.cobranca.findUnique({ where: { id: cobRenata.id } });
      assertEqual(cobRenataDepois.status, 'overdue', 'CENÁRIO 12a: "removida" reaparecida com deleted=false confirmado -> reverte pro status do payload');
      assertEqual(cobRenataDepois.removidaEm, null, 'removidaEm limpo após reverter');

      // 12b) Asaas confirma que CONTINUA deleted=true (payload do n8n
      // desatualizado) -> NÃO reverte, permanece "removida".
      const sonia = await criarAssociado('19191919191', 'Sonia Removida Continua Deleted');
      const cobSonia = await criarCobranca(sonia.id, { idExterno: 'pay_sonia_continua_deleted', valor: 95, vencimento: diasAtras(9), status: 'removida', removidaEm: new Date() });
      mockPagamentos.pay_sonia_continua_deleted = { deleted: true, status: 'DELETED' };

      const payloadSonia = [
        {
          cpf_cnpj: sonia.cpfCnpj,
          nome: sonia.nome,
          telefone: sonia.telefone,
          cobrancas: [
            { id_externo: 'pay_sonia_continua_deleted', valor: 95, vencimento: diasAtras(9), dias_diferenca: -9, descricao: 'Mensalidade', status: 'pending' },
          ],
        },
      ];
      const r2 = await post('/sync', payloadSonia, bearer);
      assertEqual(r2.corpo.cobrancas_removida_reaparecida, 1, 'cobrancas_removida_reaparecida = 1 (Sonia — Asaas confirma que continua removida)');
      const cobSoniaDepois = await db.cobranca.findUnique({ where: { id: cobSonia.id } });
      assertEqual(cobSoniaDepois.status, 'removida', 'CENÁRIO 12b: Asaas confirma deleted=true (ainda removida) -> NÃO reverte');

      // 12c) Asaas falha ao consultar -> NÃO mexe (mesmo padrão do resto do módulo).
      const tomas = await criarAssociado('20202020202', 'Tomas Removida Asaas Falha');
      const cobTomas = await criarCobranca(tomas.id, { idExterno: 'pay_tomas_asaas_falha', valor: 55, vencimento: diasAtras(6), status: 'removida', removidaEm: new Date() });
      mockPagamentos.pay_tomas_asaas_falha = { erro: true };

      const payloadTomas = [
        {
          cpf_cnpj: tomas.cpfCnpj,
          nome: tomas.nome,
          telefone: tomas.telefone,
          cobrancas: [
            { id_externo: 'pay_tomas_asaas_falha', valor: 55, vencimento: diasAtras(6), dias_diferenca: -6, descricao: 'Mensalidade', status: 'pending' },
          ],
        },
      ];
      const r3 = await post('/sync', payloadTomas, bearer);
      assertEqual(r3.corpo.cobrancas_removida_reaparecida, 1, 'cobrancas_removida_reaparecida = 1 (Tomas — falha do Asaas)');
      const cobTomasDepois = await db.cobranca.findUnique({ where: { id: cobTomas.id } });
      assertEqual(cobTomasDepois.status, 'removida', 'CENÁRIO 12c: falha do Asaas ao consultar -> NÃO mexe, permanece "removida"');
    }

    // =========================================================================
    // CENÁRIO 13 — Revisão pré-commit, item 4: guardrail de remoção
    // (LIMITE_GUARDRAIL_REMOVIDAS = 20). 21 candidatas confirmadas como
    // "removida" NUMA ÚNICA execução de POST /api/sync (modo por associado,
    // candidatasAusentes escopadas ao associado desta chamada — não se
    // mistura com nenhuma outra cobrança de outro associado/franquia) ->
    // NENHUMA é aplicada, todas permanecem pending/overdue, reportadas em
    // "removidas_bloqueadas_guardrail" e em "erros".
    // =========================================================================
    console.log('\n== Cenário 13: item 4 — guardrail de remoção (> 20 confirmadas) ==');
    {
      const ursula = await criarAssociado('23232323232', 'Ursula Guardrail Remocao');
      const idsGuardrail = [];
      for (let i = 0; i < 21; i += 1) {
        const id = `pay_guardrail_${i}`;
        idsGuardrail.push(id);
        await criarCobranca(ursula.id, { idExterno: id, valor: 15, vencimento: diasAtras(30), status: 'overdue' });
        mockPagamentos[id] = { deleted: true, status: 'DELETED' };
      }

      // Payload com "cobrancas: []" pra Ursula — nenhuma das 21 é "tocada"
      // por este sync, então todas viram candidatasAusentes pra ela.
      const payloadUrsula = [{ cpf_cnpj: ursula.cpfCnpj, nome: ursula.nome, telefone: ursula.telefone, cobrancas: [] }];
      const r = await post('/sync', payloadUrsula, bearer);
      assertEqual(r.status, 200, 'POST /api/sync (item 4, guardrail de remoção) -> 200');
      assertEqual(r.corpo.cobrancas_removidas, 0, 'cobrancas_removidas = 0 — o guardrail bloqueou TODAS as 21, nenhuma aplicada');
      assertEqual(r.corpo.removidas_bloqueadas_guardrail, 21, 'removidas_bloqueadas_guardrail = 21 (mesma constante LIMITE_GUARDRAIL_REMOVIDAS = 20, > 20 bloqueia tudo)');
      assertEqual(
        r.corpo.erros.filter((e) => idsGuardrail.includes(e.id_externo) && /guardrail/i.test(e.erro)).length,
        21,
        'cada uma das 21 candidatas bloqueadas está detalhada em "erros" mencionando o guardrail'
      );

      const countAindaAbertas = await db.cobranca.count({ where: { associadoId: ursula.id, status: { in: ['pending', 'overdue'] } } });
      assertEqual(countAindaAbertas, 21, 'as 21 cobranças da Ursula permanecem pending/overdue — guardrail não aplicou nenhuma remoção');
      const countRemovidas = await db.cobranca.count({ where: { associadoId: ursula.id, status: 'removida' } });
      assertEqual(countRemovidas, 0, 'nenhuma delas foi marcada "removida"');
    }
  } finally {
    console.log('\n== Encerrando app, mock e derrubando banco de teste ==');
    await db.$disconnect();
    app.kill('SIGTERM');
    await new Promise((resolve) => mockServer.close(resolve));
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
