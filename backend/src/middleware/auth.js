const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { validarChave } = require('../services/apiKeys.service');

/**
 * Protege as rotas da API. Aceita dois tipos de token no header
 * "Authorization: Bearer <token>":
 *   1. Qualquer API key ativa (não revogada) cadastrada em "api_keys" (ver
 *      src/services/apiKeys.service.js — validarChave). Usada por
 *      integrações externas (ex.: n8n em POST /api/sync e POST /api/cadastros).
 *      Suporta múltiplas chaves simultâneas, cada uma revogável
 *      individualmente sem afetar as demais.
 *   2. Um JWT válido emitido por POST /api/login (usado pelo painel)
 */
module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  try {
    if (await validarChave(token)) {
      req.auth = { type: 'api_key' };
      return next();
    }
  } catch (err) {
    console.error('[auth] Erro ao validar API key:', err.message);
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    req.auth = { type: 'jwt', user: payload.sub };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Token de autenticação inválido ou expirado.' });
  }
};
