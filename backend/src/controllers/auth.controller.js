const crypto = require('crypto');
const env = require('../config/env');
const prisma = require('../config/prisma');
const refreshTokens = require('../services/refreshTokens.service');
const usuariosService = require('../services/usuarios.service');

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * POST /api/login (Fase 2, Passo 2 — ver docs/plano-multi-franquia.md,
 * seção 2). Login passa a ser resolvido contra a tabela `usuarios`
 * (bcrypt), não mais uma comparação direta contra ADMIN_USER/
 * ADMIN_PASSWORD — com duas camadas de compatibilidade pra não quebrar o
 * hábito de quem já loga hoje:
 *
 * 1. Busca por email exato. Cobre qualquer Usuario com email de verdade
 *    (o caso normal, daqui pra frente).
 * 2. Se não achar E a entrada digitada for exatamente ADMIN_USER, tenta
 *    de novo pelo email padrão derivado na semeadura (`emailAdminPadrao`,
 *    ex.: "admin" -> "admin@local") — sem isso, o operador que sempre
 *    digitou "admin" precisaria aprender a digitar "admin@local" do nada.
 * 3. Break-glass: se NADA foi encontrado E a tabela `usuarios` está vazia
 *    (cenário anômalo — o boot do servidor já semeia o SUPER_ADMIN, ver
 *    `seedSuperAdminSeNecessario` — mas cobre o caso de alguém truncar a
 *    tabela sem querer) E a entrada bate com ADMIN_USER/ADMIN_PASSWORD,
 *    semeia o SUPER_ADMIN na hora e segue o login normalmente com ele.
 *
 * Em qualquer um dos 3 casos, a senha digitada ainda passa pela checagem
 * bcrypt normal (`verificarSenha`) antes de emitir sessão — o break-glass
 * só decide *quem* tentar autenticar, nunca pula a checagem de senha.
 */
exports.login = async (req, res, next) => {
  try {
    const { usuario: entrada, senha } = req.body || {};

    if (!entrada || !senha) {
      return res.status(400).json({ error: 'Informe usuario e senha.' });
    }

    let usuarioEncontrado = await usuariosService.buscarPorEmail(entrada);

    if (!usuarioEncontrado && safeEqual(entrada, env.adminUser)) {
      usuarioEncontrado = await usuariosService.buscarPorEmail(usuariosService.emailAdminPadrao());
    }

    if (!usuarioEncontrado) {
      const tabelaVazia = (await prisma.usuario.count()) === 0;
      if (tabelaVazia && safeEqual(entrada, env.adminUser) && safeEqual(senha, env.adminPassword)) {
        usuarioEncontrado =
          (await usuariosService.seedSuperAdminSeNecessario()) ||
          (await usuariosService.buscarPorEmail(usuariosService.emailAdminPadrao()));
      }
    }

    if (!usuarioEncontrado) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    const senhaOk = await usuariosService.verificarSenha(usuarioEncontrado, senha);
    if (!senhaOk) {
      return res.status(401).json({ error: 'Usuário ou senha inválidos.' });
    }

    if (!usuarioEncontrado.ativo) {
      return res.status(401).json({ error: 'Usuário desativado. Fale com o administrador.' });
    }
    if (usuarioEncontrado.franquia && !usuarioEncontrado.franquia.ativo) {
      return res.status(401).json({ error: 'Franquia desativada. Fale com o administrador.' });
    }

    const sessao = await refreshTokens.criarSessao(usuarioEncontrado);

    // Best-effort — não bloqueia a resposta do login (mesmo padrão do
    // "ultimo_uso_em" de API key em apiKeys.service.js).
    usuariosService.atualizarUltimoLogin(usuarioEncontrado.id).catch((err) => {
      console.error('[auth] Falha ao atualizar ultimo_login_em:', err.message);
    });

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
