/**
 * Teste end-to-end do brief "Filtro Jurídico via cards reais + Críticos em
 * 50 dias + alerta de aproximação" (AJUSTE 17) — Postgres real (serviço
 * "postgresql" local, mesmo padrão de test-ajuste14.js/
 * test-ajuste-filtros-inadimplencia.js), servidor Express real, chamadas
 * HTTP reais via fetch.
 *
 * SEM mock do Asaas: desde o AJUSTE 14, GET /resumo lê só da tabela local
 * "pagamentos_asaas" (nunca chama a API do Asaas ao vivo), então este teste
 * escreve as linhas de pagamento DIRETO via Prisma (`db.pagamentoAsaas.create`
 * — mesmo padrão já usado em test-ajuste14.js pra simular uma linha órfã),
 * sem precisar de backfill/webhook/mock nenhum. Mais simples que os dois
 * testes anteriores por isso.
 *
 * Cobre:
 *   1. "Jurídico" (dentro de "Tipo de inadimplente") passa a casar contra
 *      cards REAIS de `cards_juridico` (por associado, em QUALQUER etapa,
 *      inclusive uma chamada "Antigos"), não mais `associados.em_juridico`
 *      — inclusive o caso de DRIFT que motivou a mudança: associado com
 *      `em_juridico=true` mas SEM card real (não deve mais contar como
 *      "juridico") e associado com `em_juridico=false` mas COM card real
 *      (deve passar a contar). "Ativo/Recuperável" continua baseado no
 *      campo `em_juridico` (fora de escopo deste ajuste, ver docblock de
 *      `aplicarFiltroTipoInadimplente`) — testado explicitamente pra provar
 *      que não mudou.
 *   2. `LIMIAR_DIAS_CRITICO` 90 -> 50: cobrança com 60 dias de atraso (que
 *      não seria "crítica" com o limiar antigo) agora entra em
 *      `tipo_inadimplente=critico` e em `valor_criticos` (nome do campo
 *      mantido, valor já reflete o novo limiar); boundary exato em 50 dias
 *      também entra (`>=`, não `>`).
 *   3. `aproximando_juridico` (novo campo) — janela [35, 49] dias de
 *      atraso: boundary inferior (35) entra, boundary logo abaixo (34) não
 *      entra, boundary logo acima (50, já "crítico") não entra. Um mesmo
 *      devedor com 2 cobranças na janela agrega valor (soma) e usa o MAIOR
 *      atraso das duas. Lista ordenada por dias de atraso decrescente.
 */
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
// Correção pós-AJUSTE 19: "db.associado.create" abaixo usa o PrismaClient
// cru (sem a extension de escopo por franquia), e "cpf_cnpj_digits" agora é
// NOT NULL/UNIQUE no banco — precisa ser informado à mão nos creates deste
// arquivo de teste (ver prismaComEscopo.js).
const { apenasDigitos } = require('./src/lib/cpfCnpj');

const BACKEND_DIR = __dirname;
const APP_PORT = 3092;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_ajuste17_e2e_${Date.now()}`;
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
      ASAAS_API_BASE_URL: 'http://localhost:1', // nunca chamado (ver docblock) — porta inválida de propósito
      JWT_SECRET: 'test-secret-ajuste17',
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

    console.log('\n== Setup: franquia + api key + etapas/cards do Jurídico + associados + pagamentos ==');
    const franquia = await db.franquia.create({ data: { nome: 'Ajuste17 E2E' } });
    const chaveApi = crypto.randomBytes(24).toString('hex');
    await db.apiKey.create({
      data: {
        franquiaId: franquia.id,
        nome: 'teste-ajuste17',
        hash: gerarHashChave(chaveApi),
        tamanho: chaveApi.length,
        ultimosCaracteres: chaveApi.slice(-6),
      },
    });

    // Duas etapas do Jurídico — "Em andamento" e "Antigos" — pra provar que
    // QUALQUER coluna conta, não só a primeira.
    const etapaEmAndamento = await db.etapaJuridico.create({
      data: { franquiaId: franquia.id, nome: 'Em andamento', ordem: 0 },
    });
    const etapaAntigos = await db.etapaJuridico.create({
      data: { franquiaId: franquia.id, nome: 'Antigos', ordem: 1 },
    });

    // ---------------------------------------------------------------
    // Associados — ver docblock do arquivo para o "porquê" de cada um.
    // ---------------------------------------------------------------
    const ASSOCIADOS = [
      { id: 'a_field_true_sem_card', cpfCnpj: '91.000.001/0001-01', nome: 'A (campo=true, sem card)', emJuridico: true },
      { id: 'b_field_false_com_card', cpfCnpj: '91.000.002/0001-02', nome: 'B (campo=false, com card em Antigos)', emJuridico: false },
      { id: 'c_field_true_com_card', cpfCnpj: '91.000.003/0001-03', nome: 'C (campo=true, com card em Em andamento)', emJuridico: true },
      { id: 'd_ativo_baseline', cpfCnpj: '91.000.004/0001-04', nome: 'D (ativo, sem card, controle)', emJuridico: false },
      { id: 'e_critico_60', cpfCnpj: '91.000.005/0001-05', nome: 'E (60 dias de atraso)', emJuridico: false },
      { id: 'f_critico_boundary_50', cpfCnpj: '91.000.006/0001-06', nome: 'F (50 dias, boundary crítico)', emJuridico: false },
      { id: 'g_aproximando_42', cpfCnpj: '91.000.007/0001-07', nome: 'G (2 cobranças, 42 e 38 dias)', emJuridico: false },
      { id: 'h_abaixo_janela_34', cpfCnpj: '91.000.008/0001-08', nome: 'H (34 dias, fora da janela)', emJuridico: false },
      { id: 'i_boundary_35', cpfCnpj: '91.000.009/0001-09', nome: 'I (35 dias, boundary aproximando)', emJuridico: false },
    ];
    const associadoPorId = {};
    for (const a of ASSOCIADOS) {
      associadoPorId[a.id] = await db.associado.create({
        data: {
          franquiaId: franquia.id,
          cpfCnpj: a.cpfCnpj,
          cpfCnpjDigits: apenasDigitos(a.cpfCnpj),
          nome: a.nome,
          telefone: '00000000000',
          emJuridico: a.emJuridico,
        },
      });
    }

    // Cards reais: B (em "Antigos") e C (em "Em andamento") — A e D-I NÃO
    // têm nenhum card, de propósito.
    await db.cardJuridico.create({
      data: { franquiaId: franquia.id, etapaId: etapaAntigos.id, ordem: 0, associadoId: associadoPorId['b_field_false_com_card'].id },
    });
    await db.cardJuridico.create({
      data: { franquiaId: franquia.id, etapaId: etapaEmAndamento.id, ordem: 0, associadoId: associadoPorId['c_field_true_com_card'].id },
    });
    // Card livre (sem associado) — não deve entrar em nenhum conjunto de
    // cpfCnpj (prova que `associadoId: null` é ignorado por
    // `buscarCpfCnpjComCardJuridico`).
    await db.cardJuridico.create({
      data: { franquiaId: franquia.id, etapaId: etapaEmAndamento.id, ordem: 1, titulo: 'Card livre, sem associado' },
    });

    // ---------------------------------------------------------------
    // Pagamentos — todos OVERDUE (snapshot "aberto hoje"), direto via
    // Prisma (sem backfill/webhook — ver docblock do arquivo).
    // ---------------------------------------------------------------
    async function criarPagamento(id, associadoId, valor, diasAtrasoAlvo) {
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
          status: 'OVERDUE',
          description: `pagamento ${id}`,
        },
      });
    }

    await criarPagamento('p_a', 'a_field_true_sem_card', 1000, 10);
    await criarPagamento('p_b', 'b_field_false_com_card', 2000, 10);
    await criarPagamento('p_c', 'c_field_true_com_card', 1500, 10);
    await criarPagamento('p_d', 'd_ativo_baseline', 500, 10);
    await criarPagamento('p_e', 'e_critico_60', 3000, 60);
    await criarPagamento('p_f', 'f_critico_boundary_50', 700, 50);
    await criarPagamento('p_g1', 'g_aproximando_42', 800, 42);
    await criarPagamento('p_g2', 'g_aproximando_42', 200, 38);
    await criarPagamento('p_h', 'h_abaixo_janela_34', 400, 34);
    await criarPagamento('p_i', 'i_boundary_35', 300, 35);

    const janelaAmpla = `venc_de=${diasAtras(365)}&venc_ate=${diasAtras(-365)}`;

    // -------------------------------------------------------------
    // TESTE 1 — "Jurídico" via cards reais (item 1 do brief).
    // -------------------------------------------------------------
    console.log('\n== Teste: tipo_inadimplente=juridico via cards reais ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=juridico`, chaveApi);
      assertEqual(r.status, 200, 'GET /resumo (tipo_inadimplente=juridico) -> 200');
      assertEqual(
        r.corpo.valor_total_faturado,
        3500,
        'juridico (cards reais): B(2000, campo=false mas COM card) + C(1500, campo=true e COM card) = 3500 — A (campo=true, SEM card) fica de fora'
      );
    }

    console.log('\n== Teste: "ativo" continua baseado no campo em_juridico (fora de escopo deste ajuste) ==');
    {
      // B tem em_juridico=false no campo (mesmo tendo card real) — "ativo"
      // não foi tocado por este ajuste, então B ainda conta como "ativo"
      // também (drift esperado e documentado: B aparece nos dois filtros
      // se marcados juntos).
      const rAtivo = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=ativo`, chaveApi);
      const somaSemAeC = 2000 /* B */ + 500 /* D */ + 3000 /* E */ + 700 /* F */ + 1000 /* G (800+200) */ + 400 /* H */ + 300 /* I */;
      assertEqual(
        rAtivo.corpo.valor_total_faturado,
        somaSemAeC,
        '"ativo" (campo em_juridico=false) inclui B — não mudou, continua ignorando a existência de card'
      );
    }

    // -------------------------------------------------------------
    // TESTE 2 — LIMIAR_DIAS_CRITICO 90 -> 50 (item 2 do brief).
    // -------------------------------------------------------------
    console.log('\n== Teste: valor_criticos (campo) e tipo_inadimplente=critico com novo limiar de 50 ==');
    {
      const rSemFiltro = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      assertEqual(
        rSemFiltro.corpo.valor_criticos,
        3700,
        'valor_criticos (limiar já em 50): E(3000, 60 dias) + F(700, 50 dias — boundary >=) = 3700 — ninguém mais no dataset chega a 50 dias'
      );

      const rCritico = await get(`/inadimplencia/resumo?${janelaAmpla}&tipo_inadimplente=critico`, chaveApi);
      assertEqual(
        rCritico.corpo.valor_total_faturado,
        3700,
        'tipo_inadimplente=critico (limiar 50): mesmos E+F = 3700 — G(42d)/I(35d) não entram (< 50), H(34d) também não'
      );
    }

    // -------------------------------------------------------------
    // TESTE 3 — aproximando_juridico, janela [35, 49] (item 3 do brief).
    // -------------------------------------------------------------
    console.log('\n== Teste: aproximando_juridico (35-49 dias) ==');
    {
      const r = await get(`/inadimplencia/resumo?${janelaAmpla}`, chaveApi);
      const lista = r.corpo.aproximando_juridico;
      assert(Array.isArray(lista), 'aproximando_juridico é um array');
      assertEqual(lista.length, 2, 'aproximando_juridico tem exatamente 2 devedores (G e I) — H(34d) e F(50d) ficam de fora');

      assertEqual(lista[0].cpf_cnpj, associadoPorId['g_aproximando_42'].cpfCnpj, 'primeiro da lista é G (42 dias, maior atraso primeiro)');
      assertEqual(lista[0].dias_atraso, 42, 'G: dias_atraso = MAIOR entre as 2 cobranças dele (42, não 38)');
      assertEqual(lista[0].valor, 1000, 'G: valor = SOMA das 2 cobranças na janela (800 + 200 = 1000)');

      assertEqual(lista[1].cpf_cnpj, associadoPorId['i_boundary_35'].cpfCnpj, 'segundo da lista é I (35 dias, boundary inferior — entra)');
      assertEqual(lista[1].dias_atraso, 35, 'I: dias_atraso = 35 (boundary inferior da janela, inclusive)');
      assertEqual(lista[1].valor, 300, 'I: valor = 300 (1 cobrança só)');

      const cpfsNaLista = lista.map((d) => d.cpf_cnpj);
      assert(!cpfsNaLista.includes(associadoPorId['h_abaixo_janela_34'].cpfCnpj), 'H (34 dias) NÃO aparece — abaixo do piso da janela (35)');
      assert(!cpfsNaLista.includes(associadoPorId['f_critico_boundary_50'].cpfCnpj), 'F (50 dias) NÃO aparece — já é "crítico", acima do teto da janela (49)');
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
