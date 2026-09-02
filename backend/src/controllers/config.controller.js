const cache = require('../services/cache.service');
const {
  getWebhookCadastroUrl,
  setWebhookCadastroUrl,
  getAsaasApiKey,
  setAsaasApiKey,
  getPalavrasExcluidas,
  setPalavrasExcluidas,
  getDiasTolerancia,
  setDiasTolerancia,
  getDrivePastaRaizId,
  setDrivePastaRaizId,
  getGoogleServiceAccountJson,
  setGoogleServiceAccountJson,
} = require('../services/config.service');
const { listarChaves, criarChave, revogarChave } = require('../services/apiKeys.service');
const { resolverFranquiaIdOuPadrao } = require('../services/franquiaPadrao.service');
const { invalidarClienteCache: invalidarClienteDriveCache } = require('../services/drive.service');

const CARACTERES_VISIVEIS = 6;

/** Mascara a chave, mostrando só os últimos CARACTERES_VISIVEIS caracteres. */
function mascararChave(chave) {
  if (!chave) return null;
  if (chave.length <= CARACTERES_VISIVEIS) return '•'.repeat(chave.length);
  return '•'.repeat(chave.length - CARACTERES_VISIVEIS) + chave.slice(-CARACTERES_VISIVEIS);
}

/**
 * GET /api/config/api-keys
 * Lista todas as API keys cadastradas (ativas e revogadas), mais recentes
 * primeiro, sempre mascaradas (nunca em texto puro). Ver
 * src/services/apiKeys.service.js — inclui a importação automática da
 * antiga chave única na primeira chamada, se a lista ainda estiver vazia.
 */
exports.listarApiKeys = async (req, res, next) => {
  try {
    const chaves = await listarChaves(req.prisma);
    res.json(chaves);
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/config/api-keys
 * Body: { "nome": "n8n - Sync Cobrança" }
 * Gera uma nova API key aleatória forte com o nome/rótulo informado e
 * retorna a chave completa — única vez que ela aparece por inteiro na
 * resposta de qualquer endpoint. Não afeta as demais chaves já cadastradas.
 */
exports.criarApiKey = async (req, res, next) => {
  try {
    const { nome } = req.body || {};

    if (typeof nome !== 'string' || nome.trim() === '') {
      return res.status(400).json({ error: '"nome" é obrigatório.' });
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const nova = await criarChave(req.prisma, franquiaId, nome.trim());
    res.status(201).json({
      ...nova,
      aviso: 'Guarde esta chave agora — ela não será exibida completa novamente.',
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/config/api-keys/:id/revogar
 * Revoga individualmente a chave indicada (não deleta, só marca
 * "revogada_em") — deixa de ser aceita por src/middleware/auth.js, sem
 * afetar as demais chaves ativas. Idempotente: revogar uma chave já
 * revogada não é erro. 404 se o id não existir.
 */
exports.revogarApiKey = async (req, res, next) => {
  try {
    const { id } = req.params;
    const revogada = await revogarChave(req.prisma, id);

    if (!revogada) {
      return res.status(404).json({ error: 'Chave não encontrada.' });
    }

    res.json(revogada);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/webhook-cadastro
 * Retorna a URL vigente do webhook do n8n usada por POST /api/cadastros
 * (fluxo de Cadastro/Faturamento). `n8n_webhook_cadastro_url: null` quando
 * ainda não foi configurada.
 */
exports.obterWebhookCadastro = async (req, res, next) => {
  try {
    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const url = await getWebhookCadastroUrl(franquiaId);
    res.json({ n8n_webhook_cadastro_url: url });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/webhook-cadastro
 * Body: { "n8n_webhook_cadastro_url": "https://..." }
 * Atualiza (cria ou substitui) a URL do webhook do n8n na tabela "configuracoes".
 */
exports.atualizarWebhookCadastro = async (req, res, next) => {
  try {
    const { n8n_webhook_cadastro_url: url } = req.body || {};

    if (typeof url !== 'string' || url.trim() === '') {
      return res.status(400).json({ error: '"n8n_webhook_cadastro_url" é obrigatório.' });
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const urlSalva = await setWebhookCadastroUrl(url.trim(), franquiaId);
    res.json({ n8n_webhook_cadastro_url: urlSalva });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/asaas-key
 * Retorna a chave de API do Asaas vigente mascarada (só os últimos 6
 * caracteres visíveis) — usada pela integração de Taxa de Inadimplência
 * (ver src/services/asaas.service.js). `asaas_api_key: null` quando ainda
 * não foi configurada.
 */
exports.obterAsaasKey = async (req, res, next) => {
  try {
    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const chaveAtual = await getAsaasApiKey(franquiaId);
    res.json({ asaas_api_key: mascararChave(chaveAtual) });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/asaas-key
 * Body: { "chave": "$aact_..." }
 * Salva (cria ou substitui) a chave de API do Asaas na tabela
 * "configuracoes". Nunca ecoa o valor completo enviado de volta na
 * resposta — só a versão mascarada, mesmo tratamento de GET.
 */
exports.atualizarAsaasKey = async (req, res, next) => {
  try {
    const { chave } = req.body || {};

    if (typeof chave !== 'string' || chave.trim() === '') {
      return res.status(400).json({ error: '"chave" é obrigatório.' });
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    await setAsaasApiKey(chave.trim(), franquiaId);
    res.json({ asaas_api_key: mascararChave(chave.trim()) });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/palavras-excluidas
 * Retorna a lista atual de palavras-chave usadas para excluir
 * automaticamente cobranças do cálculo de Taxa de Inadimplência (ver
 * GET /api/inadimplencia/resumo) — array vazio quando nunca configurada.
 */
exports.obterPalavrasExcluidas = async (req, res, next) => {
  try {
    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const palavras = await getPalavrasExcluidas(franquiaId);
    res.json({ palavras });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/palavras-excluidas
 * Body: { "palavras": ["palavra1", "palavra2"] }
 * Substitui a lista inteira (não faz merge com a lista anterior). Limpa o
 * cache de /api/inadimplencia/resumo e /evolucao-mensal, para a mudança
 * valer imediatamente na próxima consulta.
 */
exports.atualizarPalavrasExcluidas = async (req, res, next) => {
  try {
    const { palavras } = req.body || {};

    if (!Array.isArray(palavras) || !palavras.every((p) => typeof p === 'string')) {
      return res.status(400).json({ error: '"palavras" deve ser um array de strings.' });
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const salvas = await setPalavrasExcluidas(palavras, franquiaId);
    cache.clear();
    res.json({ palavras: salvas });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/tolerancia-dias
 * Retorna o período de tolerância (dias corridos) vigente para a
 * classificação de inadimplência (ver GET /api/inadimplencia/resumo e
 * /evolucao-mensal) — `0` (padrão, nenhuma tolerância) quando nunca
 * configurado.
 */
exports.obterToleranciaDias = async (req, res, next) => {
  try {
    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const dias = await getDiasTolerancia(franquiaId);
    res.json({ dias });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/tolerancia-dias
 * Body: { "dias": number }
 * Valida que "dias" é um inteiro entre 0 e 30 (dias corridos), salva na
 * tabela "configuracoes" e limpa o cache de /api/inadimplencia/resumo e
 * /evolucao-mensal — a mudança vale já na próxima consulta, sem esperar o
 * TTL de 4 minutos expirar (mesmo tratamento já dado a
 * exclusões/palavras-excluidas).
 */
exports.atualizarToleranciaDias = async (req, res, next) => {
  try {
    const { dias } = req.body || {};

    if (!Number.isInteger(dias) || dias < 0 || dias > 30) {
      return res.status(400).json({ error: '"dias" deve ser um número inteiro entre 0 e 30.' });
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const salvo = await setDiasTolerancia(dias, franquiaId);
    cache.clear();
    res.json({ dias: salvo });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/drive-pasta-raiz
 * Retorna o id vigente da pasta raiz do Google Drive usada pela geração
 * automática de contratos (ver src/services/drive.service.js) —
 * `drive_pasta_raiz_id: null` quando ainda não foi configurada.
 */
exports.obterDrivePastaRaiz = async (req, res, next) => {
  try {
    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const id = await getDrivePastaRaizId(franquiaId);
    res.json({ drive_pasta_raiz_id: id });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/drive-pasta-raiz
 * Body: { "drive_pasta_raiz_id": "1a2B3c..." }
 * Atualiza (cria ou substitui) o id da pasta raiz na tabela "configuracoes".
 * Aceita tanto o id puro quanto o link completo da pasta
 * (https://drive.google.com/drive/folders/<id>), extraindo o id nesse caso.
 */
exports.atualizarDrivePastaRaiz = async (req, res, next) => {
  try {
    const { drive_pasta_raiz_id: valor } = req.body || {};

    if (typeof valor !== 'string' || valor.trim() === '') {
      return res.status(400).json({ error: '"drive_pasta_raiz_id" é obrigatório.' });
    }

    const match = valor.trim().match(/\/folders\/([a-zA-Z0-9_-]+)/);
    const id = match ? match[1] : valor.trim();

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const salvo = await setDrivePastaRaizId(id, franquiaId);
    res.json({ drive_pasta_raiz_id: salvo });
  } catch (err) {
    next(err);
  }
};

/**
 * Lê os metadados públicos (nunca a chave privada) de um JSON de conta de
 * serviço do Google — usado só pra exibir "qual credencial está
 * configurada" sem nunca ecoar o segredo de volta. Aceita tanto o JSON cru
 * quanto base64 (mesmo formato aceito por drive.service.js). Retorna null
 * se o valor não for um JSON de conta de serviço válido.
 */
function metadadosCredencialGoogle(valorBruto) {
  if (!valorBruto) return null;
  let credenciais;
  try {
    credenciais = JSON.parse(valorBruto);
  } catch {
    try {
      credenciais = JSON.parse(Buffer.from(valorBruto, 'base64').toString('utf-8'));
    } catch {
      return null;
    }
  }
  if (!credenciais || typeof credenciais !== 'object' || !credenciais.client_email) return null;
  return { client_email: credenciais.client_email, project_id: credenciais.project_id || null };
}

/**
 * GET /api/config/google-service-account
 * Multi-franquia — Passo 4, Item 1: nunca retorna a credencial completa
 * (é um segredo — mesmo tratamento dado à chave do Asaas). Retorna só se
 * está configurada e, quando está, o "client_email"/"project_id" (públicos,
 * úteis pra conferir que é a conta certa) — nunca a "private_key".
 */
exports.obterGoogleServiceAccount = async (req, res, next) => {
  try {
    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const valor = await getGoogleServiceAccountJson(franquiaId);
    const metadados = metadadosCredencialGoogle(valor);
    res.json({
      configurado: metadados !== null,
      client_email: metadados?.client_email ?? null,
      project_id: metadados?.project_id ?? null,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/config/google-service-account
 * Body: { "credencial": "{...json...}" } — aceita o JSON cru (colado
 * direto) ou o JSON inteiro em base64, mesmo formato hoje aceito pela
 * variável de ambiente GOOGLE_SERVICE_ACCOUNT_JSON (ver
 * drive.service.js:carregarCredenciais). Valida que decodifica pra um JSON
 * de conta de serviço com "client_email" antes de salvar — nunca grava lixo
 * que só ia falhar silenciosamente na próxima geração de contrato.
 */
exports.atualizarGoogleServiceAccount = async (req, res, next) => {
  try {
    const { credencial } = req.body || {};

    if (typeof credencial !== 'string' || credencial.trim() === '') {
      return res.status(400).json({ error: '"credencial" é obrigatório.' });
    }

    const metadados = metadadosCredencialGoogle(credencial.trim());
    if (!metadados) {
      return res.status(400).json({
        error:
          '"credencial" precisa ser um JSON de conta de serviço do Google válido (cru ou em base64), com "client_email".',
      });
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    await setGoogleServiceAccountJson(credencial.trim(), franquiaId);
    // Passo 4, Item 4: sem isso, a troca de credencial só valeria depois de
    // reiniciar o processo (drive.service.js cacheia o client por franquia).
    invalidarClienteDriveCache(franquiaId);

    res.json({ configurado: true, client_email: metadados.client_email, project_id: metadados.project_id });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/config/sync-log
 * Retorna as últimas 20 execuções de POST /api/sync, mais recentes primeiro.
 */
exports.syncLog = async (req, res, next) => {
  try {
    const logs = await req.prisma.syncLog.findMany({
      orderBy: { executadoEm: 'desc' },
      take: 20,
    });

    res.json(
      logs.map((log) => ({
        id: log.id,
        executado_em: log.executadoEm,
        total_associados_processados: log.totalAssociadosProcessados,
        sucesso: log.sucesso,
      }))
    );
  } catch (err) {
    next(err);
  }
};
