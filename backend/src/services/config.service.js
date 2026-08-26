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
 */
async function getConfigValor(chave) {
  try {
    const registro = await prisma.configuracao.findUnique({ where: { chave } });
    return registro?.valor ?? null;
  } catch (err) {
    console.error(`[config] Falha ao ler "${chave}" da tabela configuracoes:`, err.message);
    return null;
  }
}

async function setConfigValor(chave, valor) {
  await prisma.configuracao.upsert({
    where: { chave },
    update: { valor },
    create: { chave, valor },
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
async function getApiKey() {
  try {
    const registro = await prisma.configuracao.findUnique({ where: { chave: CHAVE_API_KEY } });
    if (registro?.valor) return registro.valor;
  } catch (err) {
    console.error('[config] Falha ao ler api_key da tabela configuracoes, usando fallback do .env:', err.message);
  }
  return env.apiKey;
}

/** Persiste uma nova API_KEY na tabela "configuracoes" (cria ou substitui o registro). */
async function setApiKey(novaChave) {
  await prisma.configuracao.upsert({
    where: { chave: CHAVE_API_KEY },
    update: { valor: novaChave },
    create: { chave: CHAVE_API_KEY, valor: novaChave },
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
async function getWebhookCadastroUrl() {
  return getConfigValor(CHAVE_WEBHOOK_CADASTRO_URL);
}

async function setWebhookCadastroUrl(url) {
  return setConfigValor(CHAVE_WEBHOOK_CADASTRO_URL, url);
}

/**
 * Chave de API da conta Asaas, usada pelo serviço de integração
 * (src/services/asaas.service.js) para consultar pagamentos na tela de
 * "Taxa de Inadimplência". Tratada como sensível: nunca é retornada por
 * inteiro em nenhum endpoint de leitura, só mascarada (ver
 * `mascararChave` em src/controllers/config.controller.js) — mesmo
 * tratamento já dado à API_KEY interna do painel.
 */
async function getAsaasApiKey() {
  return getConfigValor(CHAVE_ASAAS_API_KEY);
}

async function setAsaasApiKey(chave) {
  return setConfigValor(CHAVE_ASAAS_API_KEY, chave);
}

const CHAVE_PALAVRAS_EXCLUIDAS = 'inadimplencia_palavras_excluidas';

/**
 * Lista de palavras-chave usadas para excluir automaticamente cobranças do
 * cálculo de Taxa de Inadimplência (ver GET /api/inadimplencia/resumo):
 * qualquer pagamento do Asaas cuja descrição contenha (case-insensitive,
 * substring) uma dessas palavras é ignorado no cálculo — independente da
 * lista manual por ID (ver model CobrancaIgnorada). Persistida na tabela
 * "configuracoes" como um array JSON serializado em string (a coluna
 * "valor" é texto puro), por isso o parse/stringify aqui.
 */
async function getPalavrasExcluidas() {
  const valor = await getConfigValor(CHAVE_PALAVRAS_EXCLUIDAS);
  if (!valor) return [];
  try {
    const lista = JSON.parse(valor);
    return Array.isArray(lista) ? lista : [];
  } catch (err) {
    console.error('[config] Valor inválido para "inadimplencia_palavras_excluidas", ignorando:', err.message);
    return [];
  }
}

async function setPalavrasExcluidas(palavras) {
  await setConfigValor(CHAVE_PALAVRAS_EXCLUIDAS, JSON.stringify(palavras));
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
async function getDiasTolerancia() {
  const valor = await getConfigValor(CHAVE_DIAS_TOLERANCIA);
  const dias = Number.parseInt(valor, 10);
  return Number.isInteger(dias) && dias >= 0 ? dias : 0;
}

async function setDiasTolerancia(dias) {
  await setConfigValor(CHAVE_DIAS_TOLERANCIA, String(dias));
  return dias;
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
};
