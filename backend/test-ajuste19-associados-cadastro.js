/**
 * Teste end-to-end do AJUSTE 19 — "Nova aba 'Associados' + Cadastro passa a
 * abastecer o registro do associado" (ver README, seção "AJUSTE 19", e o
 * brief original). Mesmo padrão das rodadas anteriores (test-ajuste14/17/18):
 * sobe Postgres real (serviço local) + servidor Express real, chamadas HTTP
 * reais via fetch, banco consultado direto no final, banco derrubado ao fim.
 *
 * Cobre:
 *   1. POST /api/cadastros persiste Associado (upsert por CPF/CNPJ) mesmo
 *      quando o webhook do n8n falha (não configurado) — a persistência
 *      local nunca depende do disparo externo.
 *   2. Upsert CREATE (associado novo, fallback nome/telefone) vs UPDATE
 *      (associado já existia por sync — nome/telefone/email legados NÃO são
 *      tocados pelo Cadastro).
 *   3. valorParcela calculado no servidor com a mesma fórmula de
 *      contratosGeracao.service.js.
 *   4. GET /api/associados/registro — listagem paginada + busca por nome,
 *      cpfCnpj e email.
 *   5. GET /api/associados/:cpfCnpj acessível por QUALQUER UMA das duas
 *      permissões (dashboard OU associados) — 403 sem nenhuma das duas.
 *   6. Permissão dedicada 'associados' em /registro, /importar,
 *      /importar/aplicar — 403 sem ela, mesmo com 'dashboard'.
 *   7. Isolamento por franquia na listagem nova.
 *   8. Conflito de franquia no upsert por CPF/CNPJ global (409) via
 *      POST /api/cadastros.
 *   9. Importação CSV em duas fases: preview (novo/conflito/erro,
 *      delimitador ";", charset Latin-1) e aplicar (criar, atualizar,
 *      pular, erro por linha), incluindo prioridade Celular > Fone.
 */
const path = require('path');
const { execSync, spawn } = require('child_process');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
// Correção pós-AJUSTE 19: "db" (abaixo) é o PrismaClient CRU, sem a
// extension de escopo por franquia (só "req.prisma"/"tx", dentro do app,
// ganham o upsert digit-aware automaticamente — ver prismaComEscopo.js).
// Como "cpf_cnpj_digits" é NOT NULL/UNIQUE no banco, todo "db.associado.create"
// direto neste arquivo de teste precisa informar o campo à mão.
const { apenasDigitos } = require('./src/lib/cpfCnpj');

const BACKEND_DIR = __dirname;
const APP_PORT = 3082;
const BASE = `http://localhost:${APP_PORT}/api`;
const DB_NAME = `gestor_ajuste19_e2e_${Date.now()}`;
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
async function postMultipart(caminho, { filename, buffer, mimetype }, bearer) {
  const form = new FormData();
  form.append('arquivo', new Blob([buffer], { type: mimetype || 'text/csv' }), filename);
  const resp = await fetch(`${BASE}${caminho}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}` },
    body: form,
  });
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
      JWT_SECRET: 'test-secret-ajuste19',
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
    const franquiaA = await db.franquia.create({ data: { nome: 'AJUSTE19 Franquia A' } });
    const franquiaB = await db.franquia.create({ data: { nome: 'AJUSTE19 Franquia B' } });

    async function criarApiKey(franquiaId, nome) {
      const chave = crypto.randomBytes(24).toString('hex');
      await db.apiKey.create({
        data: { franquiaId, nome, hash: gerarHashChave(chave), tamanho: chave.length, ultimosCaracteres: chave.slice(-6) },
      });
      return chave;
    }
    const bearerApiA = await criarApiKey(franquiaA.id, 'teste-a');
    const bearerApiB = await criarApiKey(franquiaB.id, 'teste-b');

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

    await criarUsuario({ franquiaId: franquiaA.id, nome: 'Só Dashboard', email: 'so-dashboard@a.com', senha: 'senha123', recursosPermitidos: ['dashboard'] });
    await criarUsuario({ franquiaId: franquiaA.id, nome: 'Só Associados', email: 'so-associados@a.com', senha: 'senha123', recursosPermitidos: ['associados'] });
    await criarUsuario({ franquiaId: franquiaA.id, nome: 'Nenhum', email: 'nenhum@a.com', senha: 'senha123', recursosPermitidos: [] });
    await criarUsuario({ franquiaId: franquiaB.id, nome: 'Franquia B Associados', email: 'associados@b.com', senha: 'senha123', recursosPermitidos: ['associados'] });

    const tokenSoDashboard = await login('so-dashboard@a.com', 'senha123');
    const tokenSoAssociados = await login('so-associados@a.com', 'senha123');
    const tokenNenhum = await login('nenhum@a.com', 'senha123');
    const tokenFranquiaB = await login('associados@b.com', 'senha123');

    // -------------------------------------------------------------
    // TESTE 1 — POST /api/cadastros: CREATE, webhook não configurado
    // (persistência local não pode depender do sucesso do n8n).
    // -------------------------------------------------------------
    console.log('\n== TESTE 1: POST /api/cadastros — CREATE, webhook falha, associado persiste ==');
    const payloadNovo = {
      'CNPJ/CPF': '11122233344',
      'Razão Social': 'Empresa Nova Teste LTDA',
      'Nome Fantasia': 'Nova Teste',
      'Tipo de Pessoa': 'PJ',
      CEP: '01310-100',
      Endereço: 'Av. Paulista',
      Número: '1000',
      Complemento: 'Sala 1',
      Bairro: 'Bela Vista',
      Cidade: 'São Paulo',
      UF: 'SP',
      Contato: 'João da Silva',
      Celular: '11988887777',
      'E-mail': 'joao@novateste.com',
      'Descrição do Serviço': 'Anuidade (PIX)',
      'Valor da Entrada': '200.00',
      'Data da Entrada': '2026-09-01',
      'Número de Parcelas': '3',
      'Valor Total': '1100.00',
      'Data Vencimento': '2026-10-05',
      'Desconto Parcela': '0',
      Observações: 'Cliente indicado.',
    };
    const respCad1 = await post('/cadastros', payloadNovo, bearerApiA);
    assert(respCad1.status === 201, `POST /api/cadastros retorna 201 mesmo com webhook falhando (obtido ${respCad1.status})`);
    assertEqual(respCad1.corpo?.status, 'erro', 'cadastroEnviado marcado como "erro" (webhook não configurado)');
    assert(typeof respCad1.corpo?.resposta_n8n === 'string' && respCad1.corpo.resposta_n8n.includes('não está configurada'), 'resposta_n8n explica que a URL do webhook não está configurada');

    const associadoNovo = await db.associado.findUnique({ where: { cpfCnpj: '11122233344' } });
    assert(!!associadoNovo, 'Associado foi criado no banco apesar da falha do webhook');
    assertEqual(associadoNovo.franquiaId, franquiaA.id, 'Associado novo pertence à franquia A (da api key usada)');
    assertEqual(associadoNovo.nome, 'Empresa Nova Teste LTDA', 'fallback de nome = Razão Social (CREATE)');
    assertEqual(associadoNovo.telefone, '11988887777', 'fallback de telefone = Celular (CREATE)');
    assertEqual(associadoNovo.tipoPessoa, 'PJ', 'tipoPessoa persistido');
    assertEqual(associadoNovo.razaoSocial, 'Empresa Nova Teste LTDA', 'razaoSocial persistido');
    assertEqual(associadoNovo.cidade, 'São Paulo', 'cidade persistida');
    assertEqual(associadoNovo.emailCadastro, 'joao@novateste.com', 'emailCadastro persistido');
    assertEqual(Number(associadoNovo.valorTotal), 1100, 'valorTotal persistido');
    assertEqual(Number(associadoNovo.valorEntrada), 200, 'valorEntrada persistido');
    // valorParcela = (1100 - 200) / 3 = 300.00
    assertEqual(Number(associadoNovo.valorParcela), 300, 'valorParcela calculado no servidor: (valorTotal - valorEntrada) / numeroParcelas');
    assert(associadoNovo.observacoesCadastro === 'Cliente indicado.', 'observacoesCadastro persistido');

    // -------------------------------------------------------------
    // TESTE 2 — valorParcela com 1 parcela só (não deve gravar valor de
    // parcela separado — mesma regra do preview do formulário).
    // -------------------------------------------------------------
    console.log('\n== TESTE 2: valorParcela null quando numeroParcelas <= 1 ==');
    const payloadUmaParcela = {
      ...payloadNovo,
      'CNPJ/CPF': '55566677788',
      'Número de Parcelas': '1',
      'Valor Total': '500.00',
      'Valor da Entrada': '',
    };
    await post('/cadastros', payloadUmaParcela, bearerApiA);
    const associadoUmaParcela = await db.associado.findUnique({ where: { cpfCnpj: '55566677788' } });
    assert(associadoUmaParcela?.valorParcela === null, 'valorParcela fica null com numeroParcelas = 1');
    assertEqual(Number(associadoUmaParcela.valorTotal), 500, 'valorTotal ainda persistido normalmente');
    assert(associadoUmaParcela.valorEntrada === null, '"Valor da Entrada" vazio vira null (decimalOuNull)');

    // -------------------------------------------------------------
    // TESTE 3 — UPDATE: associado já existia (simulando sync do Asaas) —
    // nome/telefone/email legados NÃO podem ser tocados pelo Cadastro.
    // -------------------------------------------------------------
    console.log('\n== TESTE 3: POST /api/cadastros — UPDATE não toca nome/telefone/email legados ==');
    const associadoPreExistente = await db.associado.create({
      data: {
        franquiaId: franquiaA.id,
        cpfCnpj: '99988877766',
        cpfCnpjDigits: apenasDigitos('99988877766'),
        nome: 'Nome Vindo Do Asaas',
        nomeAsaas: '99988877766 NOME VINDO DO ASAAS',
        telefone: '11900001111',
        email: 'asaas-original@example.com',
      },
    });
    const payloadUpdate = {
      ...payloadNovo,
      'CNPJ/CPF': '99988877766',
      'Razão Social': 'Razão Social Diferente Do Cadastro',
      Contato: 'Outro Contato',
      Celular: '11955554444',
      'E-mail': 'cadastro-novo@example.com',
    };
    await post('/cadastros', payloadUpdate, bearerApiA);
    const associadoAtualizado = await db.associado.findUnique({ where: { cpfCnpj: '99988877766' } });
    assertEqual(associadoAtualizado.nome, 'Nome Vindo Do Asaas', 'UPDATE: "nome" legado NÃO foi tocado pelo Cadastro');
    assertEqual(associadoAtualizado.telefone, '11900001111', 'UPDATE: "telefone" legado NÃO foi tocado pelo Cadastro');
    assertEqual(associadoAtualizado.email, 'asaas-original@example.com', 'UPDATE: "email" legado NÃO foi tocado pelo Cadastro');
    assertEqual(associadoAtualizado.razaoSocial, 'Razão Social Diferente Do Cadastro', 'UPDATE: razaoSocial (campo do Cadastro) foi atualizado');
    assertEqual(associadoAtualizado.celular, '11955554444', 'UPDATE: celular (campo do Cadastro) foi atualizado');
    assertEqual(associadoAtualizado.emailCadastro, 'cadastro-novo@example.com', 'UPDATE: emailCadastro (campo do Cadastro) foi atualizado, email legado intacto');
    assertEqual(associadoAtualizado.id, associadoPreExistente.id, 'UPDATE: mesmo registro (upsert, não duplicou)');

    // -------------------------------------------------------------
    // TESTE 4 — conflito de franquia: mesmo CPF/CNPJ, api key de outra
    // franquia -> 409 (erroConflitoFranquia da extension do Prisma).
    // -------------------------------------------------------------
    console.log('\n== TESTE 4: POST /api/cadastros — conflito de franquia (CPF já existe em outra) -> 409 ==');
    const respConflito = await post('/cadastros', { ...payloadNovo, 'CNPJ/CPF': '99988877766' }, bearerApiB);
    assertEqual(respConflito.status, 409, 'POST /api/cadastros com CPF de associado de OUTRA franquia retorna 409');

    // -------------------------------------------------------------
    // TESTE 5 — permissão dedicada 'associados' (não reaproveita 'dashboard').
    // -------------------------------------------------------------
    console.log("\n== TESTE 5: permissão 'associados' — /registro, /importar, /importar/aplicar ==");
    const semAssociados1 = await get('/associados/registro', tokenSoDashboard);
    assertEqual(semAssociados1.status, 403, 'usuário só com "dashboard" recebe 403 em GET /associados/registro');
    const semAssociados2 = await get('/associados/registro', tokenNenhum);
    assertEqual(semAssociados2.status, 403, 'usuário sem nenhum recurso recebe 403 em GET /associados/registro');
    const comAssociados = await get('/associados/registro', tokenSoAssociados);
    assertEqual(comAssociados.status, 200, 'usuário só com "associados" recebe 200 em GET /associados/registro');

    // -------------------------------------------------------------
    // TESTE 6 — detalhe /associados/:cpfCnpj aceita dashboard OU associados.
    // -------------------------------------------------------------
    console.log('\n== TESTE 6: GET /associados/:cpfCnpj aceita dashboard OU associados (OR) ==');
    const detalheViaDashboard = await get('/associados/11122233344', tokenSoDashboard);
    assertEqual(detalheViaDashboard.status, 200, 'usuário só com "dashboard" acessa o detalhe (200)');
    const detalheViaAssociados = await get('/associados/11122233344', tokenSoAssociados);
    assertEqual(detalheViaAssociados.status, 200, 'usuário só com "associados" acessa o detalhe (200)');
    const detalheSemNenhum = await get('/associados/11122233344', tokenNenhum);
    assertEqual(detalheSemNenhum.status, 403, 'usuário sem nenhuma das duas permissões recebe 403 no detalhe');
    assertEqual(detalheViaAssociados.corpo?.tipo_pessoa, 'PJ', 'detalhe traz os campos novos do AJUSTE 19 (tipo_pessoa)');
    assertEqual(detalheViaAssociados.corpo?.razao_social, 'Empresa Nova Teste LTDA', 'detalhe traz razao_social');

    // -------------------------------------------------------------
    // TESTE 7 — listagem /associados/registro: busca + isolamento por franquia.
    // -------------------------------------------------------------
    console.log('\n== TESTE 7: GET /associados/registro — busca e isolamento por franquia ==');
    const buscaPorNome = await get('/associados/registro?busca=Nova%20Teste', tokenSoAssociados);
    assertEqual(buscaPorNome.status, 200, 'busca por nome fantasia retorna 200');
    assert(buscaPorNome.corpo?.dados?.some((a) => a.cpf_cnpj === '11122233344'), 'busca por "Nova Teste" encontra o associado certo');

    const buscaPorCpf = await get('/associados/registro?busca=99988877766', tokenSoAssociados);
    assert(buscaPorCpf.corpo?.dados?.length === 1 && buscaPorCpf.corpo.dados[0].cpf_cnpj === '99988877766', 'busca por CPF/CNPJ exato funciona');

    const buscaPorEmail = await get('/associados/registro?busca=cadastro-novo%40example.com', tokenSoAssociados);
    assert(buscaPorEmail.corpo?.dados?.some((a) => a.cpf_cnpj === '99988877766'), 'busca por emailCadastro funciona');

    await db.associado.create({ data: { franquiaId: franquiaB.id, cpfCnpj: '10203040506', cpfCnpjDigits: apenasDigitos('10203040506'), nome: 'Associado Franquia B Isolado', telefone: '11911112222' } });
    const listaFranquiaA = await get('/associados/registro?limit=100', tokenSoAssociados);
    assert(!listaFranquiaA.corpo?.dados?.some((a) => a.cpf_cnpj === '10203040506'), 'listagem da franquia A NÃO vê associado da franquia B');
    const listaFranquiaB = await get('/associados/registro?limit=100', tokenFranquiaB);
    assert(listaFranquiaB.corpo?.dados?.some((a) => a.cpf_cnpj === '10203040506'), 'listagem da franquia B vê o próprio associado');

    // -------------------------------------------------------------
    // TESTE 8 — importação CSV: preview, delimitador ";", charset Latin-1,
    // novo / conflito / erro, prioridade Celular > Fone.
    // -------------------------------------------------------------
    console.log('\n== TESTE 8: POST /api/associados/importar — preview CSV (Bling, ";" , Latin-1) ==');
    const cabecalhoCsv = 'Nome;Fantasia;CNPJ / CPF;Endereço;Número;Complemento;Bairro;CEP;Cidade;UF;Celular;Fone;E-mail;Estado civil;Vendedor';
    const linhasCsv = [
      // Linha 1: novo associado, com acentuação (pra validar Latin-1),
      // Celular presente (Fone deve ser ignorado).
      'Comércio São José Ltda;São José;12345678000199;Rua Açaí;50;;Centro;01000-000;São Paulo;SP;11977776666;1130001000;contato@saojose.com;Casado;Fulano',
      // Linha 2: conflito — CPF/CNPJ já existe (11122233344, criado no TESTE 1).
      'Empresa Nova Teste LTDA Atualizada;Nova Teste;11122233344;Av. Paulista;1000;;Bela Vista;01310-100;São Paulo;SP;11988880000;;joao@novateste.com;;',
      // Linha 3: sem Celular, só Fone -> Fone deve preencher celular.
      'Só Fone Comercio;;22233344000155;Rua das Flores;10;;Jardim;02000-000;São Paulo;SP;;1122223333;sofone@example.com;;',
      // Linha 4: CPF/CNPJ inválido (dígitos insuficientes) -> erro.
      'Linha Invalida;;123;Rua X;1;;Bairro;03000-000;São Paulo;SP;11900000000;;invalido@example.com;;',
      // Linha 5: CPF/CNPJ ausente -> erro.
      ';;;Rua Y;2;;Bairro;04000-000;São Paulo;SP;11900000001;;semcpf@example.com;;',
      // Linha 6 — Correção pós-AJUSTE 19: CPF/CNPJ formatado DIFERENTE do que
      // já está cadastrado (99988877766, gravado sem pontuação — ver TESTE 3).
      // Precisa cair em "conflitos", nunca em "novos", mesmo com a planilha
      // vindo com pontuação (ex.: "999.888.777-66").
      'Razão Social Diferente Do Cadastro Via Planilha;Fantasia X;999.888.777-66;Rua Formatada;77;;Bairro Testado;06000-000;São Paulo;SP;11900007777;;formatado@example.com;;',
    ];
    const csvTexto = [cabecalhoCsv, ...linhasCsv].join('\r\n');
    const csvBufferLatin1 = Buffer.from(csvTexto, 'latin1');

    const preview = await postMultipart('/associados/importar', { filename: 'contatos.csv', buffer: csvBufferLatin1, mimetype: 'text/csv' }, tokenSoAssociados);
    assertEqual(preview.status, 200, 'POST /api/associados/importar (preview) retorna 200');
    assertEqual(preview.corpo?.delimitador_detectado, ';', 'delimitador detectado corretamente (";")');
    assertEqual(preview.corpo?.total_linhas, 6, 'total_linhas bate com as 6 linhas de dados do CSV');
    assertEqual(preview.corpo?.novos?.length, 2, 'preview classifica 2 linhas como "novos" (Comércio São José + Só Fone)');
    assertEqual(preview.corpo?.conflitos?.length, 2, 'preview classifica 2 linhas como "conflito" (11122233344 exato + 999.888.777-66 formatado diferente)');
    assertEqual(preview.corpo?.erros?.length, 2, 'preview classifica 2 linhas como "erro" (CPF inválido / CPF ausente)');

    const novoComercio = preview.corpo.novos.find((n) => n.cpf_cnpj === '12345678000199');
    assert(!!novoComercio, 'novo "Comércio São José" presente no preview');
    assert(novoComercio.razao_social.includes('Comércio São José'), 'acentuação preservada (charset Latin-1 decodificado corretamente)');
    assertEqual(novoComercio.celular, '11977776666', 'Celular tem prioridade sobre Fone quando ambos presentes');

    const novoSoFone = preview.corpo.novos.find((n) => n.cpf_cnpj === '22233344000155');
    assert(!!novoSoFone, 'novo "Só Fone" presente no preview');
    assertEqual(novoSoFone.celular, '1122223333', 'Fone preenche celular quando Celular está ausente na linha');

    const conflito = preview.corpo.conflitos.find((c) => c.cpf_cnpj === '11122233344');
    assert(!!conflito, 'conflito identificado pelo CPF/CNPJ certo (formato idêntico ao já cadastrado)');
    assertEqual(conflito.atual?.razao_social, 'Empresa Nova Teste LTDA', 'conflito traz o valor ATUAL (do banco) pra comparação');
    assert(conflito.razao_social?.includes('Atualizada'), 'conflito traz o valor da planilha (top-level) pra comparação com "atual"');

    // -------------------------------------------------------------
    // TESTE 8b — Correção pós-AJUSTE 19: CPF/CNPJ da planilha vem
    // FORMATADO DIFERENTE (com pontuação, "999.888.777-66") do que já está
    // cadastrado (99988877766, gravado sem pontuação, ver TESTE 3) — tem que
    // ser reconhecido como CONFLITO, nunca como associado novo, só por causa
    // da pontuação.
    // -------------------------------------------------------------
    console.log('\n== TESTE 8b: importação CSV reconhece CPF/CNPJ formatado diferente como conflito (não como novo) ==');
    const conflitoFormatoDiferente = preview.corpo.conflitos.find((c) => c.cpf_cnpj === '999.888.777-66');
    assert(!!conflitoFormatoDiferente, 'linha com CPF/CNPJ pontuado ("999.888.777-66") foi classificada em "conflitos"');
    assertEqual(
      conflitoFormatoDiferente?.atual?.razao_social,
      'Razão Social Diferente Do Cadastro',
      'conflito casou certo com o associado já existente (99988877766, sem pontuação) via cpfCnpjDigits, e traz o valor ATUAL do banco'
    );
    assert(
      !preview.corpo.novos.some((n) => n.cpf_cnpj === '999.888.777-66'),
      'linha com CPF/CNPJ pontuado NÃO foi classificada como "novo" (não criou associado duplicado só por causa da formatação)'
    );
    assert(
      !preview.corpo.erros.some((e) => e.linha === conflitoFormatoDiferente?.linha),
      'linha com CPF/CNPJ pontuado não caiu em "erros" (11 dígitos válidos, só com pontuação)'
    );

    assert(preview.corpo.erros.some((e) => e.motivo && e.motivo.toLowerCase().includes('inválid')), 'erro reportado pra CPF/CNPJ com dígitos insuficientes');
    assert(preview.corpo.erros.some((e) => e.motivo && (e.motivo.toLowerCase().includes('ausente') || e.motivo.toLowerCase().includes('obrigat'))), 'erro reportado pra linha sem CPF/CNPJ');

    console.log('\n== TESTE 9: preview é somente leitura (não altera o banco) ==');
    const totalAssociadosAntes = await db.associado.count({ where: { franquiaId: franquiaA.id } });
    assert(!(await db.associado.findUnique({ where: { cpfCnpj: '12345678000199' } })), 'preview NÃO criou o associado novo ainda (só aplicar cria)');

    console.log('\n== TESTE 10: POST /api/associados/importar/aplicar — criar, atualizar, pular ==');
    const aplicar1 = await post(
      '/associados/importar/aplicar',
      {
        novos: preview.corpo.novos,
        decisoes: [{ ...conflito, acao: 'atualizar' }],
      },
      tokenSoAssociados
    );
    assertEqual(aplicar1.status, 200, 'POST /api/associados/importar/aplicar retorna 200');
    assertEqual(aplicar1.corpo?.criados, 2, 'aplicar: 2 associados criados (os 2 "novos")');
    assertEqual(aplicar1.corpo?.atualizados, 1, 'aplicar: 1 associado atualizado (decisão "atualizar")');
    assertEqual(aplicar1.corpo?.pulados, 0, 'aplicar: 0 pulados nesta rodada');

    const totalAssociadosDepois = await db.associado.count({ where: { franquiaId: franquiaA.id } });
    assertEqual(totalAssociadosDepois, totalAssociadosAntes + 2, 'contagem de associados da franquia A aumentou exatamente em 2');

    const comercioAplicado = await db.associado.findUnique({ where: { cpfCnpj: '12345678000199' } });
    assert(!!comercioAplicado, 'associado "Comércio São José" foi criado de verdade após aplicar');
    assertEqual(comercioAplicado.franquiaId, franquiaA.id, 'associado criado pela importação pertence à franquia do usuário (A)');
    assertEqual(comercioAplicado.cidade, 'São Paulo', 'endereço mapeado corretamente na importação');

    const conflitoAplicado = await db.associado.findUnique({ where: { cpfCnpj: '11122233344' } });
    assert(conflitoAplicado.razaoSocial.includes('Atualizada'), 'conflito com decisão "atualizar" foi de fato atualizado no banco');

    console.log('\n== TESTE 11: importar/aplicar — decisão "pular" não altera o registro ==');
    const antesDoUpdate = await db.associado.findUnique({ where: { cpfCnpj: '99988877766' } });
    const previewPular = { cpf_cnpj: '99988877766', razao_social: 'Não Deveria Salvar Isso' };
    const aplicar2 = await post('/associados/importar/aplicar', { novos: [], decisoes: [{ ...previewPular, acao: 'pular' }] }, tokenSoAssociados);
    assertEqual(aplicar2.status, 200, 'aplicar com decisão "pular" retorna 200');
    assertEqual(aplicar2.corpo?.pulados, 1, 'aplicar: 1 pulado');
    const depoisDoUpdate = await db.associado.findUnique({ where: { cpfCnpj: '99988877766' } });
    assertEqual(depoisDoUpdate.razaoSocial, antesDoUpdate.razaoSocial, 'decisão "pular" não alterou o registro no banco');

    console.log('\n== TESTE 12: importação sem permissão "associados" -> 403 ==');
    const semPermissaoImportar = await postMultipart('/associados/importar', { filename: 'x.csv', buffer: Buffer.from('Nome;CNPJ / CPF\nX;11111111111'), mimetype: 'text/csv' }, tokenSoDashboard);
    assertEqual(semPermissaoImportar.status, 403, 'POST /api/associados/importar sem "associados" retorna 403');

    console.log('\n== TESTE 13: CSV sem coluna de CPF/CNPJ mapeável -> 400 ==');
    const csvSemCpf = 'Nome;Fantasia\nAlguem;Alguem Fantasia';
    const previewSemCpf = await postMultipart('/associados/importar', { filename: 'sem-cpf.csv', buffer: Buffer.from(csvSemCpf), mimetype: 'text/csv' }, tokenSoAssociados);
    assertEqual(previewSemCpf.status, 400, 'CSV sem coluna de CPF/CNPJ mapeável retorna 400');
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
