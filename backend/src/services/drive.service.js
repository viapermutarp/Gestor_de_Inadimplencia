const { google } = require('googleapis');
const { Readable } = require('stream');
const { getDrivePastaRaizId, getGoogleServiceAccountJson } = require('./config.service');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// Multi-franquia — Passo 4, Item 4: um cliente Drive cacheado POR franquia
// (era um único `clienteCache` de módulo, global pra todo o processo — só
// funcionava porque só existia 1 franquia/1 credencial até aqui). Invalidado
// explicitamente por `invalidarClienteCache(franquiaId)` sempre que a
// credencial dessa franquia for salva de novo (ver config.controller.js:
// atualizarGoogleServiceAccount) — sem isso, trocar a credencial pela tela
// só valeria depois de reiniciar o processo.
const clienteCachePorFranquia = new Map();

/**
 * Interpreta uma credencial de conta de serviço do Google, cru (JSON direto)
 * ou em base64 — útil em plataformas (ex.: EasyPanel) onde colar um valor
 * multi-linha é incômodo/arriscado. Retorna null se `bruto` for vazio ou não
 * for um JSON válido em nenhum dos dois formatos. Mesma lógica usada pra
 * validar antes de salvar em config.controller.js:atualizarGoogleServiceAccount
 * (duplicada intencionalmente ali — aquele lado só precisa dos metadados
 * públicos pra exibir, nunca do objeto de credencial completo).
 */
function carregarCredenciais(bruto) {
  if (!bruto || !bruto.trim()) return null;

  try {
    return JSON.parse(bruto);
  } catch {
    try {
      return JSON.parse(Buffer.from(bruto, 'base64').toString('utf-8'));
    } catch {
      return null;
    }
  }
}

/**
 * Cliente autenticado da Drive API v3 (conta de serviço) da franquia
 * informada, cacheado em memória depois da primeira resolução bem-sucedida
 * (por franquia — ver `clienteCachePorFranquia`). Retorna null (não lança)
 * se a franquia não tiver credencial configurada ou o valor salvo for
 * inválido — quem chama decide como degradar (ver gerarContratosParaCadastro
 * em contratosGeracao.service.js, que pula a geração e só loga o problema).
 *
 * Multi-franquia — Passo 4, Item 4: a credencial vem de "configuracoes"
 * (chave "google_service_account_json", por franquia — ver
 * config.service.js), não mais da variável de ambiente
 * GOOGLE_SERVICE_ACCOUNT_JSON — essa variável só serve de semente pra
 * migração automática no boot (ver migrarGoogleServiceAccountJsonSeNecessario
 * em config.service.js), lida uma única vez, nunca mais depois disso.
 */
async function obterClienteDrive(franquiaId) {
  if (!franquiaId) return null;
  if (clienteCachePorFranquia.has(franquiaId)) return clienteCachePorFranquia.get(franquiaId);

  const bruto = await getGoogleServiceAccountJson(franquiaId);
  const credenciais = carregarCredenciais(bruto);
  if (!credenciais) return null;

  const auth = new google.auth.GoogleAuth({ credentials: credenciais, scopes: SCOPES });
  const cliente = google.drive({ version: 'v3', auth });
  clienteCachePorFranquia.set(franquiaId, cliente);
  return cliente;
}

/**
 * Limpa o cliente cacheado de uma franquia (ou de todas, se "franquiaId" não
 * for informado) — chamado depois que uma nova credencial é salva pela tela
 * de Configurações, pra a mudança valer já na próxima geração de contrato,
 * sem esperar reiniciar o processo.
 */
function invalidarClienteCache(franquiaId) {
  if (franquiaId) clienteCachePorFranquia.delete(franquiaId);
  else clienteCachePorFranquia.clear();
}

/** Só para testes automatizados: injeta um client fake pra uma franquia (ou limpa, se cliente for null/undefined). */
function _definirClienteParaTeste(cliente, franquiaId) {
  if (cliente == null) invalidarClienteCache(franquiaId);
  else clienteCachePorFranquia.set(franquiaId, cliente);
}

/**
 * Cria uma subpasta com o nome informado dentro da pasta raiz configurada
 * (ver GET/PATCH /api/config/drive-pasta-raiz). Lança erro se a pasta raiz
 * não estiver configurada — quem chama decide como tratar.
 *
 * Multi-franquia — Passo 4: "franquiaId" agora é obrigatório aqui porque
 * `getDrivePastaRaizId` (config.service.js) não tem mais fallback interno
 * pra franquia (Item 1) — cada franquia tem sua própria pasta raiz. Quem
 * chama (contratosGeracao.service.js) já tem o `franquiaId` do próprio
 * cadastro disponível em memória.
 */
async function criarPasta(nome, drive, franquiaId) {
  const pastaRaizId = await getDrivePastaRaizId(franquiaId);
  if (!pastaRaizId) {
    throw new Error('Pasta raiz do Drive (drive_pasta_raiz_id) não está configurada.');
  }

  const resposta = await drive.files.create({
    requestBody: {
      name: nome,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [pastaRaizId],
    },
    fields: 'id, webViewLink',
    // Necessário sempre que a pasta raiz (ou qualquer coisa dentro dela)
    // vive num Drive Compartilhado (Shared Drive) — sem isso a API trata
    // esse conteúdo como inexistente e o create falha com "File not
    // found" no id do parent, mesmo com a pasta corretamente compartilhada
    // com a conta de serviço. Não tem efeito quando o conteúdo é do "Meu
    // Drive" normal, então é seguro deixar sempre ligado.
    supportsAllDrives: true,
  });

  return { id: resposta.data.id, url: resposta.data.webViewLink };
}

/** Sobe um buffer .docx pra dentro da pasta indicada. */
async function uploadDocx({ nome, buffer, pastaId, drive }) {
  const resposta = await drive.files.create({
    requestBody: { name: nome, parents: [pastaId] },
    media: { mimeType: MIME_DOCX, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
    // Ver comentário em criarPasta — mesma necessidade aqui, já que o
    // upload também tem um "parents" que pode estar num Drive Compartilhado.
    supportsAllDrives: true,
  });

  return { id: resposta.data.id, url: resposta.data.webViewLink };
}

module.exports = {
  obterClienteDrive,
  criarPasta,
  uploadDocx,
  invalidarClienteCache,
  _definirClienteParaTeste,
};
