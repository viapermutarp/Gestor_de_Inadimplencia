const cache = require('../services/cache.service');
const { getPalavrasExcluidas, getDiasTolerancia } = require('../services/config.service');
// AJUSTE 14 — "AsaasApiError" continua importado (só ela — "listarPagamentos"/
// "obterClientesPorId" saíram deste arquivo) porque `reconciliarPagamentos`
// (abaixo) ainda pode propagar esse erro: `sincronizarJanela`, que ele chama,
// consulta a API do Asaas ao vivo de propósito (é uma reconciliação — precisa
// comparar contra a fonte de verdade). "/resumo" e "/evolucao-mensal" NÃO
// consultam mais o Asaas (ver docblock de `buscarPagamentosValidos`), então
// não podem mais lançar esse erro.
const { AsaasApiError } = require('../services/asaas.service');
const { resolverFranquiaIdOuPadrao } = require('../services/franquiaPadrao.service');
const { sincronizarJanela, calcularJanelaReconciliacao } = require('../services/pagamentosAsaas.service');

const FILTRO_TRI_ESTADO_VALIDAS = ['todos', 'sim', 'nao'];
const VISAO_VALIDAS = ['aberto', 'historico']; // AJUSTE 6 — renomeado de "visao_faixas"
// pra "visao": o parâmetro deixou de controlar só as faixas de atraso e passou a
// controlar também valor_inadimplente/valor_adimplente/as duas taxas do topo da
// tela (ver docblock de `resumo`).
const TIPO_PENDENCIA_VALIDAS = ['todos', 'vencidas', 'confirmadas'];
const CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutos — dentro da faixa de 3-5min pedida.
const MESES_PADRAO = 12;
const UM_DIA_MS = 24 * 60 * 60 * 1000;
const PALAVRA_RENEGOCIACAO = 'renegociação';
const LIMIAR_DIAS_CRITICO = 90; // mesmo limiar de "criticos_90_dias", ver computarFaixasECriticos/computarCpfCnpjCriticos.

/**
 * Repaginação dos filtros da tela "Taxa de Inadimplência" (item 2 do brief
 * "Repaginar filtros") — "Filtrar período por": qual campo de data o par
 * "venc_de"/"venc_ate" (nomes de parâmetro mantidos por compatibilidade —
 * ver `resolverPeriodo`, inalterada) passa a restringir. Default
 * "vencimento" preserva o comportamento de sempre (nenhuma regressão pra
 * quem não manda o parâmetro novo). Ver `buscarPagamentosValidos`.
 */
const FILTRO_PERIODO_VALIDAS = ['vencimento', 'emissao', 'pagamento'];
const CAMPO_DATA_POR_FILTRO_PERIODO = {
  vencimento: 'dueDate',
  emissao: 'dateCreated',
  pagamento: 'paymentDate',
};

/**
 * Item 3 do brief — "Situação da cobrança": filtro de população (some ao
 * grupo renegociacao/em_juridico/bloqueado, ver `aplicarFiltrosCrossReference`)
 * que restringe TODO o conjunto de trabalho pelo status atual, ANTES de
 * qualquer cálculo — diferente do "tipo_pendencia" (AJUSTE 4), que só
 * afeta a composição de "valor_inadimplente" sem tirar nada de
 * "valor_total_faturado"/faixas/etc. Combinável (`situacao=em_aberto,pagas`,
 * lista separada por vírgula — ver `validarListaMultipla`): vazio/ausente =
 * "Todas" (sem restrição, comportamento de sempre). Substitui "tipo_pendencia"
 * na UI (removido do novo layout de filtros — ver README); o parâmetro
 * "tipo_pendencia" continua aceito no backend por compatibilidade, só não é
 * mais enviado pela tela.
 */
const SITUACAO_VALIDAS = ['em_aberto', 'pagas'];
const STATUS_POR_SITUACAO = {
  em_aberto: ['OVERDUE', 'CONFIRMED', 'PENDING'],
  pagas: ['RECEIVED', 'RECEIVED_IN_CASH'],
};

/**
 * Item 6 do brief — "Tipo de inadimplente": expande o antigo filtro
 * exclusivo `em_juridico` (todos|sim|nao) para 3 opções COMBINÁVEIS por OU
 * entre si (`tipo_inadimplente=juridico,critico`, mesma lista separada por
 * vírgula de "situacao") — um associado Jurídico com 100 dias de atraso
 * aparece com "juridico" e "critico" marcados ao mesmo tempo, sem exclusão
 * mútua. Vazio/ausente = "Todos" (sem restrição). Continua combinando por E
 * com "renegociacao"/"bloqueado" (inalterados) — só o antigo `em_juridico`
 * exclusivo foi substituído por este grupo na tela nova; o parâmetro
 * "em_juridico" continua aceito no backend por compatibilidade. Ver
 * `computarCpfCnpjCriticos`/`aplicarFiltroTipoInadimplente`.
 */
const TIPO_INADIMPLENTE_VALIDAS = ['ativo', 'juridico', 'critico'];

/**
 * AJUSTE CRÍTICO 3 — critério de "valor_inadimplente"/"valor_adimplente"
 * deixou de ser a classificação histórica por data de pagamento
 * (`classificarPagamento`, ver docblock dela) e passou a ser o STATUS
 * ATUAL de cada cobrança no Asaas — decisão de negócio confirmada
 * explicitamente: a Taxa de Inadimplência deve refletir o que está em
 * aberto AGORA, não o histórico de atraso de algo já quitado (reverte de
 * propósito o raciocínio do AJUSTE CRÍTICO 1, feito originalmente pro caso
 * oposto). `classificarPagamento` continua existindo e sendo usada, sem
 * NENHUMA mudança de comportamento, só para `faixas`/`criticos_90_dias` no
 * modo "historico" — ver docblocks de `resumo` e `computarFaixasECriticos`.
 *
 *   - INADIMPLENTE: status "OVERDUE" (vencida, ainda não paga) ou
 *     "CONFIRMED" (confirmada — ex.: cartão de crédito aprovado, dinheiro
 *     ainda não caiu na conta). `STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA`
 *     conforme o filtro "tipo_pendencia" controla quais dos dois entram
 *     (AJUSTE 4).
 *   - ADIMPLENTE: status "RECEIVED" ou "RECEIVED_IN_CASH" (dinheiro já
 *     confirmado na conta — a segunda variante é a baixa manual "recebido
 *     em dinheiro" do Asaas).
 *   - Nem um nem outro (não entra em nenhum dos dois somatórios): qualquer
 *     outro status — o mais comum sendo "PENDING" (ainda não venceu, ainda
 *     não foi pago). É esperado e correto que
 *     `valor_total_faturado !== valor_inadimplente + valor_adimplente`
 *     sempre que houver cobranças desse terceiro grupo no período.
 *
 * AJUSTE 6 — esta classificação por STATUS ATUAL só é usada quando "visao"
 * (renomeado de "visao_faixas") = "aberto" (padrão, sem regressão). Em
 * "visao=historico", "valor_inadimplente"/"valor_adimplente" passam a usar a
 * MESMA classificação histórica por data de `classificarPagamento` que já
 * alimenta "faixas"/"criticos_90_dias" — ver
 * `computarValorInadimplenteAdimplenteHistorico` e o docblock de `resumo`.
 * Consequência confirmada explicitamente: o filtro "tipo_pendencia" (que só
 * faz sentido sobre status atual — OVERDUE x CONFIRMED) fica SEM EFEITO
 * quando "visao=historico" — não existe um equivalente de "só vencidas"/"só
 * confirmadas" numa classificação por data de pagamento. O frontend
 * desabilita visualmente o campo "Tipo de pendência" nesse caso, pra deixar
 * isso explícito pro usuário (em vez de aceitar o valor e simplesmente
 * ignorá-lo em silêncio).
 */
const STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA = {
  todos: ['OVERDUE', 'CONFIRMED'],
  vencidas: ['OVERDUE'],
  confirmadas: ['CONFIRMED'],
};
const STATUS_ADIMPLENTE = ['RECEIVED', 'RECEIVED_IN_CASH'];

function formatarDataISO(data) {
  const ano = data.getFullYear();
  const mes = String(data.getMonth() + 1).padStart(2, '0');
  const dia = String(data.getDate()).padStart(2, '0');
  return `${ano}-${mes}-${dia}`;
}

function dataValida(str) {
  return typeof str === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(str) && !Number.isNaN(Date.parse(str));
}

function arredondar2(valor) {
  return Math.round((Number(valor) || 0) * 100) / 100;
}

function calcularTaxa(valorTotalFaturado, valorParcial) {
  return valorTotalFaturado > 0 ? arredondar2((valorParcial / valorTotalFaturado) * 100) : 0;
}

/**
 * Diferença em dias inteiros entre duas datas "YYYY-MM-DD" (dataFimStr -
 * dataInicioStr). Usada tanto para "dias de atraso até hoje" quanto para
 * "dias entre pagamento e vencimento" — sempre à meia-noite, para não
 * sofrer efeito de fuso horário/hora do dia.
 */
function diferencaDias(dataFimStr, dataInicioStr) {
  const fim = new Date(`${dataFimStr}T00:00:00`);
  const inicio = new Date(`${dataInicioStr}T00:00:00`);
  return Math.floor((fim.getTime() - inicio.getTime()) / UM_DIA_MS);
}

/**
 * Soma "dias" dias corridos a uma data "YYYY-MM-DD", devolvendo outra
 * string "YYYY-MM-DD" — mesmo cuidado de fuso horário (meia-noite local)
 * das demais funções de data deste arquivo. Usada para calcular a "data
 * limite efetiva" do período de tolerância (ver `classificarPagamento` e
 * o docblock de `resumo`/`evolucaoMensal` sobre a tolerância).
 */
function somarDias(dataStr, dias) {
  if (!dias) return dataStr;
  const data = new Date(`${dataStr}T00:00:00`);
  data.setDate(data.getDate() + dias);
  return formatarDataISO(data);
}

/**
 * Resolve o período padrão (últimos 12 meses, terminando hoje) quando
 * "venc_de"/"venc_ate" não são informados juntos.
 */
function resolverPeriodo(vencDeParam, vencAteParam) {
  if (vencDeParam === undefined && vencAteParam === undefined) {
    const hoje = new Date();
    const inicio = new Date(hoje);
    inicio.setMonth(inicio.getMonth() - MESES_PADRAO);
    return { vencDe: formatarDataISO(inicio), vencAte: formatarDataISO(hoje), erro: null };
  }

  if (vencDeParam === undefined || vencAteParam === undefined) {
    return { erro: 'Informe "venc_de" e "venc_ate" juntos, ou nenhum dos dois (usa os últimos 12 meses).' };
  }

  if (!dataValida(vencDeParam) || !dataValida(vencAteParam)) {
    return { erro: '"venc_de" e "venc_ate" devem estar no formato YYYY-MM-DD.' };
  }

  if (vencDeParam > vencAteParam) {
    return { erro: '"venc_de" não pode ser depois de "venc_ate".' };
  }

  return { vencDe: vencDeParam, vencAte: vencAteParam, erro: null };
}

/**
 * Valida um parâmetro no formato "todos|sim|nao" (usado por "renegociacao",
 * "em_juridico" e "bloqueado", com exatamente a mesma regra para os três).
 */
function validarFiltroTriEstado(valorParam, nomeParam) {
  const valor = valorParam === undefined ? 'todos' : valorParam;
  if (!FILTRO_TRI_ESTADO_VALIDAS.includes(valor)) {
    return { erro: `"${nomeParam}" deve ser "todos", "sim" ou "nao".` };
  }
  return { valor, erro: null };
}

/**
 * Valida o filtro "tipo_pendencia" ("todos"|"vencidas"|"confirmadas",
 * padrão "todos") — AJUSTE 4: separa, dentro de "valor_inadimplente", as
 * cobranças vencidas (status "OVERDUE") das confirmadas/crédito futuro
 * (status "CONFIRMED"), que antes desta correção sempre apareciam somadas.
 * Afeta só "valor_inadimplente"/"taxa_inadimplencia_percentual" — nunca
 * "valor_adimplente" (sempre RECEIVED/RECEIVED_IN_CASH, independente deste
 * filtro) nem "valor_total_faturado" (sempre o período inteiro).
 */
function validarTipoPendencia(valorParam) {
  const valor = valorParam === undefined ? 'todos' : valorParam;
  if (!TIPO_PENDENCIA_VALIDAS.includes(valor)) {
    return { erro: '"tipo_pendencia" deve ser "todos", "vencidas" ou "confirmadas".' };
  }
  return { valor, erro: null };
}

/**
 * Valida o filtro "filtro_periodo" ("vencimento"|"emissao"|"pagamento",
 * padrão "vencimento" — ver docblock de FILTRO_PERIODO_VALIDAS).
 */
function validarFiltroPeriodo(valorParam) {
  const valor = valorParam === undefined ? 'vencimento' : valorParam;
  if (!FILTRO_PERIODO_VALIDAS.includes(valor)) {
    return { erro: '"filtro_periodo" deve ser "vencimento", "emissao" ou "pagamento".' };
  }
  return { valor, erro: null };
}

/**
 * Parser/validador compartilhado pelos dois filtros novos combináveis
 * ("situacao"/"tipo_inadimplente") — mesmo formato: lista separada por
 * vírgula, sem espaços obrigatórios (`.trim()` por item), duplicatas
 * removidas, vazio/ausente = `[]` (nenhuma restrição — "Todas"/"Todos").
 * Qualquer item fora de `valoresValidos` é erro 400 explícito, não
 * silenciosamente ignorado.
 */
function validarListaMultipla(valorParam, valoresValidos, nomeParam) {
  if (valorParam === undefined || valorParam === '') {
    return { valores: [], erro: null };
  }
  const itens = [...new Set(valorParam.split(',').map((item) => item.trim()).filter(Boolean))];
  const invalido = itens.find((item) => !valoresValidos.includes(item));
  if (invalido) {
    return { erro: `"${nomeParam}" contém um valor inválido: "${invalido}" (válidos: ${valoresValidos.join(', ')}).` };
  }
  return { valores: itens, erro: null };
}

/**
 * Classifica uma cobrança em ADIMPLENTE | INADIMPLENTE | A_VENCER a partir
 * da DATA DE PAGAMENTO (campo "paymentDate" do Asaas — confirmado na
 * documentação oficial, https://docs.asaas.com/reference/list-payments:
 * "Payment date on Asaas", populado quando a cobrança é efetivamente paga,
 * `null` enquanto não paga; distinto de "clientPaymentDate", que é
 * específico de boleto e não usado aqui), NUNCA a partir do status atual
 * (`status`) — ver AJUSTE CRÍTICO 1 no README para o porquê: o status muda
 * com o tempo (uma cobrança vencida em janeiro e paga em março aparece
 * como RECEIVED em qualquer consulta feita depois de março, "escondendo"
 * o atraso histórico de janeiro se a classificação fosse por status).
 *
 * PERÍODO DE TOLERÂNCIA (`diasTolerancia`, configurável via
 * GET/PATCH /api/config/tolerancia-dias, padrão 0) — absorve atrasos
 * operacionais irrelevantes (ex.: float bancário de fim de semana) sem
 * contá-los como inadimplência real. Toda comparação contra "dueDate" usada
 * para decidir ADIMPLENTE/INADIMPLENTE/A_VENCER passa a usar a "data limite
 * efetiva" = dueDate + diasTolerancia dias corridos (`somarDias`), não mais
 * o vencimento cru — ver README, seção "Período de tolerância", para a
 * fórmula completa e um exemplo numérico. Com diasTolerancia=0 (padrão), a
 * data limite efetiva é idêntica ao vencimento cru e o comportamento é
 * EXATAMENTE o mesmo de antes desta configuração existir (nenhuma regressão).
 *
 * Regra (mesma data em formato "YYYY-MM-DD", comparação lexicográfica =
 * cronológica; dataLimiteEfetiva = dueDate + diasTolerancia):
 *   - ADIMPLENTE: paymentDate existe E paymentDate <= dataLimiteEfetiva.
 *   - INADIMPLENTE: paymentDate existe E paymentDate > dataLimiteEfetiva
 *     (pago além da tolerância) OU paymentDate não existe E
 *     dataLimiteEfetiva <= hoje (ainda não pago, e a tolerância já esgotou).
 *   - A_VENCER: paymentDate não existe E dataLimiteEfetiva > hoje — cobre
 *     tanto o caso já existente (vencimento futuro) quanto, com tolerância
 *     configurada, uma cobrança já vencida mas ainda dentro da janela de
 *     tolerância (ainda não pode ser julgada nem em dia nem atrasada).
 *
 * > **Decisão de design**: o pedido original dizia que cobranças com
 * > vencimento futuro "continuam sendo tratadas como a vencer" (comportamento
 * > inalterado) — o que se mantém aqui: para uma cobrança realmente futura
 * > (dueDate > hoje), dataLimiteEfetiva >= dueDate > hoje sempre, então ela
 * > cai em A_VENCER de qualquer forma. A tolerância só passa a ALÉM DISSO
 * > cobrir o caso novo de "já venceu pela data crua, mas ainda dentro da
 * > tolerância" com o mesmo rótulo A_VENCER (em vez de INADIMPLENTE) — é a
 * > aplicação consistente pedida explicitamente ("para qualquer comparação
 * > entre vencimento e hoje, quando ainda não pago, use a data limite
 * > efetiva"), e é o que faz uma cobrança vencida ontem, ainda não paga, com
 * > 2 dias de tolerância, não ser contada como inadimplência real ainda.
 *
 * AJUSTE 6 — além de "faixas"/"criticos_90_dias" (uso original), esta
 * classificação passou a alimentar também "valor_inadimplente"/
 * "valor_adimplente" quando "visao=historico" (ver
 * `computarValorInadimplenteAdimplenteHistorico`) — SEM NENHUMA mudança de
 * comportamento aqui: é a mesma função, mesmas 3 categorias, só passou a
 * ser lida por mais um lugar.
 */
function classificarPagamento(pagamento, hojeStr, diasTolerancia = 0) {
  const dataLimiteEfetiva = somarDias(pagamento.dueDate, diasTolerancia);
  const paymentDate = pagamento.paymentDate || null;

  if (paymentDate) {
    return paymentDate <= dataLimiteEfetiva ? 'ADIMPLENTE' : 'INADIMPLENTE';
  }
  return dataLimiteEfetiva > hojeStr ? 'A_VENCER' : 'INADIMPLENTE';
}

/**
 * AJUSTE 14 — "cpfCnpj"/"nome" do cliente Asaas não são mais resolvidos ao
 * vivo (GET /v3/customers/{id}) a cada leitura: já vêm CACHEADOS direto no
 * pagamento (colunas "cpf_cnpj"/"nome" da tabela local "pagamentos_asaas",
 * populadas pelo webhook/backfill/reconciliação — ver
 * pagamentosAsaas.service.js), então `resolverPagamento` já recebe
 * `pagamento.cpfCnpj`/`pagamento.nome` prontos em vez de precisar de um
 * `mapaClientes` (customerId -> {cpfCnpj, nome}) resolvido via Asaas
 * separadamente. O resto da função é idêntico a antes: cruza esse cpfCnpj
 * com a nossa tabela "associados" (associadoPorCpfCnpj: cpfCnpj ->
 * associado) para { cpfCnpj, nome, emNegociacao, emJuridico, bloqueado }.
 * Pagamentos sem cpfCnpj cacheado ainda (ex.: webhook recebido há poucos
 * segundos, resolução em segundo plano ainda não terminou — ver
 * `resolverClienteEmSegundoPlano`), ou cujo cpfCnpj não bate com nenhum
 * associado nosso, são tratados como "não" nos três campos booleanos (regra
 * explícita do pedido, igual para os três — comportamento inalterado).
 */
function resolverPagamento(pagamento, associadoPorCpfCnpj) {
  const cpfCnpj = pagamento.cpfCnpj || null;
  const associado = cpfCnpj ? associadoPorCpfCnpj.get(cpfCnpj) : undefined;

  return {
    cpfCnpj,
    nome: associado?.nome || pagamento.nome || null,
    emNegociacao: associado ? associado.emNegociacao === true : false,
    emJuridico: associado ? associado.emJuridico === true : false,
    bloqueado: associado ? associado.bloqueado === true : false,
  };
}

/**
 * Busca as duas fontes de exclusão configuradas: a lista manual por ID
 * (tabela "cobrancas_ignoradas", gerenciada via
 * GET/POST/DELETE /api/inadimplencia/exclusoes) e a lista de palavras-chave
 * (tabela "configuracoes" -> "inadimplencia_palavras_excluidas", gerenciada
 * via GET/PATCH /api/config/palavras-excluidas).
 */
async function buscarExclusoesConfiguradas(reqPrisma, franquiaId) {
  const [registrosIgnorados, palavras] = await Promise.all([
    reqPrisma.cobrancaIgnorada.findMany({ select: { asaasPaymentId: true } }),
    getPalavrasExcluidas(franquiaId),
  ]);
  const idsExcluidos = new Set(registrosIgnorados.map((r) => r.asaasPaymentId));
  return { idsExcluidos, palavras };
}

/**
 * Remove tudo que não for dígito de uma string — usado para comparar
 * CPF/CNPJ independente de formatação (AJUSTE 7): tanto a palavra-chave
 * configurada ("12.345.678/0001-90") quanto o CPF/CNPJ resolvido via Asaas
 * (tipicamente já só dígitos, mas não presumimos isso) passam por aqui
 * antes de comparar, então qualquer combinação de formatado/não formatado
 * dos dois lados dá match.
 */
function normalizarDocumento(valor) {
  return (valor || '').replace(/\D/g, '');
}

/**
 * Separa os pagamentos em "válidos" (entram no cálculo) e "excluídos". Um
 * pagamento é excluído se: (a) seu ID estiver na lista manual, OU (b) uma
 * das palavras-chave configuradas bater em pelo menos um destes 3 campos
 * (AJUSTE 7 — antes só o primeiro):
 *   - descrição da cobrança (case-insensitive, substring);
 *   - CPF/CNPJ do associado, normalizado (só dígitos dos dois lados antes de
 *     comparar, substring — ver `normalizarDocumento`);
 *   - nome/razão social do associado (case-insensitive, substring; mesmo
 *     fallback de `resolverPagamento` — nome local do associado se existir,
 *     senão o nome cacheado do cliente no Asaas).
 * Os mecanismos são combinados com OU — como cada pagamento passa por essa
 * checagem uma única vez, um pagamento pego por mais de um ao mesmo tempo é
 * contado só uma vez em `excluidos` (nunca duplicado).
 *
 * AJUSTE 14 — `associadoPorCpfCnpj` (ver `resolverAssociadosPorCpfCnpj`)
 * passou a ser SEMPRE informado (nunca mais `null`): antes, resolver o
 * cliente de cada pagamento custava uma chamada à API do Asaas, então
 * `buscarPagamentosValidos` só pagava esse custo quando havia pelo menos uma
 * palavra-chave configurada (senão a checagem caía pra só descrição). Agora
 * que cpfCnpj/nome já vêm cacheados no próprio pagamento (tabela local) e
 * "associados" é uma consulta local barata, resolver sempre é grátis o
 * bastante pra não precisar mais dessa otimização condicional — resolver a
 * mais nunca muda nenhum resultado, só deixava de ser feito antes por causa
 * do custo, que não existe mais.
 */
function separarExcluidos(pagamentos, idsExcluidos, palavras, associadoPorCpfCnpj) {
  const palavrasMinusculas = palavras.filter(Boolean).map((p) => p.toLowerCase());
  const palavrasComoDocumento = palavras.filter(Boolean).map(normalizarDocumento).filter(Boolean);
  const validos = [];
  const excluidos = [];

  for (const pagamento of pagamentos) {
    const excluidoPorId = idsExcluidos.has(pagamento.id);
    let excluidoPorPalavra = false;

    if (!excluidoPorId && palavrasMinusculas.length > 0) {
      const descricao = (pagamento.description || '').toLowerCase();
      excluidoPorPalavra = palavrasMinusculas.some((palavra) => descricao.includes(palavra));

      if (!excluidoPorPalavra) {
        const { cpfCnpj, nome } = resolverPagamento(pagamento, associadoPorCpfCnpj);
        const cpfCnpjDocumento = normalizarDocumento(cpfCnpj);
        const nomeMinusculo = (nome || '').toLowerCase();

        const bateDocumento =
          cpfCnpjDocumento !== '' && palavrasComoDocumento.some((palavra) => cpfCnpjDocumento.includes(palavra));
        const bateNome = nomeMinusculo !== '' && palavrasMinusculas.some((palavra) => nomeMinusculo.includes(palavra));

        excluidoPorPalavra = bateDocumento || bateNome;
      }
    }

    if (excluidoPorId || excluidoPorPalavra) {
      excluidos.push(pagamento);
    } else {
      validos.push(pagamento);
    }
  }

  return {
    validos,
    excluidos: {
      quantidade: excluidos.length,
      valor: arredondar2(excluidos.reduce((soma, p) => soma + (Number(p.value) || 0), 0)),
    },
  };
}

/**
 * Adapta uma linha da tabela local "pagamentos_asaas" (colunas em
 * português/camelCase Prisma — ver model em schema.prisma) para o mesmo
 * formato "cru" do Asaas que todo o resto deste arquivo já espera
 * (id/customer/value/dueDate/paymentDate/status/description — os mesmos
 * nomes de campo que `listarPagamentos`, antes desta versão, devolvia direto
 * da API). Só 2 diferenças de nome (`customerId` -> `customer`) e de tipo
 * (`value`, `Decimal` do Postgres via Prisma -> `Number` plano — todo o
 * resto do arquivo já soma/arredonda com `Number(pagamento.value)`, então
 * convertido aqui de uma vez evita carregar um objeto Decimal adiante à toa).
 * `cpfCnpj`/`nome`, cacheados na própria linha (ver docblock do model),
 * seguem direto — é o que permite `resolverPagamento` não precisar mais de
 * um `mapaClientes` resolvido via Asaas (ver docblock lá).
 */
function adaptarPagamentoLocal(pagamentoLocal) {
  return {
    id: pagamentoLocal.id,
    customer: pagamentoLocal.customerId,
    value: Number(pagamentoLocal.value),
    dateCreated: pagamentoLocal.dateCreated || null,
    dueDate: pagamentoLocal.dueDate,
    paymentDate: pagamentoLocal.paymentDate || null,
    status: pagamentoLocal.status,
    description: pagamentoLocal.description || null,
    cpfCnpj: pagamentoLocal.cpfCnpj || null,
    nome: pagamentoLocal.nome || null,
  };
}

/**
 * AJUSTE 14 — "Tabela local sincronizada via webhook do Asaas para Taxa de
 * Inadimplência" (ver README, seção "AJUSTE 14"). Busca os pagamentos no
 * período informado da tabela LOCAL "pagamentos_asaas" (`req.prisma`, já
 * escopado por franquia pela extension — ver prismaComEscopo.js) em vez de
 * paginar a API do Asaas a cada leitura (`listarPagamentos`, usada até a
 * versão anterior), e já separa os excluídos pelos mecanismos configurados
 * (lista manual por ID + palavras-chave, ver `separarExcluidos`) — usado
 * tanto por `resumo` quanto por `evolucaoMensal`.
 *
 * A tabela local é mantida em dia por 3 caminhos independentes — webhook em
 * tempo real, backfill inicial, reconciliação periódica (ver docblock de
 * pagamentosAsaas.service.js) — e é sempre ela quem decide o que existe/o
 * status atual de cada pagamento; este endpoint NUNCA mais consulta o Asaas
 * ao vivo. Resultado esperado (confirmado no brief): os NÚMEROS não mudam
 * em relação à versão anterior (mesma lógica de classificação, só a fonte
 * dos dados trocou) — só a velocidade.
 *
 * AJUSTE 7 (contexto histórico, ainda válido) — o critério de exclusão por
 * palavra-chave cobre descrição, CPF/CNPJ e nome/razão social do associado.
 * Antes desta versão, resolver CPF/CNPJ de cada pagamento custava uma
 * chamada à API do Asaas, então isso só era feito quando havia pelo menos
 * uma palavra-chave configurada (ver histórico no controle de versão).
 * Agora que cpfCnpj/nome já vêm CACHEADOS em cada linha da tabela local, e
 * cruzar com "associados" é uma consulta local barata, resolvemos sempre —
 * ver `resolverAssociadosPorCpfCnpj` logo abaixo — sem essa condicional:
 * resolver a mais nunca muda nenhum resultado (só adicionava entradas de
 * mapa não usadas), só deixava de valer a pena antes por causa do custo via
 * Asaas, que não existe mais.
 */
async function buscarPagamentosValidos(reqPrisma, franquiaId, { vencDe, vencAte, filtroPeriodo = 'vencimento' }) {
  // Repaginação de filtros — "filtro_periodo" decide qual campo de data o
  // par vencDe/vencAte restringe: "vencimento" (padrão, dueDate, sem
  // mudança de comportamento), "emissao" (dateCreated) ou "pagamento"
  // (paymentDate). Nos três casos é uma comparação de STRING "YYYY-MM-DD"
  // (mesma convenção do resto do arquivo, sem passar por Date). Em
  // "pagamento", uma linha com paymentDate `null` (ainda não paga) nunca
  // casa com `{ gte, lte }` no Postgres (comparação contra NULL é sempre
  // desconhecida) — fica de fora do conjunto automaticamente, exatamente o
  // comportamento pedido ("não faz sentido incluir 'não pago' filtrando por
  // data de pagamento"), sem precisar de um `NOT NULL` explícito.
  const campoData = CAMPO_DATA_POR_FILTRO_PERIODO[filtroPeriodo] || 'dueDate';
  const [pagamentosLocais, { idsExcluidos, palavras }] = await Promise.all([
    reqPrisma.pagamentoAsaas.findMany({ where: { [campoData]: { gte: vencDe, lte: vencAte } } }),
    buscarExclusoesConfiguradas(reqPrisma, franquiaId),
  ]);
  const pagamentos = pagamentosLocais.map(adaptarPagamentoLocal);

  const associadoPorCpfCnpj = await resolverAssociadosPorCpfCnpj(reqPrisma, pagamentos);

  const resultado = separarExcluidos(pagamentos, idsExcluidos, palavras, associadoPorCpfCnpj);
  return { ...resultado, associadoPorCpfCnpj };
}

/**
 * Resolve o mapa (cpfCnpj -> associado local) via nossa tabela "associados",
 * a partir dos CPF/CNPJs JÁ CACHEADOS nos próprios pagamentos informados
 * (`pagamento.cpfCnpj`, ver `adaptarPagamentoLocal`) — reaproveitado por
 * `resumo` e `evolucaoMensal`, sempre via `buscarPagamentosValidos`.
 *
 * AJUSTE 14 — substitui `resolverClientesEAssociados` (removida): não existe
 * mais um "mapaClientes" pra resolver via Asaas primeiro — o cpfCnpj de cada
 * pagamento já está na tabela local, então esta função é SÓ a segunda metade
 * de antes (cpfCnpj -> associado), sem nenhuma chamada de rede. Isso também
 * elimina o motivo original de resolver só um subconjunto (ex.: só OVERDUE)
 * pra economizar chamadas Asaas — ver docblock de `buscarPagamentosValidos`.
 */
async function resolverAssociadosPorCpfCnpj(reqPrisma, pagamentos) {
  const cpfCnpjsDistintos = [...new Set(pagamentos.map((p) => p.cpfCnpj).filter(Boolean))];
  const associadosLocais = cpfCnpjsDistintos.length
    ? await reqPrisma.associado.findMany({
        where: { cpfCnpj: { in: cpfCnpjsDistintos } },
        select: { cpfCnpj: true, nome: true, emNegociacao: true, emJuridico: true, bloqueado: true },
      })
    : [];
  return new Map(associadosLocais.map((a) => [a.cpfCnpj, a]));
}

/**
 * Aplica (quando ativos) os filtros "renegociacao", "em_juridico" e
 * "bloqueado" sobre TODO o conjunto de pagamentos informado — não só os
 * OVERDUE — cruzando cada pagamento com
 * "associados.em_negociacao"/"associados.em_juridico"/"associados.bloqueado"
 * pelo cpfCnpj resolvido via Asaas. Os três filtros, quando ativos ao mesmo
 * tempo, são combinados com E (um pagamento só passa se bater em todos os
 * ativos).
 *
 * Importante: este filtro "renegociacao" é DIFERENTE do campo
 * `renegociacoes_abertas` da resposta de `/resumo` — este aqui cruza com
 * `associados.em_negociacao` (nossa base), enquanto `renegociacoes_abertas`
 * (AJUSTE 3) passou a olhar a descrição da cobrança no próprio Asaas. São
 * dois conceitos independentes que só compartilham o nome por coincidência
 * de domínio — ver README.
 *
 * AJUSTE 14 — perdeu o parâmetro `mapaClientes` (não existe mais — ver
 * docblock de `resolverPagamento`): cpfCnpj já vem cacheado em cada
 * pagamento, então só `associadoPorCpfCnpj` é necessário agora.
 */
function aplicarFiltrosCrossReference(pagamentos, { renegociacao, emJuridico, bloqueado }, associadoPorCpfCnpj) {
  if (renegociacao === 'todos' && emJuridico === 'todos' && bloqueado === 'todos') return pagamentos;

  return pagamentos.filter((pagamento) => {
    const {
      emNegociacao,
      emJuridico: pagamentoEmJuridico,
      bloqueado: pagamentoBloqueado,
    } = resolverPagamento(pagamento, associadoPorCpfCnpj);

    if (renegociacao !== 'todos') {
      const bateRenegociacao = renegociacao === 'sim' ? emNegociacao : !emNegociacao;
      if (!bateRenegociacao) return false;
    }

    if (emJuridico !== 'todos') {
      const bateJuridico = emJuridico === 'sim' ? pagamentoEmJuridico : !pagamentoEmJuridico;
      if (!bateJuridico) return false;
    }

    if (bloqueado !== 'todos') {
      const bateBloqueado = bloqueado === 'sim' ? pagamentoBloqueado : !pagamentoBloqueado;
      if (!bateBloqueado) return false;
    }

    return true;
  });
}

/**
 * Gera a lista de chaves "YYYY-MM" de cada mês entre vencDe e vencAte
 * (ambos "YYYY-MM-DD"), inclusive nas pontas. Trabalha só com inteiros
 * (sem passar por Date) para não sofrer problema de fuso horário.
 */
function gerarChavesMeses(vencDe, vencAte) {
  const [anoIni, mesIni] = vencDe.split('-').map(Number);
  const [anoFim, mesFim] = vencAte.split('-').map(Number);

  const meses = [];
  let ano = anoIni;
  let mes = mesIni;
  while (ano < anoFim || (ano === anoFim && mes <= mesFim)) {
    meses.push(`${ano}-${String(mes).padStart(2, '0')}`);
    mes += 1;
    if (mes > 12) {
      mes = 1;
      ano += 1;
    }
  }
  return meses;
}

/**
 * Soma as 7 faixas de atraso ("ate_vencimento", "1_20" ... "acima_100",
 * sem teto na última) e o total de "críticos 90+ dias" sobre uma lista de
 * pagamentos já filtrada para o modo certo (ver AJUSTE CRÍTICO 2):
 *   - modo "aberto": `pagamentos` já vem restrito a status OVERDUE (snapshot
 *     de hoje) — dias efetivos de atraso = hoje - dataLimiteEfetiva.
 *   - modo "historico": `pagamentos` já vem restrito a quem JÁ TEVE UM
 *     DESFECHO decidido pela classificação de `classificarPagamento` —
 *     INADIMPLENTE (não pagas em dia) OU ADIMPLENTE (pagas em dia,
 *     ver CORREÇÃO abaixo) — excluindo só A_VENCER (ainda dentro do
 *     vencimento/tolerância, ainda não paga: não tem o que julgar ainda).
 *     Dias efetivos de atraso = paymentDate - dataLimiteEfetiva quando já
 *     foi paga (negativo/zero se em dia, positivo se com atraso), ou
 *     hoje - dataLimiteEfetiva quando ainda não foi paga.
 *
 *     CORREÇÃO (bug da faixa "ate_vencimento" sempre zerada em "historico"):
 *     antes desta correção, `pagamentosParaFaixas` em `resumo` filtrava só
 *     `=== 'INADIMPLENTE'`, então nenhum pagamento ADIMPLENTE (pago em dia)
 *     chegava a esta função — a faixa "ate_vencimento" (diasAtraso <= 0)
 *     nunca tinha como receber valor no modo "historico", mesmo havendo
 *     associados que pagam em dia no período. O filtro em `resumo` passou a
 *     excluir só `=== 'A_VENCER'` (deixando passar INADIMPLENTE e
 *     ADIMPLENTE), corrigindo a causa raiz — ver teste
 *     "RECEIVED pago em dia aparece em ate_vencimento no histórico" em
 *     `test-status-ajustes.js`.
 *
 * IMPORTANTE — esta função NÃO foi afetada pelo AJUSTE CRÍTICO 3 (critério
 * de "valor_inadimplente"/"valor_adimplente" por status atual do Asaas):
 * "faixas"/"criticos_90_dias" continuam sendo, de propósito, sobre o
 * HISTÓRICO de atraso por data (pagamento vs. vencimento) — não sobre se a
 * cobrança "ainda conta como inadimplente hoje" (confirmado explicitamente
 * no brief de correção que originou o AJUSTE CRÍTICO 3).
 *
 * AJUSTE 5 — faixa nova "ate_vencimento" (`diasAtraso <= 0`): cobranças
 * ainda dentro do vencimento (ou da tolerância) passam a aparecer nesta
 * faixa em vez de serem descartadas (`continue`) como antes. A faixa final
 * foi renomeada de "100_180" pra "acima_100" — é só correção de nome/
 * chave: o comportamento (somar tudo com `diasAtraso > 100`, sem teto) já
 * era esse antes, "180" nunca foi de fato um corte.
 *
 * PERÍODO DE TOLERÂNCIA (`diasTolerancia`) — `dataLimiteEfetiva` =
 * dueDate + diasTolerancia (mesma "data limite efetiva" de
 * `classificarPagamento`, ver docblock lá para a fórmula e um exemplo
 * numérico completo no README). Isso desloca o próprio número de dias
 * usado para escolher a faixa (uma cobrança paga com 25 dias de atraso e
 * 2 dias de tolerância cai na faixa correspondente a 23 dias efetivos, não
 * 25) e, no modo "aberto", pode zerar (ou tornar negativo) o atraso de
 * cobranças que o Asaas já marca como OVERDUE mas que ainda estão dentro
 * da janela de tolerância — nesse caso `diasAtraso <= 0` e o pagamento cai
 * em "ate_vencimento", não em nenhuma outra faixa nem em `criticos90Dias`.
 */
/**
 * Extraída de `computarFaixasECriticos` (era inline lá) para ser
 * compartilhada com `computarCpfCnpjCriticos` (item 6 do brief — filtro
 * "Tipo de inadimplente" -> "Crítico") — mesma fórmula de "dias de atraso
 * efetivos" nos dois lugares, nenhuma duplicação que pudesse divergir.
 * "modo" é "aberto"|"historico" (mesmo parâmetro `visao`, ver docblocks).
 */
function calcularDiasAtraso(pagamento, modo, hojeStr, diasTolerancia) {
  const dataLimiteEfetiva = somarDias(pagamento.dueDate, diasTolerancia);
  return modo === 'historico' && pagamento.paymentDate
    ? diferencaDias(pagamento.paymentDate, dataLimiteEfetiva)
    : diferencaDias(hojeStr, dataLimiteEfetiva);
}

function computarFaixasECriticos(pagamentos, modo, hojeStr, diasTolerancia) {
  const faixas = {
    ate_vencimento: 0,
    '1_20': 0,
    '21_30': 0,
    '31_40': 0,
    '41_50': 0,
    '51_100': 0,
    acima_100: 0,
  };
  let criticos90Dias = 0;

  for (const pagamento of pagamentos) {
    const valor = Number(pagamento.value) || 0;
    const diasAtraso = calcularDiasAtraso(pagamento, modo, hojeStr, diasTolerancia);

    if (diasAtraso <= 0) faixas.ate_vencimento += valor;
    else if (diasAtraso <= 20) faixas['1_20'] += valor;
    else if (diasAtraso <= 30) faixas['21_30'] += valor;
    else if (diasAtraso <= 40) faixas['31_40'] += valor;
    else if (diasAtraso <= 50) faixas['41_50'] += valor;
    else if (diasAtraso <= 100) faixas['51_100'] += valor;
    else faixas.acima_100 += valor; // 100+ dias (sem teto)

    if (diasAtraso >= LIMIAR_DIAS_CRITICO) criticos90Dias += valor;
  }

  return { faixas, criticos90Dias };
}

/**
 * Item 6 do brief — subconjunto de "pagamentos" (mesmo formato "modo"/
 * "aberto"|"historico" de `computarFaixasECriticos`) que decide QUEM entra
 * no cálculo de dias de atraso: "aberto" = só status OVERDUE (snapshot de
 * hoje); "historico" = quem já teve desfecho decidido por
 * `classificarPagamento` (exclui só A_VENCER) — EXATAMENTE o mesmo
 * subconjunto que alimenta "faixas"/"criticos_90_dias" hoje (`pagamentosParaFaixas`
 * em `resumo`/`evolucaoMensal`, ver docblocks lá), reproduzido aqui porque
 * o filtro "Crítico" precisa decidir QUEM é crítico ANTES da filtragem
 * final por "Tipo de inadimplente" (senão seria circular — filtrar por
 * "é crítico" exigiria já saber quem sobrou depois de filtrar por "é
 * crítico"). Ver `aplicarFiltroTipoInadimplente`.
 */
function pagamentosParaCalculoDeAtraso(pagamentos, modo, hojeStr, diasTolerancia) {
  return modo === 'aberto'
    ? pagamentos.filter((p) => p.status === 'OVERDUE')
    : pagamentos.filter((p) => classificarPagamento(p, hojeStr, diasTolerancia) !== 'A_VENCER');
}

/**
 * Item 6 do brief — "Crítico" = associado com PELO MENOS 1 cobrança com
 * `diasAtraso >= 90` ("mesmo critério do card 'Críticos 90+'", respeitando
 * "visao" — ver `pagamentosParaCalculoDeAtraso`/`calcularDiasAtraso`).
 * Devolve um Set de identificadores (cpfCnpj, ou o próprio "customer" do
 * Asaas quando não há associado local correspondente — mesmo fallback de
 * identidade já usado em "top_devedores", ver `resolverPagamento`), para
 * casar contra cada pagamento em `aplicarFiltroTipoInadimplente`.
 */
function computarCpfCnpjCriticos(pagamentos, modo, hojeStr, diasTolerancia, associadoPorCpfCnpj) {
  const criticos = new Set();
  const paraAtraso = pagamentosParaCalculoDeAtraso(pagamentos, modo, hojeStr, diasTolerancia);
  for (const pagamento of paraAtraso) {
    if (calcularDiasAtraso(pagamento, modo, hojeStr, diasTolerancia) >= LIMIAR_DIAS_CRITICO) {
      const { cpfCnpj } = resolverPagamento(pagamento, associadoPorCpfCnpj);
      criticos.add(cpfCnpj || pagamento.customer);
    }
  }
  return criticos;
}

/**
 * Item 3 do brief — "Situação da cobrança": filtro de POPULAÇÃO (afeta
 * `valor_total_faturado`, não só `valor_inadimplente` — ver docblock de
 * SITUACAO_VALIDAS/STATUS_POR_SITUACAO). `situacaoSelecionada` vazio =
 * sem restrição (mesmo formato de retorno de `validarListaMultipla`).
 * Combinação entre buckets selecionados é por OU — cada pagamento entra se
 * o status bater em QUALQUER um dos buckets marcados (ex.: "em_aberto" +
 * "pagas" marcados juntos = união dos dois conjuntos de status, o que NÃO
 * é exatamente "Todas": status fora dos dois grupos, ex. REFUNDED, continua
 * de fora — comportamento deliberado, mais previsível que tratar "os dois
 * marcados" como um sinônimo mágico de "nenhum filtro").
 */
function aplicarFiltroSituacao(pagamentos, situacaoSelecionada) {
  if (!situacaoSelecionada || situacaoSelecionada.length === 0) return pagamentos;
  const statusPermitidos = new Set(situacaoSelecionada.flatMap((s) => STATUS_POR_SITUACAO[s] || []));
  return pagamentos.filter((p) => statusPermitidos.has(p.status));
}

/**
 * Item 6 do brief — "Tipo de inadimplente": filtro de população combinável
 * por OU entre "ativo" (`!emJuridico`), "juridico" (`emJuridico`) e
 * "critico" (`cpfCnpj` presente em `criticoSet`, ver
 * `computarCpfCnpjCriticos`) — um pagamento passa se bater em QUALQUER um
 * dos tipos marcados. `tipoSelecionado` vazio = sem restrição ("Todos").
 * Continua combinando por E com "renegociacao"/"bloqueado", aplicados
 * separadamente em `aplicarFiltrosCrossReference` — este filtro não lida
 * com os dois (só com a parte que substituiu o antigo `em_juridico`
 * exclusivo).
 */
function aplicarFiltroTipoInadimplente(pagamentos, tipoSelecionado, criticoSet, associadoPorCpfCnpj) {
  if (!tipoSelecionado || tipoSelecionado.length === 0) return pagamentos;

  return pagamentos.filter((pagamento) => {
    const { cpfCnpj, emJuridico } = resolverPagamento(pagamento, associadoPorCpfCnpj);
    const identificador = cpfCnpj || pagamento.customer;

    if (tipoSelecionado.includes('ativo') && !emJuridico) return true;
    if (tipoSelecionado.includes('juridico') && emJuridico) return true;
    if (tipoSelecionado.includes('critico') && criticoSet.has(identificador)) return true;
    return false;
  });
}

/**
 * AJUSTE 6 — versão "historico" de valor_inadimplente/valor_adimplente:
 * mesma classificação por data de pagamento vs. vencimento já usada em
 * "faixas"/"criticos_90_dias" (`classificarPagamento`), só que agregada em
 * 2 somas (inadimplente/adimplente) em vez de 7 faixas de dias. Espelha
 * exatamente a estrutura da versão "aberto" (por status, ver `resumo`):
 * cada pagamento cai em UM dos dois somatórios, ou em nenhum — cobranças
 * A_VENCER (ainda dentro do vencimento ou da tolerância, ainda não pagas)
 * são o "terceiro grupo" aqui, análogo ao PENDING da versão por status.
 *
 * NÃO é afetada por "tipo_pendencia" — ver docblock de
 * `STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA` e de `resumo` para o porquê (esse
 * filtro é sobre status atual, sem correspondência numa classificação por
 * data de pagamento).
 */
function computarValorInadimplenteAdimplenteHistorico(pagamentos, hojeStr, diasTolerancia) {
  let valorInadimplente = 0;
  let valorAdimplente = 0;

  for (const pagamento of pagamentos) {
    const valor = Number(pagamento.value) || 0;
    const classificacao = classificarPagamento(pagamento, hojeStr, diasTolerancia);
    if (classificacao === 'INADIMPLENTE') valorInadimplente += valor;
    else if (classificacao === 'ADIMPLENTE') valorAdimplente += valor;
  }

  return { valorInadimplente, valorAdimplente };
}

/**
 * GET /api/inadimplencia/resumo
 *   ?venc_de=YYYY-MM-DD&venc_ate=YYYY-MM-DD
 *   &renegociacao=todos|sim|nao&em_juridico=todos|sim|nao&bloqueado=todos|sim|nao
 *   &tipo_pendencia=todos|vencidas|confirmadas
 *   &visao=aberto|historico&forcar=true
 *
 * Calcula, a partir dos pagamentos com vencimento no período informado
 * (padrão: últimos 12 meses), os números da tela de "Taxa de Inadimplência".
 * Ver README para o detalhamento de cada campo e das decisões de design.
 *
 * AJUSTE 14 — "Tabela local sincronizada via webhook do Asaas". Os
 * pagamentos vêm da tabela LOCAL "pagamentos_asaas" (Postgres), não mais de
 * uma consulta ao vivo à API do Asaas — ver docblock de
 * `buscarPagamentosValidos`. TODA a lógica de classificação abaixo (faixas,
 * críticos, visao=aberto/historico, tipo_pendencia, exclusões, cross-
 * references) é EXATAMENTE a mesma de antes, sem nenhuma mudança de
 * comportamento — só a fonte dos dados trocou, para eliminar a lentidão de
 * paginar/resolver clientes no Asaas a cada troca de filtro.
 *
 * "cliente do Asaas" abaixo (renegociação/em_juridico/bloqueado, top
 * devedores etc.) passou a significar "cpfCnpj/nome cacheados na própria
 * linha local", não mais "resolvidos ao vivo via GET /v3/customers/{id}" —
 * ver docblock de `resolverPagamento`.
 *
 * Antes de qualquer cálculo, os pagamentos passam pela exclusão combinada
 * (lista manual por ID OU palavra-chave — descrição, CPF/CNPJ ou nome do
 * associado, ver AJUSTE 7 abaixo) — o que foi removido nessa etapa é
 * reportado em "excluidos", e NUNCA entra em nenhum outro campo da
 * resposta.
 *
 * "renegociacao", "em_juridico" e "bloqueado" cruzam o cpfCnpj de cada
 * pagamento do Asaas (resolvido via GET /v3/customers/{id}) com
 * "associados.em_negociacao"/"associados.em_juridico"/"associados.bloqueado"
 * na nossa base — mesma regra para os três (sem correspondência local =
 * "não"). Quando algum dos três é "sim" ou "nao", ele restringe TODO o
 * conjunto de pagamentos usado no cálculo (inclusive valor_total_faturado).
 *
 * PERÍODO DE TOLERÂNCIA — usado em TODOS os cálculos de atraso por data
 * deste endpoint (dias corridos, GET/PATCH /api/config/tolerancia-dias,
 * padrão 0), lido uma vez no início da requisição: "faixas"/
 * "criticos_90_dias" (os dois modos de "visao") E "valor_inadimplente"/
 * "valor_adimplente"/as duas taxas quando "visao=historico" (AJUSTE 6) —
 * ver `computarFaixasECriticos`/`computarValorInadimplenteAdimplenteHistorico`
 * para a fórmula ("data limite efetiva" = dueDate + diasTolerancia) e o
 * README para um exemplo numérico completo. Quando "visao=aberto"
 * (padrão), "valor_inadimplente"/"valor_adimplente" continuam por STATUS
 * ATUAL (AJUSTE CRÍTICO 3), sem nenhuma comparação de data — a tolerância
 * não entra nessa conta.
 *
 * AJUSTE 6 (renomeia e estende o parâmetro "visao_faixas" → "visao") —
 * "visao" agora controla, ao mesmo tempo, "faixas"/"criticos_90_dias" (uso
 * original, AJUSTE CRÍTICO 2) E "valor_inadimplente"/"valor_adimplente"/as
 * duas taxas (novo):
 *   - "visao=aberto" (padrão — SEM NENHUMA REGRESSÃO no comportamento
 *     default da tela): "valor_inadimplente"/"valor_adimplente" por STATUS
 *     ATUAL de cada cobrança no Asaas (AJUSTE CRÍTICO 3, mantido tal e
 *     qual — ver `STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA`/
 *     `STATUS_ADIMPLENTE` no topo do arquivo); "faixas"/"criticos_90_dias"
 *     restritos a status OVERDUE (snapshot de hoje).
 *   - "visao=historico": "valor_inadimplente"/"valor_adimplente" passam a
 *     usar a MESMA classificação por data de pagamento vs. vencimento que
 *     já alimentava só "faixas"/"criticos_90_dias" (`classificarPagamento`
 *     — ver `computarValorInadimplenteAdimplenteHistorico`): reflete o
 *     COMPORTAMENTO do associado no período (pagou em dia ou não),
 *     independente do status atual da cobrança — uma cobrança paga com
 *     atraso em março continua contando como "inadimplente" aqui mesmo
 *     que hoje esteja RECEIVED. Decisão de negócio confirmada
 *     explicitamente para esta visão (é o comportamento OPOSTO do
 *     "aberto", de propósito — as duas visões coexistem, cada uma serve a
 *     uma pergunta diferente: "quem está devendo agora" x "quem deveu
 *     durante o período").
 *   - Consequência: "tipo_pendencia" (AJUSTE 4, ver abaixo) só tem efeito
 *     quando "visao=aberto" — é um filtro por status atual (OVERDUE x
 *     CONFIRMED), sem equivalente numa classificação por data. Em
 *     "visao=historico" ele é lido/validado normalmente mas NÃO altera o
 *     resultado; o frontend desabilita visualmente o campo nesse caso.
 *
 * CORREÇÃO (bug corrigido junto com o AJUSTE 6 — faixa "ate_vencimento"
 * sempre zerada em "visao=historico") — `pagamentosParaFaixas`, usado
 * tanto para "faixas" quanto (agora) para os 2 números de
 * "visao=historico", antes excluía qualquer pagamento que não fosse
 * `=== 'INADIMPLENTE'` pela classificação de `classificarPagamento` — ou
 * seja, um pagamento ADIMPLENTE (pago em dia) nunca chegava a ser
 * bucketizado, e a faixa "ate_vencimento" (diasAtraso <= 0) não tinha como
 * receber valor. Passou a excluir só `=== 'A_VENCER'` (ainda sem
 * desfecho), deixando passar INADIMPLENTE e ADIMPLENTE — ver
 * `computarFaixasECriticos` e o teste "RECEIVED pago em dia aparece em
 * ate_vencimento no histórico" em `test-status-ajustes.js`.
 *
 * AJUSTE 4 — "tipo_pendencia" ("todos"|"vencidas"|"confirmadas", padrão
 * "todos") separa, dentro de "valor_inadimplente" (só em "visao=aberto",
 * ver AJUSTE 6 acima), as cobranças vencidas (status "OVERDUE") das
 * confirmadas/crédito futuro (status "CONFIRMED") — antes desta correção
 * sempre apareciam somadas, sem forma de isolar uma da outra. Afeta
 * "valor_inadimplente" e "taxa_inadimplencia_percentual"; NÃO afeta
 * "valor_adimplente"/"taxa_adimplencia_percentual" (sempre RECEIVED/
 * RECEIVED_IN_CASH) nem "valor_total_faturado" (sempre o período inteiro,
 * qualquer status) nem "top_devedores"/"associados_inadimplentes"/
 * "criticos_90_dias"/"renegociacoes_abertas" (nenhum destes muda com este
 * ajuste — ver docblocks próprios).
 *
 * AJUSTE CRÍTICO 2 — "faixas" e "criticos_90_dias" têm dois modos,
 * controlados por "visao" (padrão "aberto"):
 *   - "aberto": só cobranças AINDA NÃO PAGAS hoje (status OVERDUE),
 *     bucketed por (hoje - dueDate) — é um snapshot do que está em aberto
 *     agora, muda a cada consulta.
 *   - "historico": cobranças do período que já tiveram um desfecho
 *     decidido pela classificação de `classificarPagamento` — pagas em
 *     dia OU não pagas em dia, ver CORREÇÃO acima — bucketed por
 *     (paymentDate - dueDate) se já paga, ou (hoje - dueDate) se ainda não
 *     paga — fixo para o período.
 *
 * AJUSTE 5 — "faixas" ganhou uma 7ª faixa, "ate_vencimento" (atraso <= 0,
 * já considerando a tolerância), pras cobranças ainda dentro do vencimento
 * que antes eram descartadas sem aparecer em nenhuma faixa. A faixa final
 * foi renomeada de "100_180" pra "acima_100" (só o nome/chave — o
 * comportamento de somar tudo com mais de 100 dias, sem teto, já era esse
 * antes). Ver `computarFaixasECriticos`.
 *
 * "associados_inadimplentes" e "top_devedores" continuam baseados no
 * snapshot "aberto" (quem tem cobrança OVERDUE agora) — são listas
 * operacionais ("quem cobrar hoje"), independentes de "visao" e de
 * "tipo_pendencia" — ver README.
 *
 * AJUSTE 3 — "renegociacoes_abertas" conta/soma cobranças cuja descrição
 * (no próprio Asaas) contém "Renegociação" (case-insensitive, substring) e
 * cujo status ainda está em aberto (PENDING ou OVERDUE) — não cruza mais
 * com `associados.em_negociacao` (esse cruzamento continua existindo, mas
 * só como o filtro `renegociacao` do parágrafo acima). Sem mudança neste
 * ajuste.
 *
 * AJUSTE 7 — a exclusão por palavra-chave passou a casar contra 3 campos
 * (antes, só a descrição da cobrança): descrição, CPF/CNPJ do associado
 * (com ou sem formatação, dos dois lados) e nome/razão social do
 * associado — ver `separarExcluidos`/`buscarPagamentosValidos`. Não muda o
 * comportamento da lista manual por ID.
 *
 * ESCOPO (histórico) — quando este ajuste (AJUSTE 6) foi feito, "visao"
 * afetava só os 3 cards deste endpoint; GET /api/inadimplencia/evolucao-
 * mensal continuava exclusivamente por status atual, sem o parâmetro. Isso
 * mudou no AJUSTE 13 (ver docblock de `evolucaoMensal` abaixo) — os dois
 * endpoints aceitam "visao" com a mesma semântica hoje.
 *
 * Cacheado em memória por 4 minutos, por combinação exata de
 * (venc_de, venc_ate, renegociacao, em_juridico, bloqueado, tipo_pendencia,
 * visao). O cache é limpo sempre que a lista de exclusões manuais ou de
 * palavras-chave muda. AJUSTE 2 — "forcar=true" ignora a LEITURA do cache
 * (sempre busca dados frescos do Asaas para essa chamada), mas o resultado
 * novo ainda é gravado no cache ao final, com o TTL normal — as próximas
 * chamadas sem "forcar=" voltam a se beneficiar dele.
 */
exports.resumo = async (req, res, next) => {
  try {
    const {
      venc_de: vencDeParam,
      venc_ate: vencAteParam,
      filtro_periodo: filtroPeriodoParam,
      renegociacao: renegociacaoParam,
      em_juridico: emJuridicoParam,
      bloqueado: bloqueadoParam,
      situacao: situacaoParam,
      tipo_inadimplente: tipoInadimplenteParam,
      tipo_pendencia: tipoPendenciaParam,
      visao: visaoParam,
    } = req.query;

    const { vencDe, vencAte, erro: erroPeriodo } = resolverPeriodo(vencDeParam, vencAteParam);
    if (erroPeriodo) {
      return res.status(400).json({ error: erroPeriodo });
    }

    const { valor: filtroPeriodo, erro: erroFiltroPeriodo } = validarFiltroPeriodo(filtroPeriodoParam);
    if (erroFiltroPeriodo) {
      return res.status(400).json({ error: erroFiltroPeriodo });
    }

    const { valor: renegociacao, erro: erroRenegociacao } = validarFiltroTriEstado(renegociacaoParam, 'renegociacao');
    if (erroRenegociacao) {
      return res.status(400).json({ error: erroRenegociacao });
    }

    const { valor: emJuridico, erro: erroEmJuridico } = validarFiltroTriEstado(emJuridicoParam, 'em_juridico');
    if (erroEmJuridico) {
      return res.status(400).json({ error: erroEmJuridico });
    }

    const { valor: bloqueado, erro: erroBloqueado } = validarFiltroTriEstado(bloqueadoParam, 'bloqueado');
    if (erroBloqueado) {
      return res.status(400).json({ error: erroBloqueado });
    }

    const { valores: situacao, erro: erroSituacao } = validarListaMultipla(situacaoParam, SITUACAO_VALIDAS, 'situacao');
    if (erroSituacao) {
      return res.status(400).json({ error: erroSituacao });
    }

    const { valores: tipoInadimplente, erro: erroTipoInadimplente } = validarListaMultipla(
      tipoInadimplenteParam,
      TIPO_INADIMPLENTE_VALIDAS,
      'tipo_inadimplente'
    );
    if (erroTipoInadimplente) {
      return res.status(400).json({ error: erroTipoInadimplente });
    }

    const { valor: tipoPendencia, erro: erroTipoPendencia } = validarTipoPendencia(tipoPendenciaParam);
    if (erroTipoPendencia) {
      return res.status(400).json({ error: erroTipoPendencia });
    }

    // AJUSTE 6 — renomeado de "visao_faixas" pra "visao" (ver docblock acima).
    const visao = visaoParam === undefined ? 'aberto' : visaoParam;
    if (!VISAO_VALIDAS.includes(visao)) {
      return res.status(400).json({ error: '"visao" deve ser "aberto" ou "historico".' });
    }

    // AJUSTE 2 — "forcar=true" ignora a LEITURA do cache (busca sempre dados
    // frescos do Asaas), mas o resultado novo ainda é gravado no cache no
    // final (mesma chave/TTL) — as próximas consultas sem "forcar=" voltam
    // a se beneficiar dele normalmente.
    const forcar = req.query.forcar === 'true';

    const chaveCache = `inadimplencia:resumo:${vencDe}:${vencAte}:${filtroPeriodo}:${renegociacao}:${emJuridico}:${bloqueado}:${situacao.join('+')}:${tipoInadimplente.join('+')}:${tipoPendencia}:${visao}`;
    const cacheado = forcar ? undefined : cache.get(chaveCache);
    if (cacheado) {
      return res.json(cacheado);
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);

    // AJUSTE 14 — `buscarPagamentosValidos` já devolve `associadoPorCpfCnpj`
    // resolvido para TODOS os pagamentos válidos do período (consulta local
    // barata, ver docblock lá) — não há mais nenhuma resolução condicional
    // aqui (o "precisaResolverTodos"/"idsOverdue"/"idsParaResolver" de antes
    // existia só para minimizar chamadas à API do Asaas, que não existem
    // mais nesta rota).
    const [{ validos: pagamentosValidos, excluidos, associadoPorCpfCnpj }, diasTolerancia] = await Promise.all([
      buscarPagamentosValidos(req.prisma, franquiaId, { vencDe, vencAte, filtroPeriodo }),
      getDiasTolerancia(franquiaId),
    ]);

    const hojeStr = formatarDataISO(new Date());

    // Repaginação de filtros — pipeline de população, nesta ordem:
    //   1. "situacao" (item 3, status bucket — ver aplicarFiltroSituacao)
    //   2. cross-reference de sempre (renegociacao/em_juridico legado/bloqueado)
    //   3. "tipo_inadimplente" (item 6 — ativo/juridico/critico, combinável por
    //      OU), cujo "critico" precisa ser calculado ANTES deste último passo,
    //      sobre a população que já passou pelos 2 primeiros (mesma base que
    //      "criticos_90_dias" usaria pra essa combinação de filtros) — ver
    //      docblock de `computarCpfCnpjCriticos` para o porquê da ordem.
    const populacaoAntesDoTipoInadimplente = aplicarFiltrosCrossReference(
      aplicarFiltroSituacao(pagamentosValidos, situacao),
      { renegociacao, emJuridico, bloqueado },
      associadoPorCpfCnpj
    );
    const criticoSet = computarCpfCnpjCriticos(
      populacaoAntesDoTipoInadimplente,
      visao,
      hojeStr,
      diasTolerancia,
      associadoPorCpfCnpj
    );
    const conjuntoTrabalho = aplicarFiltroTipoInadimplente(
      populacaoAntesDoTipoInadimplente,
      tipoInadimplente,
      criticoSet,
      associadoPorCpfCnpj
    );

    const valorTotalFaturado = conjuntoTrabalho.reduce((soma, p) => soma + (Number(p.value) || 0), 0);

    // AJUSTE CRÍTICO 2 — "aberto" (snapshot OVERDUE de hoje) x "historico"
    // (pagas em dia ou não, pelo período inteiro — ver CORREÇÃO no docblock
    // acima). Os dois já levam o período de tolerância em conta (ver
    // computarFaixasECriticos).
    const pagamentosOverdue = conjuntoTrabalho.filter((p) => p.status === 'OVERDUE');
    const pagamentosParaFaixas =
      visao === 'aberto'
        ? pagamentosOverdue
        : conjuntoTrabalho.filter((p) => classificarPagamento(p, hojeStr, diasTolerancia) !== 'A_VENCER');
    const { faixas, criticos90Dias } = computarFaixasECriticos(pagamentosParaFaixas, visao, hojeStr, diasTolerancia);

    // AJUSTE 6 — "valor_inadimplente"/"valor_adimplente" seguem "visao":
    // "aberto" por STATUS ATUAL (AJUSTE CRÍTICO 3, com "tipo_pendencia" —
    // AJUSTE 4); "historico" pela mesma classificação por data usada acima
    // em "faixas" (`computarValorInadimplenteAdimplenteHistorico`),
    // ignorando "tipo_pendencia" (ver docblock).
    let valorInadimplente = 0;
    let valorAdimplente = 0;
    if (visao === 'historico') {
      ({ valorInadimplente, valorAdimplente } = computarValorInadimplenteAdimplenteHistorico(
        conjuntoTrabalho,
        hojeStr,
        diasTolerancia
      ));
    } else {
      const statusInadimplenteValidos = STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA[tipoPendencia];
      for (const pagamento of conjuntoTrabalho) {
        const valor = Number(pagamento.value) || 0;
        if (statusInadimplenteValidos.includes(pagamento.status)) valorInadimplente += valor;
        else if (STATUS_ADIMPLENTE.includes(pagamento.status)) valorAdimplente += valor;
      }
    }
    const taxaInadimplencia = calcularTaxa(valorTotalFaturado, valorInadimplente);
    const taxaAdimplencia = calcularTaxa(valorTotalFaturado, valorAdimplente);

    // "associados_inadimplentes" / "top_devedores" — sempre pelo snapshot
    // "aberto" (ver docblock acima).
    const identificadoresInadimplentes = new Set();
    const porDevedor = new Map();
    for (const pagamento of pagamentosOverdue) {
      const valor = Number(pagamento.value) || 0;
      const { cpfCnpj, nome } = resolverPagamento(pagamento, associadoPorCpfCnpj);
      const identificador = cpfCnpj || pagamento.customer;

      identificadoresInadimplentes.add(identificador);

      const acumulado = porDevedor.get(identificador) || {
        nome: nome || identificador,
        cpf_cnpj: cpfCnpj || identificador,
        valor: 0,
      };
      acumulado.valor += valor;
      porDevedor.set(identificador, acumulado);
    }

    const topDevedores = [...porDevedor.values()]
      .sort((a, b) => b.valor - a.valor)
      .slice(0, 10)
      .map((d) => ({ nome: d.nome, cpf_cnpj: d.cpf_cnpj, valor: arredondar2(d.valor) }));

    // AJUSTE 3 — renegociações via descrição do Asaas (PENDING/OVERDUE
    // dentro do conjunto já filtrado), não mais via associados.em_negociacao.
    let renegociacoesQuantidade = 0;
    let renegociacoesValor = 0;
    for (const pagamento of conjuntoTrabalho) {
      if (pagamento.status !== 'PENDING' && pagamento.status !== 'OVERDUE') continue;
      const descricao = (pagamento.description || '').toLowerCase();
      if (descricao.includes(PALAVRA_RENEGOCIACAO)) {
        renegociacoesQuantidade += 1;
        renegociacoesValor += Number(pagamento.value) || 0;
      }
    }

    const resultado = {
      valor_total_faturado: arredondar2(valorTotalFaturado),
      valor_inadimplente: arredondar2(valorInadimplente),
      taxa_inadimplencia_percentual: taxaInadimplencia,
      valor_adimplente: arredondar2(valorAdimplente),
      taxa_adimplencia_percentual: taxaAdimplencia,
      associados_inadimplentes: identificadoresInadimplentes.size,
      renegociacoes_abertas: { quantidade: renegociacoesQuantidade, valor: arredondar2(renegociacoesValor) },
      criticos_90_dias: arredondar2(criticos90Dias),
      faixas: Object.fromEntries(Object.entries(faixas).map(([faixa, valor]) => [faixa, arredondar2(valor)])),
      top_devedores: topDevedores,
      excluidos,
    };

    cache.set(chaveCache, resultado, CACHE_TTL_MS);
    res.json(resultado);
  } catch (err) {
    // AJUSTE 14 — sem catch específico de AsaasApiError aqui: esta rota não
    // consulta mais o Asaas ao vivo (ver docblock de `buscarPagamentosValidos`),
    // então esse erro nunca é lançado por este handler — qualquer falha cai
    // no tratamento genérico de erro, como qualquer outra rota apoiada só em
    // Postgres.
    next(err);
  }
};

/**
 * GET /api/inadimplencia/evolucao-mensal?venc_de=&venc_ate=&renegociacao=&em_juridico=&bloqueado=&tipo_pendencia=&visao=
 *
 * Mesma base de cálculo do /resumo — mesma exclusão combinada e mesmos
 * cross-references de renegociacao/em_juridico/bloqueado — mas agrupada por
 * mês de vencimento ("YYYY-MM", derivado direto da string "dueDate", sem
 * passar por Date, para não sofrer problema de fuso). Todo mês dentro do
 * intervalo aparece no resultado, mesmo sem nenhum pagamento naquele mês
 * (valores zerados; as duas taxas ficam 0%).
 *
 * AJUSTE 14 — mesma troca de fonte de dados do /resumo (Postgres local em
 * vez de Asaas ao vivo, ver docblock lá e de `buscarPagamentosValidos`) —
 * sem nenhuma mudança de comportamento, só velocidade.
 *
 * AJUSTE 13 (reunião Suelen + Roberto, 08/09) — CORRIGE um bug identificado
 * anteriormente e não corrigido até aqui: este endpoint aceita agora o
 * MESMO parâmetro "visao" do /resumo (AJUSTE 6), com exatamente a mesma
 * semântica, mês a mês:
 *   - "visao=aberto" (padrão — SEM NENHUMA REGRESSÃO): "valor_inadimplente"/
 *     "taxa_inadimplencia_percentual"/"taxa_adimplencia_percentual" por
 *     STATUS ATUAL de cada cobrança no Asaas (AJUSTE CRÍTICO 3, mantido tal
 *     e qual — ver `STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA`/
 *     `STATUS_ADIMPLENTE` no topo do arquivo), agrupado pelo mês do
 *     `dueDate`. Continua "quem está em aberto AGORA", só que já não é mais
 *     a única opção.
 *   - "visao=historico": os mesmos 2 números passam a usar a MESMA
 *     classificação por data de pagamento vs. vencimento que o /resumo já
 *     usa em "visao=historico" (`classificarPagamento`/
 *     `computarValorInadimplenteAdimplenteHistorico`) — reaproveitada aqui
 *     tal e qual, SEM recalcular do zero: cada pagamento entra em
 *     INADIMPLENTE/ADIMPLENTE/A_VENCER (mesma regra, mesmo período de
 *     tolerância) e é somado no mês do seu `dueDate`. Uma cobrança paga com
 *     atraso continua contando como inadimplente naquele mês PARA SEMPRE,
 *     independente de quando a consulta for feita (a única forma de esse
 *     número mudar depois é uma correção retroativa direto no Asaas — caso
 *     raro, aceitável, confirmado explicitamente com o usuário; não existe
 *     nenhum "congelamento"/registro imutável gravado no nosso banco, o
 *     cálculo é sempre ao vivo a partir do Asaas).
 *
 * Motivo da correção: os 3 cards do topo da tela (consumindo /resumo) já
 * usam "visao" desde o AJUSTE 6, mas este endpoint (o gráfico de evolução
 * mensal, a "bolinha") continuava fixo em status atual — fazendo os dois
 * números parecerem não bater pro mesmo período quando "Histórico do
 * período" estava selecionado (ex.: card do topo mostrando 51% pra um mês,
 * o gráfico mostrando 18% pro mesmo mês: o card já estava certo, o gráfico
 * que estava respondendo a uma pergunta diferente). Com a mesma "visao" nos
 * dois, a taxa do card do topo pra um período de 1 mês bate exatamente com
 * o ponto do gráfico pra esse mesmo mês, nas duas visões.
 *
 * PERÍODO DE TOLERÂNCIA — voltou a ser lida por este endpoint (tinha
 * deixado de ser desde o AJUSTE CRÍTICO 3, quando nenhum número aqui
 * dependia mais de comparação de datas): necessária agora para
 * "visao=historico", exatamente como no /resumo (mesma "data limite
 * efetiva" = dueDate + diasTolerancia). Sem efeito em "visao=aberto"
 * (comportamento por status atual não usa tolerância, como sempre).
 *
 * "taxa_adimplencia_percentual" continua NÃO sendo o simples complementar
 * de "taxa_inadimplencia_percentual" (100 - taxa): tem numerador próprio
 * sobre "valor_total_faturado". As duas taxas só somam 100% quando não há
 * nenhuma cobrança do "terceiro grupo" (PENDING/A_VENCER, conforme a
 * visão) no mês.
 *
 * AJUSTE 4 — aceita "tipo_pendencia" (mesma semântica do /resumo): afeta
 * "valor_inadimplente"/"taxa_inadimplencia_percentual" de cada mês, MAS SÓ
 * quando "visao=aberto" — em "visao=historico" é lido/validado normalmente
 * mas SEM EFEITO (mesma regra do /resumo — não existe um equivalente de
 * "só vencidas"/"só confirmadas" numa classificação por data de pagamento;
 * o frontend já desabilita visualmente esse campo quando "Histórico do
 * período" está selecionado, e essa mesma tela agora vale pros dois
 * endpoints, já que compartilham o mesmo toggle).
 *
 * AJUSTE 7 — a exclusão por palavra-chave (compartilhada com /resumo via
 * `buscarPagamentosValidos`) passou a casar contra CPF/CNPJ e nome do
 * associado, além da descrição — ver docblock de `separarExcluidos`.
 *
 * Cacheado em memória por 4 minutos, por combinação exata de
 * (venc_de, venc_ate, renegociacao, em_juridico, bloqueado, tipo_pendencia,
 * visao), em um namespace de cache separado do /resumo. AJUSTE 2 — aceita
 * "forcar=true" com a mesma semântica do /resumo: ignora a leitura do
 * cache, mas ainda grava o resultado novo.
 */
exports.evolucaoMensal = async (req, res, next) => {
  try {
    const {
      venc_de: vencDeParam,
      venc_ate: vencAteParam,
      filtro_periodo: filtroPeriodoParam,
      renegociacao: renegociacaoParam,
      em_juridico: emJuridicoParam,
      bloqueado: bloqueadoParam,
      situacao: situacaoParam,
      tipo_inadimplente: tipoInadimplenteParam,
      tipo_pendencia: tipoPendenciaParam,
      visao: visaoParam,
    } = req.query;

    const { vencDe, vencAte, erro: erroPeriodo } = resolverPeriodo(vencDeParam, vencAteParam);
    if (erroPeriodo) {
      return res.status(400).json({ error: erroPeriodo });
    }

    const { valor: filtroPeriodo, erro: erroFiltroPeriodo } = validarFiltroPeriodo(filtroPeriodoParam);
    if (erroFiltroPeriodo) {
      return res.status(400).json({ error: erroFiltroPeriodo });
    }

    const { valor: renegociacao, erro: erroRenegociacao } = validarFiltroTriEstado(renegociacaoParam, 'renegociacao');
    if (erroRenegociacao) {
      return res.status(400).json({ error: erroRenegociacao });
    }

    const { valor: emJuridico, erro: erroEmJuridico } = validarFiltroTriEstado(emJuridicoParam, 'em_juridico');
    if (erroEmJuridico) {
      return res.status(400).json({ error: erroEmJuridico });
    }

    const { valor: bloqueado, erro: erroBloqueado } = validarFiltroTriEstado(bloqueadoParam, 'bloqueado');
    if (erroBloqueado) {
      return res.status(400).json({ error: erroBloqueado });
    }

    const { valores: situacao, erro: erroSituacao } = validarListaMultipla(situacaoParam, SITUACAO_VALIDAS, 'situacao');
    if (erroSituacao) {
      return res.status(400).json({ error: erroSituacao });
    }

    const { valores: tipoInadimplente, erro: erroTipoInadimplente } = validarListaMultipla(
      tipoInadimplenteParam,
      TIPO_INADIMPLENTE_VALIDAS,
      'tipo_inadimplente'
    );
    if (erroTipoInadimplente) {
      return res.status(400).json({ error: erroTipoInadimplente });
    }

    const { valor: tipoPendencia, erro: erroTipoPendencia } = validarTipoPendencia(tipoPendenciaParam);
    if (erroTipoPendencia) {
      return res.status(400).json({ error: erroTipoPendencia });
    }

    // AJUSTE 13 — mesmo parâmetro/validação/default "aberto" do /resumo.
    const visao = visaoParam === undefined ? 'aberto' : visaoParam;
    if (!VISAO_VALIDAS.includes(visao)) {
      return res.status(400).json({ error: '"visao" deve ser "aberto" ou "historico".' });
    }

    // AJUSTE 2 — mesma semântica de "forcar=true" do /resumo (ver docblock
    // acima): ignora a leitura do cache, mas ainda grava o resultado novo.
    const forcar = req.query.forcar === 'true';

    const chaveCache = `inadimplencia:evolucao-mensal:${vencDe}:${vencAte}:${filtroPeriodo}:${renegociacao}:${emJuridico}:${bloqueado}:${situacao.join('+')}:${tipoInadimplente.join('+')}:${tipoPendencia}:${visao}`;
    const cacheado = forcar ? undefined : cache.get(chaveCache);
    if (cacheado) {
      return res.json(cacheado);
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);

    // AJUSTE 13 — "diasTolerancia" voltou a ser necessária aqui (só usada
    // abaixo quando "visao=historico"; buscada sempre, mesmo custo do
    // /resumo, mesmo padrão de Promise.all).
    // AJUSTE 14 — `buscarPagamentosValidos` já devolve `associadoPorCpfCnpj`
    // resolvido para todos os pagamentos válidos do período (consulta local
    // barata) — nenhuma resolução extra de cliente é feita aqui (ver
    // docblock de `buscarPagamentosValidos`/`resolverAssociadosPorCpfCnpj`).
    const [{ validos: pagamentosValidos, associadoPorCpfCnpj }, diasTolerancia] = await Promise.all([
      buscarPagamentosValidos(req.prisma, franquiaId, { vencDe, vencAte, filtroPeriodo }),
      getDiasTolerancia(franquiaId),
    ]);

    const hojeStr = formatarDataISO(new Date());

    // Repaginação de filtros — mesmo pipeline de 3 passos do /resumo (ver
    // docblock lá): situacao -> cross-reference de sempre -> tipo_inadimplente
    // (com o "critico" calculado sobre a população intermediária).
    const populacaoAntesDoTipoInadimplente = aplicarFiltrosCrossReference(
      aplicarFiltroSituacao(pagamentosValidos, situacao),
      { renegociacao, emJuridico, bloqueado },
      associadoPorCpfCnpj
    );
    const criticoSet = computarCpfCnpjCriticos(
      populacaoAntesDoTipoInadimplente,
      visao,
      hojeStr,
      diasTolerancia,
      associadoPorCpfCnpj
    );
    const conjuntoTrabalho = aplicarFiltroTipoInadimplente(
      populacaoAntesDoTipoInadimplente,
      tipoInadimplente,
      criticoSet,
      associadoPorCpfCnpj
    );

    // AJUSTE 13 — "aberto": mesmo critério por status atual de sempre (ver
    // docblock e STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA/STATUS_ADIMPLENTE no
    // topo do arquivo). "historico": reaproveita `classificarPagamento`
    // (mesma função usada por `computarValorInadimplenteAdimplenteHistorico`
    // no /resumo) por pagamento, em vez de recalcular do zero.
    const statusInadimplenteValidos = STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA[tipoPendencia];
    const meses = gerarChavesMeses(vencDe, vencAte);
    const porMes = new Map(meses.map((mes) => [mes, { valorTotalFaturado: 0, valorInadimplente: 0, valorAdimplente: 0 }]));

    // Repaginação de filtros — o mês de cada ponto do gráfico passa a vir do
    // MESMO campo de data usado pra filtrar o período ("filtro_periodo"),
    // não mais sempre "dueDate": em "vencimento" (padrão) é idêntico a
    // antes; em "emissao"/"pagamento", agrupar por "dueDate" poderia jogar
    // um pagamento pago/emitido dentro da janela [vencDe, vencAte] só que
    // com VENCIMENTO fora dela — caindo fora de `meses` (o `continue`
    // abaixo) e sumindo silenciosamente do gráfico, mesmo tendo sido
    // corretamente incluído pelo filtro. Como `buscarPagamentosValidos` já
    // restringiu a busca a linhas com esse mesmo campo dentro do período,
    // ele nunca vem nulo aqui.
    const campoMes = CAMPO_DATA_POR_FILTRO_PERIODO[filtroPeriodo] || 'dueDate';
    for (const pagamento of conjuntoTrabalho) {
      const mes = pagamento[campoMes].slice(0, 7);
      const acumulado = porMes.get(mes);
      if (!acumulado) continue; // fora do intervalo pedido (não deveria acontecer — já filtrado no Postgres por [campoMes] gte/lte, ver buscarPagamentosValidos)

      const valor = Number(pagamento.value) || 0;
      acumulado.valorTotalFaturado += valor;

      if (visao === 'historico') {
        const classificacao = classificarPagamento(pagamento, hojeStr, diasTolerancia);
        if (classificacao === 'INADIMPLENTE') acumulado.valorInadimplente += valor;
        else if (classificacao === 'ADIMPLENTE') acumulado.valorAdimplente += valor;
        // A_VENCER: nem um nem outro — mesmo "terceiro grupo" do /resumo em modo histórico.
      } else {
        if (statusInadimplenteValidos.includes(pagamento.status)) acumulado.valorInadimplente += valor;
        else if (STATUS_ADIMPLENTE.includes(pagamento.status)) acumulado.valorAdimplente += valor;
        // Nem um nem outro (ex.: PENDING, ainda não vencida): não soma em nenhum dos dois — ver docblock.
      }
    }

    const resultado = meses.map((mes) => {
      const { valorTotalFaturado, valorInadimplente, valorAdimplente } = porMes.get(mes);
      return {
        mes,
        valor_total_faturado: arredondar2(valorTotalFaturado),
        valor_inadimplente: arredondar2(valorInadimplente),
        taxa_inadimplencia_percentual: calcularTaxa(valorTotalFaturado, valorInadimplente),
        taxa_adimplencia_percentual: calcularTaxa(valorTotalFaturado, valorAdimplente),
      };
    });

    cache.set(chaveCache, resultado, CACHE_TTL_MS);
    res.json(resultado);
  } catch (err) {
    // AJUSTE 14 — mesmo motivo do /resumo (ver docblock lá): esta rota não
    // consulta mais o Asaas ao vivo, então não há mais catch específico de
    // AsaasApiError aqui.
    next(err);
  }
};

/**
 * GET /api/inadimplencia/exclusoes
 * Lista as exclusões manuais cadastradas (mais recentes primeiro).
 */
exports.listarExclusoes = async (req, res, next) => {
  try {
    const registros = await req.prisma.cobrancaIgnorada.findMany({ orderBy: { criadoEm: 'desc' } });
    res.json(
      registros.map((r) => ({
        id: r.id,
        asaas_payment_id: r.asaasPaymentId,
        motivo: r.motivo,
        criado_em: r.criadoEm,
      }))
    );
  } catch (err) {
    next(err);
  }
};

/**
 * POST /api/inadimplencia/exclusoes
 * Body: { "asaas_payment_id": "pay_...", "motivo": "..." (opcional) }
 * Limpa o cache de /resumo e /evolucao-mensal ao adicionar, para a exclusão
 * valer imediatamente na próxima consulta.
 */
exports.criarExclusao = async (req, res, next) => {
  try {
    const { asaas_payment_id: asaasPaymentId, motivo } = req.body || {};

    if (typeof asaasPaymentId !== 'string' || asaasPaymentId.trim() === '') {
      return res.status(400).json({ error: '"asaas_payment_id" é obrigatório.' });
    }
    if (motivo !== undefined && motivo !== null && typeof motivo !== 'string') {
      return res.status(400).json({ error: '"motivo" deve ser uma string.' });
    }

    // Multi-franquia — Fase 3: "franquiaId" injetado automaticamente pela
    // extension (ver prismaComEscopo.js).
    const registro = await req.prisma.cobrancaIgnorada.create({
      data: { asaasPaymentId: asaasPaymentId.trim(), motivo: motivo?.trim() || null },
    });

    cache.clear();

    res.status(201).json({
      id: registro.id,
      asaas_payment_id: registro.asaasPaymentId,
      motivo: registro.motivo,
      criado_em: registro.criadoEm,
    });
  } catch (err) {
    if (err.code === 'P2002') {
      return res.status(409).json({ error: 'Este "asaas_payment_id" já está na lista de exclusões.' });
    }
    next(err);
  }
};

/**
 * DELETE /api/inadimplencia/exclusoes/:id
 * Limpa o cache de /resumo e /evolucao-mensal ao remover, pelo mesmo motivo.
 */
exports.removerExclusao = async (req, res, next) => {
  try {
    const { id } = req.params;
    await req.prisma.cobrancaIgnorada.delete({ where: { id } });
    cache.clear();
    res.status(204).end();
  } catch (err) {
    if (err.code === 'P2025') {
      return res.status(404).json({ error: 'Exclusão não encontrada.' });
    }
    next(err);
  }
};

/**
 * POST /api/inadimplencia/reconciliar-pagamentos
 * AJUSTE 14 — mesma reconciliação de scripts/reconciliar-pagamentos-asaas.js
 * (ver docblock lá para o "porquê" — webhook entrega "at least once", isto é
 * a rede de segurança contra entregas perdidas), exposta como endpoint HTTP
 * para quem preferir disparar via um agendador externo estilo n8n em vez de
 * rodar o script diretamente no host (mesma lógica de sync do Dashboard,
 * POST /api/sync, que também é disparada de fora). Os dois caminhos
 * convergem em `sincronizarJanela`/`calcularJanelaReconciliacao`
 * (pagamentosAsaas.service.js) — nenhuma lógica duplicada.
 *
 * Diferenças em relação ao script:
 *   - Escopado a UMA franquia por chamada (a do usuário autenticado, via
 *     "auth" + "escopoFranquia" — mesmo padrão do resto da API multi-
 *     franquia), nunca "todas" — um agendador externo que precise
 *     reconciliar várias franquias chama este endpoint uma vez por franquia
 *     (mesmo padrão de POST /api/sync).
 *   - Sem modo dry-run — sempre aplica (o script é o lugar pra "só
 *     mostrar"; um endpoint HTTP chamado por um agendador automatizado não
 *     tem quem leia um relatório de dry-run).
 *   - Janela sempre a padrão (`calcularJanelaReconciliacao`, sem flags) —
 *     não expõe "--dias-atras/--dias-frente" como parâmetro de query, pra
 *     manter o endpoint simples e previsível (ajustar a janela, se um dia
 *     for preciso, é editar a constante compartilhada, refletindo em ambos
 *     os caminhos).
 *
 * Limpa o cache de /resumo e /evolucao-mensal ao final — divergências
 * corrigidas aqui (ex.: um pagamento removido) devem valer imediatamente na
 * próxima consulta, mesmo caching de 4min de exclusoes/criarExclusao.
 */
exports.reconciliarPagamentos = async (req, res, next) => {
  try {
    const { vencDe, vencAte } = calcularJanelaReconciliacao();
    const resultado = await sincronizarJanela(req.franquiaId, { vencDe, vencAte, dryRun: false });

    cache.clear();

    res.json({
      janela: { venc_de: vencDe, venc_ate: vencAte },
      total_asaas: resultado.totalAsaas,
      criados: resultado.criados,
      atualizados: resultado.atualizados,
      removidos: resultado.removidos,
      clientes_resolvidos: resultado.clientesResolvidos,
    });
  } catch (err) {
    if (err instanceof AsaasApiError) {
      return res.status(502).json({ error: `Erro ao consultar a API do Asaas: ${err.message}` });
    }
    next(err);
  }
};
