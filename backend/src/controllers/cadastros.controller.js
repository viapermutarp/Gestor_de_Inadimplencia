const { getWebhookCadastroUrl } = require('../services/config.service');
const { gerarContratosParaCadastro } = require('../services/contratosGeracao.service');
const { resolverFranquiaIdOuPadrao } = require('../services/franquiaPadrao.service');
// AJUSTE 21 — estas funções viviam definidas aqui local; extraídas pra
// src/lib/camposCadastro.js pra serem reaproveitadas, byte a byte, pelo
// PATCH /api/associados/:cpf_cnpj/cadastro novo (registroAssociados.controller.js)
// — ver docblock do módulo compartilhado.
const {
  DESCRICOES_SERVICO_VALIDAS,
  TIPOS_PESSOA_VALIDOS,
  textoOuNull,
  dataOuNull,
  decimalOuNull,
  inteiroOuNull,
  calcularValorParcela,
} = require('../lib/camposCadastro');

const LIMITE_PADRAO = 100;
const LIMITE_MAXIMO = 100;
// O n8n encadeia várias chamadas externas em sequência (cria cliente no
// Bling, cria pedido no Bling, cria cliente no Asaas, gera a cobrança —
// cada uma com retry de até 3 tentativas e 5s de espera entre elas), então
// o caminho feliz já passa de 30-40s e um retry pode empurrar pra mais de
// 1 minuto. 60s por padrão; configurável via CADASTRO_WEBHOOK_TIMEOUT_MS
// pra testes automatizados não precisarem esperar isso de verdade.
const TIMEOUT_N8N_MS = Number(process.env.CADASTRO_WEBHOOK_TIMEOUT_MS) || 60000;

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * AJUSTE 19 — mapeia o payload de POST /api/cadastros (chaves em português,
 * mesmo formato já enviado ao n8n) para as colunas novas do model
 * `Associado` (ver docblock delas em schema.prisma). Todo campo aqui é
 * exclusivo do Cadastro — nunca escrito por POST /api/sync nem pelo
 * webhook/backfill de pagamentos_asaas (ver mesmo docblock).
 *
 * "valorParcela" não vem no payload (é só preview calculado no frontend,
 * nunca enviado — ver comentário em app/cadastro/page.js) — recalculado
 * aqui com a MESMA fórmula já usada de verdade em
 * contratosGeracao.service.js ({{Valor da Parcela}}): (valorTotal -
 * valorEntrada) / numeroParcelas, só quando numeroParcelas > 1 e valorTotal
 * está preenchido (com 1 parcela só, "a parcela" é o valor total inteiro —
 * mesma regra de negócio do preview do formulário, não faz sentido gravar
 * um valor "de parcela" separado nesse caso).
 */
function mapearPayloadParaAssociado(payload) {
  const valorEntrada = decimalOuNull(payload['Valor da Entrada']);
  const valorTotal = decimalOuNull(payload['Valor Total']);
  const numeroParcelas = inteiroOuNull(payload['Número de Parcelas']);

  // AJUSTE 21 — fórmula extraída pra calcularValorParcela (src/lib/camposCadastro.js),
  // reaproveitada byte a byte pelo PATCH /api/associados/:cpf_cnpj/cadastro novo.
  const valorParcela = calcularValorParcela({ valorTotal, valorEntrada, numeroParcelas });

  return {
    tipoPessoa: textoOuNull(payload['Tipo de Pessoa']),
    razaoSocial: textoOuNull(payload['Razão Social']),
    nomeFantasia: textoOuNull(payload['Nome Fantasia']),
    cep: textoOuNull(payload['CEP']),
    endereco: textoOuNull(payload['Endereço']),
    numero: textoOuNull(payload['Número']),
    complemento: textoOuNull(payload['Complemento']),
    bairro: textoOuNull(payload['Bairro']),
    cidade: textoOuNull(payload['Cidade']),
    uf: textoOuNull(payload['UF']),
    contatoNome: textoOuNull(payload['Contato']),
    celular: textoOuNull(payload['Celular']),
    emailCadastro: textoOuNull(payload['E-mail']),
    descricaoServico: textoOuNull(payload['Descrição do Serviço']),
    valorEntrada,
    dataEntrada: dataOuNull(payload['Data da Entrada']),
    numeroParcelas,
    valorParcela,
    valorTotal,
    dataVencimento: dataOuNull(payload['Data Vencimento']),
    descontoParcela: decimalOuNull(payload['Desconto Parcela']),
    observacoesCadastro: textoOuNull(payload['Observações']),
  };
}

/**
 * Valida os campos obrigatórios do payload de POST /api/cadastros:
 * "CNPJ/CPF", ("Razão Social" OU "Contato"), "Descrição do Serviço" e
 * "Valor Total". Também valida os dois campos de valor fechado (enum)
 * quando presentes ("Descrição do Serviço" é obrigatório e precisa bater
 * com uma das opções; "Tipo de Pessoa" é opcional, mas se vier tem que ser
 * "PF" ou "PJ"). Retorna um array de mensagens de erro (vazio = válido).
 */
function validarPayload(payload) {
  const erros = [];

  if (!campoPreenchido(payload['CNPJ/CPF'])) {
    erros.push('"CNPJ/CPF" é obrigatório.');
  }

  if (!campoPreenchido(payload['Razão Social']) && !campoPreenchido(payload['Contato'])) {
    erros.push('Informe "Razão Social" ou "Contato".');
  }

  if (!campoPreenchido(payload['Descrição do Serviço'])) {
    erros.push('"Descrição do Serviço" é obrigatório.');
  } else if (!DESCRICOES_SERVICO_VALIDAS.includes(payload['Descrição do Serviço'])) {
    erros.push(
      `"Descrição do Serviço" deve ser uma das opções: ${DESCRICOES_SERVICO_VALIDAS.join(', ')}.`
    );
  }

  if (!campoPreenchido(payload['Valor Total'])) {
    erros.push('"Valor Total" é obrigatório.');
  }

  if (payload['Tipo de Pessoa'] !== undefined && !TIPOS_PESSOA_VALIDOS.includes(payload['Tipo de Pessoa'])) {
    erros.push('"Tipo de Pessoa" deve ser "PF" ou "PJ".');
  }

  return erros;
}

/**
 * Repassa o payload para o webhook do n8n configurado (n8n_webhook_cadastro_url)
 * e captura a resposta real dele — usada por POST /api/cadastros pra devolver
 * o link de pagamento e os IDs gerados (Asaas/Bling) pro frontend, em vez de
 * só confirmar que a chamada HTTP em si funcionou.
 *
 * Corpo de resposta esperado do n8n (JSON):
 *   { "sucesso": true, "linkPagamento": "...", "clienteAsaasId": "...", "pedidoBlingId": "..." }
 *   { "sucesso": false, "erro": "CPF inválido" }
 *
 * Nunca lança: sempre retorna { ok, erro? } em caso de falha, ou
 * { ok: true, linkPagamento, clienteAsaasId, pedidoBlingId } em caso de
 * sucesso. Falha de rede/timeout/HTTP/negócio nunca deve travar a resposta
 * de POST /api/cadastros — só é registrada no banco e repassada como erro.
 */
async function enviarParaN8n(payload, franquiaId) {
  const url = await getWebhookCadastroUrl(franquiaId);

  if (!url) {
    return { ok: false, erro: 'URL do webhook do n8n (n8n_webhook_cadastro_url) não está configurada.' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_N8N_MS);

  try {
    const resposta = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
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
      const detalhe = corpo?.erro || (corpoTexto ? corpoTexto.slice(0, 500) : null);
      return {
        ok: false,
        erro: `n8n respondeu com status ${resposta.status}${detalhe ? `: ${detalhe}` : ''}`,
      };
    }

    // HTTP 2xx não garante sucesso do lado do n8n — o fluxo lá pode
    // responder 200 mesmo quando a etapa de negócio falhou (ex.: CPF
    // inválido, cliente já existe no Bling). O campo "sucesso" no corpo é
    // quem manda de verdade; sem esse campo (integração ainda não
    // atualizada), trata como sucesso — mesma lógica de graceful
    // degradation usada em POST /api/sync/atualizar.
    if (corpo?.sucesso === false) {
      return {
        ok: false,
        erro: corpo.erro || 'O n8n reportou falha ao processar o cadastro (sem detalhe adicional).',
      };
    }

    return {
      ok: true,
      linkPagamento: corpo?.linkPagamento ?? null,
      clienteAsaasId: corpo?.clienteAsaasId ?? null,
      pedidoBlingId: corpo?.pedidoBlingId ?? null,
    };
  } catch (err) {
    const mensagem = err.name === 'AbortError' ? 'Tempo esgotado ao chamar o webhook do n8n.' : err.message;
    return { ok: false, erro: mensagem };
  } finally {
    clearTimeout(timeoutId);
  }
}

function serializeCadastro(cadastro) {
  return {
    id: cadastro.id,
    payload: cadastro.payload,
    status: cadastro.status,
    resposta_n8n: cadastro.respostaN8n,
    link_pagamento: cadastro.linkPagamento,
    cliente_asaas_id: cadastro.clienteAsaasId,
    pedido_bling_id: cadastro.pedidoBlingId,
    nome_pasta: cadastro.nomePasta,
    modelos_contrato_ids: cadastro.modelosContratoIds,
    pasta_drive_id: cadastro.pastaDriveId,
    arquivos_gerados: cadastro.arquivosGerados,
    criado_em: cadastro.criadoEm,
  };
}

/**
 * POST /api/cadastros
 *
 * Recebe o payload do formulário de Cadastro/Faturamento (chaves em
 * português, com acento/espaço — mantidas assim porque é o formato que o
 * n8n já espera). Fluxo:
 *   1. Valida os campos obrigatórios (ver `validarPayload`).
 *   2. Salva o registro em "cadastros_enviados" com status "enviado".
 *   3. Repassa o payload ao webhook do n8n configurado e aguarda a resposta
 *      dele (até 60s, ver TIMEOUT_N8N_MS — o fluxo lá encadeia Bling e
 *      Asaas com retries, pode demorar).
 *   4. Se o repasse falhar (rede, timeout, HTTP de erro, URL não
 *      configurada, ou o próprio n8n reportando `"sucesso": false` no
 *      corpo), atualiza o registro para status "erro" com o motivo em
 *      "resposta_n8n". Se der certo, grava `link_pagamento`,
 *      `cliente_asaas_id` e `pedido_bling_id` vindos da resposta do n8n.
 *   Em ambos os casos a resposta HTTP deste endpoint continua sendo 201 —
 *   o cadastro em si foi salvo; quem decide se deu certo é o campo
 *   "status" do corpo (ver serializeCadastro), não o status HTTP. Assim o
 *   frontend sempre recebe uma resposta pra mostrar (sucesso com link, ou
 *   erro com o motivo), sem a chamada "travar" nem virar uma exceção.
 *
 *   5. Se o body trouxer "modelosContratoIds" (array de ids de
 *      ModeloContrato — campo "Contratos a gerar" do formulário), a
 *      geração dos .docx e o upload pro Drive rodam em segundo plano
 *      DEPOIS da resposta HTTP já ter sido enviada (ver
 *      gerarContratosParaCadastro em contratosGeracao.service.js) — nunca
 *      atrasa nem trava o envio do cadastro. "nomePasta" (campo "Nome da
 *      pasta") e "modelosContratoIds" são metadados internos: não entram
 *      no "payload" salvo/repassado ao n8n, só nos campos dedicados do
 *      registro (nome_pasta, modelos_contrato_ids). O resultado
 *      (pasta_drive_id, arquivos_gerados) é preenchido de forma
 *      assíncrona — consulte GET /api/cadastros depois pra ver o status.
 *
 *   6. AJUSTE 19 — além de salvar em "cadastros_enviados", faz upsert do
 *      `Associado` correspondente (chave: "CNPJ/CPF" do payload), SEMPRE,
 *      **antes** de disparar o webhook do n8n — decisão explícita do
 *      brief: "persistir local primeiro, sempre; o disparo externo pode
 *      falhar e ser reenviado depois, mas o registro no sistema não
 *      deveria depender disso". O upsert do associado e a criação do
 *      "cadastroEnviado" rodam na MESMA transação (`req.prisma.$transaction`,
 *      forma callback — mesmo padrão de associados.controller.js, exigido
 *      pela extension de isolamento por franquia); se qualquer um dos dois
 *      falhar, nenhum dos dois é salvo. Só depois dessa transação confirmada
 *      é que `enviarParaN8n` é chamado — uma falha ali (rede, timeout, n8n
 *      fora do ar) não desfaz nem impede o registro local, só marca o
 *      "cadastroEnviado" como "erro" (ver passo 4 acima, inalterado).
 *
 *      Ver `mapearPayloadParaAssociado` pro mapeamento campo a campo. Em
 *      um UPDATE (associado já existia — por exemplo, criado antes por
 *      POST /api/sync), "nome"/"telefone"/"email" (campos legados) NÃO são
 *      tocados — continuam sendo escritos só pelo sync (ver docblock do
 *      model em schema.prisma). Em um CREATE (associado ainda não
 *      existia), como "nome"/"telefone" são NOT NULL no schema, usa
 *      fallback: nome = Razão Social || Nome Fantasia || Contato (uma
 *      dessas sempre vem preenchida, `validarPayload` garante Razão Social
 *      OU Contato); telefone = Celular (pode ficar como string vazia se o
 *      formulário não trouxer Celular — o valor real chega depois, na
 *      primeira vez que o sync do Asaas tocar esse associado).
 */
exports.criar = async (req, res, next) => {
  try {
    // "nomePasta" e "modelosContratoIds" são metadados internos da
    // geração de contratos (ver contratosGeracao.service.js) — não fazem
    // parte do contrato de payload que o n8n espera, então são extraídos
    // aqui e nunca repassados pra "payload" (nem salvos nem enviados ao n8n).
    const { nomePasta, modelosContratoIds, ...payload } = req.body || {};

    const erros = validarPayload(payload);
    if (erros.length > 0) {
      return res.status(400).json({ error: erros.join(' ') });
    }

    const modelosIds = Array.isArray(modelosContratoIds)
      ? modelosContratoIds.filter((id) => typeof id === 'string' && id.trim() !== '')
      : [];

    // Multi-franquia — Passo 4, Item 2: valida que cada "modeloContratoId"
    // pertence à franquia de quem está enviando ANTES de salvar o cadastro
    // — sem isso, alguém poderia (por bug do frontend ou de propósito)
    // apontar pro id de um modelo de OUTRA franquia, e
    // contratosGeracao.service.js (job assíncrono, fora do req.prisma)
    // acabaria gerando o contrato com o modelo errado (ver Item 3, defesa em
    // profundidade complementar dentro do próprio job). "req.prisma" já
    // filtra por franquia automaticamente (ver prismaComEscopo.js) — um id
    // de outra franquia simplesmente não aparece no resultado.
    const idsUnicos = [...new Set(modelosIds)];
    if (idsUnicos.length > 0) {
      const modelosEncontrados = await req.prisma.modeloContrato.findMany({
        where: { id: { in: idsUnicos } },
        select: { id: true },
      });
      if (modelosEncontrados.length !== idsUnicos.length) {
        return res.status(400).json({
          error: 'Um ou mais "modelosContratoIds" não existem ou não pertencem à sua franquia.',
        });
      }
    }

    const cpfCnpj = payload['CNPJ/CPF'].trim();
    const camposAssociado = mapearPayloadParaAssociado(payload);
    const nomeFallback =
      textoOuNull(payload['Razão Social']) || textoOuNull(payload['Nome Fantasia']) || textoOuNull(payload['Contato']) || cpfCnpj;
    const telefoneFallback = textoOuNull(payload['Celular']) || '';

    // Multi-franquia — Fase 3: "franquiaId" injetado automaticamente pela
    // extension (ver prismaComEscopo.js) — não precisa mais resolver via
    // franquiaPadrao.service.js aqui.
    let { cadastro } = await req.prisma.$transaction(async (tx) => {
      await tx.associado.upsert({
        where: { cpfCnpj },
        create: { cpfCnpj, nome: nomeFallback, telefone: telefoneFallback, ...camposAssociado },
        update: camposAssociado,
      });

      const cadastro = await tx.cadastroEnviado.create({
        data: {
          payload,
          status: 'enviado',
          nomePasta: typeof nomePasta === 'string' && nomePasta.trim() !== '' ? nomePasta.trim() : null,
          modelosContratoIds: modelosIds,
        },
      });

      return { cadastro };
    });

    const franquiaId = await resolverFranquiaIdOuPadrao(req);
    const resultadoN8n = await enviarParaN8n(payload, franquiaId);

    if (!resultadoN8n.ok) {
      cadastro = await req.prisma.cadastroEnviado.update({
        where: { id: cadastro.id },
        data: { status: 'erro', respostaN8n: resultadoN8n.erro },
      });
    } else {
      cadastro = await req.prisma.cadastroEnviado.update({
        where: { id: cadastro.id },
        data: {
          linkPagamento: resultadoN8n.linkPagamento,
          clienteAsaasId: resultadoN8n.clienteAsaasId,
          pedidoBlingId: resultadoN8n.pedidoBlingId,
        },
      });
    }

    // Geração dos contratos selecionados: roda em segundo plano, depois
    // da resposta HTTP já ter sido enviada (ver abaixo) — nunca deve
    // atrasar nem travar o formulário. gerarContratosParaCadastro nunca
    // lança (qualquer falha só é logada); o resultado (pastaDriveId /
    // arquivosGerados) é salvo direto no registro quando terminar.
    if (modelosIds.length > 0) {
      setImmediate(() => {
        gerarContratosParaCadastro(cadastro.id).catch((err) => {
          console.error(`[cadastros] Erro inesperado ao gerar contratos (cadastro ${cadastro.id}):`, err.message);
        });
      });
    }

    res.status(201).json(serializeCadastro(cadastro));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/cadastros
 * GET /api/cadastros?page=2&limit=50
 *
 * Lista os cadastros enviados, paginado (mesmo padrão de GET /api/associados):
 * "page" (padrão 1) e "limit" (padrão 100, máximo 100). Mais recentes primeiro.
 * Resposta: { dados: [...], paginacao: { pagina_atual, total_paginas, total_registros, por_pagina } }
 */
exports.listar = async (req, res, next) => {
  try {
    const { page: pageParam, limit: limitParam } = req.query;

    let page = parseInt(pageParam, 10);
    if (!Number.isInteger(page) || page < 1) page = 1;

    let limit = parseInt(limitParam, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = LIMITE_PADRAO;
    if (limit > LIMITE_MAXIMO) limit = LIMITE_MAXIMO;

    const totalRegistros = await req.prisma.cadastroEnviado.count();
    const totalPaginas = Math.max(Math.ceil(totalRegistros / limit), 1);

    const cadastros = await req.prisma.cadastroEnviado.findMany({
      orderBy: { criadoEm: 'desc' },
      skip: (page - 1) * limit,
      take: limit,
    });

    res.json({
      dados: cadastros.map(serializeCadastro),
      paginacao: {
        pagina_atual: page,
        total_paginas: totalPaginas,
        total_registros: totalRegistros,
        por_pagina: limit,
      },
    });
  } catch (err) {
    next(err);
  }
};
