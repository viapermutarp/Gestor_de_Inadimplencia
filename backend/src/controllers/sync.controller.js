const prisma = require('../config/prisma');

const STATUS_VALIDOS = ['pending', 'overdue', 'paid'];

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
 */
async function registrarSyncLog({ total, sucesso }) {
  try {
    await prisma.syncLog.create({
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
 * Reconciliação (quitação automática): para cada associado cujo registro
 * traga "cobrancas" como array (mesmo vazio), toda cobrança já existente no
 * banco para esse associado com status "pending"/"overdue" que NÃO foi
 * criada/atualizada por esta chamada é marcada como "quitada" (com
 * "quitada_em" = agora). Isso cobre o caso comum de uma cobrança ser paga no
 * Asaas: o n8n simplesmente para de trazê-la nas próximas chamadas (a
 * consulta lá filtra por status PENDING/OVERDUE), então sem essa
 * reconciliação a cobrança ficava presa no banco para sempre no último
 * status sincronizado, contando indevidamente como "em aberto" no Dashboard.
 * Não é hard delete — o registro continua no banco, só muda de status
 * (histórico financeiro preservado). Associados cujo registro não trouxer
 * "cobrancas" como array (chave ausente ou não-array) não sofrem nenhuma
 * reconciliação — preserva o comportamento de syncs "só cadastrais", que não
 * pretendem informar nada sobre cobranças.
 */
exports.sync = async (req, res, next) => {
  let totalAssociadosProcessados = 0;

  try {
    const registros = Array.isArray(req.body) ? req.body : req.body?.associados;

    if (!Array.isArray(registros) || registros.length === 0) {
      await registrarSyncLog({ total: 0, sucesso: false });
      return res.status(400).json({ error: 'Envie um array de associados no corpo da requisição.' });
    }

    totalAssociadosProcessados = registros.length;

    let associadosCriados = 0;
    let associadosAtualizados = 0;
    let cobrancasCriadas = 0;
    let cobrancasAtualizadas = 0;
    let cobrancasQuitadas = 0;
    const erros = [];

    for (const [index, registro] of registros.entries()) {
      const { cpf_cnpj: cpfCnpj, nome, telefone, email, cobrancas } = registro || {};

      if (!cpfCnpj || !nome || !telefone) {
        erros.push({ index, cpf_cnpj: cpfCnpj || null, erro: 'cpf_cnpj, nome e telefone são obrigatórios.' });
        continue;
      }

      const existente = await prisma.associado.findUnique({ where: { cpfCnpj } });

      const associado = await prisma.associado.upsert({
        where: { cpfCnpj },
        update: { nome, telefone, email: email ?? null },
        create: { cpfCnpj, nome, telefone, email: email ?? null },
      });

      if (existente) {
        associadosAtualizados += 1;
      } else {
        associadosCriados += 1;
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
            cobrancaExistente = await prisma.cobranca.findUnique({ where: { idExterno } });
          } else {
            // Fallback (compatibilidade retroativa): casa por associado + vencimento + descrição.
            // Só considera cobranças que também não têm id_externo, para não "roubar" e
            // sobrescrever por engano um registro que já está vinculado a um ID do Asaas.
            cobrancaExistente = await prisma.cobranca.findFirst({
              where: {
                associadoId: associado.id,
                vencimento: vencimentoDate,
                descricao: descricao ?? null,
                idExterno: null,
              },
            });
          }

          if (cobrancaExistente) {
            await prisma.cobranca.update({
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
            cobrancasAtualizadas += 1;
          } else {
            const criada = await prisma.cobranca.create({
              data: {
                ...dadosComuns,
                idExterno,
              },
            });
            idsTratados.add(criada.id);
            cobrancasCriadas += 1;
          }
        }

        // Reconciliação: cobranças que estavam pending/overdue no banco para
        // este associado mas não vieram (nem foram criadas/atualizadas) neste
        // payload — o caso mais comum é a cobrança ter sido paga no Asaas, que
        // simplesmente para de devolvê-la nas próximas consultas. Marca como
        // "quitada" em vez de apagar, preservando o histórico financeiro.
        const resultadoQuitacao = await prisma.cobranca.updateMany({
          where: {
            associadoId: associado.id,
            status: { in: STATUS_CONSIDERADOS_ABERTOS },
            ...(idsTratados.size > 0 ? { id: { notIn: Array.from(idsTratados) } } : {}),
          },
          data: { status: 'quitada', quitadaEm: new Date() },
        });
        cobrancasQuitadas += resultadoQuitacao.count;
      }
    }

    await registrarSyncLog({ total: totalAssociadosProcessados, sucesso: true });

    res.json({
      associados_criados: associadosCriados,
      associados_atualizados: associadosAtualizados,
      cobrancas_criadas: cobrancasCriadas,
      cobrancas_atualizadas: cobrancasAtualizadas,
      cobrancas_quitadas: cobrancasQuitadas,
      erros,
    });
  } catch (err) {
    await registrarSyncLog({ total: totalAssociadosProcessados, sucesso: false });
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
