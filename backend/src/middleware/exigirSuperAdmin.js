/**
 * Multi-franquia — Etapa 5 ("Controle Geral", ver docs/plano-multi-franquia.md,
 * seção 6). Protege as rotas cross-franquia (gestão de franquias/usuários) —
 * só um usuário logado com papel "SUPER_ADMIN" passa. Qualquer outro caso
 * (sessão de usuário comum, autenticação por API key — que nunca tem
 * "papel" nenhum, ver middleware/auth.js — ou nenhuma sessão) recebe 403,
 * nunca 401 (a autenticação em si já foi validada por "auth", que roda
 * antes deste middleware nas rotas que o usam; 403 aqui significa
 * "autenticado, mas sem permissão", não "não autenticado").
 *
 * Uso: sempre depois de "auth" nas rotas de /api/franquias e /api/usuarios
 * (ver routes/franquias.routes.js, routes/usuarios.routes.js) — nunca
 * escondido só no frontend (AppHeader só ESCONDE o link do menu pra quem
 * não é SUPER_ADMIN; a proteção de verdade é esta, no backend).
 */
module.exports = function exigirSuperAdmin(req, res, next) {
  if (!req.auth || req.auth.papel !== 'SUPER_ADMIN') {
    return res.status(403).json({ error: 'Acesso restrito ao administrador geral (SUPER_ADMIN).' });
  }
  next();
};
