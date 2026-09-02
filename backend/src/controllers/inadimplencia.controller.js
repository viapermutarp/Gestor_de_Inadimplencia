const cache = require('../services/cache.service');
const { getPalavrasExcluidas, getDiasTolerancia } = require('../services/config.service');
const { listarPagamentos, obterClientesPorId, AsaasApiError } = require('../services/asaas.service');
const { resolverFranquiaIdOuPadrao } = require('../services/franquiaPadrao.service');

const FILTRO_TRI_ESTADO_VALIDAS = ['todos', 'sim', 'nao'];
const VISAO_FAIXAS_VALIDAS = ['aberto', 'historico'];
const CACHE_TTL_MS = 4 * 60 * 1000; // 4 minutos — dentro da faixa de 3-5min pedida.
const MESES_PADRAO = 12;
const UM_DIA_MS = 24 * 60 * 60 * 1000;
const PALAVRA_RENEGOCIACAO = 'renegociação';

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
 * Para cada pagamento, resolve { cpfCnpj, nome, emNegociacao, emJuridico,
 * bloqueado } cruzando o cliente do Asaas (mapaClientes: customerId ->
 * {cpfCnpj, nome}) com a nossa tabela "associados" (associadoPorCpfCnpj:
 * cpfCnpj -> associado). Pagamentos cujo cliente não tem cpfCnpj resolvido,
 * ou cujo cpfCnpj não bate com nenhum associado nosso, são tratados como
 * "não" nos três campos booleanos (regra explícita do pedido, igual para
 * os três).
 */
function resolverPagamento(pagamento, mapaClientes, associadoPorCpfCnpj) {
  const cliente = mapaClientes.get(pagamento.customer);
  const cpfCnpj = cliente?.cpfCnpj || null;
  const associado = cpfCnpj ? associadoPorCpfCnpj.get(cpfCnpj) : undefined;

  return {
    cpfCnpj,
    nome: associado?.nome || cliente?.nome || null,
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
 * Separa os pagamentos em "válidos" (entram no cálculo) e "excluídos". Um
 * pagamento é excluído se: (a) seu ID estiver na lista manual, OU (b) sua
 * descrição contiver, de forma case-insensitive e por substring, alguma das
 * palavras configuradas. Os dois mecanismos são combinados com OU — como
 * cada pagamento passa por essa checagem uma única vez, um pagamento pego
 * pelos dois mecanismos ao mesmo tempo é contado só uma vez em `excluidos`
 * (nunca duplicado).
 */
function separarExcluidos(pagamentos, idsExcluidos, palavras) {
  const palavrasMinusculas = palavras.filter(Boolean).map((p) => p.toLowerCase());
  const validos = [];
  const excluidos = [];

  for (const pagamento of pagamentos) {
    const excluidoPorId = idsExcluidos.has(pagamento.id);
    const descricao = (pagamento.description || '').toLowerCase();
    const excluidoPorPalavra = !excluidoPorId && palavrasMinusculas.some((palavra) => descricao.includes(palavra));

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
 * Busca os pagamentos do Asaas no período informado e já separa os
 * excluídos pelos dois mecanismos (AJUSTE 1) — usado tanto por `resumo`
 * quanto por `evolucaoMensal`.
 */
async function buscarPagamentosValidos(reqPrisma, franquiaId, { vencDe, vencAte }) {
  const [pagamentos, { idsExcluidos, palavras }] = await Promise.all([
    listarPagamentos({ dueDateGe: vencDe, dueDateLe: vencAte }, franquiaId),
    buscarExclusoesConfiguradas(reqPrisma, franquiaId),
  ]);
  return separarExcluidos(pagamentos, idsExcluidos, palavras);
}

/**
 * Resolve, para uma lista de IDs de cliente do Asaas, o mapa
 * (customerId -> {cpfCnpj, nome}) via API do Asaas e o mapa
 * (cpfCnpj -> associado local) via nossa tabela "associados" — reaproveitado
 * por `resumo` e `evolucaoMensal`.
 */
async function resolverClientesEAssociados(reqPrisma, franquiaId, idsClientes) {
  const mapaClientes = await obterClientesPorId(idsClientes, franquiaId);
  const cpfCnpjsResolvidos = [...new Set([...mapaClientes.values()].map((c) => c.cpfCnpj).filter(Boolean))];
  const associadosLocais = cpfCnpjsResolvidos.length
    ? await reqPrisma.associado.findMany({
        where: { cpfCnpj: { in: cpfCnpjsResolvidos } },
        select: { cpfCnpj: true, nome: true, emNegociacao: true, emJuridico: true, bloqueado: true },
      })
    : [];
  const associadoPorCpfCnpj = new Map(associadosLocais.map((a) => [a.cpfCnpj, a]));
  return { mapaClientes, associadoPorCpfCnpj };
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
 */
function aplicarFiltrosCrossReference(pagamentos, { renegociacao, emJuridico, bloqueado }, mapaClientes, associadoPorCpfCnpj) {
  if (renegociacao === 'todos' && emJuridico === 'todos' && bloqueado === 'todos') return pagamentos;

  return pagamentos.filter((pagamento) => {
    const {
      emNegociacao,
      emJuridico: pagamentoEmJuridico,
      bloqueado: pagamentoBloqueado,
    } = resolverPagamento(pagamento, mapaClientes, associadoPorCpfCnpj);

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
 * Soma as 6 faixas de atraso (0_20 ... 100_180, sem teto na última) e o
 * total de "críticos 90+ dias" sobre uma lista de pagamentos já filtrada
 * para o modo certo (ver AJUSTE CRÍTICO 2):
 *   - modo "aberto": `pagamentos` já vem restrito a status OVERDUE (snapshot
 *     de hoje) — dias efetivos de atraso = hoje - dataLimiteEfetiva.
 *   - modo "historico": `pagamentos` já vem restrito às INADIMPLENTES pela
 *     classificação de `classificarPagamento` (não pagas em dia, já
 *     considerando a tolerância) — dias efetivos de atraso =
 *     paymentDate - dataLimiteEfetiva quando já foi paga (com atraso), ou
 *     hoje - dataLimiteEfetiva quando ainda não foi paga.
 *
 * PERÍODO DE TOLERÂNCIA (`diasTolerancia`) — `dataLimiteEfetiva` =
 * dueDate + diasTolerancia (mesma "data limite efetiva" de
 * `classificarPagamento`, ver docblock lá para a fórmula e um exemplo
 * numérico completo no README). Isso desloca o próprio número de dias
 * usado para escolher a faixa (uma cobrança paga com 25 dias de atraso e
 * 2 dias de tolerância cai na faixa correspondente a 23 dias efetivos, não
 * 25) e, no modo "aberto", pode zerar o atraso de cobranças que o Asaas já
 * marca como OVERDUE mas que ainda estão dentro da janela de tolerância —
 * nesse caso `diasAtraso` fica negativo e o pagamento é pulado (`continue`)
 * SEM entrar em nenhuma faixa nem em `criticos90Dias`, exatamente como
 * pedido ("não devem aparecer em nenhuma faixa"). No modo "historico" isso
 * não deveria acontecer na prática (o conjunto já vem restrito a
 * INADIMPLENTE, que por definição já esgotou a tolerância), mas o guard
 * fica por segurança/simetria entre os dois modos.
 */
function computarFaixasECriticos(pagamentos, modo, hojeStr, diasTolerancia) {
  const faixas = { '0_20': 0, '20_30': 0, '30_40': 0, '40_50': 0, '50_100': 0, '100_180': 0 };
  let criticos90Dias = 0;

  for (const pagamento of pagamentos) {
    const valor = Number(pagamento.value) || 0;
    const dataLimiteEfetiva = somarDias(pagamento.dueDate, diasTolerancia);
    const diasAtraso =
      modo === 'historico' && pagamento.paymentDate
        ? diferencaDias(pagamento.paymentDate, dataLimiteEfetiva)
        : diferencaDias(hojeStr, dataLimiteEfetiva);

    if (diasAtraso < 0) continue; // ainda dentro da tolerância — não conta em nenhuma faixa, nem em críticos 90+ dias

    if (diasAtraso < 20) faixas['0_20'] += valor;
    else if (diasAtraso < 30) faixas['20_30'] += valor;
    else if (diasAtraso < 40) faixas['30_40'] += valor;
    else if (diasAtraso < 50) faixas['40_50'] += valor;
    else if (diasAtraso < 100) faixas['50_100'] += valor;
    else faixas['100_180'] += valor; // 100+ dias (sem teto — atrasos além de 180d continuam contados aqui, não desaparecem do relatório)

    if (diasAtraso >= 90) criticos90Dias += valor;
  }

  return { faixas, criticos90Dias };
}

/**
 * GET /api/inadimplencia/resumo
 *   ?venc_de=YYYY-MM-DD&venc_ate=YYYY-MM-DD
 *   &renegociacao=todos|sim|nao&em_juridico=todos|sim|nao&bloqueado=todos|sim|nao
 *   &visao_faixas=aberto|historico&forcar=true
 *
 * Calcula, a partir dos pagamentos do Asaas com vencimento no período
 * informado (padrão: últimos 12 meses), os números da tela de "Taxa de
 * Inadimplência". Ver README para o detalhamento de cada campo e das
 * decisões de design.
 *
 * Antes de qualquer cálculo, os pagamentos passam pela exclusão combinada
 * (lista manual por ID OU palavra-chave na descrição) — o que foi removido
 * nessa etapa é reportado em "excluidos", e NUNCA entra em nenhum outro
 * campo da resposta.
 *
 * "renegociacao", "em_juridico" e "bloqueado" cruzam o cpfCnpj de cada
 * pagamento do Asaas (resolvido via GET /v3/customers/{id}) com
 * "associados.em_negociacao"/"associados.em_juridico"/"associados.bloqueado"
 * na nossa base — mesma regra para os três (sem correspondência local =
 * "não"). Quando algum dos três é "sim" ou "nao", ele restringe TODO o
 * conjunto de pagamentos usado no cálculo (inclusive valor_total_faturado).
 *
 * PERÍODO DE TOLERÂNCIA — todo cálculo que classifica ADIMPLENTE x
 * INADIMPLENTE (valor_inadimplente/valor_adimplente/as duas taxas) e a
 * bucketização de "faixas"/"criticos_90_dias" nos dois modos de
 * visao_faixas usam o período de tolerância vigente (dias corridos,
 * GET/PATCH /api/config/tolerancia-dias, padrão 0), lido uma vez no início
 * da requisição. Ver `classificarPagamento` e `computarFaixasECriticos`
 * para a fórmula ("data limite efetiva" = dueDate + diasTolerancia) e o
 * README para um exemplo numérico completo.
 *
 * AJUSTE CRÍTICO 1 — "valor_inadimplente"/"taxa_inadimplencia_percentual"
 * usam a classificação HISTÓRICA por data de pagamento
 * (`classificarPagamento` — ADIMPLENTE/INADIMPLENTE/A_VENCER), não mais o
 * status atual do Asaas. Isso torna o retrato de qualquer período passado
 * fixo, independente de quando a consulta é feita.
 *
 * AJUSTE CRÍTICO 2 — "faixas" e "criticos_90_dias" têm dois modos,
 * controlados por "visao_faixas" (padrão "aberto"):
 *   - "aberto": só cobranças AINDA NÃO PAGAS hoje (status OVERDUE),
 *     bucketed por (hoje - dueDate) — é um snapshot do que está em aberto
 *     agora, muda a cada consulta.
 *   - "historico": cobranças do período que NÃO foram pagas em dia (mesma
 *     regra de INADIMPLENTE do Ajuste 1), bucketed por (paymentDate -
 *     dueDate) se já paga, ou (hoje - dueDate) se ainda não paga — fixo
 *     para o período, como a taxa de inadimplência histórica.
 *
 * "associados_inadimplentes" e "top_devedores" continuam baseados no
 * snapshot "aberto" (quem tem cobrança OVERDUE agora) — são listas
 * operacionais ("quem cobrar hoje"), independentes de "visao_faixas" e da
 * classificação histórica do Ajuste 1 — ver README.
 *
 * AJUSTE 3 — "renegociacoes_abertas" conta/soma cobranças cuja descrição
 * (no próprio Asaas) contém "Renegociação" (case-insensitive, substring) e
 * cujo status ainda está em aberto (PENDING ou OVERDUE) — não cruza mais
 * com `associados.em_negociacao` (esse cruzamento continua existindo, mas
 * só como o filtro `renegociacao` do parágrafo acima).
 *
 * AJUSTE 1 (rodada seguinte) — "valor_adimplente" e
 * "taxa_adimplencia_percentual" usam a mesma classificação histórica do
 * Ajuste Crítico 1 (numerador = soma dos pagamentos ADIMPLENTE), calculados
 * já prontos aqui no backend — nunca derivados no frontend por subtração
 * (ex.: `total - inadimplente`), porque isso daria errado sempre que houver
 * cobranças "A_VENCER" no período (que não entram nem no numerador de
 * inadimplência, nem no de adimplência).
 *
 * Cacheado em memória por 4 minutos, por combinação exata de
 * (venc_de, venc_ate, renegociacao, em_juridico, bloqueado, visao_faixas).
 * O cache é limpo sempre que a lista de exclusões manuais ou de
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
      renegociacao: renegociacaoParam,
      em_juridico: emJuridicoParam,
      bloqueado: bloqueadoParam,
      visao_faixas: visaoFaixasParam,
    } = req.query;

    const { vencDe, vencAte, erro: erroPeriodo } = resolverPeriodo(vencDeParam, vencAteParam);
    if (erroPeriodo) {
      return res.status(400).json({ error: erroPeriodo });
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

    const visaoFaixas = visaoFaixasParam === undefined ? 'aberto' : visaoFaixasParam;
    if (!VISAO_FAIXAS_VALIDAS.includes(visaoFaixas)) {
      return res.status(400).json({ error: '"visao_faixas" deve ser "aberto" ou "historico".' });
    }

    // AJUSTE 2 — "forcar=true" ignora a LEITURA do cache (busca sempre dados
    // frescos do Asaas), mas o resultado novo ainda é gravado no cache no
    // final (mesma chave/TTL) — as próximas consultas sem "forcar=" voltam
    // a se beneficiar dele normalmente.
    const forcar = req.query.forcar === 'true';

    const chaveCache = `inadimplencia:resumo:${vencDe}:${vencAte}:${renegociacao}:${emJuridico}:${bloqueado}:${visaoFaixas}`;
    const cacheado = forcar ? undefined : cache.get(chaveCache);
    if (cacheado) {
      return res.json(cacheado);
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);

    const [{ validos: pagamentosValidos, excluidos }, diasTolerancia] = await Promise.all([
      buscarPagamentosValidos(req.prisma, franquiaId, { vencDe, vencAte }),
      getDiasTolerancia(franquiaId),
    ]);

    // Só precisamos resolver cpfCnpj de TODOS os pagamentos válidos quando
    // algum filtro de cross-reference está ativo (ele filtra o conjunto
    // inteiro, não só os OVERDUE). Sem filtro ativo, basta resolver os
    // OVERDUE — é tudo que "associados_inadimplentes"/"top_devedores"
    // precisam.
    const precisaResolverTodos = renegociacao !== 'todos' || emJuridico !== 'todos' || bloqueado !== 'todos';
    const idsOverdue = pagamentosValidos.filter((p) => p.status === 'OVERDUE').map((p) => p.customer);
    const idsParaResolver = precisaResolverTodos ? pagamentosValidos.map((p) => p.customer) : idsOverdue;

    const { mapaClientes, associadoPorCpfCnpj } = await resolverClientesEAssociados(
      req.prisma,
      franquiaId,
      idsParaResolver
    );

    const conjuntoTrabalho = aplicarFiltrosCrossReference(
      pagamentosValidos,
      { renegociacao, emJuridico, bloqueado },
      mapaClientes,
      associadoPorCpfCnpj
    );

    const hojeStr = formatarDataISO(new Date());

    const valorTotalFaturado = conjuntoTrabalho.reduce((soma, p) => soma + (Number(p.value) || 0), 0);

    // AJUSTE CRÍTICO 1 — classificação histórica por data de pagamento.
    // AJUSTE 1 (rodada seguinte) — "valor_adimplente"/"taxa_adimplencia_percentual"
    // usam a mesma classificação, com numerador próprio (ADIMPLENTE), igual
    // já era feito em /evolucao-mensal — não é o complementar de
    // taxa_inadimplencia_percentual, já que cobranças "A_VENCER" não entram
    // em nenhum dos dois numeradores (ver docblock do endpoint).
    let valorInadimplente = 0;
    let valorAdimplente = 0;
    for (const pagamento of conjuntoTrabalho) {
      const classe = classificarPagamento(pagamento, hojeStr, diasTolerancia);
      if (classe === 'INADIMPLENTE') valorInadimplente += Number(pagamento.value) || 0;
      else if (classe === 'ADIMPLENTE') valorAdimplente += Number(pagamento.value) || 0;
    }
    const taxaInadimplencia = calcularTaxa(valorTotalFaturado, valorInadimplente);
    const taxaAdimplencia = calcularTaxa(valorTotalFaturado, valorAdimplente);

    // AJUSTE CRÍTICO 2 — "aberto" (snapshot OVERDUE de hoje) x "historico"
    // (não pagas em dia, pelo período inteiro). Os dois já levam o período
    // de tolerância em conta (ver computarFaixasECriticos).
    const pagamentosOverdue = conjuntoTrabalho.filter((p) => p.status === 'OVERDUE');
    const pagamentosParaFaixas =
      visaoFaixas === 'aberto'
        ? pagamentosOverdue
        : conjuntoTrabalho.filter((p) => classificarPagamento(p, hojeStr, diasTolerancia) === 'INADIMPLENTE');
    const { faixas, criticos90Dias } = computarFaixasECriticos(pagamentosParaFaixas, visaoFaixas, hojeStr, diasTolerancia);

    // "associados_inadimplentes" / "top_devedores" — sempre pelo snapshot
    // "aberto" (ver docblock acima).
    const identificadoresInadimplentes = new Set();
    const porDevedor = new Map();
    for (const pagamento of pagamentosOverdue) {
      const valor = Number(pagamento.value) || 0;
      const { cpfCnpj, nome } = resolverPagamento(pagamento, mapaClientes, associadoPorCpfCnpj);
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
    if (err instanceof AsaasApiError) {
      return res.status(err.status || 502).json({ error: err.message });
    }
    next(err);
  }
};

/**
 * GET /api/inadimplencia/evolucao-mensal?venc_de=&venc_ate=&renegociacao=&em_juridico=&bloqueado=
 *
 * Mesma base de cálculo do /resumo — mesma exclusão combinada e mesmos
 * cross-references de renegociacao/em_juridico/bloqueado — mas agrupada por
 * mês de vencimento ("YYYY-MM", derivado direto da string "dueDate" do
 * Asaas, sem passar por Date, para não sofrer problema de fuso). Todo mês
 * dentro do intervalo aparece no resultado, mesmo sem nenhum pagamento
 * naquele mês (valores zerados; as duas taxas ficam 0%).
 *
 * AJUSTE CRÍTICO 1 — "valor_inadimplente"/"taxa_inadimplencia_percentual"/
 * "taxa_adimplencia_percentual" usam a mesma classificação histórica por
 * data de pagamento do /resumo (`classificarPagamento`), não mais o status
 * atual. IMPORTANTE: "taxa_adimplencia_percentual" NÃO é mais o simples
 * complementar de "taxa_inadimplencia_percentual" (100 - taxa) — é
 * calculada com seu próprio numerador (soma dos valores ADIMPLENTES) sobre
 * "valor_total_faturado". As duas taxas só somam 100% quando não há
 * nenhuma cobrança "A_VENCER" (vencimento futuro, ainda não paga) no mês —
 * quando há, a diferença é exatamente o valor "a vencer" daquele mês, que
 * não entra em nenhuma das duas (ver AJUSTE CRÍTICO 1 no README).
 *
 * PERÍODO DE TOLERÂNCIA — mesma regra do /resumo: a classificação usa a
 * "data limite efetiva" (dueDate + dias de tolerância vigentes,
 * GET/PATCH /api/config/tolerancia-dias) em vez do vencimento cru — ver
 * `classificarPagamento` e o README.
 *
 * Cacheado em memória por 4 minutos, por combinação exata de
 * (venc_de, venc_ate, renegociacao, em_juridico, bloqueado), em um
 * namespace de cache separado do /resumo. AJUSTE 2 — aceita "forcar=true"
 * com a mesma semântica do /resumo: ignora a leitura do cache, mas ainda
 * grava o resultado novo.
 */
exports.evolucaoMensal = async (req, res, next) => {
  try {
    const {
      venc_de: vencDeParam,
      venc_ate: vencAteParam,
      renegociacao: renegociacaoParam,
      em_juridico: emJuridicoParam,
      bloqueado: bloqueadoParam,
    } = req.query;

    const { vencDe, vencAte, erro: erroPeriodo } = resolverPeriodo(vencDeParam, vencAteParam);
    if (erroPeriodo) {
      return res.status(400).json({ error: erroPeriodo });
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

    // AJUSTE 2 — mesma semântica de "forcar=true" do /resumo (ver docblock
    // acima): ignora a leitura do cache, mas ainda grava o resultado novo.
    const forcar = req.query.forcar === 'true';

    const chaveCache = `inadimplencia:evolucao-mensal:${vencDe}:${vencAte}:${renegociacao}:${emJuridico}:${bloqueado}`;
    const cacheado = forcar ? undefined : cache.get(chaveCache);
    if (cacheado) {
      return res.json(cacheado);
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);

    const [{ validos: pagamentosValidos }, diasTolerancia] = await Promise.all([
      buscarPagamentosValidos(req.prisma, franquiaId, { vencDe, vencAte }),
      getDiasTolerancia(franquiaId),
    ]);

    let conjuntoTrabalho = pagamentosValidos;
    if (renegociacao !== 'todos' || emJuridico !== 'todos' || bloqueado !== 'todos') {
      const idsParaResolver = pagamentosValidos.map((p) => p.customer);
      const { mapaClientes, associadoPorCpfCnpj } = await resolverClientesEAssociados(
        req.prisma,
        franquiaId,
        idsParaResolver
      );
      conjuntoTrabalho = aplicarFiltrosCrossReference(
        pagamentosValidos,
        { renegociacao, emJuridico, bloqueado },
        mapaClientes,
        associadoPorCpfCnpj
      );
    }

    const hojeStr = formatarDataISO(new Date());
    const meses = gerarChavesMeses(vencDe, vencAte);
    const porMes = new Map(meses.map((mes) => [mes, { valorTotalFaturado: 0, valorInadimplente: 0, valorAdimplente: 0 }]));

    for (const pagamento of conjuntoTrabalho) {
      const mes = pagamento.dueDate.slice(0, 7);
      const acumulado = porMes.get(mes);
      if (!acumulado) continue; // fora do intervalo pedido (não deveria acontecer, já filtrado pelo Asaas via dueDate[ge]/[le])

      const valor = Number(pagamento.value) || 0;
      acumulado.valorTotalFaturado += valor;

      const classe = classificarPagamento(pagamento, hojeStr, diasTolerancia);
      if (classe === 'INADIMPLENTE') acumulado.valorInadimplente += valor;
      else if (classe === 'ADIMPLENTE') acumulado.valorAdimplente += valor;
      // A_VENCER: não soma em nenhum dos dois — ver docblock.
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
    if (err instanceof AsaasApiError) {
      return res.status(err.status || 502).json({ error: err.message });
    }
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
