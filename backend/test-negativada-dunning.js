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
 * Cenário (1 franquia, 8 "associados"):
 *   A — DUNNING_REQUESTED ISOLADA (sem par): 1000, 10 dias de atraso.
 *       Cobre o gap fechado NUM SEGUNDO LOTE desta mesma correção:
 *       "pagamentosOverdue" (top_devedores/associados_inadimplentes/faixas/
 *       aproximando_juridico) filtrava só "status === 'OVERDUE'" e não via
 *       DUNNING_REQUESTED — o total subia (valor_total_aberto/
 *       valor_inadimplente) mas ninguém aparecia como responsável por ele
 *       nas listas operacionais. Ver STATUS_ATRASADOS_PARA_COBRANCA.
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
 *   G — DUNNING_REQUESTED ISOLADA, 900, 40 dias de atraso (dentro da janela
 *       [35,49] de "aproximando_juridico") — confirma que o gap fechado
 *       também vale pra essa lista, não só top_devedores.
 *   H — DUNNING_REQUESTED ISOLADA, 1100, 60 dias de atraso (>= 50,
 *       LIMIAR_DIAS_CRITICO) — confirma faixa "51_100" e "valor_criticos"
 *       agora contam uma cobrança DUNNING_REQUESTED isolada.
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

    const ASSOCIADOS = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((letra) => ({
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

    // G — DUNNING_REQUESTED isolada, 40 dias de atraso (janela aproximando_juridico).
    await criarPagamento('p_g', 'g', 900, 40, { status: 'DUNNING_REQUESTED', descricao: 'Cobrança G' });

    // H — DUNNING_REQUESTED isolada, 60 dias de atraso (>= LIMIAR_DIAS_CRITICO).
    await criarPagamento('p_h', 'h', 1100, 60, { status: 'DUNNING_REQUESTED', descricao: 'Cobrança H' });

    const janelaAmpla = `venc_de=${diasAtras(365)}&venc_ate=${diasAtras(-365)}`;

    // -------------------------------------------------------------
    // TESTE 1 — valor_total_faturado soma TUDO, cópia negativada incluída.
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_total_faturado soma todas as linhas, cópias negativadas incluídas ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      assertEqual(r.status, 200, 'GET resumo -> 200');
      // A(1000) + B(500+500) + C(600+600) + D(700+700) + E(300+300) + F(200) + G(900) + H(1100) = 7400
      assertEqual(r.corpo.valor_total_faturado, 7400, 'valor_total_faturado = 7400 (soma de TODAS as linhas, cópias negativadas incluídas)');
    }

    // -------------------------------------------------------------
    // TESTE 2 — valor_total_aberto: DUNNING_REQUESTED conta, negativada some, coincidência (E) conta as 2.
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_total_aberto (item 1 + item 2 juntos) ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      // A=1000 (DUNNING isolada) + B=500 (só original) + C=600 (só original OVERDUE;
      // cópia DUNNING_REQUESTED excluída — SEM ISSO duplicaria) + D=700 (só original;
      // cópia RECEIVED excluída) + E=600 (300+300, sem sufixo, não é par) + F=200 +
      // G=900 (DUNNING isolada) + H=1100 (DUNNING isolada)
      assertEqual(r.corpo.valor_total_aberto, 1000 + 500 + 600 + 700 + 600 + 200 + 900 + 1100, 'valor_total_aberto = 5600');
    }

    // -------------------------------------------------------------
    // TESTE 3 — valor_inadimplente (tipo_pendencia=todos, visao=aberto): mesmo conjunto (sem PENDING no cenário).
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_inadimplente inclui DUNNING_REQUESTED, exclui cópias negativadas ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_pendencia=todos`, chaveApi);
      assertEqual(r.corpo.valor_inadimplente, 5600, 'valor_inadimplente(todos) = 5600, igual a valor_total_aberto neste cenário (sem PENDING)');
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
      // vencidas = só OVERDUE, deduplicado: B(500)+C(600)+D(700)+E(600)+F(200) = 2600 — SEM A/G/H (DUNNING_REQUESTED)
      assertEqual(rVencidas.corpo.valor_inadimplente, 2600, 'tipo_pendencia=vencidas: valor_inadimplente = 2600 (sem A/G/H, que são DUNNING_REQUESTED)');

      const rConfirmadas = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_pendencia=confirmadas`, chaveApi);
      assertEqual(rConfirmadas.corpo.valor_inadimplente, 0, 'tipo_pendencia=confirmadas: valor_inadimplente = 0 (nenhum CONFIRMED no cenário)');
    }

    // -------------------------------------------------------------
    // TESTE 6 — top_devedores / associados_inadimplentes / faixas / valor_criticos / aproximando_juridico:
    // GAP FECHADO — "pagamentosOverdue" agora reconhece DUNNING_REQUESTED (STATUS_ATRASADOS_PARA_COBRANCA),
    // então A/G/H (antes invisíveis aqui, só contavam no total) agora aparecem.
    // -------------------------------------------------------------
    console.log('\n== Teste: gap fechado — DUNNING_REQUESTED isolada aparece em top_devedores/associados_inadimplentes/faixas/críticos/aproximando ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);

      const cpfsTop = r.corpo.top_devedores.map((d) => d.cpf_cnpj);
      assert(cpfsTop.includes(associadoPorId['a'].cpfCnpj), 'A (só DUNNING_REQUESTED, 10d) AGORA aparece em top_devedores — gap fechado');
      assertEqual(r.corpo.associados_inadimplentes, 8, 'associados_inadimplentes = 8 (A,B,C,D,E,F,G,H — todos, gap fechado)');

      const devedorA = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['a'].cpfCnpj);
      assertEqual(devedorA.valor, 1000, 'A em top_devedores = 1000');

      const devedorB = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['b'].cpfCnpj);
      assertEqual(devedorB.valor, 500, 'B em top_devedores = 500 (só o original, cópia negativada excluída — SEM a correção seria 1000)');

      const devedorC = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['c'].cpfCnpj);
      assertEqual(devedorC.valor, 600, 'C em top_devedores = 600 (só o original OVERDUE — a cópia DUNNING_REQUESTED excluída como negativada)');

      const devedorE = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['e'].cpfCnpj);
      assertEqual(devedorE.valor, 600, 'E em top_devedores = 600 (300+300 — SEM sufixo negativada, as 2 contam, não é par)');

      const devedorG = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['g'].cpfCnpj);
      assertEqual(devedorG.valor, 900, 'G (DUNNING_REQUESTED, 40d) AGORA aparece em top_devedores = 900 — gap fechado');

      const devedorH = r.corpo.top_devedores.find((d) => d.cpf_cnpj === associadoPorId['h'].cpfCnpj);
      assertEqual(devedorH.valor, 1100, 'H (DUNNING_REQUESTED, 60d) AGORA aparece em top_devedores = 1100 — gap fechado');

      // faixas (visao=aberto): A/B/C/D/E/F caem todos em "1_20" (10-12 dias);
      // G (40d) em "31_40"; H (60d) em "51_100".
      assertEqual(r.corpo.faixas['1_20'], 1000 + 500 + 600 + 700 + 600 + 200, 'faixas.1_20 = 3600 (A+B+C+D+E+F, todos 10-12 dias)');
      assertEqual(r.corpo.faixas['31_40'], 900, 'faixas.31_40 = 900 (G, DUNNING_REQUESTED, 40 dias) — AGORA conta, gap fechado');
      assertEqual(r.corpo.faixas['51_100'], 1100, 'faixas.51_100 = 1100 (H, DUNNING_REQUESTED, 60 dias) — AGORA conta, gap fechado');

      // valor_criticos (>= 50 dias): só H (60d) qualifica.
      assertEqual(r.corpo.valor_criticos, 1100, 'valor_criticos = 1100 (H, DUNNING_REQUESTED, 60 dias >= 50) — AGORA conta, gap fechado');

      // aproximando_juridico (janela 35-49 dias): só G (40d) qualifica — H (60d) já é "crítico", fora da janela.
      assertEqual(r.corpo.aproximando_juridico.length, 1, 'aproximando_juridico tem 1 devedor (G)');
      assertEqual(r.corpo.aproximando_juridico[0].cpf_cnpj, associadoPorId['g'].cpfCnpj, 'aproximando_juridico[0] = G (DUNNING_REQUESTED, 40 dias) — AGORA aparece, gap fechado');
      assertEqual(r.corpo.aproximando_juridico[0].valor, 900, 'aproximando_juridico[0].valor = 900');
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
      assertEqual(Math.round(totalFaturado * 100) / 100, 7400, 'evolucao-mensal: soma de valor_total_faturado = 7400 (mesmo do /resumo)');
      assertEqual(Math.round(totalInadimplente * 100) / 100, 5600, 'evolucao-mensal: soma de valor_inadimplente = 5600 (mesmo do /resumo)');
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
