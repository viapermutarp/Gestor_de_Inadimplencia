const { buscarClientePorCpfCnpj } = require('../services/asaas.service');
const { buscarCobrancasPresas, aplicarQuitacao } = require('../services/cobrancasPresas.service');
const {
  LIMITE_GUARDRAIL_REMOVIDAS,
  reconciliarCandidatasEmLote,
  confirmarERemoverSemCorrespondencia,
  reverterRemovidaSeReapareceuNoPayload,
} = require('../services/cobrancasRemovidas.service');
const { apenasDigitos } = require('../lib/cpfCnpj');

const STATUS_VALIDOS = ['pending', 'overdue', 'paid'];

// AJUSTE 18 — guardrail de segurança pro endpoint de reconciliação via
// pagamentos_asaas (ver exports.reconciliarCobrancasQuitadas abaixo):
// mesmo limiar/mesma lógica de scripts/reconciliar-cobrancas-quitadas-no-asaas.js
// e scripts/reconciliar-cobrancas-presas.js — o endpoint HTTP não tem como
// pedir confirmação interativa (--force), então, ao estourar o limite, só
// recusa aplicar e devolve 409 (quem chamou — um workflow n8n agendado —
// decide se alerta alguém ou tenta de novo mais tarde).
const LIMITE_SEGURANCA_RECONCILIACAO_COBRANCAS = 60;

// Status considerados "em aberto" no banco — mesmo conjunto usado por
// GET /api/associados e GET /api/associados/resumo (ver COBRANCAS_ABERTAS
// em associados.controller.js). Usado pela reconciliação de POST /api/sync
// para decidir quais cobranças existentes ainda contam como pendências
// ativas de um associado.
const STATUS_CONSIDERADOS_ABERTOS = ['pending', 'overdue'];

// Timeout generoso pro webhook do n8n usado por POST /api/sync/atualizar —
// ele pagina no Asaas antes de responder, então pode demorar bem mais que
// uma chamada HTTP comum (mas não deve travar o botão "Atualizar" do
// frontend indefinidamente se o n8n ficar preso). Configurável via
// SYNC_WEBHOOK_TIMEOUT_MS (útil pra testes automatizados de timeout sem
// esperar 30s de verdade); sem essa variável, usa os 30s padrão.
const TIMEOUT_WEBHOOK_ATUALIZAR_MS = Number(process.env.SYNC_WEBHOOK_TIMEOUT_MS) || 30000;

/**
 * Registra uma linha em sync_log para cada chamada a POST /api/sync
 * (sucesso ou falha). Nunca lança erro — uma falha ao gravar o log não
 * pode derrubar a resposta do /sync em si.
 *
 * Multi-franquia — Fase 3: recebe "reqPrisma" (o "req.prisma" já escopado
 * pela franquia da API key usada — ver escopoFranquia.js) em vez de
 * resolver a franquia via a ponte temporária franquiaPadrao.service.js —
 * o "create" da extension injeta "franquiaId" automaticamente.
 */
async function registrarSyncLog(reqPrisma, { total, sucesso }) {
  try {
    await reqPrisma.syncLog.create({
      data: { totalAssociadosProcessados: total, sucesso },
    });
  } catch (err) {
    console.error('[sync] Falha ao registrar sync_log:', err.message);
  }
}

/**
 * POST /api/sync
 *
 * Corpo esperado: array de associados, cada um podendo trazer um array
 * "cobrancas" com as cobranças em aberto/pagas daquele associado.
 *
 * [
 *   {
 *     "cpf_cnpj": "123.456.789-00",
 *     "nome": "Fulano de Tal",
 *     "telefone": "11999999999",
 *     "email": "fulano@email.com",
 *     "cobrancas": [
 *       {
 *         "id_externo": "pay_xxxxxxxxxxxxx",
 *         "valor": 150.5,
 *         "vencimento": "2026-08-10",
 *         "dias_diferenca": -2,
 *         "link_pagamento": "https://...",
 *         "descricao": "Mensalidade agosto/2026",
 *         "status": "overdue"
 *       }
 *     ]
 *   }
 * ]
 *
 * Alternativamente, o corpo pode ser um objeto com "associados" (mesmo
 * formato do array acima) e "janela" — ver seção de reconciliação abaixo
 * pra quando/por que usar essa forma:
 *
 * {
 *   "janela": { "inicio": "2026-07-03", "fim": "2026-08-30" },
 *   "associados": [ ... ]
 * }
 *
 * Upsert de associado: chave = cpf_cnpj.
 *
 * Upsert de cobrança:
 *   1. Se a cobrança trouxer "id_externo" (ex.: o ID gerado pelo Asaas para
 *      a cobrança, tipo "pay_xxxxxxxxxxxxx"), o casamento é feito por esse
 *      campo — é o identificador mais confiável, tem prioridade máxima.
 *   2. Se "id_externo" não vier no payload (compatibilidade com integrações
 *      antigas que ainda não enviam esse campo), mantém o fallback anterior:
 *      casa por (associado_id, vencimento, descricao).
 *
 * Reconciliação (quitação automática): cobre o caso de uma cobrança ser paga
 * no Asaas — o n8n simplesmente para de trazê-la nas próximas chamadas (a
 * consulta lá filtra por status PENDING/OVERDUE), então sem reconciliação a
 * cobrança ficava presa no banco para sempre no último status sincronizado,
 * contando indevidamente como "em aberto" no Dashboard. Não é hard delete —
 * o registro continua no banco, só muda para "quitada" (histórico
 * financeiro preservado).
 *
 * Tem dois modos, dependendo de o corpo trazer "janela" ou não:
 *
 * MODO GLOBAL (recomendado — requer "janela" no corpo):
 * ```
 * {
 *   "janela": { "inicio": "2026-07-03", "fim": "2026-08-30" },
 *   "associados": [ ... ]
 * }
 * ```
 * "janela" descreve o intervalo de vencimento usado pela consulta ao Asaas
 * que gerou este payload. Nesse modo, a reconciliação roda **uma vez só,
 * pra base inteira**, ao final do processamento: toda cobrança pending/
 * overdue no banco cujo "vencimento" caia dentro da janela e cujo id
 * (interno) não foi tocado por NENHUM associado deste payload é marcada
 * como quitada — mesmo que o associado dela não tenha aparecido em
 * "associados" (caso comum: quando TODAS as cobranças de um associado são
 * pagas, o agrupamento do n8n para de gerar uma entrada pra ele, então o
 * associado inteiro some do payload; sem o modo global, essas cobranças
 * nunca eram reconciliadas). Cobranças com vencimento FORA da janela não são
 * tocadas de jeito nenhum — o Asaas nem foi consultado sobre elas nesta
 * chamada, então não há informação nova pra agir.
 *
 * MODO POR ASSOCIADO (compatibilidade — sem "janela" no corpo):
 * Para cada associado cujo registro traga "cobrancas" como array (mesmo
 * vazio), toda cobrança já existente no banco PARA ESSE ASSOCIADO com status
 * pending/overdue que não foi criada/atualizada por esta chamada é marcada
 * como quitada. Tem a limitação que motivou o modo global: se um associado
 * inteiro sumir do payload (todas as cobranças dele pagas), suas cobranças
 * presas nunca são examinadas, porque o loop nem chega a rodar pra ele.
 * Mantido só até o n8n passar a enviar "janela" em todo payload.
 *
 * Em ambos os modos: se uma cobrança marcada "quitada" voltar a aparecer
 * num payload seguinte (ex.: reversão de pagamento no Asaas), a quitação é
 * desfeita automaticamente pelo upsert normal (quitada_em volta a null).
 *
 * AJUSTE 22 — "removida" (cobrança apagada no Asaas, nunca paga — ver
 * src/services/cobrancasRemovidas.service.js para o contexto completo e por
 * que nunca reaproveita "quitada"): duas mudanças neste endpoint,
 * decorrentes do mesmo problema raiz.
 *
 * 1) Reconciliação de "ausente do payload" NÃO marca mais "quitada" às
 *    cegas (o `updateMany` direto que existia antes desta versão). Pra cada
 *    candidata (pending/overdue, não tocada por este payload, no modo por
 *    associado OU no modo global — ver `reconciliarCandidatasEmLote`):
 *      a) se `pagamentos_asaas` já tem esse id em STATUS_ADIMPLENTE_ASAAS
 *         (RECEIVED/RECEIVED_IN_CASH/CONFIRMED — critério ÚNICO, revisão
 *         pré-commit: a mesma constante em cobrancasPresas.service.js
 *         decide "quitada" em TODOS os caminhos, incluindo a detecção de
 *         "presas" do job diário e a reversão do webhook PAYMENT_RESTORED;
 *         CONFIRMED existe pra cartão de crédito aprovado mas ainda
 *         aguardando repasse não voltar a aparecer como "em aberto" no
 *         Dashboard só porque saiu do payload, mesmo comportamento de antes
 *         do AJUSTE 22) -> quitada (quitada_em = paymentDate ??
 *         clientPaymentDate ?? confirmedDate ?? agora — ver `aplicarQuitacao`);
 *      b) senão, consulta a API do Asaas ao vivo — `deleted: true` ->
 *         removida (removida_em = agora, SALVO se o guardrail de remoção
 *         bloquear — ver LIMITE_GUARDRAIL_REMOVIDAS em
 *         cobrancasRemovidas.service.js: mais de 20 candidatas confirmadas
 *         como removida NUMA ÚNICA chamada a `reconciliarCandidatasEmLote`
 *         e NENHUMA é aplicada, contam em `removidas_bloqueadas_guardrail`);
 *         existe e em STATUS_ADIMPLENTE_ASAAS -> quitada (mesmo critério do
 *         item a, só que confirmado ao vivo); qualquer outra resposta
 *         (existe sob outro status, 404, ou falha do Asaas) -> NÃO MEXE, só
 *         entra em "erros" pra revisão manual. Uma falha ao consultar o
 *         Asaas (timeout, 5xx) nunca aplica nada — fica pending/overdue até
 *         a próxima chamada tentar de novo.
 *    Efeito prático: este endpoint agora pode fazer chamadas HTTP pro Asaas
 *    (uma por candidata sem correspondência local, concorrência limitada —
 *    ver CONCORRENCIA_CONFIRMACAO_ASAAS), então pode ficar mais lento que
 *    antes quando há muitas cobranças "sumidas" no mesmo payload (ver
 *    seção "Volume de chamadas ao Asaas" no README pra números).
 *
 * 2) Se uma Cobranca JÁ MARCADA "removida" reaparecer num payload (o
 *    próprio n8n volta a trazer aquele id_externo, pending/overdue) — desde
 *    a revisão pré-commit (item 5), NÃO é mais um "ignora e reporta" cego:
 *    `reverterRemovidaSeReapareceuNoPayload` consulta a API do Asaas AO VIVO
 *    pra esse id_externo antes de decidir —
 *      - Asaas confirma `deleted: false` -> reverte pro status TRAZIDO PELO
 *        PAYLOAD (não necessariamente o que a cobrança tinha antes de ser
 *        removida — o payload é o dado mais fresco disponível) e limpa
 *        `removidaEm`; conta em `cobrancas_removida_revertida`.
 *      - qualquer outra resposta (ainda `deleted: true`, 404, ou falha do
 *        Asaas) -> NÃO MEXE, permanece "removida", entra em "erros" pra
 *        revisão humana; conta em `cobrancas_removida_reaparecida`.
 *    O payload do n8n sozinho continua NÃO sendo confirmação suficiente
 *    (pode estar atrasado/com uma janela obsoleta em relação a uma remoção
 *    recém-processada) — só a consulta ao vivo autoriza a reversão aqui.
 *    Isto é DIFERENTE do webhook `PAYMENT_RESTORED` (evento ao vivo do
 *    próprio Asaas — já é a confirmação em si, sem precisar de uma chamada
 *    extra, ver `reverterRemovidaParaStatusAsaas`).
 */
exports.sync = async (req, res, next) => {
  let totalAssociadosProcessados = 0;

  try {
    const corpoEhArray = Array.isArray(req.body);
    const registros = corpoEhArray ? req.body : req.body?.associados;

    if (!Array.isArray(registros) || registros.length === 0) {
      await registrarSyncLog(req.prisma, { total: 0, sucesso: false });
      return res.status(400).json({ error: 'Envie um array de associados no corpo da requisição.' });
    }

    // "janela" só é lida quando o corpo é um objeto (não um array na raiz —
    // não haveria onde colocá-la). Precisa de "inicio"/"fim" parseáveis como
    // data e "inicio" <= "fim"; qualquer coisa fora disso é tratada como
    // "sem janela" (cai no modo por-associado, não quebra a chamada).
    let janela = null;
    if (!corpoEhArray && req.body?.janela && typeof req.body.janela === 'object') {
      const inicioDate = new Date(req.body.janela.inicio);
      const fimDate = new Date(req.body.janela.fim);
      if (!Number.isNaN(inicioDate.getTime()) && !Number.isNaN(fimDate.getTime()) && inicioDate <= fimDate) {
        janela = { inicio: inicioDate, fim: fimDate };
      }
    }

    totalAssociadosProcessados = registros.length;

    let associadosCriados = 0;
    let associadosAtualizados = 0;
    let cobrancasCriadas = 0;
    let cobrancasAtualizadas = 0;
    let cobrancasQuitadas = 0;
    let cobrancasRemovidas = 0;
    let cobrancasRemovidaReaparecida = 0;
    let cobrancasRemovidaRevertida = 0;
    // AJUSTE 22 (revisão pré-commit, item 4) — candidatas a "removida" que
    // ficaram de fora porque o guardrail de segurança bloqueou a chamada
    // inteira (ver LIMITE_GUARDRAIL_REMOVIDAS em cobrancasRemovidas.service.js
    // e reconciliarCandidatasEmLote) — permanecem pending/overdue, cada uma
    // também detalhada em "erros".
    let cobrancasRemovidaBloqueadaGuardrail = 0;
    const erros = [];
    // Ids (internos) de toda cobrança criada/atualizada por QUALQUER
    // associado deste payload — só usado no modo global (com "janela"), pra
    // reconciliar a base inteira numa passada só, no final.
    const idsTratadosGlobal = new Set();

    for (const [index, registro] of registros.entries()) {
      const { cpf_cnpj: cpfCnpj, nome, telefone, email, cobrancas } = registro || {};

      if (!cpfCnpj || !nome || !telefone) {
        erros.push({ index, cpf_cnpj: cpfCnpj || null, erro: 'cpf_cnpj, nome e telefone são obrigatórios.' });
        continue;
      }

      // Correção pós-AJUSTE 19: busca pela versão só-dígitos, não pelo
      // valor exato de "cpfCnpj" — o Asaas já manda o CPF/CNPJ sempre no
      // mesmo formato, mas esta checagem existe só pra contar
      // criados/atualizados (estatística do sync_log), então usa a mesma
      // normalização do resto do sistema por consistência, mesmo que o
      // risco prático de formato divergente seja baixo aqui.
      const existente = await req.prisma.associado.findFirst({
        where: { cpfCnpjDigits: apenasDigitos(cpfCnpj) },
      });

      // Multi-franquia — Fase 3: "franquiaId" não é mais resolvido aqui —
      // o "create" da extension injeta automaticamente a franquia da
      // própria API key usada (ver prismaComEscopo.js). Se "cpfCnpj" já
      // existir em OUTRA franquia (cpf_cnpj é único globalmente, não por
      // franquia — ver schema.prisma), a extension rejeita com um erro
      // claro de conflito em vez de sobrescrever o registro de outra
      // franquia ou criar duplicata. A comparação em si (inclusive entre
      // franquias) é feita pela versão só-dígitos — ver
      // executarUpsertEscopado em prismaComEscopo.js.
      const associado = await req.prisma.associado.upsert({
        where: { cpfCnpj },
        update: { nome, telefone, email: email ?? null },
        create: { cpfCnpj, nome, telefone, email: email ?? null },
      });

      if (existente) {
        associadosAtualizados += 1;
      } else {
        associadosCriados += 1;
      }

      // AJUSTE 9 — popula Associado.nomeAsaas (nome verbatim do Asaas, com
      // o prefixo numérico dele, exibido em "Dados cadastrais" no modal) SÓ
      // quando ainda está nulo/vazio. Sync incremental reenvia o mesmo
      // associado em aberto repetidamente (a cada "Sync Horário"/"Atualizar"),
      // então nunca re-buscamos nem sobrescrevemos um valor já preenchido —
      // uma atualização completa exige rodar o script de backfill de novo
      // (decisão explícita do usuário, ver README). Uma falha aqui (Asaas
      // fora do ar, chave inválida, cliente não encontrado) é só logada —
      // não pode derrubar o sync do associado/cobranças em si.
      if (!associado.nomeAsaas) {
        try {
          const nomeAsaas = await buscarClientePorCpfCnpj(cpfCnpj, req.franquiaId);
          if (nomeAsaas) {
            // "associado.id" (não "cpfCnpj" — o valor local do loop) —
            // depois da correção pós-AJUSTE 19, o registro gravado pode ter
            // um "cpf_cnpj" num formato diferente do que veio neste payload
            // (mesmo dígitos, pontuação diferente); "id" sempre identifica
            // a linha certa, independente disso.
            await req.prisma.associado.update({
              where: { id: associado.id },
              data: { nomeAsaas },
            });
          }
        } catch (err) {
          console.error(`[sync] Falha ao buscar nomeAsaas para ${cpfCnpj}:`, err.message);
        }
      }

      if (Array.isArray(cobrancas)) {
        // Ids (internos, do nosso banco) de toda cobrança criada ou
        // atualizada nesta chamada para este associado — usado depois do
        // loop para achar as que NÃO foram tocadas (candidatas a "quitada").
        const idsTratados = new Set();

        for (const cobranca of cobrancas) {
          const {
            id_externo: idExternoRaw,
            valor,
            vencimento,
            dias_diferenca: diasDiferenca,
            link_pagamento: linkPagamento,
            descricao,
            status,
          } = cobranca || {};

          const idExterno =
            typeof idExternoRaw === 'string' && idExternoRaw.trim() !== '' ? idExternoRaw.trim() : null;

          if (valor === undefined || valor === null || !vencimento) {
            erros.push({
              index,
              cpf_cnpj: cpfCnpj,
              id_externo: idExterno,
              erro: 'Cobrança inválida: "valor" e "vencimento" são obrigatórios.',
            });
            continue;
          }

          const statusFinal = STATUS_VALIDOS.includes(status) ? status : 'pending';
          const vencimentoDate = new Date(vencimento);

          if (Number.isNaN(vencimentoDate.getTime())) {
            erros.push({
              index,
              cpf_cnpj: cpfCnpj,
              id_externo: idExterno,
              erro: `Data de vencimento inválida: ${vencimento}`,
            });
            continue;
          }

          const dadosComuns = {
            associadoId: associado.id,
            valor,
            vencimento: vencimentoDate,
            diasDiferenca: diasDiferenca ?? 0,
            linkPagamento: linkPagamento ?? null,
            descricao: descricao ?? null,
            status: statusFinal,
          };

          let cobrancaExistente;

          if (idExterno) {
            // Prioridade máxima: casa pelo identificador externo (ex.: ID do Asaas).
            cobrancaExistente = await req.prisma.cobranca.findUnique({ where: { idExterno } });
          } else {
            // Fallback (compatibilidade retroativa): casa por associado + vencimento + descrição.
            // Só considera cobranças que também não têm id_externo, para não "roubar" e
            // sobrescrever por engano um registro que já está vinculado a um ID do Asaas.
            cobrancaExistente = await req.prisma.cobranca.findFirst({
              where: {
                associadoId: associado.id,
                vencimento: vencimentoDate,
                descricao: descricao ?? null,
                idExterno: null,
              },
            });
          }

          if (cobrancaExistente && cobrancaExistente.status === 'removida') {
            // AJUSTE 22 (revisão pré-commit, item 5) — cobrança marcada
            // "removida" reapareceu no payload do n8n: consulta a API do
            // Asaas AO VIVO antes de decidir (ver docblock de exports.sync
            // acima, item 2, e reverterRemovidaSeReapareceuNoPayload em
            // cobrancasRemovidas.service.js) — o payload do n8n sozinho não
            // é confirmação suficiente, mas também não é mais ignorado
            // cegamente como antes desta revisão.
            const resultadoReversao = await reverterRemovidaSeReapareceuNoPayload(
              cobrancaExistente,
              req.franquiaId,
              dadosComuns,
              { prisma: req.prisma }
            );

            if (resultadoReversao.revertida) {
              cobrancasRemovidaRevertida += 1;
              idsTratados.add(cobrancaExistente.id);
              idsTratadosGlobal.add(cobrancaExistente.id);
              cobrancasAtualizadas += 1;
            } else {
              cobrancasRemovidaReaparecida += 1;
              erros.push({
                index,
                cpf_cnpj: cpfCnpj,
                id_externo: idExterno,
                erro:
                  'Cobrança marcada "removida" reapareceu no payload do n8n — Asaas consultado ao vivo não confirmou ' +
                  `a reversão (${resultadoReversao.acao}${resultadoReversao.detalhe ? `: ${resultadoReversao.detalhe}` : ''}). ` +
                  'Permanece "removida", revisar manualmente.',
              });
            }
            continue;
          }

          if (cobrancaExistente) {
            await req.prisma.cobranca.update({
              where: { id: cobrancaExistente.id },
              data: {
                ...dadosComuns,
                idExterno,
                sincronizadoEm: new Date(),
                // Se essa cobrança tinha sido reconciliada como "quitada" em
                // algum sync anterior e voltou a aparecer agora (ex.: reversão
                // de pagamento no Asaas), desfaz a quitação — o "status" acima
                // (em dadosComuns) já reflete o valor atual vindo do payload.
                quitadaEm: null,
              },
            });
            idsTratados.add(cobrancaExistente.id);
            idsTratadosGlobal.add(cobrancaExistente.id);
            cobrancasAtualizadas += 1;
          } else {
            const criada = await req.prisma.cobranca.create({
              data: {
                ...dadosComuns,
                idExterno,
              },
            });
            idsTratados.add(criada.id);
            idsTratadosGlobal.add(criada.id);
            cobrancasCriadas += 1;
          }
        }

        // Reconciliação por-associado (modo de compatibilidade): só roda
        // quando NÃO veio "janela" no corpo. Com "janela", a reconciliação
        // acontece uma vez só, pra base inteira, depois deste loop (ver
        // abaixo) — rodar as duas juntas seria redundante e o modo
        // por-associado tem a limitação que o modo global resolve (não
        // reconcilia associados que sumiram inteiros do payload).
        if (!janela) {
          // Multi-franquia — Fase 3: este bloco era o caso concreto que
          // embasou todo o desenho da extension de isolamento (ver seção 4
          // do plano) — SEM filtro de franquia explícito aqui, um sync de
          // uma franquia podia tocar cobranças de OUTRA franquia por
          // engano. "req.prisma" (escopado pela franquia da API key usada)
          // injeta "associado: { franquiaId }" automaticamente neste
          // "findMany" (Cobranca é escopo por relação — ver
          // prismaComEscopo.js), mesmo já filtrando por "associadoId"
          // específico (que já é da franquia certa, mas a dupla checagem é
          // a defesa em profundidade documentada).
          //
          // AJUSTE 22 — não é mais um "updateMany" cego pra "quitada" (ver
          // docblock de exports.sync acima, item 1): busca as candidatas e
          // classifica/aplica cada uma via reconciliarCandidatasEmLote.
          const candidatasAusentes = await req.prisma.cobranca.findMany({
            where: {
              associadoId: associado.id,
              status: { in: STATUS_CONSIDERADOS_ABERTOS },
              ...(idsTratados.size > 0 ? { id: { notIn: Array.from(idsTratados) } } : {}),
            },
          });
          const resultado = await reconciliarCandidatasEmLote(candidatasAusentes, req.franquiaId, { prisma: req.prisma });
          cobrancasQuitadas += resultado.quitadas.length;
          cobrancasRemovidas += resultado.removidas.length;
          for (const item of resultado.naoResolvidas) {
            if (item.acao === 'sem_id_externo') continue; // sem id_externo: nunca deu pra confirmar nada, não é um "erro" a reportar
            erros.push({
              index,
              cpf_cnpj: cpfCnpj,
              id_externo: item.cobranca.idExterno,
              erro: `Cobrança ausente do payload não reconciliada (${item.acao}${item.detalhe ? `: ${item.detalhe}` : ''}) — permanece pending/overdue.`,
            });
          }
          // AJUSTE 22 (revisão pré-commit, item 4) — guardrail de remoção:
          // nenhuma das candidatas a "removida" desta chamada foi aplicada
          // porque o total confirmado passou de LIMITE_GUARDRAIL_REMOVIDAS
          // nesta chamada específica a reconciliarCandidatasEmLote (escopo
          // por-associado — ver docblock de LIMITE_GUARDRAIL_REMOVIDAS em
          // cobrancasRemovidas.service.js pra como isso se compõe com o modo
          // global logo abaixo). Cada uma permanece pending/overdue.
          cobrancasRemovidaBloqueadaGuardrail += resultado.removidasBloqueadasGuardrail.length;
          for (const item of resultado.removidasBloqueadasGuardrail) {
            erros.push({
              index,
              cpf_cnpj: cpfCnpj,
              id_externo: item.cobranca.idExterno,
              erro:
                `Cobrança confirmada como removida no Asaas, mas NÃO aplicada — guardrail de segurança ` +
                `(mais de ${LIMITE_GUARDRAIL_REMOVIDAS} remoções confirmadas nesta chamada). Permanece pending/overdue.`,
            });
          }
        }
      }
    }

    // Reconciliação global (modo "janela"): roda uma vez só, depois de
    // processar todos os associados do payload. Pega qualquer cobrança
    // pending/overdue com vencimento dentro da janela informada que não foi
    // tocada por NENHUM associado desta chamada — cobre o caso de um
    // associado sumir inteiro do payload porque todas as cobranças dele
    // foram pagas (o modo por-associado nunca examinava esse associado).
    if (janela) {
      // Multi-franquia — Fase 3: ESTE é o "findMany" (era "updateMany" cego
      // antes do AJUSTE 22) citado na seção 4 do plano como justificativa
      // central da extension — roda sobre a base INTEIRA (nenhum filtro de
      // associado aqui, de propósito, é o modo "global"), então sem
      // isolamento automático um sync de uma franquia tocaria cobranças de
      // OUTRA franquia. "req.prisma" (Cobranca é escopo por relação) injeta
      // "associado: { franquiaId }" nesse "where" automaticamente — ver
      // prismaComEscopo.js e o teste dedicado a este cenário específico.
      //
      // AJUSTE 22 — mesma mudança do modo por-associado acima (ver docblock
      // de exports.sync, item 1): classifica/aplica cada candidata via
      // reconciliarCandidatasEmLote em vez de marcar "quitada" às cegas.
      const idsGlobal = Array.from(idsTratadosGlobal);
      const candidatasAusentesGlobal = await req.prisma.cobranca.findMany({
        where: {
          status: { in: STATUS_CONSIDERADOS_ABERTOS },
          vencimento: { gte: janela.inicio, lte: janela.fim },
          ...(idsGlobal.length > 0 ? { id: { notIn: idsGlobal } } : {}),
        },
      });
      const resultadoGlobal = await reconciliarCandidatasEmLote(candidatasAusentesGlobal, req.franquiaId, { prisma: req.prisma });
      cobrancasQuitadas += resultadoGlobal.quitadas.length;
      cobrancasRemovidas += resultadoGlobal.removidas.length;
      for (const item of resultadoGlobal.naoResolvidas) {
        if (item.acao === 'sem_id_externo') continue;
        erros.push({
          index: null,
          cpf_cnpj: null,
          id_externo: item.cobranca.idExterno,
          erro: `Cobrança ausente do payload (reconciliação global) não reconciliada (${item.acao}${item.detalhe ? `: ${item.detalhe}` : ''}) — permanece pending/overdue.`,
        });
      }
      // AJUSTE 22 (revisão pré-commit, item 4) — mesmo guardrail do modo
      // por-associado acima, aplicado aqui ao resultado da chamada única do
      // modo global (candidatas da base inteira dentro da janela, numa só
      // chamada a reconciliarCandidatasEmLote).
      cobrancasRemovidaBloqueadaGuardrail += resultadoGlobal.removidasBloqueadasGuardrail.length;
      for (const item of resultadoGlobal.removidasBloqueadasGuardrail) {
        erros.push({
          index: null,
          cpf_cnpj: null,
          id_externo: item.cobranca.idExterno,
          erro:
            `Cobrança confirmada como removida no Asaas, mas NÃO aplicada — guardrail de segurança ` +
            `(mais de ${LIMITE_GUARDRAIL_REMOVIDAS} remoções confirmadas nesta chamada). Permanece pending/overdue.`,
        });
      }
    }

    await registrarSyncLog(req.prisma, { total: totalAssociadosProcessados, sucesso: true });

    res.json({
      associados_criados: associadosCriados,
      associados_atualizados: associadosAtualizados,
      cobrancas_criadas: cobrancasCriadas,
      cobrancas_atualizadas: cobrancasAtualizadas,
      cobrancas_quitadas: cobrancasQuitadas,
      // AJUSTE 22 — cobrancas_removidas: cobranças confirmadas como apagadas
      // no Asaas (deleted=true) durante a reconciliação de "ausente do
      // payload" (ver docblock de exports.sync, item 1). Distinto de
      // cobrancas_quitadas de propósito — nunca a mesma coisa.
      cobrancas_removidas: cobrancasRemovidas,
      // cobrancas_removida_reaparecida: cobranças que estavam "removida",
      // voltaram a aparecer neste payload, e o Asaas consultado ao vivo NÃO
      // confirmou a reversão (ver docblock, item 2) — permanecem
      // "removida"; cada uma também está detalhada em "erros".
      cobrancas_removida_reaparecida: cobrancasRemovidaReaparecida,
      // cobrancas_removida_revertida: cobranças que estavam "removida",
      // voltaram a aparecer neste payload, E o Asaas consultado ao vivo
      // confirmou deleted:false — revertidas pro status do payload
      // (AJUSTE 22, revisão pré-commit, item 5).
      cobrancas_removida_revertida: cobrancasRemovidaRevertida,
      // removidas_bloqueadas_guardrail: candidatas confirmadas como
      // "removida" no Asaas, mas NÃO aplicadas porque o guardrail de
      // segurança bloqueou a chamada inteira (AJUSTE 22, revisão
      // pré-commit, item 4 — ver LIMITE_GUARDRAIL_REMOVIDAS em
      // cobrancasRemovidas.service.js). Cada uma também detalhada em
      // "erros"; permanecem pending/overdue.
      removidas_bloqueadas_guardrail: cobrancasRemovidaBloqueadaGuardrail,
      reconciliacao: janela ? 'global' : 'por_associado',
      erros,
    });
  } catch (err) {
    await registrarSyncLog(req.prisma, { total: totalAssociadosProcessados, sucesso: false });
    next(err);
  }
};

/**
 * POST /api/sync/atualizar
 *
 * Dispara sob demanda o webhook do n8n configurado em
 * "N8N_SYNC_WEBHOOK_URL" (variável de ambiente — não é um valor
 * configurável em runtime como "n8n_webhook_cadastro_url", já que pode
 * mudar entre ambientes e não tem UI própria pra isso). Esse webhook busca
 * os dados atualizados no Asaas e chama POST /api/sync internamente — ou
 * seja, quando esta chamada retorna (sucesso), nosso banco já está
 * atualizado. Usado pelo botão "Atualizar" do Dashboard (ver README do
 * frontend): o frontend chama este endpoint primeiro e só depois re-busca a
 * tabela/os cards de resumo, garantindo que a re-busca já reflita os dados
 * novos.
 *
 * Sem corpo de requisição. Timeout de 30s (ver TIMEOUT_WEBHOOK_ATUALIZAR_MS)
 * — o n8n pode demorar porque pagina no Asaas antes de responder.
 *
 * Resposta de sucesso (200), repassando o corpo do webhook:
 *   { "status": "ok", "synced_at": "...", "total_associados": N }
 *
 * Falhas (URL não configurada, timeout, erro de rede, ou o webhook
 * respondendo com status HTTP de erro) voltam como 502, com uma mensagem
 * clara em "error" — nunca como 500 genérico, pra deixar claro pro frontend
 * que o problema foi no upstream (n8n/Asaas), não na nossa API. O frontend
 * trata esse 502 mostrando um aviso, mas ainda assim re-busca os dados
 * locais em seguida (podem já estar atualizados de uma sincronização
 * anterior, mesmo que esta tentativa específica tenha falhado).
 */
exports.atualizarSobDemanda = async (req, res) => {
  const url = process.env.N8N_SYNC_WEBHOOK_URL;

  if (!url) {
    return res.status(502).json({ error: 'N8N_SYNC_WEBHOOK_URL não está configurada no ambiente do backend.' });
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_WEBHOOK_ATUALIZAR_MS);

  try {
    const resposta = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
    });

    const corpoTexto = await resposta.text().catch(() => '');
    let corpo = null;
    try {
      corpo = corpoTexto ? JSON.parse(corpoTexto) : null;
    } catch {
      corpo = null;
    }

    if (!resposta.ok) {
      return res.status(502).json({
        error: `Webhook de sincronização respondeu com status ${resposta.status}.`,
        ...(corpoTexto ? { detalhe: corpoTexto.slice(0, 500) } : {}),
      });
    }

    res.json({
      status: corpo?.status ?? 'ok',
      synced_at: corpo?.syncedAt ?? null,
      total_associados: corpo?.totalAssociados ?? null,
    });
  } catch (err) {
    const mensagem =
      err.name === 'AbortError'
        ? 'Tempo esgotado ao aguardar o webhook de sincronização (30s).'
        : `Falha ao chamar o webhook de sincronização: ${err.message}`;
    res.status(502).json({ error: mensagem });
  } finally {
    clearTimeout(timeoutId);
  }
};

/**
 * POST /api/sync/reconciliar-cobrancas-quitadas
 *
 * AJUSTE 18 — segunda via de reconciliação de `cobrancas`, independente do
 * payload do n8n, exposta como endpoint HTTP pra quem preferir disparar via
 * um workflow n8n agendado em vez de rodar
 * `scripts/reconciliar-cobrancas-quitadas-no-asaas.js` direto no host
 * (mesmo padrão de `POST /api/inadimplencia/reconciliar-pagamentos` pro
 * AJUSTE 14 — ver docblock lá). Ver docblock do script irmão e de
 * `src/services/cobrancasPresas.service.js` para o "porquê" completo: a
 * janela `-53/+5 dias` que o n8n manda em `POST /api/sync` só anda pra
 * frente, então uma cobrança paga cujo vencimento já envelheceu além do
 * início da janela nunca mais seria reconciliada só por ali — este
 * endpoint usa `pagamentos_asaas` (sem limite de janela) como fonte de
 * verdade independente.
 *
 * Escopado a UMA franquia por chamada (a do usuário/API key autenticado,
 * via "auth" + "escopoFranquia" — mesmo padrão do resto da API
 * multi-franquia), nunca "todas" — um agendador externo que precise
 * reconciliar várias franquias chama este endpoint uma vez por franquia
 * (mesmo padrão de POST /api/sync e de POST /api/inadimplencia/reconciliar-pagamentos).
 *
 * Sem modo dry-run — sempre aplica (o script é o lugar pra "só mostrar";
 * um endpoint chamado por um agendador automatizado não tem quem leia um
 * relatório de dry-run). Tem o mesmo guardrail de segurança dos scripts
 * irmãos: se o número de cobranças presas encontradas passar de
 * LIMITE_SEGURANCA_RECONCILIACAO_COBRANCAS, recusa aplicar e responde 409
 * (sem --force possível aqui — quem precisar ignorar o guardrail nesse
 * cenário usa o script direto, com --confirm --force, depois de revisar a
 * lista).
 *
 * `quitadaEm` grava a data real (`paymentDate` ?? `clientPaymentDate` ??
 * `confirmedDate` ?? "agora" — revisão pré-commit do AJUSTE 22, item 2) —
 * mesmo comportamento do script, ver `aplicarQuitacao` no serviço.
 *
 * AJUSTE 22 — rede de segurança adicional: além de quitar as "presas" (já
 * fazia isso), agora também CONFIRMA VIA API DO ASAAS cada cobrança
 * "sem_correspondencia_em_pagamentos_asaas" (nenhuma linha correspondente
 * em pagamentos_asaas — ambíguo por comparação só local, ver docblock de
 * `cobrancasRemovidas.service.js`) via `confirmarERemoverSemCorrespondencia`
 * — que reaproveita a MESMA `classificarCandidataAusente` usada por
 * `POST /api/sync` (ver acima): marca "removida" as que o Asaas confirma
 * como `deleted: true` (salvo se o guardrail de remoção bloquear — ver
 * `LIMITE_GUARDRAIL_REMOVIDAS`, item 4 abaixo), e — a partir da revisão
 * pré-commit do AJUSTE 22 (item 3) — TAMBÉM marca "quitada" as que o Asaas
 * confirma como RECEIVED/RECEIVED_IN_CASH/CONFIRMED (mesmo critério único de
 * `STATUS_ADIMPLENTE_ASAAS`, já que é a mesma função por trás dos dois
 * endpoints). `cobrancas_quitadas` na resposta soma as duas origens
 * (via "presas", que já existia, e via esta confirmação ao vivo das
 * "sem correspondência", nova). Nunca marca "removida"/"quitada" só pela
 * ausência local — sempre confirma ao vivo antes. O guardrail de segurança
 * (`LIMITE_SEGURANCA_RECONCILIACAO_COBRANCAS`) continua cobrindo só a
 * quitação de "presas" (não a confirmação via Asaas ao vivo das "sem
 * correspondência", que já é inerentemente mais lenta/conservadora — uma
 * chamada HTTP por candidata, nunca aplica nada em caso de dúvida ou falha
 * do Asaas).
 *
 * EQUIVALÊNCIA COM O SCRIPT CLI (corrigida na revisão pré-commit do AJUSTE
 * 22 — antes deste ajuste havia uma divergência aqui, ver histórico no
 * README): `scripts/reconciliar-cobrancas-quitadas-no-asaas.js` (o script
 * CLI irmão deste endpoint, pensado pro mesmo job diário) agora reaproveita
 * a MESMA `confirmarERemoverSemCorrespondencia` (só que com `aplicar: false`
 * por padrão, pro seu modo dry-run) — nenhuma lógica própria de
 * classificação. Uma cobrança CONFIRMED sem correspondência local é tratada
 * de forma idêntica pelos dois: quitada quando o Asaas confirma
 * RECEIVED/RECEIVED_IN_CASH/CONFIRMED, removida (sujeita ao mesmo guardrail
 * — `LIMITE_GUARDRAIL_REMOVIDAS`) quando confirma `deleted: true`.
 *
 * `removidas_bloqueadas_guardrail` na resposta (AJUSTE 22, revisão
 * pré-commit, item 4): candidatas confirmadas como removida nesta chamada,
 * mas NÃO aplicadas porque o total passou de `LIMITE_GUARDRAIL_REMOVIDAS` —
 * nenhuma removida é aplicada nesse caso, todas permanecem pending/overdue.
 * Mesma constante/mesmo comportamento de `POST /api/sync` (ver docblock de
 * `exports.sync`, item 1b).
 */
exports.reconciliarCobrancasQuitadas = async (req, res, next) => {
  try {
    const { presas, comIdExterno, semIdExterno, semCorrespondencia } = await buscarCobrancasPresas({
      franquiaId: req.franquiaId,
    });

    if (presas.length > LIMITE_SEGURANCA_RECONCILIACAO_COBRANCAS) {
      return res.status(409).json({
        error:
          `${presas.length} cobrança(s) presa(s) encontrada(s) — acima do limite de segurança ` +
          `(${LIMITE_SEGURANCA_RECONCILIACAO_COBRANCAS}) pra aplicar automaticamente via endpoint.`,
        presas_encontradas: presas.length,
        limite_seguranca: LIMITE_SEGURANCA_RECONCILIACAO_COBRANCAS,
        acao_sugerida:
          'Revise com scripts/diagnostico-cobrancas-presas-sistemico.js (dry-run) e, se a lista estiver correta, ' +
          'aplique com scripts/reconciliar-cobrancas-quitadas-no-asaas.js --confirm --force.',
      });
    }

    const aplicados = await aplicarQuitacao(presas, { prisma: req.prisma });
    const valorTotalQuitadoPresas = presas.reduce((soma, { cobranca }) => soma + Number(cobranca.valor), 0);

    const resultadoRemovidas = await confirmarERemoverSemCorrespondencia(semCorrespondencia, req.franquiaId, {
      prisma: req.prisma,
    });

    // AJUSTE 22 (revisão pré-commit, item 3) — valor_total_quitado precisa
    // somar as duas origens de "quitada", igual cobrancas_quitadas logo
    // abaixo: via "presas" (calculado acima) + via confirmação ao vivo das
    // "sem correspondência" (resultadoRemovidas.quitadas — cada item carrega
    // a "cobranca" original, com o "valor"). Antes desta correção só somava
    // "presas" — ficava inconsistente com cobrancas_quitadas assim que esse
    // segundo caminho começasse a aplicar quitações de verdade (CONFIRMED
    // confirmado ao vivo).
    const valorTotalQuitadoSemCorrespondencia = resultadoRemovidas.quitadas.reduce(
      (soma, item) => soma + Number(item.cobranca.valor),
      0
    );
    const valorTotalQuitado = valorTotalQuitadoPresas + valorTotalQuitadoSemCorrespondencia;

    res.json({
      cobrancas_verificadas: comIdExterno.length,
      // AJUSTE 22 (revisão pré-commit, item 3) — soma as duas origens de
      // "quitada": via "presas" (pagamentos_asaas local já RECEIVED/
      // RECEIVED_IN_CASH/CONFIRMED, comportamento original do AJUSTE 18) +
      // via confirmação ao vivo das "sem correspondência" (RECEIVED/
      // RECEIVED_IN_CASH/CONFIRMED confirmado direto na API do Asaas, ver
      // docblock acima).
      cobrancas_quitadas: aplicados.length + resultadoRemovidas.quitadas.length,
      valor_total_quitado: valorTotalQuitado,
      cobrancas_removidas: resultadoRemovidas.removidas.length,
      // removidas_bloqueadas_guardrail — ver docblock acima (item 4).
      removidas_bloqueadas_guardrail: resultadoRemovidas.removidasBloqueadasGuardrail.length,
      sem_id_externo: semIdExterno.length,
      sem_correspondencia_em_pagamentos_asaas: semCorrespondencia.length,
    });
  } catch (err) {
    next(err);
  }
};
