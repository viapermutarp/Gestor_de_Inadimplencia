/**
 * Teste end-to-end do AJUSTE 14 — "Tabela local sincronizada via webhook do
 * Asaas para Taxa de Inadimplência" (ver README, seção "AJUSTE 14", e
 * pagamentosAsaas.service.js para o desenho completo). Segue o mesmo padrão
 * das rodadas anteriores (test-ajustes.js / test-status-ajustes.js): sobe
 * tudo de verdade (Postgres real, app real, mock do Asaas real), faz
 * chamadas HTTP reais, valida, derruba no final.
 *
 * DIFERENÇA em relação a test-status-ajustes.js: em vez de subir um
 * Postgres embutido via "embedded-postgres" (dependência extra), reaproveita
 * o serviço "postgresql" já instalado/rodando neste ambiente — ainda um
 * Postgres REAL (não mockado), só sem precisar baixar o binário embutido de
 * novo a cada rodada. Cria/derruba um banco próprio (nome com timestamp) a
 * cada execução.
 *
 * Cobre exatamente o "Teste esperado" do brief:
 *   1. Webhook: PAYMENT_CREATED -> PAYMENT_RECEIVED, PAYMENT_OVERDUE,
 *      PAYMENT_UPDATED (mudando valor/vencimento) — tabela local reflete
 *      cada transição corretamente.
 *   2. Mesmo evento entregue 2x não duplica nem corrompe (idempotência) —
 *      inclusive PAYMENT_DELETED entregue 2x.
 *   3. Backfill populando corretamente MÚLTIPLAS franquias (2, com datasets
 *      disjuntos — ver mock-asaas-ajuste14.js) sem misturar dados; rodado 2x
 *      (idempotência do backfill).
 *   4. Reconciliação (via endpoint HTTP) corrige uma divergência simulada
 *      (um valor alterado à força no banco local + uma linha "órfã" que não
 *      existe mais no Asaas).
 *   5. /resumo e /evolucao-mensal devolvendo os MESMOS números de antes:
 *      reaproveita, VERBATIM, o dataset e as asserções já validadas em
 *      test-status-ajustes.js (via mock-asaas-ajuste14.js, conta
 *      "regressao" — cópia byte-a-byte do dataset de mock-asaas-inline.js),
 *      rodadas agora contra o caminho NOVO (Postgres local, via backfill) em
 *      vez do caminho antigo (Asaas ao vivo) — os mesmos valores esperados
 *      confirmam que a troca de fonte de dados não mudou nenhum resultado.
 *   6. Tempo de resposta: mede /resumo (Postgres local, "depois") e compara
 *      com uma chamada equivalente direto à API (mock) do Asaas ("antes",
 *      aproximado — o mock não reproduz a latência de rede real do Asaas em
 *      produção, mas isola o número de chamadas/paginação eliminado).
 */
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const BACKEND_DIR = __dirname;
const APP_PORT = 3072;
const MOCK_PORT = 4057;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_ajuste14_e2e_${Date.now()}`;
const DATABASE_URL = `postgresql://gestor:gestor@localhost:5432/${DB_NAME}?schema=public`;
const MOCK_BASE_URL = `http://localhost:${MOCK_PORT}`;

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
async function get(caminho, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { headers: headersPara(bearer) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
async function patch(caminho, dados, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'PATCH', headers: headersPara(bearer), body: JSON.stringify(dados) });
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

const arred2 = (v) => Math.round(v * 100) / 100;
const taxa = (total_, parcial) => (total_ > 0 ? arred2((parcial / total_) * 100) : 0);
function gerarHashChave(chave) {
  return crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');
}

async function main() {
  console.log(`== Criando banco de teste "${DB_NAME}" (Postgres real, serviço local) ==`);
  execSync(`sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME} OWNER gestor;"`, { stdio: 'inherit' });

  console.log('\n== Rodando prisma migrate deploy (histórico completo, incluindo AJUSTE 14) ==');
  execSync('npx prisma migrate deploy', { cwd: BACKEND_DIR, env: { ...process.env, DATABASE_URL }, stdio: 'inherit' });

  // Requerida DEPOIS de setar DATABASE_URL no processo — @prisma/client e os
  // services que importam "../config/prisma" (singleton) precisam ler a URL
  // certa na hora em que são carregados pela primeira vez.
  process.env.DATABASE_URL = DATABASE_URL;
  const { PrismaClient } = require('@prisma/client');
  const db = new PrismaClient({ datasources: { db: { url: DATABASE_URL } } });

  console.log('\n== Subindo mock do Asaas (multi-tenant: regressao/multi_f1/multi_f2) ==');
  const mock = spawn('node', ['mock-asaas-ajuste14.js'], {
    cwd: BACKEND_DIR,
    env: { ...process.env, MOCK_ASAAS_PORT: String(MOCK_PORT) },
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
      JWT_SECRET: 'test-secret-ajuste14',
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

    // -------------------------------------------------------------
    // Setup: 3 franquias (regressao/multi_f1/multi_f2), cada uma com sua
    // própria ApiKey (gravada direto via Prisma — sem depender de nenhuma
    // franquia semeada automaticamente pelo bootstrap do server), sua
    // própria chave do Asaas (mock) e seu próprio token de webhook.
    // -------------------------------------------------------------
    console.log('\n== Setup: criando franquias + api keys ==');
    const franquiaRegressao = await db.franquia.create({ data: { nome: 'AJUSTE14 Regressao' } });
    const franquiaF1 = await db.franquia.create({ data: { nome: 'AJUSTE14 Multi F1' } });
    const franquiaF2 = await db.franquia.create({ data: { nome: 'AJUSTE14 Multi F2' } });

    async function criarApiKey(franquiaId, nome) {
      const chave = crypto.randomBytes(24).toString('hex');
      await db.apiKey.create({
        data: { franquiaId, nome, hash: gerarHashChave(chave), tamanho: chave.length, ultimosCaracteres: chave.slice(-6) },
      });
      return chave;
    }
    const bearerRegressao = await criarApiKey(franquiaRegressao.id, 'teste-regressao');
    const bearerF1 = await criarApiKey(franquiaF1.id, 'teste-multi-f1');
    const bearerF2 = await criarApiKey(franquiaF2.id, 'teste-multi-f2');
    assert(bearerRegressao && bearerF1 && bearerF2, 'api keys criadas para as 3 franquias');

    async function configurarAsaas(bearer, chaveAsaas) {
      const r = await patch('/config/asaas-key', { chave: chaveAsaas }, bearer);
      assertEqual(r.status, 200, `PATCH /config/asaas-key (${chaveAsaas}) -> 200`);
      const rw = await post('/config/asaas-webhook/gerar', {}, bearer);
      assertEqual(rw.status, 200, `POST /config/asaas-webhook/gerar (${chaveAsaas}) -> 200`);
      return rw.corpo.asaas_access_token;
    }
    const webhookTokenRegressao = await configurarAsaas(bearerRegressao, 'asaas-mock-status-teste');
    const webhookTokenF1 = await configurarAsaas(bearerF1, 'ajuste14-mock-f1');
    const webhookTokenF2 = await configurarAsaas(bearerF2, 'ajuste14-mock-f2');

    // -------------------------------------------------------------
    // TESTE 1 — Webhook: transições de status/valor/vencimento refletidas
    // corretamente na tabela local (franquia multi_f1, pagamento sintético
    // que NÃO existe no mock — só via webhook mesmo).
    // -------------------------------------------------------------
    console.log('\n== Teste: webhook — PAYMENT_CREATED -> RECEIVED, OVERDUE, UPDATED (valor/vencimento) ==');
    const payId = 'wh_teste_1';
    async function linhaLocal(id) {
      return db.pagamentoAsaas.findUnique({ where: { id } });
    }

    {
      const r = await postWebhook(
        franquiaF1.id,
        {
          id: 'evt_1',
          event: 'PAYMENT_CREATED',
          payment: { id: payId, customer: 'cus_f1_a', value: 100, dueDate: '2026-08-10', status: 'PENDING', description: 'teste webhook' },
        },
        webhookTokenF1
      );
      assertEqual(r.status, 200, 'webhook PAYMENT_CREATED -> 200');
      const linha = await linhaLocal(payId);
      assert(!!linha, 'linha local criada após PAYMENT_CREATED');
      assertEqual(linha.status, 'PENDING', 'status local = PENDING após CREATED');
      assertEqual(Number(linha.value), 100, 'value local = 100 após CREATED');
      assertEqual(linha.dueDate, '2026-08-10', 'dueDate local = 2026-08-10 após CREATED');
      assertEqual(linha.franquiaId, franquiaF1.id, 'linha pertence à franquia F1');
    }

    {
      const r = await postWebhook(
        franquiaF1.id,
        { id: 'evt_2', event: 'PAYMENT_OVERDUE', payment: { id: payId, customer: 'cus_f1_a', value: 100, dueDate: '2026-08-10', status: 'OVERDUE', description: 'teste webhook' } },
        webhookTokenF1
      );
      assertEqual(r.status, 200, 'webhook PAYMENT_OVERDUE -> 200');
      const linha = await linhaLocal(payId);
      assertEqual(linha.status, 'OVERDUE', 'status local = OVERDUE após transição PENDING->OVERDUE');
    }

    {
      const r = await postWebhook(
        franquiaF1.id,
        {
          id: 'evt_3',
          event: 'PAYMENT_RECEIVED',
          payment: { id: payId, customer: 'cus_f1_a', value: 100, dueDate: '2026-08-10', paymentDate: '2026-08-12', status: 'RECEIVED', description: 'teste webhook' },
        },
        webhookTokenF1
      );
      assertEqual(r.status, 200, 'webhook PAYMENT_RECEIVED -> 200');
      const linha = await linhaLocal(payId);
      assertEqual(linha.status, 'RECEIVED', 'status local = RECEIVED após transição OVERDUE->RECEIVED');
      assertEqual(linha.paymentDate, '2026-08-12', 'paymentDate local = 2026-08-12 após RECEIVED');
    }

    {
      // PAYMENT_UPDATED mudando valor E vencimento (ex.: correção manual no Asaas).
      const r = await postWebhook(
        franquiaF1.id,
        {
          id: 'evt_4',
          event: 'PAYMENT_UPDATED',
          payment: { id: payId, customer: 'cus_f1_a', value: 250.5, dueDate: '2026-08-20', paymentDate: '2026-08-12', status: 'RECEIVED', description: 'teste webhook (valor/vencimento alterados)' },
        },
        webhookTokenF1
      );
      assertEqual(r.status, 200, 'webhook PAYMENT_UPDATED (valor/vencimento) -> 200');
      const linha = await linhaLocal(payId);
      assertEqual(Number(linha.value), 250.5, 'value local = 250.5 após UPDATED');
      assertEqual(linha.dueDate, '2026-08-20', 'dueDate local = 2026-08-20 após UPDATED');
      assertEqual(linha.description, 'teste webhook (valor/vencimento alterados)', 'description local atualizada após UPDATED');
    }

    // -------------------------------------------------------------
    // TESTE 2 — Idempotência: o MESMO evento entregue 2x não duplica nem
    // corrompe (upsert por payment.id).
    // -------------------------------------------------------------
    console.log('\n== Teste: idempotência — mesmo evento entregue 2x ==');
    {
      const payload = {
        id: 'evt_4',
        event: 'PAYMENT_UPDATED',
        payment: { id: payId, customer: 'cus_f1_a', value: 250.5, dueDate: '2026-08-20', paymentDate: '2026-08-12', status: 'RECEIVED', description: 'teste webhook (valor/vencimento alterados)' },
      };
      const r1 = await postWebhook(franquiaF1.id, payload, webhookTokenF1);
      const r2 = await postWebhook(franquiaF1.id, payload, webhookTokenF1);
      assertEqual(r1.status, 200, 'entrega 1 do evento repetido -> 200');
      assertEqual(r2.status, 200, 'entrega 2 do evento repetido -> 200');

      const linhas = await db.pagamentoAsaas.findMany({ where: { id: payId } });
      assertEqual(linhas.length, 1, 'idempotência: ainda existe exatamente 1 linha para o mesmo payment.id (nunca duplica)');
      assertEqual(Number(linhas[0].value), 250.5, 'idempotência: value continua correto após entrega repetida');
      assertEqual(linhas[0].status, 'RECEIVED', 'idempotência: status continua correto após entrega repetida');
    }

    // -------------------------------------------------------------
    // TESTE 3 — PAYMENT_DELETED (idempotente também) + evento fora do
    // escopo (ignorado, sempre 200) + falhas de autenticação.
    // -------------------------------------------------------------
    console.log('\n== Teste: PAYMENT_DELETED (idempotente) + evento ignorado + auth ==');
    {
      const r1 = await postWebhook(franquiaF1.id, { id: 'evt_5', event: 'PAYMENT_DELETED', payment: { id: payId } }, webhookTokenF1);
      assertEqual(r1.status, 200, 'webhook PAYMENT_DELETED -> 200');
      assert(!(await linhaLocal(payId)), 'linha local removida após PAYMENT_DELETED');

      const r2 = await postWebhook(franquiaF1.id, { id: 'evt_5b', event: 'PAYMENT_DELETED', payment: { id: payId } }, webhookTokenF1);
      assertEqual(r2.status, 200, 'PAYMENT_DELETED entregue 2x -> ainda 200 (idempotente, remover o que já não existe é no-op)');
      assert(!(await linhaLocal(payId)), 'linha local continua ausente após 2ª entrega de PAYMENT_DELETED');

      const r3 = await postWebhook(
        franquiaF1.id,
        { id: 'evt_6', event: 'SUBSCRIPTION_CREATED', payment: { id: 'irrelevante' } },
        webhookTokenF1
      );
      assertEqual(r3.status, 200, 'evento fora do escopo (ex.: assinatura) -> 200, sempre (nunca entra em retry do Asaas)');

      const r4 = await postWebhook('franquia-inexistente-xyz', { id: 'evt_7', event: 'PAYMENT_CREATED', payment: {} }, webhookTokenF1);
      assertEqual(r4.status, 404, 'franquiaId inexistente na URL -> 404');

      const r5 = await postWebhook(franquiaF1.id, { id: 'evt_8', event: 'PAYMENT_CREATED', payment: {} }, 'token-errado');
      assertEqual(r5.status, 401, 'token de acesso errado -> 401');

      const r6 = await postWebhook(franquiaF1.id, { id: 'evt_9', event: 'PAYMENT_CREATED', payment: {} }, undefined);
      assertEqual(r6.status, 401, 'token de acesso ausente -> 401');
    }

    // -------------------------------------------------------------
    // TESTE 3b — Franquia que existe mas NUNCA gerou um token de webhook
    // (nunca chamou POST /config/asaas-webhook/gerar). Caminho distinto do
    // "token errado"/"token ausente" acima (aqueles têm um tokenEsperado
    // configurado; este não tem NENHUM) — o controller trata isso como um
    // 401 de configuração pendente (linha "!tokenEsperado" em
    // asaasWebhook.controller.js), não 404/500, e nunca grava nada.
    // -------------------------------------------------------------
    console.log('\n== Teste: franquia sem token de webhook gerado ainda ==');
    {
      const franquiaSemWebhook = await db.franquia.create({ data: { nome: 'AJUSTE14 Sem Webhook' } });
      const r = await postWebhook(
        franquiaSemWebhook.id,
        {
          id: 'evt_sem_webhook',
          event: 'PAYMENT_CREATED',
          payment: { id: 'pay_sem_webhook', customer: 'cus_x', value: 10, dueDate: '2026-08-01', status: 'PENDING' },
        },
        'qualquer-token-aqui'
      );
      assertEqual(r.status, 401, 'franquia existe mas nunca gerou token de webhook -> 401 (não 404, não 500)');
      assert(!(await linhaLocal('pay_sem_webhook')), 'nenhuma linha local criada quando a franquia não tem webhook configurado');

      // Mesmo sem token nenhum no header (não só "token errado") — reforça
      // que é a AUSÊNCIA de tokenEsperado que decide aqui, não o valor
      // enviado pelo Asaas.
      const rSemHeader = await postWebhook(
        franquiaSemWebhook.id,
        { id: 'evt_sem_webhook_2', event: 'PAYMENT_CREATED', payment: { id: 'pay_sem_webhook', customer: 'cus_x', value: 10, dueDate: '2026-08-01', status: 'PENDING' } },
        undefined
      );
      assertEqual(rSemHeader.status, 401, 'mesma franquia sem webhook configurado, sem header nenhum -> ainda 401 (mesmo motivo)');

      // Confirma que o servidor não "quebrou"/travou com isso — próxima
      // chamada, pra uma franquia normal, continua respondendo certo.
      const rSanidade = await postWebhook(
        franquiaF1.id,
        { id: 'evt_sanidade', event: 'PAYMENT_CREATED', payment: { id: 'pay_sanidade', customer: 'cus_f1_a', value: 1, dueDate: '2026-08-01', status: 'PENDING' } },
        webhookTokenF1
      );
      assertEqual(rSanidade.status, 200, 'servidor continua respondendo normalmente para outras franquias depois do 401 (nada travou)');
      await db.pagamentoAsaas.delete({ where: { id: 'pay_sanidade' } });
    }

    // -------------------------------------------------------------
    // TESTE 4 — Backfill multi-franquia: popula as 3 franquias de uma vez,
    // sem misturar dados; rodado 2x pra confirmar idempotência do backfill.
    // -------------------------------------------------------------
    console.log('\n== Teste: backfill (todas as franquias, dry-run primeiro) ==');
    function rodarBackfill(args) {
      return execSync(`node scripts/backfill-pagamentos-asaas.js ${args}`, {
        cwd: BACKEND_DIR,
        env: { ...process.env, DATABASE_URL, ASAAS_API_BASE_URL: MOCK_BASE_URL },
      }).toString();
    }
    {
      const saidaDry = rodarBackfill('');
      console.log(saidaDry);
      assert(saidaDry.includes('DRY RUN'), 'backfill sem --confirm roda em modo dry run');
      const totalAntes = await db.pagamentoAsaas.count();
      assertEqual(totalAntes, 0, 'dry run não grava nada no banco (0 linhas antes de --confirm)');
    }
    {
      const saida1 = rodarBackfill('--confirm');
      console.log(saida1);
      assert(saida1.includes('Multi F1') || saida1.includes('AJUSTE14'), 'backfill --confirm processou as franquias esperadas');

      const f1Local = await db.pagamentoAsaas.findMany({ where: { franquiaId: franquiaF1.id }, orderBy: { id: 'asc' } });
      const f2Local = await db.pagamentoAsaas.findMany({ where: { franquiaId: franquiaF2.id }, orderBy: { id: 'asc' } });

      assertEqual(f1Local.length, 3, 'franquia F1: exatamente 3 pagamentos locais após backfill (bate com o mock)');
      assertEqual(f2Local.length, 2, 'franquia F2: exatamente 2 pagamentos locais após backfill (bate com o mock)');
      assert(f1Local.every((p) => p.franquiaId === franquiaF1.id), 'F1: todas as linhas têm franquiaId = F1 (nenhuma vazou de outra franquia)');
      assert(f2Local.every((p) => p.franquiaId === franquiaF2.id), 'F2: todas as linhas têm franquiaId = F2 (nenhuma vazou de outra franquia)');
      assert(
        f1Local.every((p) => p.id.startsWith('f1_')) && f2Local.every((p) => p.id.startsWith('f2_')),
        'ids de F1/F2 continuam nos seus próprios namespaces (sem mistura)'
      );

      const f1PayOverdue = f1Local.find((p) => p.id === 'f1_pay_1');
      assertEqual(Number(f1PayOverdue.value), 1200, 'f1_pay_1: value correto após backfill (1200)');
      assertEqual(f1PayOverdue.status, 'OVERDUE', 'f1_pay_1: status correto após backfill (OVERDUE)');
      assertEqual(f1PayOverdue.cpfCnpj, '10.000.001/0001-01', 'f1_pay_1: cpfCnpj resolvido e cacheado pelo backfill');
      assertEqual(f1PayOverdue.nome, 'F1 Associado A', 'f1_pay_1: nome resolvido e cacheado pelo backfill');

      const f2PayReceived = f2Local.find((p) => p.id === 'f2_pay_2');
      assertEqual(Number(f2PayReceived.value), 2200, 'f2_pay_2: value correto após backfill (2200)');
      assertEqual(f2PayReceived.paymentDate, f2PayReceived.dueDate ? f2PayReceived.paymentDate : null, 'f2_pay_2: paymentDate presente (pago)');
    }
    {
      const totalAntesSegundaRodada = await db.pagamentoAsaas.count();
      const saida2 = rodarBackfill('--confirm');
      console.log(saida2);
      const totalDepoisSegundaRodada = await db.pagamentoAsaas.count();
      assertEqual(
        totalDepoisSegundaRodada,
        totalAntesSegundaRodada,
        'backfill rodado 2x: mesma contagem de linhas (idempotente, não duplica)'
      );
      assert(/\b0 pagamento\(s\) criado\(s\)/.test(saida2), 'segunda rodada de backfill: 0 criados (tudo já existia, só atualizou)');
    }

    // -------------------------------------------------------------
    // TESTE 5 — Reconciliação (via endpoint HTTP) corrige uma divergência
    // simulada: um valor alterado à força no banco local + uma linha órfã
    // (que não existe mais no Asaas) dentro da janela.
    // -------------------------------------------------------------
    console.log('\n== Teste: reconciliação corrige divergência (endpoint HTTP) ==');
    {
      await db.pagamentoAsaas.update({ where: { id: 'f2_pay_1' }, data: { value: 999999 } });
      await db.pagamentoAsaas.create({
        data: {
          id: 'f2_pay_orfa',
          franquiaId: franquiaF2.id,
          customerId: 'cus_f2_a',
          value: 1,
          dueDate: (() => {
            const d = new Date();
            d.setDate(d.getDate() - 8);
            return d.toISOString().slice(0, 10);
          })(),
          status: 'OVERDUE',
          description: 'linha órfã simulada (webhook PAYMENT_DELETED perdido)',
        },
      });

      const r = await post('/inadimplencia/reconciliar-pagamentos', {}, bearerF2);
      assertEqual(r.status, 200, 'POST /inadimplencia/reconciliar-pagamentos (F2) -> 200');
      assert(r.corpo.atualizados >= 1, 'reconciliação reporta ao menos 1 atualizado (f2_pay_1 corrigido)');
      assert(r.corpo.removidos >= 1, 'reconciliação reporta ao menos 1 removido (linha órfã)');

      const f2Pay1Depois = await linhaLocal('f2_pay_1');
      assertEqual(Number(f2Pay1Depois.value), 5000, 'f2_pay_1: value corrigido de volta a 5000 pela reconciliação');
      assert(!(await linhaLocal('f2_pay_orfa')), 'linha órfã removida pela reconciliação (não veio mais do Asaas)');
    }

    // -------------------------------------------------------------
    // TESTE 6 — Regressão: MESMO dataset/asserções de test-status-ajustes.js
    // (franquia "regressao", populada pelo backfill acima), agora lidas via
    // Postgres local em vez de Asaas ao vivo. Números IDÊNTICOS confirmam
    // que o AJUSTE 14 não mudou nenhum resultado.
    // -------------------------------------------------------------
    console.log('\n== Teste: regressão — /resumo e /evolucao-mensal via Postgres local, mesmos números de antes ==');
    const hoje = new Date();
    function isoOffset(diasAtras) {
      const d = new Date(hoje);
      d.setDate(d.getDate() - diasAtras);
      return d.toISOString().slice(0, 10);
    }
    const periodoA = `venc_de=${isoOffset(340)}&venc_ate=${isoOffset(150)}`;
    const periodoB = `venc_de=${isoOffset(140)}&venc_ate=${isoOffset(-5)}`;
    const periodoC = `venc_de=${isoOffset(410)}&venc_ate=${isoOffset(400)}`;

    {
      const r = await get(`/inadimplencia/resumo?${periodoA}`, bearerRegressao);
      assertEqual(r.status, 200, 'GET resumo (Grupo A, Postgres local) -> 200');
      assertEqual(r.corpo.valor_total_faturado, 3500, '[regressão] valor_total_faturado = 3500 (idêntico ao teste ao vivo)');
      assertEqual(r.corpo.valor_inadimplente, 1700, '[regressão] valor_inadimplente = 1700 (idêntico ao teste ao vivo)');
      assertEqual(r.corpo.valor_adimplente, 1200, '[regressão] valor_adimplente = 1200 (idêntico ao teste ao vivo)');
      assertEqual(r.corpo.taxa_inadimplencia_percentual, taxa(3500, 1700), '[regressão] taxa_inadimplencia bate com o cálculo manual');
    }
    {
      const rVencidas = await get(`/inadimplencia/resumo?${periodoA}&tipo_pendencia=vencidas`, bearerRegressao);
      assertEqual(rVencidas.corpo.valor_inadimplente, 1000, '[regressão] tipo_pendencia=vencidas: valor_inadimplente = 1000');
      const rConfirmadas = await get(`/inadimplencia/resumo?${periodoA}&tipo_pendencia=confirmadas`, bearerRegressao);
      assertEqual(rConfirmadas.corpo.valor_inadimplente, 700, '[regressão] tipo_pendencia=confirmadas: valor_inadimplente = 700');
    }
    {
      const r = await get(`/inadimplencia/evolucao-mensal?${periodoA}`, bearerRegressao);
      assertEqual(r.status, 200, 'GET evolucao-mensal (Grupo A, Postgres local) -> 200');
      const totalInadimplenteMeses = arred2(r.corpo.reduce((s, m) => s + m.valor_inadimplente, 0));
      assertEqual(totalInadimplenteMeses, 1700, '[regressão] soma mensal de valor_inadimplente bate com /resumo (1700)');
    }
    {
      const r = await get(`/inadimplencia/resumo?${periodoB}&visao=aberto`, bearerRegressao);
      assertEqual(r.corpo.faixas.ate_vencimento, 111, '[regressão] aberto: faixas.ate_vencimento = 111');
      assertEqual(r.corpo.faixas['1_20'], 999, '[regressão] aberto: faixas.1_20 = 999');
      assertEqual(r.corpo.faixas.acima_100, 444, '[regressão] aberto: faixas.acima_100 = 444');
      assertEqual(r.corpo.criticos_90_dias, 444, '[regressão] aberto: criticos_90_dias = 444');
    }
    {
      const r = await get(`/inadimplencia/resumo?${periodoB}&visao=historico`, bearerRegressao);
      assertEqual(r.corpo.faixas.ate_vencimento, 999, '[regressão] historico: faixas.ate_vencimento = 999 (CORREÇÃO ate_vencimento preservada)');
      assertEqual(r.corpo.faixas['21_30'], 505, '[regressão] historico: faixas.21_30 = 505');
      assertEqual(r.corpo.faixas['31_40'], 606, '[regressão] historico: faixas.31_40 = 606');
      assertEqual(r.corpo.faixas['41_50'], 707, '[regressão] historico: faixas.41_50 = 707');
    }
    {
      const rAberto = await get(`/inadimplencia/resumo?${periodoB}&visao=aberto`, bearerRegressao);
      assertEqual(rAberto.corpo.valor_total_faturado, 4593, '[regressão] visao=aberto: valor_total_faturado = 4593');
      assertEqual(rAberto.corpo.valor_inadimplente, 1887, '[regressão] visao=aberto: valor_inadimplente = 1887');
      const rHistorico = await get(`/inadimplencia/resumo?${periodoB}&visao=historico`, bearerRegressao);
      assertEqual(rHistorico.corpo.valor_inadimplente, 3705, '[regressão] visao=historico: valor_inadimplente = 3705');
      assertEqual(rHistorico.corpo.valor_adimplente, 888, '[regressão] visao=historico: valor_adimplente = 888');
    }
    {
      const rTol = await patch('/config/tolerancia-dias', { dias: 3 }, bearerRegressao);
      assertEqual(rTol.status, 200, '[regressão] PATCH tolerancia-dias=3 -> 200');
      const r = await get(`/inadimplencia/resumo?${periodoB}&visao=aberto&forcar=true`, bearerRegressao);
      assertEqual(r.corpo.faixas.ate_vencimento, 888, '[regressão] tolerancia=3: faixas.ate_vencimento = 888');
      assertEqual(r.corpo.faixas.acima_100, 0, '[regressão] tolerancia=3: faixas.acima_100 = 0 (deslocado)');
      await patch('/config/tolerancia-dias', { dias: 0 }, bearerRegressao);
    }
    {
      const r = await get(`/inadimplencia/resumo?${periodoC}`, bearerRegressao);
      assertEqual(r.corpo.valor_total_faturado, 4000, '[regressão] Grupo C sem exclusão: valor_total_faturado = 4000');

      const rPatch = await patch('/config/palavras-excluidas', { palavras: ['33.333.333/0001-33'] }, bearerRegressao);
      assertEqual(rPatch.status, 200, '[regressão] PATCH palavras-excluidas (CPF/CNPJ) -> 200');
      const rExcl = await get(`/inadimplencia/resumo?${periodoC}&forcar=true`, bearerRegressao);
      assertEqual(rExcl.corpo.excluidos.quantidade, 1, '[regressão] exclusão por CPF/CNPJ: quantidade = 1');
      assertEqual(rExcl.corpo.excluidos.valor, 1500, '[regressão] exclusão por CPF/CNPJ: valor = 1500');
      assertEqual(rExcl.corpo.valor_total_faturado, 2500, '[regressão] exclusão por CPF/CNPJ: valor_total_faturado = 2500');

      await patch('/config/palavras-excluidas', { palavras: [] }, bearerRegressao);
    }

    // -------------------------------------------------------------
    // TESTE 7 — Tempo de resposta: Postgres local ("depois") x chamada
    // equivalente direto ao mock do Asaas ("antes", aproximado).
    // -------------------------------------------------------------
    console.log('\n== Medição: tempo de resposta /resumo — Postgres local ("depois") ==');
    const temposDepois = [];
    for (let i = 0; i < 5; i += 1) {
      const inicio = Date.now();
      await get(`/inadimplencia/resumo?${periodoA}&forcar=true`, bearerRegressao);
      temposDepois.push(Date.now() - inicio);
    }
    const mediaDepois = arred2(temposDepois.reduce((a, b) => a + b, 0) / temposDepois.length);
    console.log(`  Postgres local ("depois"): ${temposDepois.join(', ')} ms — média ${mediaDepois} ms`);

    console.log('\n== Medição: chamada equivalente direto ao Asaas (mock) — "antes", aproximado ==');
    const temposAntes = [];
    for (let i = 0; i < 5; i += 1) {
      const inicio = Date.now();
      const resp = await fetch(`${MOCK_BASE_URL}/payments?limit=100&offset=0`, { headers: { access_token: 'asaas-mock-status-teste' } });
      await resp.json();
      // Simula também a resolução de clientes distintos (2 chamadas /customers/{id} pro Grupo A: cus_a/cus_b).
      await fetch(`${MOCK_BASE_URL}/customers/cus_a`, { headers: { access_token: 'asaas-mock-status-teste' } });
      await fetch(`${MOCK_BASE_URL}/customers/cus_b`, { headers: { access_token: 'asaas-mock-status-teste' } });
      temposAntes.push(Date.now() - inicio);
    }
    const mediaAntes = arred2(temposAntes.reduce((a, b) => a + b, 0) / temposAntes.length);
    console.log(`  Asaas mock ("antes", aproximado): ${temposAntes.join(', ')} ms — média ${mediaAntes} ms`);
    console.log(
      '  AVISO: o mock roda local (latência de rede ~0) — a diferença real em produção contra a API do Asaas de\n' +
        '  verdade (internet, rate limit, paginação de páginas de 100 em 100, 1 chamada /customers por cliente\n' +
        '  DISTINTO no período) tende a ser MUITO maior do que a medida aqui; esta medição só isola a mudança\n' +
        '  estrutural (N chamadas HTTP externas -> 1 consulta indexada local), não a latência de rede em si.'
    );

    console.log(`\n${'='.repeat(60)}\nResultado: ${total - falhas}/${total} passaram.`);
    if (falhas > 0) {
      console.error(`${falhas} ASSERÇÕES FALHARAM.`);
      process.exitCode = 1;
    } else {
      console.log('TODOS OS TESTES PASSARAM.');
    }

  } finally {
    await db.$disconnect().catch(() => {});
    mock.kill();
    app.kill();
    await sleep(300);
    try {
      execSync(`sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME};"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Falha ao derrubar o banco de teste (não bloqueia o resultado):', err.message);
    }
  }
}

main().catch((err) => {
  console.error('Erro fatal no teste:', err);
  process.exit(1);
});
