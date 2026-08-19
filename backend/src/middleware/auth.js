const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const env = require('../config/env');
const { getApiKey } = require('../services/config.service');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Protege as rotas da API. Aceita dois tipos de token no header
 * "Authorization: Bearer <token>":
 *   1. A API_KEY vigente (usada por integrações externas, ex.: POST /api/sync).
 *      Lida da tabela "configuracoes" no banco, com fallback para a variável
 *      de ambiente API_KEY caso a tabela ainda não tenha registro (ver
 *      src/services/config.service.js).
 *   2. Um JWT válido emitido por POST /api/login (usado pelo painel)
 */
module.exports = async function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, token] = header.split(' ');

  if (scheme !== 'Bearer' || !token) {
    return res.status(401).json({ error: 'Token de autenticação ausente ou inválido.' });
  }

  try {
    const apiKeyAtual = await getApiKey();
    if (safeEqual(token, apiKeyAtual)) {
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
