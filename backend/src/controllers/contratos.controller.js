const TIPOS_VALIDOS = ['TERMO', 'ADITIVO'];

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

function serialize(modelo) {
  return {
    id: modelo.id,
    nome: modelo.nome,
    tipo: modelo.tipo,
    conteudo: modelo.conteudo,
    ativo: modelo.ativo,
    criado_em: modelo.criadoEm,
    atualizado_em: modelo.atualizadoEm,
  };
}

/**
 * GET /api/contratos
 * Lista todos os modelos de contrato (ativos e inativos), mais recentes
 * primeiro — a tela /contratos decide como exibir o badge ativo/inativo.
 * Aceita `?ativo=true|false` opcional pra filtrar (usado pelo formulário
 * de Cadastro, que só deve oferecer modelos ativos em "Contratos a gerar").
 */
exports.listar = async (req, res, next) => {
  try {
    const { ativo } = req.query;
    const where = {};
    if (ativo === 'true') where.ativo = true;
    if (ativo === 'false') where.ativo = false;

    const modelos = await req.prisma.modeloContrato.findMany({
      where,
      orderBy: { criadoEm: 'desc' },
    });

    res.json(modelos.map(serialize));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/contratos/:id
 */
exports.obter = async (req, res, next) => {
  try {
    const modelo = await req.prisma.modeloContrato.findUnique({ where: { id: req.params.id } });
    if (!modelo) {
      return res.status(404).json({ error: 'Modelo de contrato não encontrado.' });
    }
    res.json(serialize(modelo));
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/contratos
 * Body: { nome, tipo, conteudo }. "tipo" precisa ser "TERMO" ou "ADITIVO".
 */
exports.criar = async (req, res, next) => {
  try {
    const { nome, tipo, conteudo } = req.body || {};
    const erros = [];

    if (!campoPreenchido(nome)) erros.push('"nome" é obrigatório.');
    if (!TIPOS_VALIDOS.includes(tipo)) {
      erros.push(`"tipo" deve ser um de: ${TIPOS_VALIDOS.join(', ')}.`);
    }
    if (!campoPreenchido(conteudo)) erros.push('"conteudo" é obrigatório.');

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    // Multi-franquia — Fase 3: "franquiaId" injetado automaticamente pela
    // extension (ver prismaComEscopo.js).
    const modelo = await req.prisma.modeloContrato.create({
      data: { nome: nome.trim(), tipo, conteudo },
    });

    res.status(201).json(serialize(modelo));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/contratos/:id
 * Body: qualquer subconjunto de { nome, tipo, conteudo, ativo }.
 * Reativar um modelo (ativo: true) também passa por aqui — só o DELETE
 * (soft-delete) é dedicado exclusivamente a desativar.
 */
exports.atualizar = async (req, res, next) => {
  try {
    const existente = await req.prisma.modeloContrato.findUnique({ where: { id: req.params.id } });
    if (!existente) {
      return res.status(404).json({ error: 'Modelo de contrato não encontrado.' });
    }

    const { nome, tipo, conteudo, ativo } = req.body || {};
    const data = {};
    const erros = [];

    if (nome !== undefined) {
      if (!campoPreenchido(nome)) erros.push('"nome" não pode ser vazio.');
      else data.nome = nome.trim();
    }
    if (tipo !== undefined) {
      if (!TIPOS_VALIDOS.includes(tipo)) erros.push(`"tipo" deve ser um de: ${TIPOS_VALIDOS.join(', ')}.`);
      else data.tipo = tipo;
    }
    if (conteudo !== undefined) {
      if (!campoPreenchido(conteudo)) erros.push('"conteudo" não pode ser vazio.');
      else data.conteudo = conteudo;
    }
    if (ativo !== undefined) {
      if (typeof ativo !== 'boolean') erros.push('"ativo" deve ser booleano.');
      else data.ativo = ativo;
    }

    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const modelo = await req.prisma.modeloContrato.update({ where: { id: req.params.id }, data });
    res.json(serialize(modelo));
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/contratos/:id
 * Soft-delete: só marca ativo=false, nunca apaga a linha — cadastros
 * antigos guardam o id em CadastroEnviado.modelosContratoIds e precisam
 * continuar conseguindo exibir/consultar qual modelo foi usado, mesmo
 * depois de desativado. Idempotente: desativar de novo não é erro.
 */
exports.remover = async (req, res, next) => {
  try {
    const existente = await req.prisma.modeloContrato.findUnique({ where: { id: req.params.id } });
    if (!existente) {
      return res.status(404).json({ error: 'Modelo de contrato não encontrado.' });
    }

    const modelo = await req.prisma.modeloContrato.update({
      where: { id: req.params.id },
      data: { ativo: false },
    });

    res.json(serialize(modelo));
  } catch (err) {
    next(err);
  }
};
