/**
 * Lógica de card do Kanban Jurídico compartilhada entre dois pontos que
 * agora criam/excluem card: juridico.controller.js (mutações manuais pela
 * tela) e associados.controller.js (criação/exclusão AUTOMÁTICA de card ao
 * marcar/desmarcar "em_juridico" no Dashboard — ver AJUSTE 10, README).
 * Extraído pra um módulo próprio pra não duplicar a regra de histórico
 * (nunca perder o log de criação/exclusão, sempre gravado ANTES do delete
 * de verdade e na MESMA transação da mutação) nos dois lugares.
 */

/**
 * Registra um evento no histórico do card (ver HistoricoCardJuridico em
 * schema.prisma) — sempre chamado dentro da MESMA transação da mutação que
 * o originou (create/update/mover/delete/automático), usando "tx" (não
 * "req.prisma" direto), pro log nunca ficar dessincronizado da mudança real
 * caso algo falhe no meio do caminho. "usuarioId" vem de "req.auth.user" —
 * só existe em sessões JWT (painel); sessões de API key não têm esse campo,
 * e o histórico aceita null nesse caso (ver docblock do model).
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
 * Cria automaticamente um card vinculado ao associado na primeira etapa
 * (menor "ordem" cadastrada) do quadro Jurídico da franquia — usado quando
 * o associado é marcado como "em_juridico" no Dashboard (AJUSTE 10, ver
 * PATCH /api/associados/:cpfCnpj/juridico). Mesma regra de um card manual
 * "Vincular associado": nasce sem título/descrição/observações/
 * responsável/prazo — nome/cpf_cnpj/telefone/valor em aberto vêm sempre ao
 * vivo da relação com o associado (ver serializeCard em
 * juridico.controller.js), nunca copiados estaticamente pro card aqui.
 *
 * Não cria (e não lança erro) se a franquia ainda não tem NENHUMA etapa
 * cadastrada — não há em qual coluna colocar o card; quem chama decide
 * como avisar disso (ver "sem_etapas" no retorno). Verificar se já existe
 * um card pro associado é responsabilidade de quem chama (ver
 * `buscarCardAbertoDoAssociado` abaixo) — esta função sempre cria, nunca
 * checa duplicidade sozinha. Registra o evento "criacao" no histórico, na
 * mesma transação.
 */
async function criarCardAutomaticoParaAssociado(tx, req, associadoId) {
  const primeiraEtapa = await tx.etapaJuridico.findFirst({ orderBy: { ordem: 'asc' } });
  if (!primeiraEtapa) {
    return { criado: false, motivo: 'sem_etapas' };
  }

  const max = await tx.cardJuridico.aggregate({ _max: { ordem: true }, where: { etapaId: primeiraEtapa.id } });
  const ordem = (max._max.ordem ?? -1) + 1;

  const card = await tx.cardJuridico.create({
    data: { etapaId: primeiraEtapa.id, ordem, associadoId },
  });

  await registrarHistoricoCard(tx, req, {
    cardId: card.id,
    campoAlterado: 'criacao',
    valorNovo: `associado_id:${associadoId}`,
  });

  return { criado: true, card, etapa: primeiraEtapa };
}

/**
 * Busca um card ABERTO já vinculado ao associado informado — "aberto" =
 * qualquer card não excluído, em qualquer etapa (não existe hoje uma
 * coluna "arquivado" que precisasse ser excluída dessa checagem; ver
 * escopo do AJUSTE 10). Usada antes de criar um card automático, pra não
 * duplicar. Se houver mais de um (situação só possível antes deste ajuste
 * existir, ou por vínculo manual duplicado), devolve o primeiro por
 * `criado_em` — quem chama só precisa de UM pra apontar o link no aviso.
 */
async function buscarCardAbertoDoAssociado(tx, associadoId) {
  return tx.cardJuridico.findFirst({
    where: { associadoId },
    orderBy: { criadoEm: 'asc' },
  });
}

/**
 * Exclui (hard delete) TODOS os cards vinculados a um associado — usado
 * quando o associado é desmarcado como "em_juridico" no Dashboard (AJUSTE
 * 10). Pode haver mais de um card pro mesmo associado (só possível antes
 * deste ajuste existir, ou por vínculo manual) — exclui todos, não só o
 * mais recente, e devolve quantos foram excluídos. Não importa em qual
 * etapa cada card está (mesmo já movido manualmente pra uma etapa mais
 * avançada, ex. "Processos em Andamento") — só o vínculo com o associado
 * decide, exatamente como pedido no escopo. Cada exclusão grava o evento
 * "exclusao" no histórico ANTES do delete de verdade (mesmo padrão de
 * removerCard em juridico.controller.js — o log não tem FK pro card, ver
 * docblock do model, então continua consultável depois) e reindexa a
 * "ordem" dos cards restantes na etapa de cada card excluído.
 */
async function excluirCardsDoAssociado(tx, req, associadoId) {
  const cards = await tx.cardJuridico.findMany({ where: { associadoId } });

  for (const card of cards) {
    await registrarHistoricoCard(tx, req, {
      cardId: card.id,
      campoAlterado: 'exclusao',
      valorAnterior: `associado_id:${associadoId}`,
    });

    await tx.cardJuridico.delete({ where: { id: card.id } });

    const restantes = await tx.cardJuridico.findMany({
      where: { etapaId: card.etapaId },
      orderBy: { ordem: 'asc' },
    });
    for (let i = 0; i < restantes.length; i++) {
      if (restantes[i].ordem !== i) {
        await tx.cardJuridico.update({ where: { id: restantes[i].id }, data: { ordem: i } });
      }
    }
  }

  return cards.length;
}

module.exports = {
  registrarHistoricoCard,
  criarCardAutomaticoParaAssociado,
  buscarCardAbertoDoAssociado,
  excluirCardsDoAssociado,
};
