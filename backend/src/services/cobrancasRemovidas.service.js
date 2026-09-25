const prismaBase = require('../config/prisma');
const { buscarPagamentoPorId, AsaasApiError } = require('./asaas.service');
const { STATUS_ADIMPLENTE_ASAAS, STATUS_CONSIDERADOS_ABERTOS, aplicarQuitacao } = require('./cobrancasPresas.service');

/**
 * AJUSTE 22 — "cobranças removidas no Asaas" (setembro/2026). Contexto
 * completo do problema em `scripts/diagnostico-cobrancas-removidas-asaas.js`
 * e `src/services/asaas.service.js` (docblock de `buscarPagamentoPorId`):
 * quando o Asaas apaga uma cobrança (evento `PAYMENT_DELETED` — na prática,
 * quase sempre por renegociação, que substitui a cobrança original por uma
 * nova), a linha correspondente é removida por inteiro de `pagamentos_asaas`
 * (`excluirPagamento`) e NADA em `cobrancas` era atualizado — a `Cobranca`
 * local ficava presa pending/overdue pra sempre (se o vencimento já tivesse
 * saído da janela rolante que `POST /api/sync` recebe do n8n) ou, pior,
 * podia ser marcada `"quitada"` por engano pelo `updateMany` cego de
 * `POST /api/sync` (se o vencimento ainda estivesse dentro da janela) —
 * mislabeling: dinheiro que nunca entrou contando como recebido.
 *
 * Este módulo concentra TODA a lógica de "confirmar e aplicar remoção" — o
 * status novo é `"removida"` (nunca `"quitada"`, ver docblock do campo em
 * schema.prisma), com `removidaEm` preenchido. Usado por 4 caminhos,
 * nenhum reimplementando a lógica de confirmação/aplicação:
 *   1. Webhook `PAYMENT_DELETED` (`asaasWebhook.controller.js`) —
 *      `marcarRemovidaSeAberta`. Não precisa confirmar via API do Asaas: o
 *      próprio evento JÁ É a confirmação.
 *   2. Webhook `PAYMENT_RESTORED` (`asaasWebhook.controller.js`) —
 *      `reverterRemovidaParaStatusAsaas`. Mesma lógica: o payload do evento
 *      já traz o status atual do pagamento, sem precisar de chamada extra.
 *   3. `POST /api/sync` (`sync.controller.js`, os dois modos) — candidatas
 *      SEM confirmação prévia (só "sumiram do payload"), então PRECISAM
 *      consultar a API do Asaas antes de aplicar qualquer coisa —
 *      `classificarCandidataAusente`/`reconciliarCandidatasEmLote`.
 *   4. Reconciliação diária (`POST /api/sync/reconciliar-cobrancas-quitadas`
 *      E `scripts/reconciliar-cobrancas-quitadas-no-asaas.js` — os dois
 *      reaproveitam a MESMA função desde a revisão pré-commit, nenhum tem
 *      lógica própria) — mesma necessidade de confirmação via Asaas, sobre
 *      o conjunto `semCorrespondencia` que `buscarCobrancasPresas` já
 *      calcula — `confirmarERemoverSemCorrespondencia`.
 *
 * IMPORTANTE — nunca marcar "removida" só pela ausência local (nem em
 * `pagamentos_asaas`, nem no payload do n8n): essa ausência é AMBÍGUA (pode
 * ser removida no Asaas, pode ser um atraso de sincronização, pode ser outra
 * causa) — só a API do Asaas, consultada ao vivo, decide (exceto nos
 * caminhos 1/2 acima, onde o próprio evento do Asaas já é a fonte de
 * verdade, sem ambiguidade nenhuma).
 *
 * CRITÉRIO ÚNICO PRA "QUITADA" (revisão pré-commit) — `STATUS_ADIMPLENTE_ASAAS`
 * (`cobrancasPresas.service.js`, RECEIVED/RECEIVED_IN_CASH/CONFIRMED) é a
 * ÚNICA fonte de verdade de "isto conta como pago" em toda `cobrancas` — os
 * caminhos 2, 3 e 4 acima, MAIS `buscarCobrancasPresas`/`aplicarQuitacao`
 * (detecção de "presas"), usam todos a mesma constante, sem exceção. Isto
 * NÃO afeta a tela de Taxa de Inadimplência (lê `PagamentoAsaas.status` cru,
 * critério próprio, nunca importa esta constante).
 */

/** Concorrência limitada nas consultas à API do Asaas durante a reconciliação em lote — mesmo padrão de CONCORRENCIA_CLIENTES em asaas.service.js, evita disparar dezenas de chamadas simultâneas pro Asaas numa única chamada de POST /api/sync ou do job diário. */
const CONCORRENCIA_CONFIRMACAO_ASAAS = 5;

/**
 * AJUSTE 22 (revisão pré-commit, "guardrail de remoção") — se UMA ÚNICA
 * execução (uma chamada a `reconciliarCandidatasEmLote`: uma chamada de
 * `POST /api/sync` no modo por associado conta por associado, no modo
 * global/janela conta uma vez pra base inteira; o job diário —
 * `POST /api/sync/reconciliar-cobrancas-quitadas` e o script CLI irmão —
 * conta uma vez por franquia processada) confirmar MAIS de
 * `LIMITE_GUARDRAIL_REMOVIDAS` candidatas como `"removida"`, NENHUMA delas
 * é aplicada — fica tudo como estava, reportado (ver `removidasBloqueadasGuardrail`
 * no retorno de `reconciliarCandidatasEmLote`, e `removidas_bloqueadas_guardrail`
 * na resposta de `POST /api/sync`/`POST /api/sync/reconciliar-cobrancas-quitadas`).
 * Não bloqueia "quitada" — só remoção, o efeito mais drástico/menos
 * reversível dos dois (marcar "removida" reflete uma exclusão de verdade no
 * Asaas; um volume grande de repente é mais provável sinal de algo errado —
 * ex. chave da API trocada sem querer, bug upstream — do que 20+ exclusões
 * legítimas na mesma execução). Mesmo valor do guardrail do script pontual
 * (`scripts/corrigir-cobrancas-removidas-asaas.js`, `LIMITE_SEGURANCA`), mas
 * são constantes INDEPENDENTES — o script pontual cobre uma lista fixa de
 * ids já investigados manualmente, um contexto bem diferente deste aqui.
 */
const LIMITE_GUARDRAIL_REMOVIDAS = 20;

/**
 * Consulta a API do Asaas pra UM id_externo e classifica em 4 categorias,
 * sem escrever nada no banco (só leitura — mesma função usada pelo
 * diagnóstico manual, `scripts/diagnostico-cobrancas-removidas-asaas.js`):
 *   - "removida_confirmada": Asaas responde 200 com `deleted: true`.
 *   - "existe_nao_deletada": Asaas responde 200, `deleted` não é true — NÃO
 *     é o caso "apagada", outra causa (webhook perdido, etc.) — nunca marca
 *     "removida" neste caso (mas pode virar "quitada" se `statusAsaas`
 *     estiver em STATUS_ADIMPLENTE_ASAAS — ver `classificarCandidataAusente`
 *     abaixo, que é quem decide isso; esta função só classifica).
 *   - "nao_encontrada": 404 — nunca existiu nesta conta/franquia. Também
 *     nunca marca "removida" (id trocado, franquia errada, etc. — investigar
 *     à parte, não presumir "removida" por 404).
 *   - "erro": falha ao consultar o Asaas (timeout, 5xx, chave inválida...).
 *     Quem chamar NUNCA deve aplicar nada neste caso — só reportar e tentar
 *     de novo na próxima reconciliação.
 *
 * `pagamento` (o objeto cru retornado pelo Asaas — mesmos campos de
 * `listarPagamentos`/webhook, inclusive `paymentDate`) vem incluído em
 * "removida_confirmada" e "existe_nao_deletada" — quem chamar precisa dele
 * pra eventualmente aplicar `aplicarQuitacao` (AJUSTE 22, revisão
 * pré-commit, item 3) sem precisar consultar o Asaas de novo.
 */
async function confirmarRemocaoViaAsaas(idExterno, franquiaId) {
  try {
    const resultado = await buscarPagamentoPorId(idExterno, franquiaId);
    if (!resultado.existe) {
      return { classificacao: 'nao_encontrada' };
    }
    if (resultado.deletado) {
      return { classificacao: 'removida_confirmada', statusAsaas: resultado.pagamento.status, pagamento: resultado.pagamento };
    }
    return { classificacao: 'existe_nao_deletada', statusAsaas: resultado.pagamento.status, pagamento: resultado.pagamento };
  } catch (err) {
    const mensagem = err instanceof AsaasApiError ? err.message : `Erro inesperado: ${err.message}`;
    return { classificacao: 'erro', erro: mensagem };
  }
}

/**
 * Aplica "removida" numa Cobranca JÁ IDENTIFICADA (por id interno), SÓ SE
 * ela ainda estiver pending/overdue no momento da escrita — `updateMany`
 * (não `update`) com o filtro de status embutido no `where` é o que torna
 * isto seguro contra corrida (ex.: a cobrança foi quitada por outro caminho
 * entre a leitura e esta escrita): nesse caso o `updateMany` simplesmente
 * não casa nenhuma linha, nunca sobrescreve uma "quitada". NUNCA confirma
 * nada sozinha — quem chama já decidiu (webhook: o evento já é a
 * confirmação; reconciliação: já chamou `confirmarRemocaoViaAsaas` antes).
 */
async function aplicarRemocao(cobrancaId, { prisma = prismaBase } = {}) {
  const resultado = await prisma.cobranca.updateMany({
    where: { id: cobrancaId, status: { in: STATUS_CONSIDERADOS_ABERTOS } },
    data: { status: 'removida', removidaEm: new Date() },
  });
  return resultado.count > 0;
}

/**
 * Webhook `PAYMENT_DELETED` — marca como "removida" a Cobranca cujo
 * `idExterno` bate com o pagamento apagado, SÓ SE ela estiver pending/
 * overdue hoje. NUNCA toca uma cobrança já "quitada" (dinheiro que já
 * entrou continua contando como recebido, mesmo que a cobrança tenha sido
 * apagada no Asaas DEPOIS de paga — ex.: reorganização administrativa lá) —
 * o filtro de status em `aplicarRemocao` garante isso.
 *
 * franquiaId sempre filtrado explicitamente no `where` (mesmo padrão de
 * `excluirPagamento` em pagamentosAsaas.service.js — defesa em profundidade,
 * nunca confiado só a um client escopado) — evita que um evento malformado/
 * id colidindo por acaso alcance a cobrança de outra franquia.
 */
async function marcarRemovidaSeAberta(idExterno, franquiaId, { prisma = prismaBase } = {}) {
  if (!idExterno) return { marcada: false };

  const cobranca = await prisma.cobranca.findFirst({
    where: { idExterno, associado: { franquiaId } },
    select: { id: true, status: true },
  });
  if (!cobranca) return { marcada: false, motivo: 'sem_cobranca_local' };
  if (!STATUS_CONSIDERADOS_ABERTOS.includes(cobranca.status)) {
    return { marcada: false, motivo: `status_atual_${cobranca.status}` };
  }

  const marcada = await aplicarRemocao(cobranca.id, { prisma });
  return { marcada, cobrancaId: cobranca.id };
}

/** Mapa Asaas -> status local, usado só na reversão (`PAYMENT_RESTORED`) — mesmo fallback de `STATUS_VALIDOS`/`statusFinal` em sync.controller.js (qualquer coisa não reconhecida cai em "pending", nunca trava a reversão). */
function statusLocalParaPagamentoAsaas(statusAsaas) {
  if (statusAsaas === 'OVERDUE') return 'overdue';
  if (statusAsaas === 'PENDING') return 'pending';
  return 'pending';
}

/**
 * Webhook `PAYMENT_RESTORED` — Asaas permite restaurar uma cobrança
 * apagada; este evento chega com o `payment` completo, INCLUSIVE o status
 * atual dele (igual a qualquer outro evento de upsert — ver
 * `EVENTOS_WEBHOOK_UPSERT`), então não precisa de nenhuma chamada extra à
 * API: o próprio payload já é a confirmação. Só reverte uma Cobranca que
 * esteja HOJE como "removida" (nunca mexe se estiver pending/overdue/
 * quitada — não haveria nada pra reverter, e evita sobrescrever por engano
 * um estado que já foi corrigido por outro caminho, ex. um sync mais
 * recente).
 *
 * - `payment.status` em STATUS_ADIMPLENTE_ASAAS (RECEIVED/RECEIVED_IN_CASH/
 *   CONFIRMED — critério único desde a revisão pré-commit do AJUSTE 22,
 *   mesma constante usada por `buscarCobrancasPresas`/`aplicarQuitacao` e
 *   por `classificarCandidataAusente`) -> volta direto pra "quitada"
 *   (reaproveita `aplicarQuitacao`, mesmo fallback de `quitadaEm` —
 *   `paymentDate` ?? `clientPaymentDate` ?? `confirmedDate` ?? "agora" —
 *   usado em toda reconciliação de quitação) — cobre o caso de uma cobrança
 *   ser restaurada já paga OU já confirmada (cartão, repasse pendente).
 * - PENDING/OVERDUE (ou qualquer outro valor não reconhecido, com fallback
 *   pra "pending") -> volta a pending/overdue, `removidaEm: null`.
 */
async function reverterRemovidaParaStatusAsaas(idExterno, franquiaId, payment, { prisma = prismaBase } = {}) {
  if (!idExterno) return { revertida: false };

  const cobranca = await prisma.cobranca.findFirst({
    where: { idExterno, associado: { franquiaId }, status: 'removida' },
  });
  if (!cobranca) return { revertida: false, motivo: 'nao_estava_removida' };

  if (STATUS_ADIMPLENTE_ASAAS.includes(payment?.status)) {
    await aplicarQuitacao([{ cobranca, pagamento: payment }], { prisma });
    return { revertida: true, novoStatus: 'quitada' };
  }

  const novoStatus = statusLocalParaPagamentoAsaas(payment?.status);
  await prisma.cobranca.update({
    where: { id: cobranca.id },
    data: { status: novoStatus, removidaEm: null },
  });
  return { revertida: true, novoStatus };
}

/**
 * `POST /api/sync` (e, indiretamente, a reconciliação diária) — CLASSIFICA
 * (nunca escreve nada) UMA candidata "ausente do payload" (já sabidamente
 * pending/overdue, não tocada por este sync). Separado da aplicação de
 * propósito (ver `reconciliarCandidatasEmLote` abaixo): o guardrail de
 * remoção (`LIMITE_GUARDRAIL_REMOVIDAS`) precisa saber QUANTAS candidatas de
 * uma execução seriam "removida" ANTES de decidir se aplica alguma — não dá
 * pra decidir isso candidata por candidata conforme processa.
 *
 * Ordem de verificação:
 *   1. Sem `idExterno` -> não dá pra confirmar nada (nem local nem via
 *      Asaas) -> "sem_id_externo".
 *   2. `pagamentos_asaas` (fonte local, atualizada via webhook em tempo
 *      real — AJUSTE 14) já tem esse id em STATUS_ADIMPLENTE_ASAAS
 *      (RECEIVED/RECEIVED_IN_CASH/CONFIRMED — critério único, mesma
 *      constante usada por `buscarCobrancasPresas`/`aplicarQuitacao` e por
 *      `reverterRemovidaParaStatusAsaas`, ver docblock dela em
 *      cobrancasPresas.service.js) -> "quitada" (mais barato que consultar
 *      o Asaas ao vivo pra este caso).
 *   3. Senão, consulta o Asaas ao vivo (`confirmarRemocaoViaAsaas`):
 *      - `removida_confirmada` -> "removida";
 *      - `existe_nao_deletada` com `statusAsaas` em STATUS_ADIMPLENTE_ASAAS
 *        -> "quitada" (mesmo critério do item 2, confirmado ao vivo porque
 *        não havia `pagamentos_asaas` local pra decidir sem chamar o Asaas);
 *      - qualquer outra classificação/status -> a própria classificação do
 *        Asaas (`existe_nao_deletada` com outro status / `nao_encontrada` /
 *        `erro`) — nunca presume removida/quitada por exclusão, e uma falha
 *        do Asaas (timeout/erro) nunca decide nada (pedido explícito).
 *
 * `pagamentoLocal`: passe explicitamente (mesmo `null`) quando quem chama
 * JÁ SABE que não há correspondência local (ex.: a reconciliação diária,
 * que already computou isso via `buscarCobrancasPresas`) — evita uma
 * consulta redundante. Deixe `undefined` (padrão) para esta função buscar
 * sozinha.
 *
 * Retorna `{ cobranca, acao: 'quitada'|'removida'|'sem_id_externo'|<classificação
 * do Asaas>, pagamento?, detalhe? }` — `pagamento` vem preenchido quando
 * `acao === 'quitada'` (o objeto que `aplicarQuitacao` precisa pra calcular
 * `quitadaEm`).
 */
async function classificarCandidataAusente(cobranca, franquiaId, { prisma = prismaBase, pagamentoLocal } = {}) {
  if (!cobranca.idExterno) {
    return { cobranca, acao: 'sem_id_externo' };
  }

  let pagamento = pagamentoLocal;
  if (pagamento === undefined) {
    pagamento = await prisma.pagamentoAsaas.findFirst({ where: { id: cobranca.idExterno, franquiaId } });
  }

  if (pagamento && STATUS_ADIMPLENTE_ASAAS.includes(pagamento.status)) {
    return { cobranca, acao: 'quitada', pagamento };
  }

  const confirmacao = await confirmarRemocaoViaAsaas(cobranca.idExterno, franquiaId);

  if (confirmacao.classificacao === 'removida_confirmada') {
    return { cobranca, acao: 'removida' };
  }

  if (confirmacao.classificacao === 'existe_nao_deletada' && STATUS_ADIMPLENTE_ASAAS.includes(confirmacao.statusAsaas)) {
    return { cobranca, acao: 'quitada', pagamento: confirmacao.pagamento };
  }

  // existe_nao_deletada (outro status) / nao_encontrada / erro -> nunca aplica nada, só reporta.
  return { cobranca, acao: confirmacao.classificacao, detalhe: confirmacao.erro || confirmacao.statusAsaas };
}

/**
 * Roda `classificarCandidataAusente` pra uma LISTA de candidatas, com
 * concorrência limitada nas chamadas ao Asaas (mesmo padrão worker-pool de
 * `obterClientesPorId` em asaas.service.js) — usado tanto por
 * `POST /api/sync` (candidatas = pending/overdue não tocadas pelo payload,
 * por associado ou pela janela global) quanto, indiretamente, pela
 * reconciliação diária via `confirmarERemoverSemCorrespondencia` abaixo.
 *
 * DUAS FASES (AJUSTE 22, revisão pré-commit — antes disso, cada candidata
 * era classificada E aplicada no mesmo passo):
 *   FASE 1 — classifica TODAS as candidatas primeiro (concorrência limitada,
 *   nenhuma escrita ainda). Necessário pro guardrail de remoção: só depois
 *   de classificar tudo é que dá pra saber quantas desta execução seriam
 *   "removida".
 *   FASE 2 — aplica: `aplicarQuitacao` pras "quitada" (guardrail não se
 *   aplica a elas, ver docblock de LIMITE_GUARDRAIL_REMOVIDAS); pras
 *   "removida", só aplica `aplicarRemocao` se o TOTAL desta execução não
 *   passar de `LIMITE_GUARDRAIL_REMOVIDAS` — senão, NENHUMA é aplicada,
 *   todas entram em `removidasBloqueadasGuardrail` (mesmo em modo
 *   `aplicar: false`/dry-run, pra já mostrar de antemão o que seria
 *   bloqueado).
 *
 * `aplicar: false` roda só a FASE 1 (classifica, ainda faz as chamadas ao
 * Asaas — é o único jeito de mostrar de antemão o que uma aplicação real
 * faria) e devolve os mesmos buckets, mas SEM escrever nada no banco —
 * usado por `scripts/reconciliar-cobrancas-quitadas-no-asaas.js` pro modo
 * dry-run (padrão), pra ele reaproveitar esta função em vez de ter lógica
 * própria de classificação. `POST /api/sync` e o endpoint HTTP do job diário
 * sempre chamam com o padrão (`aplicar: true` — não têm modo dry-run).
 *
 * Retorna `{ quitadas, removidas, naoResolvidas, removidasBloqueadasGuardrail }`
 * — todas como listas de itens `{ cobranca, acao, ... }`; `naoResolvidas` é
 * pra quem chamar reportar em `erros`, mesmo padrão já usado no resto de
 * sync.controller.js.
 */
async function reconciliarCandidatasEmLote(
  candidatas,
  franquiaId,
  { prisma = prismaBase, pagamentoLocalConhecidoAusente = false, aplicar = true } = {}
) {
  const resultado = { quitadas: [], removidas: [], naoResolvidas: [], removidasBloqueadasGuardrail: [] };
  if (candidatas.length === 0) return resultado;

  // FASE 1 — classifica tudo primeiro (sem escrever nada).
  const classificacoes = [];
  let cursor = 0;
  async function workerClassificar() {
    for (;;) {
      const indice = cursor++;
      if (indice >= candidatas.length) return;
      const cobranca = candidatas[indice];
      const item = await classificarCandidataAusente(cobranca, franquiaId, {
        prisma,
        pagamentoLocal: pagamentoLocalConhecidoAusente ? null : undefined,
      });
      classificacoes.push(item);
    }
  }
  const workers = Array.from({ length: Math.min(CONCORRENCIA_CONFIRMACAO_ASAAS, candidatas.length) }, workerClassificar);
  await Promise.all(workers);

  // Guardrail de remoção — avaliado sobre o TOTAL desta execução, mesmo em
  // dry-run (aplicar:false), pra já reportar o que seria bloqueado.
  const totalRemovidaConfirmada = classificacoes.filter((item) => item.acao === 'removida').length;
  const bloquearRemocao = totalRemovidaConfirmada > LIMITE_GUARDRAIL_REMOVIDAS;

  // FASE 2 — aplica (se aplicar:true), respeitando o guardrail.
  for (const item of classificacoes) {
    if (item.acao === 'quitada') {
      if (!aplicar) {
        resultado.quitadas.push(item);
        continue;
      }
      const [aplicado] = await aplicarQuitacao([{ cobranca: item.cobranca, pagamento: item.pagamento }], { prisma });
      resultado.quitadas.push({
        cobranca: item.cobranca,
        acao: 'quitada',
        quitadaEm: aplicado.quitadaEm,
        quitadaEmAproximada: aplicado.quitadaEmAproximada,
      });
    } else if (item.acao === 'removida') {
      if (bloquearRemocao) {
        resultado.removidasBloqueadasGuardrail.push(item);
        continue;
      }
      if (!aplicar) {
        resultado.removidas.push(item);
        continue;
      }
      const marcada = await aplicarRemocao(item.cobranca.id, { prisma });
      resultado.removidas.push({ cobranca: item.cobranca, acao: marcada ? 'removida' : 'ja_nao_estava_aberta' });
    } else {
      resultado.naoResolvidas.push(item);
    }
  }

  return resultado;
}

/**
 * Reconciliação diária (`POST /api/sync/reconciliar-cobrancas-quitadas` e
 * `scripts/reconciliar-cobrancas-quitadas-no-asaas.js` — os dois reaproveitam
 * esta MESMA função, nenhum tem lógica própria de classificação/aplicação)
 * — recebe o array `semCorrespondencia` que `buscarCobrancasPresas` já
 * calcula (cobranças pending/overdue cujo `idExterno` não bate com NENHUMA
 * linha em `pagamentos_asaas`) e confirma cada uma via Asaas antes de
 * marcar "removida" (ou "quitada", se o Asaas confirmar RECEIVED/
 * RECEIVED_IN_CASH/CONFIRMED — não é só sobre remoção, apesar do nome
 * histórico). `pagamentoLocalConhecidoAusente: true` pula a consulta local
 * redundante (`buscarCobrancasPresas` já garantiu a ausência). `aplicar`
 * repassado direto pra `reconciliarCandidatasEmLote` — `false` pro modo
 * dry-run do script CLI.
 */
async function confirmarERemoverSemCorrespondencia(semCorrespondencia, franquiaId, { prisma = prismaBase, aplicar = true } = {}) {
  return reconciliarCandidatasEmLote(semCorrespondencia, franquiaId, {
    prisma,
    pagamentoLocalConhecidoAusente: true,
    aplicar,
  });
}

/**
 * `POST /api/sync` — cobrança JÁ MARCADA "removida" REAPARECEU no payload do
 * n8n (AJUSTE 22, revisão pré-commit, item 5 — substitui o comportamento
 * anterior desta versão, que sempre ignorava/reportava sem consultar nada).
 *
 * Diferente do webhook `PAYMENT_RESTORED` (evento AO VIVO do próprio Asaas —
 * fonte de verdade automática, sem ambiguidade, ver
 * `reverterRemovidaParaStatusAsaas`), o payload do n8n sozinho NÃO é
 * confirmação suficiente: pode estar atrasado/com uma janela obsoleta em
 * relação a uma remoção recém-processada (o n8n só reflete o que já buscou
 * do Asaas numa chamada anterior). Por isso SEMPRE confirma direto na API do
 * Asaas (`confirmarRemocaoViaAsaas`, ao vivo) antes de decidir:
 *   - `existe_nao_deletada` (Asaas confirma `deleted: false`) -> reverte pro
 *     status TRAZIDO PELO PAYLOAD (`dadosPayload` — os mesmos dados que o
 *     upsert normal já usaria para esta cobrança) e limpa `removidaEm`.
 *   - `removida_confirmada` (Asaas confirma que CONTINUA `deleted: true` —
 *     o payload do n8n está desatualizado) -> NÃO MEXE, permanece
 *     "removida", só reporta.
 *   - `nao_encontrada` / `erro` -> NÃO MEXE (nunca aplica nada em caso de
 *     dúvida ou falha do Asaas, mesmo padrão do resto deste módulo), só
 *     reporta.
 *
 * `dadosPayload`: os campos que o `update` normal gravaria (mesmo shape de
 * `dadosComuns` em sync.controller.js: `associadoId`, `valor`, `vencimento`,
 * `diasDiferenca`, `linkPagamento`, `descricao`, `status`) — quem chama já
 * calculou isso a partir do item do payload, não recalculado aqui.
 */
async function reverterRemovidaSeReapareceuNoPayload(cobranca, franquiaId, dadosPayload, { prisma = prismaBase } = {}) {
  if (!cobranca.idExterno) {
    return { revertida: false, acao: 'sem_id_externo' };
  }

  const confirmacao = await confirmarRemocaoViaAsaas(cobranca.idExterno, franquiaId);

  if (confirmacao.classificacao !== 'existe_nao_deletada') {
    return { revertida: false, acao: confirmacao.classificacao, detalhe: confirmacao.erro || confirmacao.statusAsaas };
  }

  await prisma.cobranca.update({
    where: { id: cobranca.id },
    data: { ...dadosPayload, idExterno: cobranca.idExterno, sincronizadoEm: new Date(), removidaEm: null, quitadaEm: null },
  });

  return { revertida: true, novoStatus: dadosPayload.status };
}

module.exports = {
  CONCORRENCIA_CONFIRMACAO_ASAAS,
  LIMITE_GUARDRAIL_REMOVIDAS,
  confirmarRemocaoViaAsaas,
  aplicarRemocao,
  marcarRemovidaSeAberta,
  reverterRemovidaParaStatusAsaas,
  classificarCandidataAusente,
  reconciliarCandidatasEmLote,
  confirmarERemoverSemCorrespondencia,
  reverterRemovidaSeReapareceuNoPayload,
};
