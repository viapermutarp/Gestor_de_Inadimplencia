const COBRANCAS_ABERTAS = ['pending', 'overdue'];
const LIMITE_BUSCA_ASSOCIADOS = 20;

// Log de alterações dos cards do Jurídico (ver ajuste "Log de atualização
// dos cards do Jurídico" e docblock do model HistoricoCardJuridico em
// schema.prisma) — campos de conteúdo do card que geram um registro de
// histórico quando mudam via PATCH /api/juridico/cards/:id (mudança de
// etapa é tratada à parte, em moverCard, e criação/exclusão têm seus
// próprios eventos "criacao"/"exclusao").
const CAMPOS_HISTORICO_CARD = ['titulo', 'descricao', 'observacoes', 'responsavel', 'prazo'];

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

function valorEmAberto(associado) {
  return (associado.cobrancas || []).reduce((soma, c) => soma + Number(c.valor), 0);
}

/** Normaliza um valor de card (string, null ou Date) pra texto legível no histórico. */
function valorParaHistorico(valor) {
  if (valor === null || valor === undefined) return null;
  if (valor instanceof Date) return valor.toISOString().slice(0, 10);
  return String(valor);
}

/**
 * Registra um evento no histórico do card (ver HistoricoCardJuridico em
 * schema.prisma) — sempre chamado dentro da MESMA transação da mutação que
 * o originou (create/update/mover/delete), usando "tx" (não "req.prisma"
 * direto), pro log nunca ficar dessincronizado da mudança real caso algo
 * falhe no meio do caminho. "usuarioId" vem de "req.auth.user" — só existe
 * em sessões JWT (painel); sessões de API key não têm esse campo, e o
 * histórico aceita null nesse caso (ver docblock do model).
 */
async function registrarHistoricoCard(tx, req, { cardId, campoAlterado, valorAnterior, valorNovo }) {
  await tx.historicoCardJuridico.create({
    data: {
      cardId,
      franquiaId: req.franquiaId,
      campoAlterado,
      valorAnterior: valorAnterior ?? null,
      valorNovo: valorNovo ?? null,
      usuarioId: req.auth.user || null,
    },
  });
}

/**
 * Kanban "Jurídico" (aba nova — ver docs/plano-multi-franquia.md e
 * schema.prisma). Card vinculado a um Associado nunca tem "titulo"/
 * "descricao" próprios gravados — os dados exibidos (nome, cpf_cnpj,
 * telefone, valor em aberto) vêm SEMPRE ao vivo da relação, recarregados a
 * cada serialização (nunca copiados estaticamente pro card no momento da
 * criação/vínculo). "valor_em_aberto" é a soma das cobranças
 * pending/overdue do associado, calculada aqui mesmo a partir do include.
 */
function serializeCard(card) {
  const base = {
    id: card.id,
    etapa_id: card.etapaId,
    ordem: card.ordem,
    responsavel: card.responsavel,
    prazo: card.prazo,
    etapa_alterada_em: card.etapaAlteradaEm,
    criado_em: card.criadoEm,
    atualizado_em: card.atualizadoEm,
  };

  if (card.associado) {
    base.associado = {
      id: card.associado.id,
      nome: card.associado.nome,
      cpf_cnpj: card.associado.cpfCnpj,
      telefone: card.associado.telefone,
      valor_em_aberto: valorEmAberto(card.associado),
    };
    // "titulo" continua exclusivo de card livre (o nome exibido pra card
    // vinculado é sempre o do associado, acima) — mas "descricao"/
    // "observacoes" já não são mais (ver ajuste "Observações também no
    // modo Vincular associado"), por isso saem do "if" e valem pros dois
    // tipos de card, abaixo.
    base.titulo = null;
  } else {
    base.associado = null;
    base.titulo = card.titulo;
  }
  base.descricao = card.descricao;
  base.observacoes = card.observacoes;

  return base;
}

function serializeEtapa(etapa) {
  return {
    id: etapa.id,
    nome: etapa.nome,
    ordem: etapa.ordem,
    criado_em: etapa.criadoEm,
    cards: Array.isArray(etapa.cards) ? etapa.cards.map(serializeCard) : undefined,
  };
}

const includeAssociadoComCobrancasAbertas = {
  associado: { include: { cobrancas: { where: { status: { in: COBRANCAS_ABERTAS } } } } },
};

/** GET /api/juridico/etapas — o board inteiro: etapas ordenadas, cada uma já com seus cards (ordenados). */
exports.listarEtapas = async (req, res, next) => {
  try {
    const etapas = await req.prisma.etapaJuridico.findMany({
      orderBy: { ordem: 'asc' },
      include: {
        cards: {
          orderBy: { ordem: 'asc' },
          include: includeAssociadoComCobrancasAbertas,
        },
      },
    });
    res.json(etapas.map(serializeEtapa));
  } catch (err) {
    next(err);
  }
};

/** POST /api/juridico/etapas — body { nome }. Nasce como última coluna. */
exports.criarEtapa = async (req, res, next) => {
  try {
    const { nome } = req.body || {};
    if (!campoPreenchido(nome)) {
      return res.status(400).json({ error: '"nome" da etapa é obrigatório.' });
    }

    const max = await req.prisma.etapaJuridico.aggregate({ _max: { ordem: true } });
    const ordem = (max._max.ordem ?? -1) + 1;

    const etapa = await req.prisma.etapaJuridico.create({ data: { nome: nome.trim(), ordem } });
    res.status(201).json({ id: etapa.id, nome: etapa.nome, ordem: etapa.ordem, criado_em: etapa.criadoEm });
  } catch (err) {
    next(err);
  }
};

/** PATCH /api/juridico/etapas/:id — body { nome }. Renomear (edição simples, não mexe em "ordem"). */
exports.atualizarEtapa = async (req, res, next) => {
  try {
    const { nome } = req.body || {};
    if (!campoPreenchido(nome)) {
      return res.status(400).json({ error: '"nome" não pode ser vazio.' });
    }

    const etapa = await req.prisma.etapaJuridico.update({
      where: { id: req.params.id },
      data: { nome: nome.trim() },
    });
    res.json({ id: etapa.id, nome: etapa.nome, ordem: etapa.ordem, criado_em: etapa.criadoEm });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Etapa não encontrada.' });
    next(err);
  }
};

/**
 * POST /api/juridico/etapas/reordenar — body { ids: [...] }, a nova ordem
 * completa das colunas (drag and drop). Reindexa "ordem" = posição no
 * array, pra todas as etapas informadas, numa transação só.
 */
exports.reordenarEtapas = async (req, res, next) => {
  try {
    const { ids } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ error: '"ids" (array de ids de etapas, na nova ordem) é obrigatório.' });
    }

    const existentes = await req.prisma.etapaJuridico.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    if (existentes.length !== ids.length) {
      return res.status(400).json({ error: 'Uma ou mais etapas informadas não existem nesta franquia.' });
    }

    // Transação em callback (não array) — a Prisma Client Extension de
    // isolamento (prismaComEscopo.js) faz uma checagem assíncrona extra
    // antes de cada "update" singular, o que quebra o contrato de
    // PrismaPromise batchável exigido pela forma array (mesmo motivo
    // documentado em associados.controller.js).
    await req.prisma.$transaction(async (tx) => {
      for (let i = 0; i < ids.length; i++) {
        await tx.etapaJuridico.update({ where: { id: ids[i] }, data: { ordem: i } });
      }
    });

    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/juridico/etapas/:id
 * DELETE /api/juridico/etapas/:id?confirmar=true
 * Sem "?confirmar=true": se a etapa tiver algum card, recusa com 409 e
 * "total_cards" (o frontend usa isso pra pedir confirmação antes de tentar
 * de novo). Com "?confirmar=true" (ou etapa já vazia): remove a etapa — os
 * cards dela são removidos junto pelo ON DELETE CASCADE do banco (ver
 * schema.prisma), não é preciso apagar um por um aqui.
 */
exports.removerEtapa = async (req, res, next) => {
  try {
    const { id } = req.params;
    const confirmar = req.query.confirmar === 'true';

    const etapa = await req.prisma.etapaJuridico.findUnique({ where: { id } });
    if (!etapa) return res.status(404).json({ error: 'Etapa não encontrada.' });

    const totalCards = await req.prisma.cardJuridico.count({ where: { etapaId: id } });
    if (totalCards > 0 && !confirmar) {
      return res.status(409).json({
        error: `Esta etapa tem ${totalCards} card(s). Confirme a exclusão para remover a etapa e os cards junto.`,
        total_cards: totalCards,
      });
    }

    await req.prisma.etapaJuridico.delete({ where: { id } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/juridico/associados-busca?busca=termo
 * Busca por nome/CPF/CNPJ/telefone (mesmo padrão de GET /api/associados) —
 * usada só na hora de vincular um card a um associado existente. Resposta
 * enxuta (sem paginação, top 20), já com "valor_em_aberto" calculado.
 */
exports.buscarAssociados = async (req, res, next) => {
  try {
    const termo = typeof req.query.busca === 'string' ? req.query.busca.trim() : '';
    if (!termo) return res.json([]);

    const associados = await req.prisma.associado.findMany({
      where: {
        OR: [
          { nome: { contains: termo, mode: 'insensitive' } },
          { cpfCnpj: { contains: termo, mode: 'insensitive' } },
          { telefone: { contains: termo, mode: 'insensitive' } },
        ],
      },
      orderBy: { nome: 'asc' },
      take: LIMITE_BUSCA_ASSOCIADOS,
      include: { cobrancas: { where: { status: { in: COBRANCAS_ABERTAS } } } },
    });

    res.json(
      associados.map((a) => ({
        id: a.id,
        nome: a.nome,
        cpf_cnpj: a.cpfCnpj,
        telefone: a.telefone,
        valor_em_aberto: valorEmAberto(a),
      }))
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/juridico/cards
 * Body: { etapa_id, associado_id? , titulo?, descricao?, observacoes?, responsavel?, prazo? }
 * Exatamente uma origem: "associado_id" (vinculado) OU "titulo" (livre) —
 * nunca os dois, nunca nenhum dos dois. "titulo" continua exclusivo de card
 * livre (card vinculado usa sempre o nome do associado, ver serializeCard)
 * — mas "descricao"/"observacoes" valem nos DOIS modos desde o ajuste
 * "Observações também no modo Vincular associado" (antes eram exclusivas
 * de card livre). "responsavel"/"prazo" são opcionais nos dois casos.
 * Nasce como último card da etapa informada. Registra um evento "criacao"
 * no histórico (ver HistoricoCardJuridico), na mesma transação.
 */
exports.criarCard = async (req, res, next) => {
  try {
    const {
      etapa_id: etapaId,
      associado_id: associadoId,
      titulo,
      descricao,
      observacoes,
      responsavel,
      prazo,
    } = req.body || {};

    if (!campoPreenchido(etapaId)) {
      return res.status(400).json({ error: '"etapa_id" é obrigatório.' });
    }

    const temAssociado = campoPreenchido(associadoId);
    const temTitulo = campoPreenchido(titulo);
    if (!temAssociado && !temTitulo) {
      return res.status(400).json({ error: 'Informe "associado_id" (card vinculado) ou "titulo" (card livre).' });
    }
    if (temAssociado && temTitulo) {
      return res
        .status(400)
        .json({ error: 'Um card não pode ser vinculado a um associado e ter título livre ao mesmo tempo.' });
    }
    let prazoData;
    if (prazo !== undefined && prazo !== null && prazo !== '') {
      const data = new Date(prazo);
      if (Number.isNaN(data.getTime())) return res.status(400).json({ error: '"prazo" inválido.' });
      prazoData = data;
    }

    const etapa = await req.prisma.etapaJuridico.findUnique({ where: { id: etapaId } });
    if (!etapa) return res.status(404).json({ error: 'Etapa não encontrada nesta franquia.' });

    if (temAssociado) {
      const associado = await req.prisma.associado.findUnique({ where: { id: associadoId } });
      if (!associado) return res.status(404).json({ error: 'Associado não encontrado nesta franquia.' });
    }

    const max = await req.prisma.cardJuridico.aggregate({ _max: { ordem: true }, where: { etapaId } });
    const ordem = (max._max.ordem ?? -1) + 1;

    // Transação em callback — a extension de isolamento faz checagens
    // assíncronas em "create" singular (ver prismaComEscopo.js), mesmo
    // motivo já documentado nas outras mutações deste controller.
    const card = await req.prisma.$transaction(async (tx) => {
      const criado = await tx.cardJuridico.create({
        data: {
          etapaId,
          ordem,
          associadoId: temAssociado ? associadoId : undefined,
          titulo: temTitulo ? titulo.trim() : undefined,
          descricao: campoPreenchido(descricao) ? descricao.trim() : undefined,
          observacoes: campoPreenchido(observacoes) ? observacoes.trim() : undefined,
          responsavel: campoPreenchido(responsavel) ? responsavel.trim() : undefined,
          prazo: prazoData,
        },
        include: includeAssociadoComCobrancasAbertas,
      });

      await registrarHistoricoCard(tx, req, {
        cardId: criado.id,
        campoAlterado: 'criacao',
        valorNovo: temAssociado ? `associado_id:${associadoId}` : criado.titulo,
      });

      return criado;
    });

    res.status(201).json(serializeCard(card));
  } catch (err) {
    next(err);
  }
};

/**
 * PATCH /api/juridico/cards/:id
 * Body: qualquer subconjunto de { titulo, descricao, observacoes,
 * responsavel, prazo }. Edição de conteúdo — nunca muda "associado_id" nem
 * "etapa_id" (pra mover entre colunas, ver PATCH .../mover). Card vinculado
 * a associado rejeita só "titulo" (sempre ao vivo do nome do associado,
 * ver serializeCard) — "descricao"/"observacoes" valem nos dois modos
 * desde o ajuste "Observações também no modo Vincular associado" (antes
 * eram exclusivas de card livre). Registra um evento no histórico (ver
 * HistoricoCardJuridico) pra cada campo que MUDOU de verdade (compara
 * valor anterior x novo — não loga se o valor enviado for igual ao que já
 * estava salvo), na mesma transação da atualização.
 */
exports.atualizarCard = async (req, res, next) => {
  try {
    const { titulo, descricao, observacoes, responsavel, prazo } = req.body || {};

    const existente = await req.prisma.cardJuridico.findUnique({ where: { id: req.params.id } });
    if (!existente) return res.status(404).json({ error: 'Card não encontrado.' });

    const data = {};

    if (existente.associadoId) {
      if (titulo !== undefined) {
        return res
          .status(400)
          .json({ error: 'Card vinculado a um associado não tem título próprio (vem sempre do nome do associado).' });
      }
    } else if (titulo !== undefined) {
      if (!campoPreenchido(titulo)) return res.status(400).json({ error: '"titulo" não pode ser vazio.' });
      data.titulo = titulo.trim();
    }

    if (descricao !== undefined) {
      data.descricao = descricao === null || descricao === '' ? null : String(descricao).trim();
    }
    if (observacoes !== undefined) {
      data.observacoes = observacoes === null || observacoes === '' ? null : String(observacoes).trim();
    }
    if (responsavel !== undefined) {
      data.responsavel = responsavel === null || responsavel === '' ? null : String(responsavel).trim();
    }
    if (prazo !== undefined) {
      if (prazo === null || prazo === '') {
        data.prazo = null;
      } else {
        const dataPrazo = new Date(prazo);
        if (Number.isNaN(dataPrazo.getTime())) return res.status(400).json({ error: '"prazo" inválido.' });
        data.prazo = dataPrazo;
      }
    }

    const card = await req.prisma.$transaction(async (tx) => {
      const atualizado = await tx.cardJuridico.update({
        where: { id: req.params.id },
        data,
        include: includeAssociadoComCobrancasAbertas,
      });

      for (const campo of CAMPOS_HISTORICO_CARD) {
        if (!(campo in data)) continue;
        const anterior = valorParaHistorico(existente[campo]);
        const novo = valorParaHistorico(data[campo]);
        if (anterior === novo) continue;
        await registrarHistoricoCard(tx, req, {
          cardId: existente.id,
          campoAlterado: campo,
          valorAnterior: anterior,
          valorNovo: novo,
        });
      }

      return atualizado;
    });

    res.json(serializeCard(card));
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Card não encontrado.' });
    next(err);
  }
};

/**
 * PATCH /api/juridico/cards/:id/mover
 * Body: { etapa_id, indice }. Move o card pra "etapa_id" (pode ser a mesma
 * etapa, só reordenando) na posição "indice" (0-based) da lista de destino
 * — reindexa "ordem" de todos os cards afetados na etapa de destino e,
 * se mudou de etapa, também reindexa a etapa de origem (fecha o buraco
 * deixado). "etapa_alterada_em" só é preenchido quando a etapa muda de
 * verdade (ver escopo: "registrar quando um card mudou de etapa") — e,
 * nesse mesmo caso, um evento "etapa" também é registrado no histórico
 * completo (ver HistoricoCardJuridico), com o id da etapa de origem/destino.
 * Só reordenar dentro da mesma etapa não gera evento de histórico (não é
 * uma "mudança de etapa").
 */
exports.moverCard = async (req, res, next) => {
  try {
    const { etapa_id: etapaIdDestino, indice } = req.body || {};

    if (!campoPreenchido(etapaIdDestino)) {
      return res.status(400).json({ error: '"etapa_id" é obrigatório.' });
    }
    if (!Number.isInteger(indice) || indice < 0) {
      return res.status(400).json({ error: '"indice" deve ser um inteiro maior ou igual a 0.' });
    }

    const card = await req.prisma.cardJuridico.findUnique({ where: { id: req.params.id } });
    if (!card) return res.status(404).json({ error: 'Card não encontrado.' });

    const etapaDestino = await req.prisma.etapaJuridico.findUnique({ where: { id: etapaIdDestino } });
    if (!etapaDestino) return res.status(404).json({ error: 'Etapa de destino não encontrada nesta franquia.' });

    const etapaOrigemId = card.etapaId;
    const mudouDeEtapa = etapaOrigemId !== etapaIdDestino;

    await req.prisma.$transaction(async (tx) => {
      const cardsDestino = await tx.cardJuridico.findMany({
        where: { etapaId: etapaIdDestino, id: { not: card.id } },
        orderBy: { ordem: 'asc' },
      });
      const posicao = Math.min(indice, cardsDestino.length);
      cardsDestino.splice(posicao, 0, card);

      for (let i = 0; i < cardsDestino.length; i++) {
        const atual = cardsDestino[i];
        if (atual.id === card.id) {
          const data = { ordem: i };
          if (mudouDeEtapa) {
            data.etapaId = etapaIdDestino;
            data.etapaAlteradaEm = new Date();
          }
          await tx.cardJuridico.update({ where: { id: atual.id }, data });
        } else if (atual.ordem !== i) {
          await tx.cardJuridico.update({ where: { id: atual.id }, data: { ordem: i } });
        }
      }

      if (mudouDeEtapa) {
        const cardsOrigem = await tx.cardJuridico.findMany({
          where: { etapaId: etapaOrigemId },
          orderBy: { ordem: 'asc' },
        });
        for (let i = 0; i < cardsOrigem.length; i++) {
          if (cardsOrigem[i].ordem !== i) {
            await tx.cardJuridico.update({ where: { id: cardsOrigem[i].id }, data: { ordem: i } });
          }
        }

        await registrarHistoricoCard(tx, req, {
          cardId: card.id,
          campoAlterado: 'etapa',
          valorAnterior: etapaOrigemId,
          valorNovo: etapaIdDestino,
        });
      }
    });

    const atualizado = await req.prisma.cardJuridico.findUnique({
      where: { id: req.params.id },
      include: includeAssociadoComCobrancasAbertas,
    });
    res.json(serializeCard(atualizado));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/juridico/cards/:id/historico — lista os eventos de
 * `historico_card_juridico` do card indicado, mais recente primeiro (ver
 * escopo do ajuste "Visualizar histórico do card dentro do modal").
 * `historicoCardJuridico` está no ESCOPO_DIRETO da extension de isolamento
 * (ver prismaComEscopo.js) — "req.prisma" já filtra por franquia sozinho,
 * sem precisar repetir a checagem aqui. Confirma antes que o card existe
 * NESTA franquia (404 caso contrário, mesmo padrão dos outros handlers
 * deste controller) — hoje só é chamado com um card aberto de verdade no
 * modal, mas o histórico em si continuaria consultável mesmo depois do
 * card excluído (sem FK pro card, ver docblock do model), se um dia
 * precisar disso.
 */
exports.listarHistoricoCard = async (req, res, next) => {
  try {
    const card = await req.prisma.cardJuridico.findUnique({ where: { id: req.params.id } });
    if (!card) return res.status(404).json({ error: 'Card não encontrado.' });

    const eventos = await req.prisma.historicoCardJuridico.findMany({
      where: { cardId: req.params.id },
      orderBy: { criadoEm: 'desc' },
    });

    // "usuarioId" é uma coluna solta, sem FK (ver docblock do model) —
    // resolvido aqui num select à parte, nunca via "include"/relação do
    // Prisma (não existe uma pra usar). null tanto pra ação via API key
    // (usuarioId já nasce null, ver registrarHistoricoCard) quanto pro
    // usuário já ter sido removido depois — os dois casos ficam
    // distinguíveis pro frontend por "usuario_id" ser ou não null.
    const usuarioIds = [...new Set(eventos.map((e) => e.usuarioId).filter(Boolean))];
    const usuarios = usuarioIds.length
      ? await req.prisma.usuario.findMany({ where: { id: { in: usuarioIds } }, select: { id: true, nome: true } })
      : [];
    const nomePorUsuarioId = new Map(usuarios.map((u) => [u.id, u.nome]));

    res.json(
      eventos.map((e) => ({
        id: e.id,
        campo_alterado: e.campoAlterado,
        valor_anterior: e.valorAnterior,
        valor_novo: e.valorNovo,
        usuario_id: e.usuarioId,
        usuario_nome: e.usuarioId ? (nomePorUsuarioId.get(e.usuarioId) ?? null) : null,
        criado_em: e.criadoEm,
      }))
    );
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/juridico/cards/:id — remove e reindexa a ordem da etapa
 * (fecha o buraco). Registra o evento final "exclusao" no histórico ANTES
 * do delete de verdade (ver escopo do ajuste "Log de atualização dos cards
 * do Jurídico"), na mesma transação — o registro de histórico não tem FK
 * pro card (ver docblock do model), então continua consultável depois que
 * o card já não existe mais.
 */
exports.removerCard = async (req, res, next) => {
  try {
    const existente = await req.prisma.cardJuridico.findUnique({ where: { id: req.params.id } });
    if (!existente) return res.status(404).json({ error: 'Card não encontrado.' });

    await req.prisma.$transaction(async (tx) => {
      await registrarHistoricoCard(tx, req, {
        cardId: existente.id,
        campoAlterado: 'exclusao',
        valorAnterior: existente.associadoId ? `associado_id:${existente.associadoId}` : existente.titulo,
      });

      await tx.cardJuridico.delete({ where: { id: req.params.id } });

      const restantes = await tx.cardJuridico.findMany({
        where: { etapaId: existente.etapaId },
        orderBy: { ordem: 'asc' },
      });
      for (let i = 0; i < restantes.length; i++) {
        if (restantes[i].ordem !== i) {
          await tx.cardJuridico.update({ where: { id: restantes[i].id }, data: { ordem: i } });
        }
      }
    });

    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Card não encontrado.' });
    next(err);
  }
};
