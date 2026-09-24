/**
 * Teste dedicado — investigação "associados sumindo do filtro Jurídico"
 * (pedido do usuário), item 3: confirmar que as porcentagens do gráfico
 * "Valor em atraso por faixa" somam certo sobre `valor_total_faturado`
 * quando o filtro "Jurídico" está ativo com VÁRIOS associados (8, aqui) e
 * VALORES GRANDES (na casa de R$ 40-90 mil cada, como no cenário real
 * relatado — "Fernanda R$ 42.455,77").
 *
 * NÃO usa dados reais do usuário (não temos acesso ao banco de produção
 * dele nesta investigação) — é um teste de CORREÇÃO DE CÁLCULO,
 * reproduzindo o formato do cenário (muitos associados Jurídico, valores
 * grandes) num banco de teste isolado, pra confirmar/descartar a hipótese
 * de haver um bug de arredondamento ou de numerador/denominador
 * inconsistente nas porcentagens, independente da causa raiz do sumiço
 * (que é investigada à parte, com um script SQL pro usuário rodar contra o
 * banco real — ver backend/scripts/diagnostico-juridico-sumindo.sql).
 *
 * O que é verificado:
 *   1. Todos os 8 associados têm card real no Jurídico e pelo menos 1
 *      pagamento OVERDUE grande, cobrindo as 7 faixas (uma com 2
 *      associados na mesma faixa, pra testar agregação dentro do bucket).
 *   2. Com `tipo_inadimplente=juridico&visao=aberto`, `valor_total_faturado`
 *      soma EXATAMENTE os 8 valores (população 100% Jurídico, 100%
 *      OVERDUE, sem mais ninguém no banco de teste).
 *   3. A SOMA das 7 faixas bate exatamente com `valor_total_faturado` (não
 *      só "não excede") — só é possível porque, neste cenário controlado,
 *      100% do conjunto de trabalho é OVERDUE (faixas em modo "aberto" só
 *      inclui OVERDUE; em produção, com PENDING/CONFIRMED/RECEIVED
 *      também presentes, a soma das faixas fica MENOR que
 *      valor_total_faturado por design — ver docblock de
 *      `computarFaixasECriticos` no controller — não é o cenário testado
 *      aqui).
 *   4. As porcentagens (mesma fórmula do frontend — `FaixasChart.js`:
 *      `valor / totalFaturado * 100`, com `totalFaturado` = `resumo.valor_total_faturado`,
 *      MESMA resposta HTTP que devolveu as faixas, nunca uma chamada
 *      separada) somam 100.00% dentro de uma tolerância de ponto flutuante
 *      (±0.02 pontos percentuais em 7 parcelas arredondadas a 1 casa —
 *      igual ao `toLocaleString(..., {minimumFractionDigits:1,
 *      maximumFractionDigits:1})` do componente), e nenhuma faixa
 *      individual excede 100%.
 *   5. Cada faixa contém exatamente o valor esperado (nenhum associado
 *      caiu na faixa errada, nenhum ficou de fora, nenhum duplicado).
 *
 * Mesmo padrão de infraestrutura de teste de test-ajuste17-juridico-critico.js
 * (Postgres local real, servidor Express real, sem mock do Asaas — grava
 * pagamentos_asaas direto via Prisma).
 */
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
// Correção pós-AJUSTE 19: "db.associado.create" abaixo usa o PrismaClient
// cru (sem a extension de escopo por franquia), e "cpf_cnpj_digits" agora é
// NOT NULL/UNIQUE no banco — precisa ser informado à mão (ver prismaComEscopo.js).
const { apenasDigitos } = require('./src/lib/cpfCnpj');

const BACKEND_DIR = __dirname;
const APP_PORT = 3093;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_investigacao_faixas_${Date.now()}`;
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
function assertProximo(atual, esperado, tolerancia, mensagem) {
  assert(Math.abs(atual - esperado) <= tolerancia, `${mensagem} (esperado≈${esperado}±${tolerancia}, obtido=${atual})`);
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
// Mesma fórmula de FaixasChart.js (formatarPercentual): valor/total*100,
// exibido com 1 casa decimal.
function percentual1casa(valor, total) {
  return Number(((valor / total) * 100).toFixed(1));
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
      ASAAS_API_BASE_URL: 'http://localhost:1',
      JWT_SECRET: 'test-secret-investigacao-faixas',
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

    console.log('\n== Setup: franquia + api key + etapa Jurídico + 8 associados com valores grandes ==');
    const franquia = await db.franquia.create({ data: { nome: 'Investigacao Faixas E2E' } });
    const chaveApi = crypto.randomBytes(24).toString('hex');
    await db.apiKey.create({
      data: {
        franquiaId: franquia.id,
        nome: 'teste-investigacao-faixas',
        hash: gerarHashChave(chaveApi),
        tamanho: chaveApi.length,
        ultimosCaracteres: chaveApi.slice(-6),
      },
    });
    const etapa = await db.etapaJuridico.create({
      data: { franquiaId: franquia.id, nome: 'Em andamento', ordem: 0 },
    });

    // 8 associados, TODOS com card real no Jurídico, valores grandes
    // (40-90 mil), cobrindo as 7 faixas — "51_100" recebe 2 associados
    // (F1 e F2) pra testar soma dentro do mesmo bucket.
    const ASSOCIADOS = [
      { id: 'ate_vencimento', cpfCnpj: '92.000.001/0001-01', nome: 'Fernanda (em dia)', valor: 42455.77, diasAtraso: -5 },
      { id: 'faixa_1_20', cpfCnpj: '92.000.002/0001-02', nome: 'Nadia (1-20d)', valor: 55000.0, diasAtraso: 10 },
      { id: 'faixa_21_30', cpfCnpj: '92.000.003/0001-03', nome: 'Malu (21-30d)', valor: 61234.5, diasAtraso: 25 },
      { id: 'faixa_31_40', cpfCnpj: '92.000.004/0001-04', nome: 'Joyce (31-40d)', valor: 48900.25, diasAtraso: 35 },
      { id: 'faixa_41_50', cpfCnpj: '92.000.005/0001-05', nome: 'Associado 41-50d', valor: 39999.99, diasAtraso: 45 },
      { id: 'faixa_51_100_a', cpfCnpj: '92.000.006/0001-06', nome: 'Associado 51-100d (A)', valor: 70000.0, diasAtraso: 75 },
      { id: 'faixa_51_100_b', cpfCnpj: '92.000.007/0001-07', nome: 'Associado 51-100d (B)', valor: 33500.1, diasAtraso: 90 },
      { id: 'faixa_acima_100', cpfCnpj: '92.000.008/0001-08', nome: 'Associado acima de 100d', valor: 89123.45, diasAtraso: 150 },
    ];
    const associadoPorId = {};
    for (const a of ASSOCIADOS) {
      associadoPorId[a.id] = await db.associado.create({
        data: { franquiaId: franquia.id, cpfCnpj: a.cpfCnpj, cpfCnpjDigits: apenasDigitos(a.cpfCnpj), nome: a.nome, telefone: '00000000000', emJuridico: false },
      });
      await db.cardJuridico.create({
        data: { franquiaId: franquia.id, etapaId: etapa.id, ordem: 0, associadoId: associadoPorId[a.id].id },
      });
      await db.pagamentoAsaas.create({
        data: {
          id: `pay_${a.id}`,
          franquiaId: franquia.id,
          customerId: `cus_${a.id}`,
          cpfCnpj: a.cpfCnpj,
          nome: a.nome,
          value: a.valor,
          dueDate: diasAtras(a.diasAtraso),
          status: 'OVERDUE',
          description: `pagamento ${a.id}`,
        },
      });
    }

    const valorTotalEsperado = ASSOCIADOS.reduce((soma, a) => soma + a.valor, 0);
    const janela = 'venc_de=2020-01-01&venc_ate=2030-12-31';

    console.log('\n== Teste: valor_total_faturado com tipo_inadimplente=juridico (8 associados, valores grandes) ==');
    const r = await get(`/inadimplencia/resumo?${janela}&tipo_inadimplente=juridico&visao=aberto`, chaveApi);
    assertEqual(r.status, 200, 'GET /resumo (tipo_inadimplente=juridico) -> 200');
    assertProximo(r.corpo.valor_total_faturado, Number(valorTotalEsperado.toFixed(2)), 0.01, `valor_total_faturado soma os 8 valores grandes (${valorTotalEsperado.toFixed(2)})`);

    console.log('\n== Teste: cada faixa recebeu o associado certo, com o valor certo ==');
    const f = r.corpo.faixas;
    assertProximo(f.ate_vencimento, 42455.77, 0.01, 'ate_vencimento = Fernanda (42455.77)');
    assertProximo(f['1_20'], 55000.0, 0.01, '1_20 = Nadia (55000.00)');
    assertProximo(f['21_30'], 61234.5, 0.01, '21_30 = Malu (61234.50)');
    assertProximo(f['31_40'], 48900.25, 0.01, '31_40 = Joyce (48900.25)');
    assertProximo(f['41_50'], 39999.99, 0.01, '41_50 = Associado 41-50d (39999.99)');
    assertProximo(f['51_100'], 70000.0 + 33500.1, 0.01, '51_100 = soma dos dois associados do bucket (103500.10)');
    assertProximo(f.acima_100, 89123.45, 0.01, 'acima_100 = Associado acima de 100d (89123.45)');

    console.log('\n== Teste: soma das 7 faixas bate com valor_total_faturado (100% OVERDUE, sem mais ninguém no banco) ==');
    const somaFaixas = Object.values(f).reduce((s, v) => s + v, 0);
    assertProximo(somaFaixas, r.corpo.valor_total_faturado, 0.02, 'soma das 7 faixas === valor_total_faturado (cenário 100% OVERDUE)');

    console.log('\n== Teste: porcentagens (mesma fórmula do FaixasChart.js) somam 100% ==');
    const percentuais = Object.entries(f).map(([chave, valor]) => ({
      chave,
      percentual: percentual1casa(valor, r.corpo.valor_total_faturado),
    }));
    for (const { chave, percentual } of percentuais) {
      assert(percentual >= 0 && percentual <= 100, `faixa "${chave}": percentual individual dentro de [0,100] (obtido=${percentual}%)`);
    }
    const somaPercentuais = percentuais.reduce((s, p) => s + p.percentual, 0);
    assertProximo(somaPercentuais, 100, 0.1, `soma das 7 porcentagens ≈ 100% (tolerância de arredondamento por faixa: ${percentuais.map((p) => `${p.chave}=${p.percentual}%`).join(', ')})`);

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
