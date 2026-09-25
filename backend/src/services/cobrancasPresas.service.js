const prismaBase = require('../config/prisma');

/**
 * Reconciliação de cobranças "presas" via `pagamentos_asaas` (AJUSTE 18).
 *
 * CONTEXTO: `POST /api/sync` já reconcilia cobranças pagas com base no
 * payload do n8n (ver docblock de `exports.sync` em sync.controller.js),
 * mas depende de uma janela de vencimento ROLANTE (`-53/+5 dias de hoje`,
 * calculada pelo n8n a cada chamada) — qualquer cobrança cujo `vencimento`
 * envelheça além do início dessa janela fica permanentemente fora de
 * alcance de QUALQUER reconciliação futura baseada nesse payload, mesmo
 * que seja paga depois (achado da investigação do caso "Marcela", CPF
 * 27649948000129 — ver `scripts/diagnostico-marcela-cobranca-presa.js` e
 * `scripts/diagnostico-cobrancas-presas-sistemico.js`).
 *
 * Este serviço é a segunda via, independente do payload do n8n: usa
 * `pagamentos_asaas` (atualizado continuamente via webhook — AJUSTE 14 —
 * sem limite de janela por data de vencimento) como fonte de verdade pra
 * decidir se uma cobrança específica já foi paga, casando pelo `id`
 * (Asaas) contra `Cobranca.idExterno`. Comparação SEMPRE por cobrança
 * individual, nunca por associado inteiro — um associado pode ter uma
 * cobrança já paga e outra genuinamente em aberto ao mesmo tempo (ex.:
 * parcela de renegociação), e só a paga deve ser tocada.
 *
 * Usado por três caminhos, nenhum reimplementando a lógica de
 * busca/classificação/aplicação:
 *   1. `scripts/diagnostico-cobrancas-presas-sistemico.js` — relatório
 *      manual, com `--confirm` opcional pra remediar pontualmente.
 *   2. `scripts/reconciliar-cobrancas-quitadas-no-asaas.js` — job
 *      periódico (rede de segurança contínua, pensado pra rodar diário via
 *      agendador externo).
 *   3. `POST /api/sync/reconciliar-cobrancas-quitadas` — mesmo job,
 *      exposto como endpoint HTTP pra quem preferir disparar via um
 *      workflow n8n agendado em vez de rodar o script direto no host
 *      (mesmo padrão de `POST /api/inadimplencia/reconciliar-pagamentos`
 *      pro AJUSTE 14).
 *
 * NÃO substitui `POST /api/sync` — continua sendo a fonte primária de
 * novidade (cobrança nova, valor mudado, etc.). Isto só fecha o buraco
 * temporal que a janela rolante deixa aberto pra quitações.
 */

/**
 * AJUSTE 22 (revisão pré-commit) — inclui "CONFIRMED" (cartão de crédito
 * aprovado, repasse pro lojista ainda pendente de cair na conta) a partir
 * desta revisão. Critério único: em `Cobranca.status`, CONFIRMED conta como
 * quitado em TODOS os caminhos que usam esta constante — "presas" (esta
 * função, `buscarCobrancasPresas`/`aplicarQuitacao`, usada pelo job diário e
 * pelo diagnóstico manual), `classificarCandidataAusente`
 * (`cobrancasRemovidas.service.js`, POST /api/sync e a reconciliação de
 * "sem correspondência") e `reverterRemovidaParaStatusAsaas` (webhook
 * PAYMENT_RESTORED) — nenhum caminho mais tem seu próprio critério
 * divergente (o script CLI do job diário também, ver
 * `scripts/reconciliar-cobrancas-quitadas-no-asaas.js`, que agora reaproveita
 * a mesma função do endpoint HTTP em vez de ter lógica própria).
 *
 * IMPORTANTE — isto NÃO afeta a tela de Taxa de Inadimplência
 * (`GET /api/inadimplencia/*`, `inadimplencia.controller.js`): aquele
 * controller nunca importa esta constante, lê `PagamentoAsaas.status` cru
 * direto e tem seus próprios critérios (`STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA`
 * etc.) — mudar esta constante não muda "Total recebido"/faixas/críticos
 * daquela tela em nada.
 */
const STATUS_ADIMPLENTE_ASAAS = ['RECEIVED', 'RECEIVED_IN_CASH', 'CONFIRMED'];
const STATUS_CONSIDERADOS_ABERTOS = ['pending', 'overdue'];

/**
 * Busca cobranças pending/overdue com id_externo preenchido (opcionalmente
 * restrito a uma franquia) e classifica cada uma comparando com o
 * PagamentoAsaas de MESMO id — "presa" só quando esse pagamento específico
 * já está em STATUS_ADIMPLENTE_ASAAS (RECEIVED/RECEIVED_IN_CASH/CONFIRMED).
 * Só leitura, não aplica nada.
 *
 * @param {{ franquiaId?: string|null }} opts
 * @returns {Promise<{
 *   totalAbertas: number,
 *   semIdExterno: Array,
 *   comIdExterno: Array,
 *   presas: Array<{ cobranca: object, pagamento: object }>,
 *   semCorrespondencia: Array,
 *   naoQuitadasNoAsaas: Array<{ cobranca: object, pagamento: object }>,
 * }>}
 */
async function buscarCobrancasPresas({ franquiaId = null } = {}) {
  const cobrancasAbertas = await prismaBase.cobranca.findMany({
    where: {
      status: { in: STATUS_CONSIDERADOS_ABERTOS },
      ...(franquiaId ? { associado: { franquiaId } } : {}),
    },
    include: { associado: { select: { id: true, nome: true, cpfCnpj: true, franquiaId: true } } },
    orderBy: [{ associado: { nome: 'asc' } }, { vencimento: 'asc' }],
  });

  const comIdExterno = cobrancasAbertas.filter((c) => c.idExterno);
  const semIdExterno = cobrancasAbertas.filter((c) => !c.idExterno);

  const idsExternos = comIdExterno.map((c) => c.idExterno);
  const pagamentosCorrespondentes = idsExternos.length
    ? await prismaBase.pagamentoAsaas.findMany({ where: { id: { in: idsExternos } } })
    : [];
  const pagamentoPorId = new Map(pagamentosCorrespondentes.map((p) => [p.id, p]));

  const presas = [];
  const semCorrespondencia = [];
  const naoQuitadasNoAsaas = [];

  for (const c of comIdExterno) {
    const pagamento = pagamentoPorId.get(c.idExterno);
    if (!pagamento) {
      semCorrespondencia.push(c);
      continue;
    }
    if (STATUS_ADIMPLENTE_ASAAS.includes(pagamento.status)) {
      presas.push({ cobranca: c, pagamento });
    } else {
      naoQuitadasNoAsaas.push({ cobranca: c, pagamento });
    }
  }

  return { totalAbertas: cobrancasAbertas.length, semIdExterno, comIdExterno, presas, semCorrespondencia, naoQuitadasNoAsaas };
}

/**
 * Aplica a quitação de verdade — `status: 'quitada'`, `quitadaEm` a partir
 * da primeira data disponível, nesta ordem: `paymentDate` ?? `clientPaymentDate`
 * ?? `confirmedDate` ?? "agora" (AJUSTE 22, revisão pré-commit). Preserva
 * quando o pagamento realmente aconteceu, pra não distorcer relatórios que
 * olhem pra `quitada_em` no futuro. Motivo da cadeia (antes só `paymentDate`):
 * pra CONFIRMED (cartão aprovado), `paymentDate` costuma vir `null` até o
 * repasse pro lojista terminar de processar — `confirmedDate`/
 * `clientPaymentDate` já vêm preenchidos nesse meio tempo (ver docblock dos
 * campos em schema.prisma), então usá-los evita cair em "agora"
 * desnecessariamente pro caso mais comum de CONFIRMED. Todos gravados como
 * string "YYYY-MM-DD" (ver schema.prisma); a data escolhida é convertida pra
 * meia-noite UTC daquele dia. Só quando NENHUMA das três existe (RECEIVED/
 * RECEIVED_IN_CASH sem `paymentDate` — caso de borda não esperado na
 * prática — ou um CONFIRMED tão recente que nenhuma das três já chegou) cai
 * pra "agora", e o item vem marcado com `quitadaEmAproximada: true` no
 * retorno, pra quem chamou poder sinalizar isso no relatório.
 *
 * Aceita opcionalmente um client Prisma já escopado por franquia (ex.:
 * `req.prisma`, ver `config/prismaComEscopo.js`) — mesma defesa em
 * profundidade documentada em `sync.controller.js`: `buscarCobrancasPresas`
 * já filtra por franquia na leitura, e passar um client escopado aqui
 * garante que o `update` também não alcançaria, por engano, o id de outra
 * franquia. Scripts (sem sessão de franquia própria) usam o client base
 * (padrão), já que eles mesmos escolhem explicitamente o escopo via
 * `--franquia`/varredura completa.
 *
 * @param {Array<{ cobranca: object, pagamento: object }>} presas
 * @param {{ prisma?: object }} opts
 * @returns {Promise<Array<{ cobrancaId: string, quitadaEm: Date, quitadaEmAproximada: boolean }>>}
 */
async function aplicarQuitacao(presas, { prisma = prismaBase } = {}) {
  const aplicados = [];
  for (const { cobranca, pagamento } of presas) {
    const dataQuitacao = pagamento.paymentDate ?? pagamento.clientPaymentDate ?? pagamento.confirmedDate ?? null;
    const quitadaEmAproximada = !dataQuitacao;
    const quitadaEm = dataQuitacao ? new Date(`${dataQuitacao}T00:00:00.000Z`) : new Date();

    await prisma.cobranca.update({
      where: { id: cobranca.id },
      data: {
        status: 'quitada',
        quitadaEm,
        // AJUSTE 22 — limpa removidaEm sempre, mesmo quando a cobrança nunca
        // esteve "removida" (fica null->null, no-op inofensivo nesse caso).
        // Necessário pro caminho novo, via reverterRemovidaParaStatusAsaas
        // (webhook PAYMENT_RESTORED de uma cobrança que estava "removida" e
        // volta já RECEIVED): sem isso, "quitada" ficaria com um
        // removidaEm remanescente — inconsistente, os dois campos nunca
        // devem estar preenchidos ao mesmo tempo.
        removidaEm: null,
      },
    });

    aplicados.push({ cobrancaId: cobranca.id, quitadaEm, quitadaEmAproximada });
  }
  return aplicados;
}

module.exports = {
  STATUS_ADIMPLENTE_ASAAS,
  STATUS_CONSIDERADOS_ABERTOS,
  buscarCobrancasPresas,
  aplicarQuitacao,
};
