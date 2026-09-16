/**
 * Teste end-to-end da correção "duplicata Negativada + DUNNING_REQUESTED
 * como inadimplente" (brief pós-auditoria — ver
 * scripts/auditoria-duplicatas-negativada-dunning.js, rodada em produção
 * antes desta correção: 9 pares duplicando R$ 39.652,95, 11 cobranças
 * DUNNING_REQUESTED isoladas R$ 53.132,32 invisíveis).
 *
 * Mesmo padrão de test-ajuste17-juridico-critico.js: Postgres real (serviço
 * "postgresql" local), servidor Express real, pagamentos escritos DIRETO
 * via Prisma (sem mock do Asaas — AJUSTE 14, GET /resumo não chama o Asaas
 * ao vivo).
 *
 * Cenário (1 franquia, 6 "associados", todos com diasAtraso bem abaixo de
 * LIMIAR_DIAS_CRITICO=50, pra não interferir com faixas/críticos):
 *   A — DUNNING_REQUESTED ISOLADA (sem par): 1000, 10 dias de atraso.
 *   B — par Negativada, AMBOS OVERDUE: original 500 (10d) + cópia
 *       "(Negativada)" 500 (11d, mesmo cliente).
 *   C — par Negativada, OVERDUE + DUNNING_REQUESTED (o caso que o item 2 do
 *       brief diz que FICARIA duplicado se a exclusão não fosse aplicada
 *       junto com o item 1): original OVERDUE 600 (10d) + cópia
 *       "(NEGATIVADO)" DUNNING_REQUESTED 600 (11d) — variação maiúscula/
 *       masculina da descrição, testando a regex.
 *   D — par Negativada onde a CÓPIA já foi paga: original OVERDUE 700
 *       (10d) + cópia "(Negativada)" RECEIVED 700 — a cópia deve ficar de
 *       fora de TUDO (aberto/inadimplente/adimplente), não só não duplicar.
 *   E — coincidência de value/dueDate SEM nenhum sufixo "negativada" nos 2
 *       lados (2 parcelas normais, mesmo valor, dueDate próximo): NÃO deve
 *       ser tratado como par — os 2 devem contar.
 *   F — controle, 1 cobrança normal: 200 (10d).
 *
 * Todos os valores/somas abaixo foram calculados à mão a partir deste
 * cenário, independente do controller.
 */
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');

const BACKEND_DIR = __dirname;
const APP_PORT = 3093;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_negdunning_e2e_${Date.now()}`;
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
async function get(caminho, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { headers: { Authorization: `Bearer ${bearer}` } });
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

async function main() {
  console.log(`== Criando banco de teste "${DB_NAME}" ==`);
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
      ASAAS_API_BASE_URL: 'http://localhost:1', // nunca chamado
      JWT_SECRET: 'test-secret-negdunning',
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

    console.log('\n== Setup: franquia + api key + associados + pagamentos ==');
    const franquia = await db.franquia.create({ data: { nome: 'NegDunning E2E' } });
    const chaveApi = crypto.randomBytes(24).toString('hex');
    await db.apiKey.create({
      data: {
        franquiaId: franquia.id,
        nome: 'teste-negdunning',
        hash: gerarHashChave(chaveApi),
        tamanho: chaveApi.length,
        ultimosCaracteres: chaveApi.slice(-6),
      },
    });

    const ASSOCIADOS = ['a', 'b', 'c', 'd', 'e', 'f'].map((letra) => ({
      id: letra,
      cpfCnpj: `92.000.00${letra.charCodeAt(0) - 96}/0001-0${letra.charCodeAt(0) - 96}`,
      nome: `Associado ${letra.toUpperCase()}`,
    }));
    const associadoPorId = {};
    for (const a of ASSOCIADOS) {
      associadoPorId[a.id] = await db.associado.create({
        data: { franquiaId: franquia.id, cpfCnpj: a.cpfCnpj, nome: a.nome, telefone: '00000000000', emJuridico: false },
      });
    }

    async function criarPagamento(id, associadoId, valor, diasAtrasoAlvo, { status = 'OVERDUE', descricao = `Cobrança ${associadoId}` } = {}) {
      const assoc = associadoPorId[associadoId];
      await db.pagamentoAsaas.create({
        data: {
          id,
          franquiaId: franquia.id,
          customerId: `cus_${associadoId}`,
          cpfCnpj: assoc.cpfCnpj,
          nome: assoc.nome,
          value: valor,
          dueDate: diasAtras(diasAtrasoAlvo),
          status,
          description: descricao,
        },
      });
    }

    // A — DUNNING_REQUESTED isolada.
    await criarPagamento('p_a', 'a', 1000, 10, { status: 'DUNNING_REQUESTED', descricao: 'Cobrança A' });

    // B — par Negativada, ambos OVERDUE.
    await criarPagamento('p_b_orig', 'b', 500, 10, { status: 'OVERDUE', descricao: 'Cobrança B' });
    await criarPagamento('p_b_neg', 'b', 500, 11, { status: 'OVERDUE', descricao: 'Cobrança B (Negativada)' });

    // C — par Negativada, OVERDUE + DUNNING_REQUESTED, variação maiúscula/masculina.
    await criarPagamento('p_c_orig', 'c', 600, 10, { status: 'OVERDUE', descricao: 'Cobrança C' });
    await criarPagamento('p_c_neg', 'c', 600, 11, { status: 'DUNNING_REQUESTED', descricao: 'Cobrança C (NEGATIVADO)' });

    // D — par Negativada, cópia já RECEIVED.
    await criarPagamento('p_d_orig', 'd', 700, 10, { status: 'OVERDUE', descricao: 'Cobrança D' });
    await criarPagamento('p_d_neg', 'd', 700, 8, { status: 'RECEIVED', descricao: 'Cobrança D (Negativada)' });

    // E — coincidência SEM sufixo em nenhum dos 2 — não deve ser deduplicado.
    await criarPagamento('p_e_1', 'e', 300, 10, { status: 'OVERDUE', descricao: 'Parcela 1/2' });
    await criarPagamento('p_e_2', 'e', 300, 12, { status: 'OVERDUE', descricao: 'Parcela 2/2' });

    // F — controle, 1 cobrança normal.
    await criarPagamento('p_f', 'f', 200, 10, { status: 'OVERDUE', descricao: 'Cobrança F' });

    const janelaAmpla = `venc_de=${diasAtras(365)}&venc_ate=${diasAtras(-365)}`;

    // -------------------------------------------------------------
    // TESTE 1 — valor_total_faturado soma TUDO, cópia negativada incluída.
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_total_faturado soma todas as linhas, cópias negativadas incluídas ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      assertEqual(r.status, 200, 'GET resumo -> 200');
      // A(1000) + B(500+500) + C(600+600) + D(700+700) + E(300+300) + F(200) = 5400
      assertEqual(r.corpo.valor_total_faturado, 5400, 'valor_total_faturado = 5400 (soma de TODAS as linhas, cópias negativadas incluídas)');
    }

    // -------------------------------------------------------------
    // TESTE 2 — valor_total_aberto: DUNNING_REQUESTED conta, negativada some, coincidência (E) conta as 2.
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_total_aberto (item 1 + item 2 juntos) ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      // A=1000 (DUNNING isolada, agora conta) + B=500 (só original, cópia excluída) +
      // C=600 (só original OVERDUE; cópia DUNNING_REQUESTED excluída — SEM ISSO duplicaria) +
      // D=700 (só original; cópia RECEIVED excluída, nem contaria mesmo sem a correção) +
      // E=600 (300+300, SEM sufixo em nenhum dos 2 — não é par, os 2 contam) + F=200
      assertEqual(r.corpo.valor_total_aberto, 1000 + 500 + 600 + 700 + 600 + 200, 'valor_total_aberto = 3600');
    }

    // -------------------------------------------------------------
    // TESTE 3 — valor_inadimplente (tipo_pendencia=todos, visao=aberto): mesmo conjunto (sem PENDING no cenário).
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_inadimplente inclui DUNNING_REQUESTED, exclui cópias negativadas ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_pendencia=todos`, chaveApi);
      assertEqual(r.corpo.valor_inadimplente, 3600, 'valor_inadimplente(todos) = 3600, igual a valor_total_aberto neste cenário (sem PENDING)');
    }

    // -------------------------------------------------------------
    // TESTE 4 — valor_adimplente: a cópia negativada RECEIVED (D) fica de FORA — não é "recuperada" como adimplente.
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_adimplente exclui a cópia negativada mesmo estando RECEIVED ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      assertEqual(r.corpo.valor_adimplente, 0, 'valor_adimplente = 0 — a única linha RECEIVED do cenário (D, cópia negativada) foi excluída de TUDO, não só do "aberto"');
    }

    // -------------------------------------------------------------
    // TESTE 5 — tipo_pendencia=vencidas/confirmadas NÃO incluem DUNNING_REQUESTED (escopo deliberado, só "todos").
    // -------------------------------------------------------------
    console.log('\n== Teste: DUNNING_REQUESTED só entra em tipo_pendencia=todos, não em vencidas/confirmadas ==');
    {
      const rVencidas = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_pendencia=vencidas`, chaveApi);
      // vencidas = só OVERDUE, deduplicado: B(500)+C(600)+D(700)+E(600)+F(200) = 2600 — SEM A (DUNNING, não é OVERDUE)
      assertEqual(rVencidas.corpo.valor_inadimplente, 2600, 'tipo_pendencia=vencidas: valor_inadimplente = 2600 (sem A, que é DUNNING_REQUESTED)');

      const rConfirmadas = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_pendencia=confirmadas`, chaveApi);
      assertEqual(rConfirmadas.corpo.valor_inadimplente, 0, 'tipo_pendencia=confirmadas: valor_inadimplente = 0 (nenhum CONFIRMED no cenário)');
    }

    // -------------------------------------------------------------
    // TESTE 6 — top_devedores / associados_inadimplentes: só quem tem status OVERDUE (pagamentosOverdue,
    // literal — NÃO reaproveita STATUS_POR_SITUACAO/STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA, fora do escopo
    // deste brief, ver relatório de entrega) — A (só DUNNING) fica de fora aqui, de propósito, é um gap
    // conhecido e sinalizado, não um bug desta correção.
    // -------------------------------------------------------------
    console.log('\n== Teste: top_devedores/associados_inadimplentes — só OVERDUE, deduplicado, A fica de fora (gap sinalizado) ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      const cpfsTop = r.corpo.top_devedores.map((d) => d.cpf_cnpj);
      assert(!cpfsTop.includes(associadoPorId['a'].cpfCnpj), 'A (só DUNNING_REQUESTED) NÃO aparece em top_devedores — gap sinalizado no relatório, fora do escopo deste brief');
      assertEqual(r.corpo.associados_inadimplentes, 5, 'associados_inadimplentes = 5 (B,C,D,E,F — A fica de fora, mesmo motivo)');

      const devedorB = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['b'].cpfCnpj);
      assertEqual(devedorB.valor, 500, 'B em top_devedores = 500 (só o original, cópia negativada excluída — SEM a correção seria 1000)');

      const devedorC = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['c'].cpfCnpj);
      assertEqual(devedorC.valor, 600, 'C em top_devedores = 600 (só o original OVERDUE — a cópia DUNNING_REQUESTED nem entraria aqui de qualquer forma, "pagamentosOverdue" é só status OVERDUE)');

      const devedorE = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['e'].cpfCnpj);
      assertEqual(devedorE.valor, 600, 'E em top_devedores = 600 (300+300 — SEM sufixo negativada, as 2 contam, não é par)');
    }

    // -------------------------------------------------------------
    // TESTE 7 — evolucao-mensal: mesma dedução/inclusão, agregado no mês.
    // -------------------------------------------------------------
    console.log('\n== Teste: evolucao-mensal aplica a mesma correção ==');
    {
      const r = await get(`/inadimplencia/evolucao-mensal?${janelaAmpla}&tipo_pendencia=todos`, chaveApi);
      assertEqual(r.status, 200, 'GET evolucao-mensal -> 200');
      const totalFaturado = r.corpo.reduce((s, m) => s + m.valor_total_faturado, 0);
      const totalInadimplente = r.corpo.reduce((s, m) => s + m.valor_inadimplente, 0);
      assertEqual(Math.round(totalFaturado * 100) / 100, 5400, 'evolucao-mensal: soma de valor_total_faturado = 5400 (mesmo do /resumo)');
      assertEqual(Math.round(totalInadimplente * 100) / 100, 3600, 'evolucao-mensal: soma de valor_inadimplente = 3600 (mesmo do /resumo)');
    }

    console.log(`\n== Resultado: ${total - falhas}/${total} ==`);
    if (falhas > 0) process.exitCode = 1;
  } finally {
    app.kill('SIGKILL');
    await db.$disconnect().catch(() => {});
    execSync(`sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME};"`, { stdio: 'inherit' });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
