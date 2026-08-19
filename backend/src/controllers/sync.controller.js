const prisma = require('../config/prisma');

const STATUS_VALIDOS = ['pending', 'overdue', 'paid'];

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
              },
            });
            cobrancasAtualizadas += 1;
          } else {
            await prisma.cobranca.create({
              data: {
                ...dadosComuns,
                idExterno,
              },
            });
            cobrancasCriadas += 1;
          }
        }
      }
    }

    await registrarSyncLog({ total: totalAssociadosProcessados, sucesso: true });

    res.json({
      associados_criados: associadosCriados,
      associados_atualizados: associadosAtualizados,
      cobrancas_criadas: cobrancasCriadas,
      cobrancas_atualizadas: cobrancasAtualizadas,
      erros,
    });
  } catch (err) {
    await registrarSyncLog({ total: totalAssociadosProcessados, sucesso: false });
    next(err);
  }
};
