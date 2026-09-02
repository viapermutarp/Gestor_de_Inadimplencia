const prisma = require('../config/prisma');
const refreshTokens = require('../services/refreshTokens.service');
const usuariosService = require('../services/usuarios.service');

function serializeUsuario(usuario) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    papel: usuario.papel,
    franquia_id: usuario.franquiaId,
    ativo: usuario.ativo,
    ultimo_login_em: usuario.ultimoLoginEm,
  };
}

/**
 * PATCH /api/usuarios/:id — body { ativo: boolean }. Bloqueia/desbloqueia
 * o acesso de um usuário individual (distinto de desativar a franquia
 * inteira — ver franquias.controller.js:atualizar —, embora hoje, com 1
 * usuário por franquia, o efeito prático seja o mesmo; os dois controles
 * ficam separados no banco/API de propósito, ver escopo da Etapa 5, item
 * 3). Bloquear (`ativo: false`) também revoga todas as sessões já abertas
 * desse usuário — mesmo raciocínio do `atualizar` de franquia.
 *
 * Não deixa o SUPER_ADMIN bloquear a SI MESMO por aqui (evitaria se
 * trancar fora sem querer) — usa `/api/perfil` pra mexer na própria conta.
 */
exports.atualizarStatus = async (req, res, next) => {
  try {
    const { ativo } = req.body || {};
    if (typeof ativo !== 'boolean') {
      return res.status(400).json({ error: '"ativo" deve ser booleano.' });
    }

    if (req.params.id === req.auth.user) {
      return res.status(400).json({ error: 'Não é possível bloquear o próprio usuário por aqui.' });
    }

    const existente = await prisma.usuario.findUnique({ where: { id: req.params.id } });
    if (!existente) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    const usuario = await prisma.usuario.update({ where: { id: req.params.id }, data: { ativo } });

    if (ativo === false) {
      await refreshTokens.revogarTodasDoUsuario(usuario.id);
    }

    res.json(serializeUsuario(usuario));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/usuarios/:id/resetar-senha — body { senha }. O SUPER_ADMIN
 * define uma senha nova pro usuário indicado, sem precisar saber a antiga
 * (ver usuarios.service.js:resetarSenha — diferente de trocar a própria
 * senha, que sempre exige a senha atual, ver PATCH /api/perfil abaixo).
 * Revoga todas as sessões já abertas desse usuário — a senha só muda de
 * verdade se ele precisar logar de novo com ela; deixar sessões antigas
 * vivas depois de um reset (ex.: reset por suspeita de senha vazada)
 * derrotaria o propósito.
 */
exports.resetarSenha = async (req, res, next) => {
  try {
    const { senha } = req.body || {};
    if (!usuariosService.senhaValida(senha)) {
      return res.status(400).json({
        error: `"senha" precisa ter pelo menos ${usuariosService.SENHA_TAMANHO_MINIMO} caracteres.`,
      });
    }

    const existente = await prisma.usuario.findUnique({ where: { id: req.params.id } });
    if (!existente) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    await usuariosService.resetarSenha(req.params.id, senha);
    await refreshTokens.revogarTodasDoUsuario(req.params.id);

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/perfil — dados do PRÓPRIO usuário autenticado (não precisa ser
 * SUPER_ADMIN — qualquer sessão de painel pode ver os próprios dados;
 * sessões por API key, que não têm "req.auth.user", tomam 403). Usado pra
 * pré-popular o formulário de "Meu perfil" em Controle Geral.
 */
exports.obterPerfil = async (req, res, next) => {
  try {
    if (req.auth.type !== 'jwt') {
      return res.status(403).json({ error: 'Disponível só para sessões de usuário do painel.' });
    }

    const usuario = await prisma.usuario.findUnique({ where: { id: req.auth.user } });
    if (!usuario) {
      return res.status(404).json({ error: 'Usuário não encontrado.' });
    }

    res.json(serializeUsuario(usuario));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/perfil — body { nome?, email?, senha_atual, senha_nova? }.
 * Troca as PRÓPRIAS credenciais (hoje usado só pelo SUPER_ADMIN, ver escopo
 * da Etapa 5, item 5 — "hoje isso só é possível via SQL direto no banco").
 * Sempre exige "senha_atual" correta, mesmo pra trocar só o nome — ver
 * usuarios.service.js:atualizarCredenciaisProprias pro raciocínio.
 */
exports.atualizarPerfil = async (req, res, next) => {
  try {
    if (req.auth.type !== 'jwt') {
      return res.status(403).json({ error: 'Disponível só para sessões de usuário do painel.' });
    }

    const { nome, email, senha_atual: senhaAtual, senha_nova: senhaNova } = req.body || {};
    const erros = [];

    if (!senhaAtual) erros.push('"senha_atual" é obrigatório.');
    if (nome !== undefined && (typeof nome !== 'string' || nome.trim() === '')) {
      erros.push('"nome" não pode ser vazio.');
    }
    if (email !== undefined && !usuariosService.pareceEmail(email)) {
      erros.push('"email" precisa ser um e-mail válido.');
    }
    if (senhaNova !== undefined && !usuariosService.senhaValida(senhaNova)) {
      erros.push(`"senha_nova" precisa ter pelo menos ${usuariosService.SENHA_TAMANHO_MINIMO} caracteres.`);
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const usuario = await usuariosService.atualizarCredenciaisProprias(req.auth.user, {
      nome: nome !== undefined ? nome.trim() : undefined,
      email: email !== undefined ? email.trim() : undefined,
      senhaAtual,
      senhaNova,
    });

    // Trocar a própria senha invalida as OUTRAS sessões abertas (ex.: login
    // esquecido em outro computador) — a sessão atual (o access token já em
    // uso nesta chamada) continua valendo até expirar sozinha por conta
    // própria (poucos minutos, ver JWT_EXPIRES_IN), mesmo comportamento já
    // documentado em qualquer outro fluxo de revogação deste projeto.
    if (senhaNova !== undefined) {
      await refreshTokens.revogarTodasDoUsuario(usuario.id);
    }

    res.json(serializeUsuario(usuario));
  } catch (err) {
    next(err);
  }
};
