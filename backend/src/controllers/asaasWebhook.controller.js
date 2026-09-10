const prisma = require('../config/prisma');
const { criarPrismaEscopado } = require('../config/prismaComEscopo');
const { getAsaasWebhookToken } = require('../services/config.service');
const {
  EVENTOS_WEBHOOK_UPSERT,
  EVENTO_WEBHOOK_DELETE,
  upsertPagamento,
  excluirPagamento,
  resolverClienteEmSegundoPlano,
} = require('../services/pagamentosAsaas.service');

/**
 * POST /api/asaas/webhook/:franquiaId
 * Header: "asaas-access-token: <token gerado em POST /api/config/asaas-webhook/gerar>"
 * Body: payload padrão de webhook do Asaas, { "id": "evt_...", "event": "PAYMENT_...", "payment": {...} }
 *
 * AJUSTE 14 — "Tabela local sincronizada via webhook do Asaas para Taxa de
 * Inadimplência". Recebe eventos do Asaas em tempo real e mantém a tabela
 * "pagamentos_asaas" (ver docblock do model em schema.prisma) sincronizada,
 * eliminando a necessidade de GET /api/inadimplencia/resumo/evolucao-mensal
 * consultarem a API do Asaas ao vivo a cada troca de filtro.
 *
 * SEM "Authorization: Bearer" — o Asaas não envia esse header (o middleware
 * "auth" comum, usado no resto da API, não se aplica aqui). Autenticação é
 * por FRANQUIA + TOKEN, os dois na própria URL/header, sem sessão nenhuma:
 *   1. ":franquiaId" na URL identifica QUAL franquia este evento pertence
 *      (cada franquia tem sua própria conta Asaas, logo sua própria URL de
 *      webhook a cadastrar lá — nunca uma URL genérica compartilhada).
 *   2. O header "asaas-access-token" precisa bater com o token gerado para
 *      essa franquia (ver GET/POST /api/config/asaas-webhook) — campo
 *      "Token de acesso" no cadastro do webhook, no painel do Asaas (opção
 *      nativa do Asaas para autenticar o próprio webhook, sem precisar de
 *      verificação de assinatura HMAC).
 * Qualquer uma das duas falhando é rejeitado com clareza e LOGADO (nunca
 * falha silenciosamente — pedido explícito do brief): franquiaId
 * inexistente → 404; franquia sem token gerado ainda, ou token
 * ausente/não bate → 401. Nos dois casos o Asaas NÃO deve reter esses
 * eventos numa fila de retry indefinida — são erros de configuração, não
 * uma falha transitória — mas como o Asaas trata qualquer resposta != 2xx
 * como falha e reenvia, um erro de configuração vai aparecer repetido nos
 * logs até ser corrigido (URL/token errados no cadastro do webhook lá).
 *
 * IDEMPOTÊNCIA — o Asaas entrega eventos "at least once" (o mesmo evento
 * pode chegar mais de uma vez). Não há uma tabela separada de eventos
 * processados/"evt_..." — a idempotência vem do próprio upsert por
 * "payment.id" (ver `upsertPagamento` em pagamentosAsaas.service.js):
 * aplicar o mesmo evento 2x upserta a mesma linha pro mesmo estado final,
 * nunca duplica nem corrompe. Isso funciona porque cada evento do Asaas
 * traz o estado ATUAL e COMPLETO do pagamento (não um diff) — duas entregas
 * do mesmo evento carregam exatamente os mesmos dados.
 *
 * RESPOSTA RÁPIDA — o upsert em si (1 escrita local no Postgres) é
 * síncrono e rápido, então é feito ANTES de responder 200. A ÚNICA parte
 * mais pesada — resolver cpfCnpj/nome do cliente via GET /v3/customers/{id}
 * do Asaas, só necessária quando o pagamento é novo pra nós — roda em
 * SEGUNDO PLANO, disparada DEPOIS de já ter respondido 200 (nunca
 * "await"ada antes da resposta): mesmo se essa chamada demorar ou falhar,
 * o Asaas já recebeu sua confirmação e não entra em retry por causa disso.
 *
 * EVENTOS TRATADOS (ver EVENTOS_WEBHOOK_UPSERT/EVENTO_WEBHOOK_DELETE em
 * pagamentosAsaas.service.js): PAYMENT_CREATED, PAYMENT_UPDATED,
 * PAYMENT_CONFIRMED, PAYMENT_RECEIVED, PAYMENT_OVERDUE, PAYMENT_RESTORED,
 * PAYMENT_REFUNDED, PAYMENT_CHARGEBACK_REQUESTED, PAYMENT_CHARGEBACK_DISPUTE,
 * PAYMENT_AWAITING_CHARGEBACK_REVERSAL (upsert — o campo "payment.status" do
 * próprio evento já reflete a transição, nenhum tratamento especial por
 * tipo de evento é necessário: é sempre o MESMO upsert, com o "status" que
 * vier) e PAYMENT_DELETED (remove a linha local). QUALQUER outro tipo de
 * evento que a conta Asaas gerar (assinaturas, antecipação, transferências,
 * etc. — fora do escopo desta tabela) responde 200 e não faz nada, de
 * propósito — pra nunca entrar na fila de retry do Asaas por um evento que
 * nunca vamos processar mesmo.
 */
exports.receber = async (req, res) => {
  const { franquiaId } = req.params;

  try {
    const franquia = await prisma.franquia.findUnique({ where: { id: franquiaId }, select: { id: true } });
    if (!franquia) {
      console.error(`[asaas-webhook] Evento recebido para franquiaId inexistente: "${franquiaId}".`);
      return res.status(404).json({ error: 'Franquia não encontrada.' });
    }

    const tokenEsperado = await getAsaasWebhookToken(franquiaId);
    if (!tokenEsperado) {
      console.error(
        `[asaas-webhook] Franquia "${franquiaId}" recebeu um evento mas ainda não tem token de webhook gerado — rejeitando.`
      );
      return res.status(401).json({
        error: 'Webhook não configurado para esta franquia. Gere um token em Configurações antes de cadastrar a URL no Asaas.',
      });
    }

    const tokenRecebido = req.header('asaas-access-token');
    if (!tokenRecebido || tokenRecebido !== tokenEsperado) {
      console.error(`[asaas-webhook] Token de acesso ausente ou inválido para a franquia "${franquiaId}".`);
      return res.status(401).json({ error: 'Token de acesso inválido.' });
    }

    const { event, payment } = req.body || {};
    if (typeof event !== 'string' || !event) {
      console.error(`[asaas-webhook] Payload sem "event" (franquia "${franquiaId}").`, req.body);
      return res.status(400).json({ error: 'Payload inválido: "event" ausente.' });
    }

    if (event === EVENTO_WEBHOOK_DELETE) {
      if (!payment?.id) {
        console.error(`[asaas-webhook] Evento "PAYMENT_DELETED" sem "payment.id" (franquia "${franquiaId}").`, req.body);
        return res.status(400).json({ error: 'Payload inválido: "payment.id" ausente.' });
      }
      await excluirPagamento(franquiaId, payment.id);
      return res.status(200).json({ ok: true, evento: event, acao: 'removido' });
    }

    if (!EVENTOS_WEBHOOK_UPSERT.has(event)) {
      // Fora do escopo tratado — 200 sempre (ver docblock acima), nunca 4xx/5xx.
      return res.status(200).json({ ok: true, evento: event, acao: 'ignorado' });
    }

    if (!payment?.id || !payment?.customer || !payment?.dueDate || payment?.value === undefined || !payment?.status) {
      console.error(`[asaas-webhook] Evento "${event}" com "payment" incompleto (franquia "${franquiaId}").`, payment);
      return res.status(400).json({ error: 'Payload inválido: "payment" incompleto.' });
    }

    const prismaEscopado = criarPrismaEscopado(franquiaId);
    await upsertPagamento(prismaEscopado, franquiaId, payment, null);

    res.status(200).json({ ok: true, evento: event, acao: 'upsert' });

    // Segundo plano — depois de já ter respondido, nunca segurando o Asaas
    // esperando (ver docblock acima). O ".catch()" é só defesa extra: a
    // própria função já nunca lança (loga e retorna), mas nada aqui pode
    // virar unhandled rejection de jeito nenhum.
    resolverClienteEmSegundoPlano(franquiaId, payment.id, payment.customer).catch((err) => {
      console.error(`[asaas-webhook] Falha inesperada na resolução de cliente em segundo plano:`, err);
    });
  } catch (err) {
    console.error(`[asaas-webhook] Erro inesperado processando evento (franquia "${franquiaId}"):`, err);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Erro interno ao processar o evento.' });
    }
  }
};
