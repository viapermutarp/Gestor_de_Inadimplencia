const crypto = require('crypto');
const env = require('../config/env');
const refreshTokens = require('../services/refreshTokens.service');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

exports.login = async (req, res, next) => {
  try {
    const { usuario, senha } = req.body || {};

    if (!usuario || !senha) {
      return res.status(400).json({ error: 'Informe usuario e senha.' });
    }

    const usuarioOk = safeEqual(usuario, env.adminUser);
    const senhaOk = safeEqual(senha, env.adminPassword);

    if (!usuarioOk || !senhaOk) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    const sessao = await refreshTokens.criarSessao(usuario);

    res.json({
      token: sessao.accessToken,
      refresh_token: sessao.refreshToken,
      tipo: 'Bearer',
      expira_em: sessao.expiraEm,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/refresh — troca um refresh token válido por uma sessão nova
 * (access token + refresh token, ambos novos — rotação, ver
 * `rotacionar` em refreshTokens.service.js). Chamado pelo frontend em
 * segundo plano sempre que uma chamada autenticada leva 401 por access
 * token expirado, sem exigir que o usuário digite a senha de novo. Rota
 * pública (não passa pelo middleware de auth — o próprio refresh token É
 * a credencial aqui).
 */
exports.refresh = async (req, res, next) => {
  try {
    const { refresh_token: refreshToken } = req.body || {};

    if (!refreshToken) {
      return res.status(400).json({ error: 'Informe refresh_token.' });
    }

    const sessao = await refreshTokens.rotacionar(refreshToken);
    if (!sessao) {
      return res.status(401).json({ error: 'Sessão expirada ou revogada. Faça login novamente.' });
    }

    res.json({
      token: sessao.accessToken,
      refresh_token: sessao.refreshToken,
      tipo: 'Bearer',
      expira_em: sessao.expiraEm,
    });
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/logout — revoga a sessão (refresh token) indicada. Idempotente
 * e sempre 204, mesmo se o token já estiver revogado/expirado/inexistente
 * — o resultado desejado ("essa sessão não funciona mais") já vale nesses
 * casos também. Rota pública pelo mesmo motivo de /refresh.
 */
exports.logout = async (req, res, next) => {
  try {
    const { refresh_token: refreshToken } = req.body || {};
    if (refreshToken) {
      await refreshTokens.revogar(refreshToken);
    }
    res.status(204).end();
  } catch (err) {
    next(err);
  }
};
