const { google } = require('googleapis');
const { Readable } = require('stream');
const { getDrivePastaRaizId } = require('./config.service');

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const MIME_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

let clienteCache = null;

/**
 * Lê a credencial da conta de serviço a partir de GOOGLE_SERVICE_ACCOUNT_JSON.
 * Aceita tanto o JSON cru (colado direto, únicas linhas escapadas com
 * \n dentro de "private_key") quanto o JSON inteiro em base64 — útil em
 * plataformas (ex.: EasyPanel) onde colar um valor multi-linha em uma
 * variável de ambiente é incômodo/arriscado. Retorna null se a variável
 * não estiver definida ou o conteúdo não for um JSON válido em nenhum dos
 * dois formatos.
 */
function carregarCredenciais() {
  const bruto = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
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
 * Cliente autenticado da Drive API v3 (conta de serviço), cacheado depois
 * da primeira chamada bem-sucedida. Retorna null (não lança) se a
 * credencial não estiver configurada ou for inválida — quem chama decide
 * como degradar (ver gerarContratosParaCadastro em
 * contratosGeracao.service.js, que pula a geração e só loga o problema).
 */
function obterClienteDrive() {
  if (clienteCache) return clienteCache;

  const credenciais = carregarCredenciais();
  if (!credenciais) return null;

  const auth = new google.auth.GoogleAuth({ credentials: credenciais, scopes: SCOPES });
  clienteCache = google.drive({ version: 'v3', auth });
  return clienteCache;
}

/** Só para testes automatizados: injeta um client fake / limpa o cache. */
function _definirClienteParaTeste(cliente) {
  clienteCache = cliente;
}

/**
 * Cria uma subpasta com o nome informado dentro da pasta raiz configurada
 * (ver GET/PATCH /api/config/drive-pasta-raiz). Lança erro se a pasta raiz
 * não estiver configurada — quem chama decide como tratar.
 */
async function criarPasta(nome, drive) {
  const pastaRaizId = await getDrivePastaRaizId();
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
  });

  return { id: resposta.data.id, url: resposta.data.webViewLink };
}

/** Sobe um buffer .docx pra dentro da pasta indicada. */
async function uploadDocx({ nome, buffer, pastaId, drive }) {
  const resposta = await drive.files.create({
    requestBody: { name: nome, parents: [pastaId] },
    media: { mimeType: MIME_DOCX, body: Readable.from(buffer) },
    fields: 'id, webViewLink',
  });

  return { id: resposta.data.id, url: resposta.data.webViewLink };
}

module.exports = {
  obterClienteDrive,
  criarPasta,
  uploadDocx,
  _definirClienteParaTeste,
};
