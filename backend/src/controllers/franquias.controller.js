const prisma = require('../config/prisma');
const refreshTokens = require('../services/refreshTokens.service');
const { criarUsuarioFranquia, pareceEmail, senhaValida, SENHA_TAMANHO_MINIMO } = require('../services/usuarios.service');

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Multi-franquia — Etapa 5 ("Controle Geral", seção 6 do plano). Como cada
 * franquia tem exatamente 1 usuário (trava @@unique([franquiaId]) desde a
 * Fase 1), a serialização já embute o usuário dela — a tela não precisa de
 * uma segunda chamada nem de uma rota separada pra "usuários" (ver escopo
 * combinado no pedido: "pode ser mostrado junto da lista de franquias").
 *
 * "usuario: null" acontece pra franquias que nunca passaram por
 * POST /api/franquias — hoje, na prática, só a franquia semeada pela
 * migração da Fase 1 ("Via Permuta Ribeirão Preto"), que nasceu antes do
 * model Usuario existir e nunca teve um usuário "FRANQUIA" vinculado a ela
 * (o único usuário de hoje é o SUPER_ADMIN, com franquiaId null). O
 * frontend trata esse caso mostrando "Nenhum usuário vinculado" em vez de
 * quebrar.
 */
function serializeFranquia(franquia) {
  const usuario = Array.isArray(franquia.usuarios) ? franquia.usuarios[0] : franquia.usuarios;
  return {
    id: franquia.id,
    nome: franquia.nome,
    ativo: franquia.ativo,
    criado_em: franquia.criadoEm,
    usuario: usuario
      ? {
          id: usuario.id,
          nome: usuario.nome,
          email: usuario.email,
          ativo: usuario.ativo,
          ultimo_login_em: usuario.ultimoLoginEm,
        }
      : null,
  };
}

/**
 * GET /api/franquias — lista todas as franquias (ativas e inativas), mais
 * antigas primeiro (a franquia padrão sempre aparece no topo), cada uma já
 * com o próprio usuário embutido. Só SUPER_ADMIN (ver
 * middleware/exigirSuperAdmin.js).
 */
exports.listar = async (req, res, next) => {
  try {
    const franquias = await prisma.franquia.findMany({
      orderBy: { criadoEm: 'asc' },
      include: { usuarios: true },
    });
    res.json(franquias.map(serializeFranquia));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/franquias — body { nome, usuario: { nome, email, senha } }.
 * Cria a franquia E o usuário titular dela numa única transação — não
 * existe fluxo de criar uma franquia "vazia" sem usuário (ver escopo da
 * Etapa 5, item 2): se a criação do usuário falhar (ex.: email já em uso
 * por outra franquia), a franquia também não é criada (rollback).
 */
exports.criar = async (req, res, next) => {
  try {
    const { nome, usuario } = req.body || {};
    const erros = [];

    if (!campoPreenchido(nome)) erros.push('"nome" da franquia é obrigatório.');
    if (!usuario || typeof usuario !== 'object') {
      erros.push('"usuario" (nome, email, senha) é obrigatório.');
    } else {
      if (!campoPreenchido(usuario.nome)) erros.push('"usuario.nome" é obrigatório.');
      if (!pareceEmail(usuario.email)) erros.push('"usuario.email" precisa ser um e-mail válido.');
      if (!senhaValida(usuario.senha)) {
        erros.push(`"usuario.senha" precisa ter pelo menos ${SENHA_TAMANHO_MINIMO} caracteres.`);
      }
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const resultado = await prisma.$transaction(async (tx) => {
      const franquia = await tx.franquia.create({ data: { nome: nome.trim() } });
      const usuarioCriado = await criarUsuarioFranquia(
        {
          franquiaId: franquia.id,
          nome: usuario.nome.trim(),
          email: usuario.email.trim(),
          senha: usuario.senha,
        },
        tx
      );
      return { ...franquia, usuarios: [usuarioCriado] };
    });

    res.status(201).json(serializeFranquia(resultado));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/franquias/:id — body: qualquer subconjunto de { nome, ativo }.
 * Desativar (`ativo: false`) bloqueia o login do usuário dela IMEDIATAMENTE
 * — o próprio POST /api/login e POST /api/refresh já checam
 * "usuario.franquia.ativo" a cada tentativa (ver auth.controller.js,
 * refreshTokens.service.js:rotacionar), então isso já vale sem nenhuma
 * ação extra aqui. Complementarmente, revoga também todas as sessões já
 * abertas desse usuário (mesmo mecanismo usado ao bloquear um usuário
 * individual — ver usuarios.controller.js) — sem isso, um refresh token já
 * emitido e ainda não usado só seria barrado na PRÓXIMA tentativa de
 * renovação, não imediatamente; revogar fecha essa janela.
 */
exports.atualizar = async (req, res, next) => {
  try {
    const existente = await prisma.franquia.findUnique({ where: { id: req.params.id }, include: { usuarios: true } });
    if (!existente) {
      return res.status(404).json({ error: 'Franquia não encontrada.' });
    }

    const { nome, ativo } = req.body || {};
    const data = {};
    const erros = [];

    if (nome !== undefined) {
      if (!campoPreenchido(nome)) erros.push('"nome" não pode ser vazio.');
      else data.nome = nome.trim();
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') erros.push('"ativo" deve ser booleano.');
      else data.ativo = ativo;
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const franquia = await prisma.franquia.update({
      where: { id: req.params.id },
      data,
      include: { usuarios: true },
    });

    if (ativo === false) {
      const usuarioDaFranquia = existente.usuarios[0];
      if (usuarioDaFranquia) {
        await refreshTokens.revogarTodasDoUsuario(usuarioDaFranquia.id);
      }
    }

    res.json(serializeFranquia(franquia));
  } catch (err) {
    next(err);
  }
};
