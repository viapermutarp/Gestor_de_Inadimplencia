const prisma = require('../config/prisma');
const refreshTokens = require('../services/refreshTokens.service');
const { criarUsuarioFranquia, pareceEmail, senhaValida, SENHA_TAMANHO_MINIMO } = require('../services/usuarios.service');
const { RECURSOS } = require('../config/recursos');

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * Restrição de telas por USUÁRIO (ver docs/plano-multi-franquia.md, seção
 * 8, item 8). Valida um array de chaves de recurso — todas precisam estar
 * em RECURSOS (ver src/config/recursos.js) e sem duplicatas. `undefined` é
 * aceito (significa "não informado" — quem chama decide o default: criar()
 * e criarUsuarioExtra() usam a lista completa por padrão).
 */
function recursosValidos(recursos) {
  if (!Array.isArray(recursos)) return false;
  const unicos = new Set(recursos);
  return unicos.size === recursos.length && recursos.every((r) => RECURSOS.includes(r));
}

/**
 * Multi-franquia — Etapa 5 ("Controle Geral", seção 6 do plano) e ajuste
 * "Super Admin pode adicionar mais de 1 usuário numa franquia" (seção 8,
 * item 8): desde que a trava @@unique([franquiaId]) foi removida do model
 * Usuario, a serialização passa a embutir TODOS os usuários da franquia
 * (array, não mais um objeto único) — a tela não precisa de uma segunda
 * chamada nem de uma rota separada pra "usuários" (ver escopo combinado no
 * pedido: "pode ser mostrado junto da lista de franquias"). Cada usuário
 * já traz "recursos_permitidos" PRÓPRIO (movido de
 * Franquia.recursosPermitidos — ver docblock legado no schema.prisma), por
 * isso a franquia em si não expõe mais um "recursos_permitidos" no nível
 * dela.
 *
 * "usuarios: []" acontece pra franquias que nunca passaram por
 * POST /api/franquias nem por POST /api/franquias/:id/usuarios — hoje, na
 * prática, só a franquia semeada pela migração da Fase 1 ("Via Permuta
 * Ribeirão Preto"), que nasceu antes do model Usuario existir e nunca
 * teve um usuário "FRANQUIA" vinculado a ela. O frontend trata esse caso
 * mostrando "Nenhum usuário vinculado" em vez de quebrar.
 */
function serializeUsuarioDaFranquia(usuario) {
  return {
    id: usuario.id,
    nome: usuario.nome,
    email: usuario.email,
    ativo: usuario.ativo,
    ultimo_login_em: usuario.ultimoLoginEm,
    recursos_permitidos: usuario.recursosPermitidos,
  };
}

function serializeFranquia(franquia) {
  const usuarios = Array.isArray(franquia.usuarios) ? franquia.usuarios : [];
  return {
    id: franquia.id,
    nome: franquia.nome,
    ativo: franquia.ativo,
    criado_em: franquia.criadoEm,
    usuarios: usuarios.map(serializeUsuarioDaFranquia),
  };
}

/**
 * GET /api/franquias — lista todas as franquias (ativas e inativas), mais
 * antigas primeiro (a franquia padrão sempre aparece no topo), cada uma já
 * com TODOS os usuários dela embutidos (mais antigo primeiro — o titular,
 * quando existe, sempre aparece antes dos usuários extras adicionados
 * depois). Só SUPER_ADMIN (ver middleware/exigirSuperAdmin.js).
 */
exports.listar = async (req, res, next) => {
  try {
    const franquias = await prisma.franquia.findMany({
      orderBy: { criadoEm: 'asc' },
      include: { usuarios: { orderBy: { criadoEm: 'asc' } } },
    });
    res.json(franquias.map(serializeFranquia));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/franquias — body { nome, usuario: { nome, email, senha },
 * recursos_permitidos? }. Cria a franquia E o usuário TITULAR dela numa
 * única transação — não existe fluxo de criar uma franquia "vazia" sem
 * usuário (ver escopo da Etapa 5, item 2): se a criação do usuário falhar
 * (ex.: email já em uso por outra franquia), a franquia também não é
 * criada (rollback). Pra adicionar usuários EXTRAS a uma franquia já
 * existente, ver POST /api/franquias/:id/usuarios (exports.criarUsuarioExtra
 * abaixo).
 */
exports.criar = async (req, res, next) => {
  try {
    const { nome, usuario, recursos_permitidos: recursosPermitidos } = req.body || {};
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

    // Restrição de telas por USUÁRIO (movido de Franquia — ver escopo do
    // ajuste "Super Admin pode adicionar mais de 1 usuário numa franquia").
    // "recursos_permitidos" é opcional na criação — sem ele, o usuário
    // titular nasce com TODOS os recursos liberados por padrão (mesmo
    // default que os checkboxes já vêm marcados no frontend); se
    // informado, precisa ser um array só com chaves válidas de RECURSOS.
    const listaRecursos = recursosPermitidos === undefined ? RECURSOS : recursosPermitidos;
    if (!recursosValidos(listaRecursos)) {
      erros.push(`"recursos_permitidos" precisa ser um array só com estas chaves (sem repetir): ${RECURSOS.join(', ')}.`);
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
          recursosPermitidos: listaRecursos,
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
 * POST /api/franquias/:id/usuarios — body { nome, email, senha,
 * recursos_permitidos? }. Multi-franquia — ajuste "Super Admin pode
 * adicionar mais de 1 usuário numa franquia" (ver
 * docs/plano-multi-franquia.md, seção 8, item 8). Diferente de
 * POST /api/franquias (que cria franquia + usuário titular juntos), aqui a
 * franquia JÁ EXISTE — só nasce mais um login pra ela, compartilhando as
 * integrações da franquia (Asaas/webhook/Drive, todas já por-franquia) mas
 * com "recursos_permitidos" (telas liberadas) PRÓPRIOS, independentes dos
 * outros usuários dela. Mesma validação de email único GLOBALMENTE que já
 * vale pro usuário titular (constraint do banco em usuarios.email — ver
 * usuarios.service.js:criarUsuarioFranquia).
 */
exports.criarUsuarioExtra = async (req, res, next) => {
  try {
    const franquia = await prisma.franquia.findUnique({ where: { id: req.params.id } });
    if (!franquia) {
      return res.status(404).json({ error: 'Franquia não encontrada.' });
    }

    const { nome, email, senha, recursos_permitidos: recursosPermitidos } = req.body || {};
    const erros = [];

    if (!campoPreenchido(nome)) erros.push('"nome" é obrigatório.');
    if (!pareceEmail(email)) erros.push('"email" precisa ser um e-mail válido.');
    if (!senhaValida(senha)) erros.push(`"senha" precisa ter pelo menos ${SENHA_TAMANHO_MINIMO} caracteres.`);

    const listaRecursos = recursosPermitidos === undefined ? RECURSOS : recursosPermitidos;
    if (!recursosValidos(listaRecursos)) {
      erros.push(`"recursos_permitidos" precisa ser um array só com estas chaves (sem repetir): ${RECURSOS.join(', ')}.`);
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const usuarioCriado = await criarUsuarioFranquia({
      franquiaId: franquia.id,
      nome: nome.trim(),
      email: email.trim(),
      senha,
      recursosPermitidos: listaRecursos,
    });

    res.status(201).json(serializeUsuarioDaFranquia(usuarioCriado));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/franquias/:id — body: qualquer subconjunto de { nome, ativo }.
 * "recursos_permitidos" NÃO é mais aceito aqui (movido pra Usuario — ver
 * escopo do ajuste "Super Admin pode adicionar mais de 1 usuário numa
 * franquia"); pra mudar as telas liberadas de um usuário específico, ver
 * PATCH /api/usuarios/:id (usuarios.controller.js).
 *
 * Desativar (`ativo: false`) bloqueia o login de TODOS os usuários da
 * franquia IMEDIATAMENTE (não só o titular — desde que uma franquia pode
 * ter N usuários) — o próprio POST /api/login e POST /api/refresh já
 * checam "usuario.franquia.ativo" a cada tentativa (ver
 * auth.controller.js, refreshTokens.service.js:rotacionar), então isso já
 * vale sem nenhuma ação extra aqui. Complementarmente, revoga também
 * todas as sessões já abertas de CADA usuário da franquia (mesmo
 * mecanismo usado ao bloquear um usuário individual — ver
 * usuarios.controller.js) — sem isso, um refresh token já emitido e ainda
 * não usado só seria barrado na PRÓXIMA tentativa de renovação, não
 * imediatamente; revogar fecha essa janela pra todos de uma vez.
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
      include: { usuarios: { orderBy: { criadoEm: 'asc' } } },
    });

    if (ativo === false) {
      await Promise.all(existente.usuarios.map((u) => refreshTokens.revogarTodasDoUsuario(u.id)));
    }

    res.json(serializeFranquia(franquia));
  } catch (err) {
    next(err);
  }
};
