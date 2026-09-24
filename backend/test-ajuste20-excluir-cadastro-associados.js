/**
 * Teste end-to-end do AJUSTE 20 — "Excluir cadastro (individual e em massa)
 * na aba Associados" (ver README, seção "AJUSTE 20", e
 * src/controllers/registroAssociados.controller.js). Mesmo padrão das
 * rodadas anteriores (test-ajuste19-associados-cadastro.js e irmãos): sobe
 * Postgres real (serviço local) + servidor Express real, chamadas HTTP
 * reais via fetch, banco consultado direto no final, banco derrubado ao fim.
 *
 * Cobre:
 *   1. GET /api/associados/registro só lista associado que TEM cadastro
 *      (pelo menos um dos 22 campos do AJUSTE 19 preenchido) — associado
 *      só-sync (nunca passou por Cadastro/importação) NÃO aparece.
 *   2. DELETE /api/associados/:cpf_cnpj/cadastro — limpa só os 22 campos de
 *      cadastro, nunca os legados (nome/telefone/email/em_negociacao/
 *      bloqueado/em_juridico); associado continua existindo (aparece em
 *      GET /api/associados, o Dashboard) mas some de GET /associados/registro.
 *   3. Permissão "associados" exigida (403 sem ela, mesmo com "dashboard").
 *   4. 404 pra CPF/CNPJ inexistente OU de outra franquia (isolamento).
 *   5. POST /api/associados/cadastro/excluir-lote — mistura de: já tem
 *      cadastro (excluído), já sem cadastro (idempotente, ainda conta como
 *      excluído), inexistente e de outra franquia (ambos em
 *      "nao_encontrados", sem derrubar o resto do lote). 400 com lista
 *      vazia/inválida.
 *   6. Busca (`?busca=`) continua funcionando em conjunto (AND, não OR) com
 *      o filtro novo de "tem cadastro".
 */
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
// Ver mesmo comentário em test-ajuste19-associados-cadastro.js — "db" abaixo
// é o PrismaClient cru (sem a extension de escopo por franquia), e
// "cpf_cnpj_digits" é NOT NULL/UNIQUE no banco — precisa ser informado à mão
// em todo "db.associado.create" deste arquivo.
const { apenasDigitos } = require('./src/lib/cpfCnpj');

const BACKEND_DIR = __dirname;
const APP_PORT = 3083;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_ajuste20_e2e_${Date.now()}`;
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
async function get(caminho, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { headers: headersPara(bearer) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
async function post(caminho, dados, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'POST', headers: headersPara(bearer), body: JSON.stringify(dados ?? {}) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
async function del(caminho, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'DELETE', headers: headersPara(bearer) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
}
function gerarHashChave(chave) {
  return crypto.createHash('sha256').update(String(chave), 'utf8').digest('hex');
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
      JWT_SECRET: 'test-secret-ajuste20',
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

    console.log('\n== Setup: franquias + api keys + usuários ==');
    const franquiaA = await db.franquia.create({ data: { nome: 'AJUSTE20 Franquia A' } });
    const franquiaB = await db.franquia.create({ data: { nome: 'AJUSTE20 Franquia B' } });

    async function criarUsuario({ franquiaId, nome, email, senha, recursosPermitidos }) {
      const senhaHash = await bcrypt.hash(senha, 4); // custo baixo só pra teste rodar rápido
      return db.usuario.create({
        data: { nome, email, senhaHash, papel: 'FRANQUIA', franquiaId, ativo: true, recursosPermitidos },
      });
    }
    async function login(email, senha) {
      const resp = await post('/login', { usuario: email, senha });
      assert(resp.status === 200, `login "${email}" retorna 200 (obtido ${resp.status}: ${JSON.stringify(resp.corpo)})`);
      return resp.corpo?.token;
    }

    await criarUsuario({ franquiaId: franquiaA.id, nome: 'Só Associados', email: 'so-associados@a.com', senha: 'senha123', recursosPermitidos: ['associados'] });
    await criarUsuario({ franquiaId: franquiaA.id, nome: 'Só Dashboard', email: 'so-dashboard@a.com', senha: 'senha123', recursosPermitidos: ['dashboard'] });
    await criarUsuario({ franquiaId: franquiaB.id, nome: 'Franquia B Associados', email: 'associados@b.com', senha: 'senha123', recursosPermitidos: ['associados'] });

    const tokenSoAssociados = await login('so-associados@a.com', 'senha123');
    const tokenSoDashboard = await login('so-dashboard@a.com', 'senha123');
    const tokenFranquiaB = await login('associados@b.com', 'senha123');

    // -------------------------------------------------------------
    // Fixtures: associado COM cadastro (o alvo principal dos testes de
    // exclusão) + associado SÓ-SYNC (nunca passou por Cadastro/importação —
    // todos os 22 campos do AJUSTE 19 null) + associado de OUTRA franquia
    // (isolamento).
    // -------------------------------------------------------------
    async function criarAssociadoComCadastro(franquiaId, cpfCnpj, extras = {}) {
      return db.associado.create({
        data: {
          franquiaId,
          cpfCnpj,
          cpfCnpjDigits: apenasDigitos(cpfCnpj),
          nome: 'Nome Legado (sync)',
          telefone: '11900000000',
          email: 'legado@example.com',
          emNegociacao: true,
          razaoSocial: 'Razão Social Do Cadastro',
          nomeFantasia: 'Fantasia',
          cep: '01000-000',
          endereco: 'Rua Teste',
          numero: '100',
          bairro: 'Centro',
          cidade: 'São Paulo',
          uf: 'SP',
          contatoNome: 'Contato Teste',
          celular: '11988887777',
          emailCadastro: 'cadastro@example.com',
          descricaoServico: 'Anuidade',
          valorTotal: 1000,
          numeroParcelas: 2,
          ...extras,
        },
      });
    }
    async function criarAssociadoSoSync(franquiaId, cpfCnpj) {
      return db.associado.create({
        data: {
          franquiaId,
          cpfCnpj,
          cpfCnpjDigits: apenasDigitos(cpfCnpj),
          nome: 'Associado Só Sync',
          telefone: '11911112222',
        },
      });
    }

    const cpfAlvo = '11122233344';
    const cpfSoSync = '55566677788';
    const cpfInexistente = '99999999999';
    const cpfOutraFranquia = '22233344055';
    const cpfLote1 = '10101010101'; // com cadastro
    const cpfLote2 = '20202020202'; // já sem cadastro (idempotência)

    await criarAssociadoComCadastro(franquiaA.id, cpfAlvo);
    await criarAssociadoSoSync(franquiaA.id, cpfSoSync);
    await criarAssociadoSoSync(franquiaB.id, cpfOutraFranquia); // "sem cadastro" de propósito — só usado pro teste de isolamento
    await criarAssociadoComCadastro(franquiaA.id, cpfLote1);
    await criarAssociadoSoSync(franquiaA.id, cpfLote2); // já "sem cadastro" — vai entrar no lote mesmo assim

    // -------------------------------------------------------------
    // TESTE 1 — GET /associados/registro só lista quem TEM cadastro.
    // -------------------------------------------------------------
    console.log('\n== TESTE 1: GET /associados/registro filtra por "tem cadastro" ==');
    const listaAntes = await get('/associados/registro?limit=100', tokenSoAssociados);
    assertEqual(listaAntes.status, 200, 'GET /associados/registro retorna 200');
    assert(listaAntes.corpo?.dados?.some((a) => a.cpf_cnpj === cpfAlvo), 'associado COM cadastro aparece na listagem');
    assert(listaAntes.corpo?.dados?.some((a) => a.cpf_cnpj === cpfLote1), 'associado do lote (com cadastro) aparece na listagem');
    assert(!listaAntes.corpo?.dados?.some((a) => a.cpf_cnpj === cpfSoSync), 'associado SÓ-SYNC (nunca passou por Cadastro) NÃO aparece na listagem');
    assert(!listaAntes.corpo?.dados?.some((a) => a.cpf_cnpj === cpfLote2), 'associado já-sem-cadastro NÃO aparece na listagem');

    const buscaSoSync = await get(`/associados/registro?busca=${cpfSoSync}`, tokenSoAssociados);
    assertEqual(buscaSoSync.corpo?.dados?.length, 0, 'busca por CPF/CNPJ do associado só-sync não retorna nada (AND com "tem cadastro", não OR)');

    // Confirma que o associado só-sync CONTINUA existindo pro Dashboard
    // (GET /api/associados, filtro diferente, não filtra por cadastro) —
    // usa "em_negociacao=false" (valor real do fixture) pra não cair no
    // filtro "exigirCobrancaAberta" da aba "Todos" (associado de teste não
    // tem nenhuma cobrança criada, então some de "/associados" sem filtro
    // nenhum — comportamento correto e NÃO relacionado ao AJUSTE 20, ver
    // associados.controller.js:construirCondicoesFiltro).
    const dashboardSoSync = await get('/associados?limit=100&em_negociacao=false', tokenSoDashboard);
    assert(dashboardSoSync.corpo?.dados?.some((a) => a.cpf_cnpj === cpfSoSync), 'associado só-sync CONTINUA aparecendo no Dashboard (GET /api/associados)');

    // -------------------------------------------------------------
    // TESTE 2 — DELETE /associados/:cpfCnpj/cadastro (individual).
    // -------------------------------------------------------------
    console.log('\n== TESTE 2: DELETE /associados/:cpfCnpj/cadastro — individual ==');
    const antesExcluir = await db.associado.findUnique({ where: { cpfCnpj: cpfAlvo } });
    assert(antesExcluir.razaoSocial === 'Razão Social Do Cadastro', 'sanity check: associado alvo tem cadastro antes de excluir');

    const respExcluir = await del(`/associados/${cpfAlvo}/cadastro`, tokenSoAssociados);
    assertEqual(respExcluir.status, 200, 'DELETE /associados/:cpfCnpj/cadastro retorna 200');
    assertEqual(respExcluir.corpo?.cadastro_excluido, true, 'resposta confirma cadastro_excluido: true');

    const depoisExcluir = await db.associado.findUnique({ where: { cpfCnpj: cpfAlvo } });
    assert(!!depoisExcluir, 'associado CONTINUA existindo no banco depois de excluir o cadastro');
    for (const campo of [
      'tipoPessoa', 'razaoSocial', 'nomeFantasia', 'cep', 'endereco', 'numero', 'complemento', 'bairro',
      'cidade', 'uf', 'contatoNome', 'celular', 'emailCadastro', 'descricaoServico', 'valorEntrada',
      'dataEntrada', 'numeroParcelas', 'valorParcela', 'valorTotal', 'dataVencimento', 'descontoParcela',
      'observacoesCadastro',
    ]) {
      assert(depoisExcluir[campo] === null, `campo de cadastro "${campo}" foi limpo (null)`);
    }
    assertEqual(depoisExcluir.nome, 'Nome Legado (sync)', 'campo legado "nome" NÃO foi tocado');
    assertEqual(depoisExcluir.telefone, '11900000000', 'campo legado "telefone" NÃO foi tocado');
    assertEqual(depoisExcluir.email, 'legado@example.com', 'campo legado "email" NÃO foi tocado');
    assertEqual(depoisExcluir.emNegociacao, true, 'campo legado "em_negociacao" NÃO foi tocado');

    const listaDepoisExcluir = await get('/associados/registro?limit=100', tokenSoAssociados);
    assert(!listaDepoisExcluir.corpo?.dados?.some((a) => a.cpf_cnpj === cpfAlvo), 'associado some de GET /associados/registro depois de excluir o cadastro');

    // "em_negociacao=true" (valor real do fixture, nunca tocado por
    // "excluir cadastro") pelo mesmo motivo do comentário acima.
    const dashboardDepoisExcluir = await get('/associados?limit=100&em_negociacao=true', tokenSoDashboard);
    assert(dashboardDepoisExcluir.corpo?.dados?.some((a) => a.cpf_cnpj === cpfAlvo), 'associado CONTINUA aparecendo no Dashboard (GET /api/associados) depois de excluir o cadastro');

    // -------------------------------------------------------------
    // TESTE 3 — permissão "associados" exigida (403 sem ela).
    // -------------------------------------------------------------
    console.log('\n== TESTE 3: DELETE .../cadastro sem permissão "associados" -> 403 ==');
    const respSemPermissao = await del(`/associados/${cpfSoSync}/cadastro`, tokenSoDashboard);
    assertEqual(respSemPermissao.status, 403, 'DELETE .../cadastro com só "dashboard" (sem "associados") retorna 403');

    // -------------------------------------------------------------
    // TESTE 4 — 404 pra CPF/CNPJ inexistente OU de outra franquia.
    // -------------------------------------------------------------
    console.log('\n== TESTE 4: DELETE .../cadastro — 404 (inexistente / outra franquia) ==');
    const respInexistente = await del(`/associados/${cpfInexistente}/cadastro`, tokenSoAssociados);
    assertEqual(respInexistente.status, 404, 'DELETE .../cadastro com CPF/CNPJ inexistente retorna 404');

    const respOutraFranquia = await del(`/associados/${cpfOutraFranquia}/cadastro`, tokenSoAssociados);
    assertEqual(respOutraFranquia.status, 404, 'DELETE .../cadastro com CPF/CNPJ de OUTRA franquia retorna 404 (isolamento, nunca 403/leak)');
    const outraFranquiaIntacta = await db.associado.findUnique({ where: { cpfCnpj: cpfOutraFranquia } });
    assertEqual(outraFranquiaIntacta.franquiaId, franquiaB.id, 'associado de outra franquia continua intacto (nada foi alterado)');

    // -------------------------------------------------------------
    // TESTE 5 — POST /associados/cadastro/excluir-lote.
    // -------------------------------------------------------------
    console.log('\n== TESTE 5: POST /associados/cadastro/excluir-lote — mistura de casos ==');
    const respLote = await post(
      '/associados/cadastro/excluir-lote',
      { cpf_cnpjs: [cpfLote1, cpfLote2, cpfInexistente, cpfOutraFranquia] },
      tokenSoAssociados
    );
    assertEqual(respLote.status, 200, 'POST .../excluir-lote retorna 200');
    assertEqual(respLote.corpo?.total_solicitados, 4, 'total_solicitados bate com os 4 CPF/CNPJ enviados');
    assertEqual(respLote.corpo?.excluidos, 2, 'excluidos = 2 (cpfLote1 com cadastro + cpfLote2 já sem cadastro, idempotente)');
    assertEqual(
      [...(respLote.corpo?.nao_encontrados || [])].sort(),
      [cpfInexistente, cpfOutraFranquia].sort(),
      'nao_encontrados = inexistente + de outra franquia (nenhum dos dois derrubou o lote)'
    );

    const lote1Depois = await db.associado.findUnique({ where: { cpfCnpj: cpfLote1 } });
    assert(lote1Depois.razaoSocial === null, 'cpfLote1: cadastro de fato limpo no banco');
    const lote2Depois = await db.associado.findUnique({ where: { cpfCnpj: cpfLote2 } });
    assert(lote2Depois.razaoSocial === null && lote2Depois.nome === 'Associado Só Sync', 'cpfLote2: continuava sem cadastro (idempotente), nada quebrou');

    console.log('\n== TESTE 6: POST /associados/cadastro/excluir-lote — sem permissão -> 403 ==');
    const respLoteSemPermissao = await post('/associados/cadastro/excluir-lote', { cpf_cnpjs: [cpfSoSync] }, tokenSoDashboard);
    assertEqual(respLoteSemPermissao.status, 403, 'POST .../excluir-lote com só "dashboard" retorna 403');

    console.log('\n== TESTE 7: POST /associados/cadastro/excluir-lote — lista vazia/inválida -> 400 ==');
    const respLoteVazio = await post('/associados/cadastro/excluir-lote', { cpf_cnpjs: [] }, tokenSoAssociados);
    assertEqual(respLoteVazio.status, 400, '"cpf_cnpjs" vazio retorna 400');
    const respLoteSemCampo = await post('/associados/cadastro/excluir-lote', {}, tokenSoAssociados);
    assertEqual(respLoteSemCampo.status, 400, '"cpf_cnpjs" ausente retorna 400');
    const respLoteTipoErrado = await post('/associados/cadastro/excluir-lote', { cpf_cnpjs: 'não é array' }, tokenSoAssociados);
    assertEqual(respLoteTipoErrado.status, 400, '"cpf_cnpjs" não-array retorna 400');

    console.log('\n== TESTE 8: excluir-lote de franquia B não enxerga/afeta CPF/CNPJ da franquia A ==');
    const respLoteFranquiaB = await post('/associados/cadastro/excluir-lote', { cpf_cnpjs: [cpfSoSync] }, tokenFranquiaB);
    assertEqual(respLoteFranquiaB.status, 200, 'excluir-lote (franquia B) retorna 200');
    assertEqual(respLoteFranquiaB.corpo?.excluidos, 0, 'franquia B: 0 excluídos (CPF/CNPJ é da franquia A)');
    assertEqual(respLoteFranquiaB.corpo?.nao_encontrados, [cpfSoSync], 'franquia B: CPF/CNPJ da franquia A cai em nao_encontrados (isolamento)');
  } finally {
    console.log('\n== Encerrando servidor e limpando banco de teste ==');
    app.kill('SIGTERM');
    await sleep(500);
    await db.$disconnect();
    try {
      execSync(`sudo -u postgres psql -c "DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);"`, { stdio: 'inherit' });
    } catch (err) {
      console.error('Falha ao derrubar banco de teste:', err.message);
    }
  }

  console.log(`\n== Resultado: ${total - falhas}/${total} passaram ==`);
  if (falhas > 0) {
    console.error(`${falhas} teste(s) falharam.`);
    process.exit(1);
  }
  console.log('Todos os testes passaram.');
}

main().catch((err) => {
  console.error('Erro fatal no teste:', err);
  process.exit(1);
});
