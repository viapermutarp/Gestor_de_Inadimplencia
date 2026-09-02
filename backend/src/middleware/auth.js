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
    const chaveValida = await validarChave(token);
    if (chaveValida) {
      // Multi-franquia — Fase 3: "franquiaId" vem da própria ApiKey usada
      // (ver apiKeys.service.js:validarChave) — é o que permite ao
      // middleware escopoFranquia (ver routes/*.js, sempre logo depois
      // deste) montar "req.prisma" já isolado pra franquia certa, sem
      // precisar de sessão de usuário nenhuma (sync/cadastros são
      // autenticados por API key, não por JWT).
      req.auth = { type: 'api_key', franquiaId: chaveValida.franquiaId };
      return next();
    }
  } catch (err) {
    console.error('[auth] Erro ao validar API key:', err.message);
  }

  try {
    const payload = jwt.verify(token, env.jwtSecret);
    // "jti" identifica a sessão (RefreshToken) que originou este access
    // token — ver src/services/refreshTokens.service.js. Não é checado
    // contra o banco aqui (manteria o access token stateless/rápido); a
    // revogação de uma sessão específica faz efeito no próximo refresh
    // (POST /api/refresh), não neste middleware.
    //
    // "papel"/"franquiaId": claims novos da Fase 2 (multi-franquia) — só
    // existem em tokens emitidos depois desse deploy; um access token
    // antigo (emitido antes, ainda não expirado) simplesmente não tem
    // esses campos no payload, então ficam null aqui. Nada hoje lê
    // req.auth.papel/franquiaId ainda (chega na Fase 3), então isso não
    // muda nenhum comportamento agora — só prepara o terreno.
    req.auth = {
      type: 'jwt',
      user: payload.sub,
      jti: payload.jti,
      papel: payload.papel ?? null,
      franquiaId: payload.franquiaId ?? null,
    };
    return next();
  } catch (err) {
    return res.status(401).json({ error: 'Token de autenticação inválido ou expirado.' });
  }
};
