/**
 * Teste end-to-end do AJUSTE 21 — "Editar cadastro do associado na aba
 * Associados" (ver README, seção "AJUSTE 21", e
 * src/controllers/registroAssociados.controller.js:editarCadastro). Mesmo
 * padrão das rodadas anteriores (test-ajuste19/20): sobe Postgres real
 * (serviço local) + servidor Express real, chamadas HTTP reais via fetch,
 * banco consultado direto no final, banco derrubado ao fim.
 *
 * Cobre:
 *   1. Partial update — editar só UM campo (ex.: celular) não toca nos
 *      demais campos de cadastro nem nos legados.
 *   2. Recálculo de valor_parcela — cada um dos 3 componentes
 *      (valor_total/valor_entrada/numero_parcelas) individualmente E
 *      combinados, inclusive lendo do banco o componente que não veio no
 *      body (merge com o valor atual salvo).
 *   3. valor_parcela explícito no body tem prioridade sobre o recálculo
 *      automático, inclusive null explícito (limpa o campo).
 *   4. Validação de enum (tipo_pessoa/descricao_servico inválidos -> 400) —
 *      só quando o campo vem preenchido (nada é obrigatório).
 *   5. Campos legados (nome/telefone/email/em_negociacao/bloqueado/
 *      em_juridico) NUNCA tocados.
 *   6. 404 — CPF/CNPJ inexistente e de outra franquia (isolamento).
 *   7. 403 sem permissão "associados".
 *   8. Body vazio / sem nenhum campo de cadastro reconhecido -> 400.
 */
const { execSync, spawn } = require('child_process');
const bcrypt = require('bcryptjs');
const { apenasDigitos } = require('./src/lib/cpfCnpj');

const BACKEND_DIR = __dirname;
const APP_PORT = 3084;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_ajuste21_e2e_${Date.now()}`;
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
async function patch(caminho, dados, bearer) {
  const resp = await fetch(`${BASE}${caminho}`, { method: 'PATCH', headers: headersPara(bearer), body: JSON.stringify(dados ?? {}) });
  const corpo = await resp.json().catch(() => null);
  return { status: resp.status, corpo };
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
      JWT_SECRET: 'test-secret-ajuste21',
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

    console.log('\n== Setup: franquias + usuários ==');
    const franquiaA = await db.franquia.create({ data: { nome: 'AJUSTE21 Franquia A' } });
    const franquiaB = await db.franquia.create({ data: { nome: 'AJUSTE21 Franquia B' } });

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
          bloqueado: false,
          emJuridico: false,
          tipoPessoa: 'PJ',
          razaoSocial: 'Razão Social Original',
          nomeFantasia: 'Fantasia Original',
          cep: '01000-000',
          endereco: 'Rua Original',
          numero: '100',
          bairro: 'Centro',
          cidade: 'São Paulo',
          uf: 'SP',
          contatoNome: 'Contato Original',
          celular: '11988887777',
          emailCadastro: 'cadastro@example.com',
          descricaoServico: 'Anuidade (PIX)',
          valorTotal: 1200,
          valorEntrada: 200,
          numeroParcelas: 5,
          valorParcela: 200, // (1200-200)/5
          ...extras,
        },
      });
    }

    const cpfPartial = '11122233344';
    const cpfRecalcTotal = '20202020202';
    const cpfRecalcEntrada = '30303030303';
    const cpfRecalcParcelas = '40404040404';
    const cpfRecalcCombinado = '50505050505';
    const cpfParcelaExplicita = '60606060606';
    const cpfParcelaExplicitaNull = '70707070707';
    const cpfEnum = '80808080808';
    const cpfLegado = '90909090909';
    const cpfInexistente = '99999999999';
    const cpfOutraFranquia = '22233344055';
    const cpfVazio = '10101010101';

    await criarAssociadoComCadastro(franquiaA.id, cpfPartial);
    await criarAssociadoComCadastro(franquiaA.id, cpfRecalcTotal);
    await criarAssociadoComCadastro(franquiaA.id, cpfRecalcEntrada);
    await criarAssociadoComCadastro(franquiaA.id, cpfRecalcParcelas);
    await criarAssociadoComCadastro(franquiaA.id, cpfRecalcCombinado);
    await criarAssociadoComCadastro(franquiaA.id, cpfParcelaExplicita);
    await criarAssociadoComCadastro(franquiaA.id, cpfParcelaExplicitaNull);
    await criarAssociadoComCadastro(franquiaA.id, cpfEnum);
    await criarAssociadoComCadastro(franquiaA.id, cpfLegado);
    await criarAssociadoComCadastro(franquiaB.id, cpfOutraFranquia);
    await criarAssociadoComCadastro(franquiaA.id, cpfVazio);

    // -------------------------------------------------------------
    // TESTE 1 — partial update: editar só "celular" não toca nos demais.
    // -------------------------------------------------------------
    console.log('\n== TESTE 1: PATCH .../cadastro — partial update (só celular) ==');
    const respPartial = await patch(`/associados/${cpfPartial}/cadastro`, { celular: '11999998888' }, tokenSoAssociados);
    assertEqual(respPartial.status, 200, 'PATCH partial (só celular) retorna 200');
    assertEqual(respPartial.corpo?.celular, '11999998888', 'resposta já traz o celular atualizado');
    assertEqual(respPartial.corpo?.razao_social, 'Razão Social Original', 'resposta: razao_social NÃO foi tocada');
    assertEqual(respPartial.corpo?.valor_total, '1200', 'resposta: valor_total NÃO foi tocado');

    const partialNoBanco = await db.associado.findUnique({ where: { cpfCnpj: cpfPartial } });
    assertEqual(partialNoBanco.celular, '11999998888', 'banco: celular atualizado');
    assertEqual(partialNoBanco.razaoSocial, 'Razão Social Original', 'banco: razao_social intacta');
    assertEqual(partialNoBanco.nomeFantasia, 'Fantasia Original', 'banco: nome_fantasia intacta');
    assertEqual(partialNoBanco.numeroParcelas, 5, 'banco: numero_parcelas intacto (não presente no body)');
    assert(partialNoBanco.valorParcela?.toString() === '200', 'banco: valor_parcela intacto (nenhum componente veio no body)');

    // -------------------------------------------------------------
    // TESTE 2 — recálculo de valor_parcela a partir de cada componente.
    // -------------------------------------------------------------
    console.log('\n== TESTE 2a: recálculo — só valor_total muda (entrada/parcelas vêm do banco) ==');
    const respRecalcTotal = await patch(`/associados/${cpfRecalcTotal}/cadastro`, { valor_total: 2200 }, tokenSoAssociados);
    assertEqual(respRecalcTotal.status, 200, 'PATCH (só valor_total) retorna 200');
    // (2200 - 200) / 5 = 400
    assertEqual(respRecalcTotal.corpo?.valor_parcela, '400', 'valor_parcela recalculado corretamente (valor_total mudou, entrada/parcelas lidos do banco)');

    console.log('\n== TESTE 2b: recálculo — só valor_entrada muda ==');
    const respRecalcEntrada = await patch(`/associados/${cpfRecalcEntrada}/cadastro`, { valor_entrada: 700 }, tokenSoAssociados);
    assertEqual(respRecalcEntrada.status, 200, 'PATCH (só valor_entrada) retorna 200');
    // (1200 - 700) / 5 = 100
    assertEqual(respRecalcEntrada.corpo?.valor_parcela, '100', 'valor_parcela recalculado corretamente (valor_entrada mudou)');

    console.log('\n== TESTE 2c: recálculo — só numero_parcelas muda ==');
    const respRecalcParcelas = await patch(`/associados/${cpfRecalcParcelas}/cadastro`, { numero_parcelas: 2 }, tokenSoAssociados);
    assertEqual(respRecalcParcelas.status, 200, 'PATCH (só numero_parcelas) retorna 200');
    // (1200 - 200) / 2 = 500
    assertEqual(respRecalcParcelas.corpo?.valor_parcela, '500', 'valor_parcela recalculado corretamente (numero_parcelas mudou)');
    assertEqual(respRecalcParcelas.corpo?.numero_parcelas, 2, 'numero_parcelas atualizado');

    console.log('\n== TESTE 2d: recálculo — os 3 componentes juntos, numero_parcelas=1 -> valor_parcela null ==');
    const respRecalcCombinado = await patch(
      `/associados/${cpfRecalcCombinado}/cadastro`,
      { valor_total: 900, valor_entrada: 0, numero_parcelas: 1 },
      tokenSoAssociados
    );
    assertEqual(respRecalcCombinado.status, 200, 'PATCH (3 componentes juntos) retorna 200');
    assertEqual(respRecalcCombinado.corpo?.valor_parcela, null, 'numero_parcelas=1 -> valor_parcela null (mesma regra de POST /api/cadastros)');

    // -------------------------------------------------------------
    // TESTE 3 — valor_parcela explícito tem prioridade sobre o recálculo.
    // -------------------------------------------------------------
    console.log('\n== TESTE 3a: valor_parcela explícito vence o recálculo automático ==');
    const respParcelaExplicita = await patch(
      `/associados/${cpfParcelaExplicita}/cadastro`,
      { valor_total: 5000, valor_parcela: 999.99 },
      tokenSoAssociados
    );
    assertEqual(respParcelaExplicita.status, 200, 'PATCH (valor_total + valor_parcela explícito) retorna 200');
    assertEqual(respParcelaExplicita.corpo?.valor_parcela, '999.99', 'valor_parcela explícito prevalece sobre o recálculo (não vira (5000-200)/5)');
    assertEqual(respParcelaExplicita.corpo?.valor_total, '5000', 'valor_total foi atualizado normalmente');

    console.log('\n== TESTE 3b: valor_parcela explicitamente null limpa o campo (mesmo com os 3 componentes presentes) ==');
    const respParcelaNull = await patch(
      `/associados/${cpfParcelaExplicitaNull}/cadastro`,
      { valor_total: 3000, valor_entrada: 100, numero_parcelas: 3, valor_parcela: null },
      tokenSoAssociados
    );
    assertEqual(respParcelaNull.status, 200, 'PATCH (valor_parcela: null explícito) retorna 200');
    assertEqual(respParcelaNull.corpo?.valor_parcela, null, 'valor_parcela explicitamente null NÃO foi recalculado — ficou null');

    // -------------------------------------------------------------
    // TESTE 4 — validação de enum (só quando o campo vem preenchido).
    // -------------------------------------------------------------
    console.log('\n== TESTE 4: validação de enum (tipo_pessoa/descricao_servico) ==');
    const respTipoPessoaInvalido = await patch(`/associados/${cpfEnum}/cadastro`, { tipo_pessoa: 'XX' }, tokenSoAssociados);
    assertEqual(respTipoPessoaInvalido.status, 400, 'tipo_pessoa inválido retorna 400');

    const respDescricaoInvalida = await patch(`/associados/${cpfEnum}/cadastro`, { descricao_servico: 'Serviço Qualquer' }, tokenSoAssociados);
    assertEqual(respDescricaoInvalida.status, 400, 'descricao_servico inválida retorna 400');

    const respTipoPessoaValido = await patch(`/associados/${cpfEnum}/cadastro`, { tipo_pessoa: 'PF' }, tokenSoAssociados);
    assertEqual(respTipoPessoaValido.status, 200, 'tipo_pessoa válido (PF) retorna 200');
    assertEqual(respTipoPessoaValido.corpo?.tipo_pessoa, 'PF', 'tipo_pessoa atualizado pra PF');

    const enumNoBanco = await db.associado.findUnique({ where: { cpfCnpj: cpfEnum } });
    assertEqual(enumNoBanco.descricaoServico, 'Anuidade (PIX)', 'descricao_servico continua a original (as duas tentativas de 400 não gravaram nada)');

    // -------------------------------------------------------------
    // TESTE 5 — campos legados nunca tocados.
    // -------------------------------------------------------------
    console.log('\n== TESTE 5: campos legados (nome/telefone/email/em_negociacao/bloqueado/em_juridico) nunca tocados ==');
    await patch(
      `/associados/${cpfLegado}/cadastro`,
      { razao_social: 'Nova Razão Social', celular: '11977776666' },
      tokenSoAssociados
    );
    const legadoNoBanco = await db.associado.findUnique({ where: { cpfCnpj: cpfLegado } });
    assertEqual(legadoNoBanco.nome, 'Nome Legado (sync)', 'campo legado "nome" intacto');
    assertEqual(legadoNoBanco.telefone, '11900000000', 'campo legado "telefone" intacto');
    assertEqual(legadoNoBanco.email, 'legado@example.com', 'campo legado "email" intacto');
    assertEqual(legadoNoBanco.emNegociacao, true, 'campo legado "em_negociacao" intacto');
    assertEqual(legadoNoBanco.bloqueado, false, 'campo legado "bloqueado" intacto');
    assertEqual(legadoNoBanco.emJuridico, false, 'campo legado "em_juridico" intacto');
    assertEqual(legadoNoBanco.razaoSocial, 'Nova Razão Social', 'sanity check: o campo de cadastro em si foi mesmo atualizado');

    // -------------------------------------------------------------
    // TESTE 6 — 404 (inexistente / outra franquia).
    // -------------------------------------------------------------
    console.log('\n== TESTE 6: PATCH .../cadastro — 404 (inexistente / outra franquia) ==');
    const respInexistente = await patch(`/associados/${cpfInexistente}/cadastro`, { celular: '11900000000' }, tokenSoAssociados);
    assertEqual(respInexistente.status, 404, 'CPF/CNPJ inexistente retorna 404');

    const respOutraFranquia = await patch(`/associados/${cpfOutraFranquia}/cadastro`, { celular: '11900000000' }, tokenSoAssociados);
    assertEqual(respOutraFranquia.status, 404, 'CPF/CNPJ de OUTRA franquia retorna 404 (isolamento, nunca 403/leak)');
    const outraFranquiaIntacta = await db.associado.findUnique({ where: { cpfCnpj: cpfOutraFranquia } });
    assertEqual(outraFranquiaIntacta.celular, '11988887777', 'associado de outra franquia continua intacto (nada foi alterado)');

    // -------------------------------------------------------------
    // TESTE 7 — permissão "associados" exigida (403 sem ela).
    // -------------------------------------------------------------
    console.log('\n== TESTE 7: PATCH .../cadastro sem permissão "associados" -> 403 ==');
    const respSemPermissao = await patch(`/associados/${cpfPartial}/cadastro`, { celular: '11900000000' }, tokenSoDashboard);
    assertEqual(respSemPermissao.status, 403, 'PATCH .../cadastro com só "dashboard" (sem "associados") retorna 403');

    console.log('\n== TESTE 7b: franquia B não enxerga/afeta CPF/CNPJ da franquia A ==');
    const respFranquiaBCruzada = await patch(`/associados/${cpfPartial}/cadastro`, { celular: '11900000000' }, tokenFranquiaB);
    assertEqual(respFranquiaBCruzada.status, 404, 'franquia B tentando editar CPF/CNPJ da franquia A recebe 404 (isolamento)');

    // -------------------------------------------------------------
    // TESTE 8 — body vazio / sem campo reconhecido -> 400.
    // -------------------------------------------------------------
    console.log('\n== TESTE 8: body vazio / sem campo de cadastro reconhecido -> 400 ==');
    const respBodyVazio = await patch(`/associados/${cpfVazio}/cadastro`, {}, tokenSoAssociados);
    assertEqual(respBodyVazio.status, 400, 'body vazio ({}) retorna 400');

    const respBodySemCampoReconhecido = await patch(
      `/associados/${cpfVazio}/cadastro`,
      { campo_que_nao_existe: 'valor qualquer', nome: 'Tentativa de tocar legado' },
      tokenSoAssociados
    );
    assertEqual(respBodySemCampoReconhecido.status, 400, 'body só com chaves não-reconhecidas (inclusive tentando "nome", legado) retorna 400');
    const vazioNoBanco = await db.associado.findUnique({ where: { cpfCnpj: cpfVazio } });
    assertEqual(vazioNoBanco.nome, 'Nome Legado (sync)', '"nome" legado não foi alterado pela tentativa acima (chave ignorada, nunca mapeada)');
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
