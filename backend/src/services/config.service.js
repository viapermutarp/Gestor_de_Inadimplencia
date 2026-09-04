const prisma = require('../config/prisma');
const env = require('../config/env');

const CHAVE_API_KEY = 'api_key';
const CHAVE_WEBHOOK_CADASTRO_URL = 'n8n_webhook_cadastro_url';
const CHAVE_ASAAS_API_KEY = 'asaas_api_key';

/**
 * Leitura/escrita genérica de uma chave da tabela "configuracoes" — usada
 * por qualquer configuração persistida em runtime que não precise de um
 * fallback especial (diferente de `getApiKey`, que cai para a variável de
 * ambiente `API_KEY` quando a tabela ainda não tem registro).
 *
 * Multi-franquia — Passo 4: "franquiaId" é sempre exigido explicitamente
 * (nunca resolvido silenciosamente aqui dentro) — quem chama é responsável
 * por resolvê-lo a partir de "req.franquiaId" (ou, no caso do SUPER_ADMIN
 * sem seletor de franquia ainda, via `resolverFranquiaIdOuPadrao(req)` em
 * franquiaPadrao.service.js — ver comentário lá). "configuracoes" tem chave
 * primária composta (chave, franquia_id) desde a Fase 1 — cada franquia tem
 * sua própria linha por chave. O seletor único correto pro Prisma é o nome
 * do campo composto gerado a partir da ordem do `@@id` no schema:
 * `chave_franquiaId`.
 */
async function getConfigValor(chave, franquiaId) {
  try {
    const registro = await prisma.configuracao.findUnique({
      where: { chave_franquiaId: { chave, franquiaId } },
    });
    return registro?.valor ?? null;
  } catch (err) {
    console.error(`[config] Falha ao ler "${chave}" da tabela configuracoes:`, err.message);
    return null;
  }
}

async function setConfigValor(chave, valor, franquiaId) {
  await prisma.configuracao.upsert({
    where: { chave_franquiaId: { chave, franquiaId } },
    update: { valor },
    create: { chave, franquiaId, valor },
  });
  return valor;
}

/**
 * Lê a antiga API_KEY única (legada). Prioridade: tabela "configuracoes"
 * no banco. Fallback: variável de ambiente API_KEY. Usada hoje só como
 * semente da migração automática para a tabela "api_keys" (múltiplas
 * chaves nomeadas e revogáveis individualmente — ver
 * src/services/apiKeys.service.js e src/middleware/auth.js, que não usam
 * mais esta função diretamente para autenticar requisições).
 */
async function getApiKey(franquiaId) {
  try {
    const registro = await prisma.configuracao.findUnique({
      where: { chave_franquiaId: { chave: CHAVE_API_KEY, franquiaId } },
    });
    if (registro?.valor) return registro.valor;
  } catch (err) {
    console.error('[config] Falha ao ler api_key da tabela configuracoes, usando fallback do .env:', err.message);
  }
  return env.apiKey;
}

/** Persiste uma nova API_KEY na tabela "configuracoes" (cria ou substitui o registro). */
async function setApiKey(novaChave, franquiaId) {
  await prisma.configuracao.upsert({
    where: { chave_franquiaId: { chave: CHAVE_API_KEY, franquiaId } },
    update: { valor: novaChave },
    create: { chave: CHAVE_API_KEY, franquiaId, valor: novaChave },
  });
  return novaChave;
}

/**
 * URL do webhook do n8n que recebe os cadastros enviados via POST /api/cadastros
 * (fluxo de Cadastro/Faturamento que substitui o gatilho do Kommo). Sem
 * fallback de variável de ambiente — se não estiver configurada, o envio ao
 * n8n falha de forma tratada (ver src/controllers/cadastros.controller.js),
 * mas o cadastro em si continua sendo salvo normalmente.
 */
async function getWebhookCadastroUrl(franquiaId) {
  return getConfigValor(CHAVE_WEBHOOK_CADASTRO_URL, franquiaId);
}

async function setWebhookCadastroUrl(url, franquiaId) {
  return setConfigValor(CHAVE_WEBHOOK_CADASTRO_URL, url, franquiaId);
}

/**
 * Chave de API da conta Asaas, usada pelo serviço de integração
 * (src/services/asaas.service.js) para consultar pagamentos na tela de
 * "Taxa de Inadimplência". Tratada como sensível: nunca é retornada por
 * inteiro em nenhum endpoint de leitura, só mascarada (ver
 * `mascararChave` em src/controllers/config.controller.js) — mesmo
 * tratamento já dado à API_KEY interna do painel.
 */
async function getAsaasApiKey(franquiaId) {
  return getConfigValor(CHAVE_ASAAS_API_KEY, franquiaId);
}

async function setAsaasApiKey(chave, franquiaId) {
  return setConfigValor(CHAVE_ASAAS_API_KEY, chave, franquiaId);
}

const CHAVE_PALAVRAS_EXCLUIDAS = 'inadimplencia_palavras_excluidas';

/**
 * Lista de palavras-chave usadas para excluir automaticamente cobranças do
 * cálculo de Taxa de Inadimplência (ver GET /api/inadimplencia/resumo):
 * qualquer pagamento do Asaas cuja descrição, CPF/CNPJ (com ou sem
 * formatação) ou nome/razão social do associado contenha (case-insensitive,
 * substring) uma dessas palavras é ignorado no cálculo (AJUSTE 7 — antes,
 * só a descrição) — independente da lista manual por ID (ver model
 * CobrancaIgnorada). Ver `separarExcluidos` em inadimplencia.controller.js
 * para o critério de match completo. Persistida na tabela "configuracoes"
 * como um array JSON serializado em string (a coluna "valor" é texto
 * puro), por isso o parse/stringify aqui.
 */
async function getPalavrasExcluidas(franquiaId) {
  const valor = await getConfigValor(CHAVE_PALAVRAS_EXCLUIDAS, franquiaId);
  if (!valor) return [];
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista) ? lista : [];
  } catch (err) {
    console.error('[config] Valor inválido para "inadimplencia_palavras_excluidas", ignorando:', err.message);
    return [];
  }
}

async function setPalavrasExcluidas(palavras, franquiaId) {
  await setConfigValor(CHAVE_PALAVRAS_EXCLUIDAS, JSON.stringify(palavras), franquiaId);
  return palavras;
}

const CHAVE_DIAS_TOLERANCIA = 'inadimplencia_dias_tolerancia';

/**
 * Período de tolerância (dias corridos) usado na classificação de
 * inadimplência (ver src/controllers/inadimplencia.controller.js) — absorve
 * atrasos operacionais irrelevantes (ex.: float bancário de fim de semana)
 * sem contá-los como inadimplência real. Padrão `0` (nenhuma tolerância,
 * comportamento idêntico ao que existia antes desta configuração) quando a
 * tabela ainda não tem registro, ou se o valor salvo não for um inteiro
 * válido por algum motivo (defesa extra, não deveria acontecer já que
 * `setDiasTolerancia`/o controller validam antes de salvar).
 */
async function getDiasTolerancia(franquiaId) {
  const valor = await getConfigValor(CHAVE_DIAS_TOLERANCIA, franquiaId);
  const dias = Number.parseInt(valor, 10);
  return Number.isInteger(dias) && dias >= 0 ? dias : 0;
}

async function setDiasTolerancia(dias, franquiaId) {
  await setConfigValor(CHAVE_DIAS_TOLERANCIA, String(dias), franquiaId);
  return dias;
}

const CHAVE_DRIVE_PASTA_RAIZ_ID = 'drive_pasta_raiz_id';

/**
 * Id da pasta raiz no Google Drive dentro da qual as subpastas por
 * Cadastro (nomeadas pelo campo "Nome da pasta") são criadas — ver
 * src/services/drive.service.js e a geração automática de contratos em
 * src/services/contratosGeracao.service.js. Sem fallback de variável de
 * ambiente: se não estiver configurada, a geração de contratos é pulada
 * de forma tratada (não derruba o envio do Cadastro em si).
 */
async function getDrivePastaRaizId(franquiaId) {
  return getConfigValor(CHAVE_DRIVE_PASTA_RAIZ_ID, franquiaId);
}

async function setDrivePastaRaizId(id, franquiaId) {
  return setConfigValor(CHAVE_DRIVE_PASTA_RAIZ_ID, id, franquiaId);
}

const CHAVE_GOOGLE_SERVICE_ACCOUNT_JSON = 'google_service_account_json';

/**
 * Multi-franquia — Passo 4, Item 1: credencial da conta de serviço do
 * Google (antes só `GOOGLE_SERVICE_ACCOUNT_JSON` no ambiente do processo,
 * global e única) — passa a ser mais uma chave em "configuracoes", por
 * franquia. Aceita o mesmo formato de sempre (JSON cru ou base64) — quem
 * decodifica/valida é `drive.service.js` (mantém a mesma lógica de
 * `carregarCredenciais`, só trocando a origem do texto bruto). Sem
 * fallback pra variável de ambiente aqui dentro (diferente de `getApiKey`):
 * a migração automática do valor do ambiente pra dentro desta chave
 * acontece uma única vez, no boot (ver `googleServiceAccount.migracao.js`),
 * não a cada leitura.
 */
async function getGoogleServiceAccountJson(franquiaId) {
  return getConfigValor(CHAVE_GOOGLE_SERVICE_ACCOUNT_JSON, franquiaId);
}

async function setGoogleServiceAccountJson(jsonOuBase64, franquiaId) {
  return setConfigValor(CHAVE_GOOGLE_SERVICE_ACCOUNT_JSON, jsonOuBase64, franquiaId);
}

/**
 * Multi-franquia — Passo 4, Item 1: se `GOOGLE_SERVICE_ACCOUNT_JSON` estiver
 * setada no ambiente do processo (comportamento pré-Passo 4) e a franquia
 * padrão ainda não tiver essa configuração salva em "configuracoes", copia o
 * valor automaticamente — zero passo manual pra quem já está configurado
 * hoje. Idempotente: só copia se a chave ainda estiver vazia (nunca
 * sobrescreve um valor já salvo, seja ele vindo desta mesma migração numa
 * subida anterior, seja porque o usuário já editou pela tela de
 * Configurações). A variável de ambiente pode continuar setada sem
 * problema — só serve de semente aqui, quem lê pra valer a partir de agora é
 * `drive.service.js` via `getGoogleServiceAccountJson` (Passo 4, Item 4).
 * Chamada no boot do servidor (ver server.js), mesmo padrão de
 * `seedSuperAdminSeNecessario` — não trava a subida se falhar.
 */
async function migrarGoogleServiceAccountJsonSeNecessario() {
  const valorAmbiente = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!valorAmbiente || !valorAmbiente.trim()) return;

  // Import tardio pra evitar qualquer risco de dependência circular entre
  // os dois módulos (franquiaPadrao.service.js não importa config.service.js
  // hoje, mas mantém a garantia mesmo se isso mudar no futuro).
  const { obterFranquiaIdPadrao } = require('./franquiaPadrao.service');

  let franquiaId;
  try {
    franquiaId = await obterFranquiaIdPadrao();
  } catch (err) {
    console.error('[config] Falha ao resolver franquia padrão pra migrar GOOGLE_SERVICE_ACCOUNT_JSON:', err.message);
    return;
  }

  const jaConfigurado = await getGoogleServiceAccountJson(franquiaId);
  if (jaConfigurado) return;

  await setGoogleServiceAccountJson(valorAmbiente.trim(), franquiaId);
  console.log(
    '[config] GOOGLE_SERVICE_ACCOUNT_JSON do ambiente migrada automaticamente para "configuracoes" (franquia padrão).'
  );
}

module.exports = {
  getApiKey,
  setApiKey,
  CHAVE_API_KEY,
  getConfigValor,
  setConfigValor,
  getWebhookCadastroUrl,
  setWebhookCadastroUrl,
  CHAVE_WEBHOOK_CADASTRO_URL,
  getAsaasApiKey,
  setAsaasApiKey,
  CHAVE_ASAAS_API_KEY,
  getPalavrasExcluidas,
  setPalavrasExcluidas,
  CHAVE_PALAVRAS_EXCLUIDAS,
  getDiasTolerancia,
  setDiasTolerancia,
  CHAVE_DIAS_TOLERANCIA,
  getDrivePastaRaizId,
  setDrivePastaRaizId,
  CHAVE_DRIVE_PASTA_RAIZ_ID,
  getGoogleServiceAccountJson,
  setGoogleServiceAccountJson,
  CHAVE_GOOGLE_SERVICE_ACCOUNT_JSON,
  migrarGoogleServiceAccountJsonSeNecessario,
};
