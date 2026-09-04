const cache = require('../services/cache.service');
const { getPalavrasExcluidas, getDiasTolerancia } = require('../services/config.service');
const { listarPagamentos, obterClientesPorId, AsaasApiError } = require('../services/asaas.service');
const { resolverFranquiaIdOuPadrao } = require('../services/franquiaPadrao.service');

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
 *     senão o nome do cliente no Asaas).
 * Os mecanismos são combinados com OU — como cada pagamento passa por essa
 * checagem uma única vez, um pagamento pego por mais de um ao mesmo tempo é
 * contado só uma vez em `excluidos` (nunca duplicado).
 *
 * `resolucaoClientes` ({ mapaClientes, associadoPorCpfCnpj }, ver
 * `resolverClientesEAssociados`) só é necessário pra checar CPF/CNPJ e nome
 * — quando `null` (nenhuma palavra configurada, ver `buscarPagamentosValidos`,
 * que evita o custo de resolver clientes à toa), a checagem cai de volta pra
 * só descrição, e como não há palavras mesmo, nem chega a fazer diferença.
 */
function separarExcluidos(pagamentos, idsExcluidos, palavras, resolucaoClientes) {
  const palavrasMinusculas = palavras.filter(Boolean).map((p) => p.toLowerCase());
  const palavrasComoDocumento = palavras.filter(Boolean).map(normalizarDocumento).filter(Boolean);
  const mapaClientes = resolucaoClientes?.mapaClientes;
  const associadoPorCpfCnpj = resolucaoClientes?.associadoPorCpfCnpj;
  const validos = [];
  const excluidos = [];

  for (const pagamento of pagamentos) {
    const excluidoPorId = idsExcluidos.has(pagamento.id);
    let excluidoPorPalavra = false;

    if (!excluidoPorId && palavrasMinusculas.length > 0) {
      const descricao = (pagamento.description || '').toLowerCase();
      excluidoPorPalavra = palavrasMinusculas.some((palavra) => descricao.includes(palavra));

      if (!excluidoPorPalavra && mapaClientes) {
        const { cpfCnpj, nome } = resolverPagamento(pagamento, mapaClientes, associadoPorCpfCnpj);
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
 * Busca os pagamentos do Asaas no período informado e já separa os
 * excluídos pelos mecanismos configurados (lista manual por ID + palavras-
 * chave, ver `separarExcluidos`) — usado tanto por `resumo` quanto por
 * `evolucaoMensal`.
 *
 * AJUSTE 7 — quando há pelo menos uma palavra-chave configurada, o critério
 * de match por palavra passou a cobrir também CPF/CNPJ e nome/razão social
 * do associado, não só a descrição da cobrança. Isso exige saber quem é o
 * cliente (via Asaas) de CADA pagamento do período ANTES de decidir quem é
 * excluído — não só dos pagamentos que sobrarem depois, nem só do
 * subconjunto (ex.: só OVERDUE) que outros filtros precisariam. Por isso,
 * SÓ quando `palavras.length > 0`, resolvemos aqui a lista COMPLETA de
 * clientes do período inteiro (via `resolverClientesEAssociados`) — e
 * devolvemos essa resolução (`resolucaoClientes`) pra quem chamou reusar,
 * em vez de resolver os mesmos clientes de novo mais adiante (ver `resumo`/
 * `evolucaoMensal`). Franquias sem nenhuma palavra-chave configurada
 * (`palavras.length === 0`) continuam com o comportamento e o custo de
 * antes: nenhuma resolução extra de cliente aqui, exclusão só por ID/
 * descrição, e `resolucaoClientes` sai `null` (cada endpoint resolve só o
 * que precisar, como já fazia).
 */
async function buscarPagamentosValidos(reqPrisma, franquiaId, { vencDe, vencAte }) {
  const [pagamentos, { idsExcluidos, palavras }] = await Promise.all([
    listarPagamentos({ dueDateGe: vencDe, dueDateLe: vencAte }, franquiaId),
    buscarExclusoesConfiguradas(reqPrisma, franquiaId),
  ]);

  const resolucaoClientes =
    palavras.filter(Boolean).length > 0
      ? await resolverClientesEAssociados(reqPrisma, franquiaId, pagamentos.map((p) => p.customer))
      : null;

  const resultado = separarExcluidos(pagamentos, idsExcluidos, palavras, resolucaoClientes);
  return { ...resultado, resolucaoClientes };
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
    const dataLimiteEfetiva = somarDias(pagamento.dueDate, diasTolerancia);
    const diasAtraso =
      modo === 'historico' && pagamento.paymentDate
        ? diferencaDias(pagamento.paymentDate, dataLimiteEfetiva)
        : diferencaDias(hojeStr, dataLimiteEfetiva);

    if (diasAtraso <= 0) faixas.ate_vencimento += valor;
    else if (diasAtraso <= 20) faixas['1_20'] += valor;
    else if (diasAtraso <= 30) faixas['21_30'] += valor;
    else if (diasAtraso <= 40) faixas['31_40'] += valor;
    else if (diasAtraso <= 50) faixas['41_50'] += valor;
    else if (diasAtraso <= 100) faixas['51_100'] += valor;
    else faixas.acima_100 += valor; // 100+ dias (sem teto)

    if (diasAtraso >= 90) criticos90Dias += valor;
  }

  return { faixas, criticos90Dias };
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
 * Calcula, a partir dos pagamentos do Asaas com vencimento no período
 * informado (padrão: últimos 12 meses), os números da tela de "Taxa de
 * Inadimplência". Ver README para o detalhamento de cada campo e das
 * decisões de design.
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
 * ESCOPO — este ajuste ("visao" afetando os 3 cards) é só deste endpoint.
 * GET /api/inadimplencia/evolucao-mensal continua exclusivamente por
 * STATUS ATUAL (AJUSTE CRÍTICO 3), sem parâmetro "visao" — o gráfico de
 * evolução mensal não foi incluído no pedido desta unificação.
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
      renegociacao: renegociacaoParam,
      em_juridico: emJuridicoParam,
      bloqueado: bloqueadoParam,
      tipo_pendencia: tipoPendenciaParam,
      visao: visaoParam,
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

    const chaveCache = `inadimplencia:resumo:${vencDe}:${vencAte}:${renegociacao}:${emJuridico}:${bloqueado}:${tipoPendencia}:${visao}`;
    const cacheado = forcar ? undefined : cache.get(chaveCache);
    if (cacheado) {
      return res.json(cacheado);
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);

    const [{ validos: pagamentosValidos, excluidos, resolucaoClientes: resolucaoDaExclusao }, diasTolerancia] =
      await Promise.all([
        buscarPagamentosValidos(req.prisma, franquiaId, { vencDe, vencAte }),
        getDiasTolerancia(franquiaId),
      ]);

    // Só precisamos resolver cpfCnpj de TODOS os pagamentos válidos quando
    // algum filtro de cross-reference está ativo (ele filtra o conjunto
    // inteiro, não só os OVERDUE). Sem filtro ativo, basta resolver os
    // OVERDUE — é tudo que "associados_inadimplentes"/"top_devedores"
    // precisam. AJUSTE 7 — se `buscarPagamentosValidos` já resolveu TODOS os
    // clientes do período (porque há palavra-chave de exclusão configurada),
    // reaproveitamos essa resolução em vez de chamar a API do Asaas de novo
    // pros mesmos clientes.
    const precisaResolverTodos = renegociacao !== 'todos' || emJuridico !== 'todos' || bloqueado !== 'todos';
    const idsOverdue = pagamentosValidos.filter((p) => p.status === 'OVERDUE').map((p) => p.customer);
    const idsParaResolver = precisaResolverTodos ? pagamentosValidos.map((p) => p.customer) : idsOverdue;

    const { mapaClientes, associadoPorCpfCnpj } =
      resolucaoDaExclusao || (await resolverClientesEAssociados(req.prisma, franquiaId, idsParaResolver));

    const conjuntoTrabalho = aplicarFiltrosCrossReference(
      pagamentosValidos,
      { renegociacao, emJuridico, bloqueado },
      mapaClientes,
      associadoPorCpfCnpj
    );

    const hojeStr = formatarDataISO(new Date());

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
 * GET /api/inadimplencia/evolucao-mensal?venc_de=&venc_ate=&renegociacao=&em_juridico=&bloqueado=&tipo_pendencia=
 *
 * Mesma base de cálculo do /resumo — mesma exclusão combinada e mesmos
 * cross-references de renegociacao/em_juridico/bloqueado — mas agrupada por
 * mês de vencimento ("YYYY-MM", derivado direto da string "dueDate" do
 * Asaas, sem passar por Date, para não sofrer problema de fuso). Todo mês
 * dentro do intervalo aparece no resultado, mesmo sem nenhum pagamento
 * naquele mês (valores zerados; as duas taxas ficam 0%).
 *
 * AJUSTE CRÍTICO 3 (substitui o AJUSTE CRÍTICO 1) — "valor_inadimplente"/
 * "taxa_inadimplencia_percentual"/"taxa_adimplencia_percentual" usam o
 * mesmo critério por STATUS ATUAL do /resumo (ver docblock lá e
 * `STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA`/`STATUS_ADIMPLENTE` no topo do
 * arquivo), não mais a classificação histórica por data de pagamento.
 * "taxa_adimplencia_percentual" continua NÃO sendo o simples complementar
 * de "taxa_inadimplencia_percentual" (100 - taxa): tem numerador próprio
 * (soma dos valores com status RECEIVED/RECEIVED_IN_CASH) sobre
 * "valor_total_faturado". As duas taxas só somam 100% quando não há
 * nenhuma cobrança do "terceiro grupo" (nem inadimplente nem adimplente —
 * o mais comum sendo status PENDING, ainda não vencida) no mês.
 *
 * AJUSTE 4 — aceita "tipo_pendencia" (mesma semântica do /resumo): afeta
 * "valor_inadimplente"/"taxa_inadimplencia_percentual" de cada mês, nunca
 * "valor_adimplente"/"taxa_adimplencia_percentual".
 *
 * PERÍODO DE TOLERÂNCIA — não é mais lida por este endpoint: desde o
 * AJUSTE CRÍTICO 3, nenhum dos números aqui devolvidos depende de
 * comparação de datas (só de status atual). Fica só no /resumo, pra
 * "faixas"/"criticos_90_dias" (que este endpoint não tem).
 *
 * AJUSTE 7 — a exclusão por palavra-chave (compartilhada com /resumo via
 * `buscarPagamentosValidos`) passou a casar contra CPF/CNPJ e nome do
 * associado, além da descrição — ver docblock de `separarExcluidos`.
 *
 * ESCOPO — este endpoint NÃO recebeu o parâmetro "visao" do AJUSTE 6:
 * "valor_inadimplente"/as duas taxas aqui continuam exclusivamente por
 * STATUS ATUAL (AJUSTE CRÍTICO 3), sempre, independente de "visao" no
 * /resumo — o pedido de unificação foi só para os 3 cards do topo da
 * tela, que consomem /resumo; o gráfico de evolução mensal (que consome
 * este endpoint) não foi incluído.
 *
 * Cacheado em memória por 4 minutos, por combinação exata de
 * (venc_de, venc_ate, renegociacao, em_juridico, bloqueado, tipo_pendencia),
 * em um namespace de cache separado do /resumo. AJUSTE 2 — aceita
 * "forcar=true" com a mesma semântica do /resumo: ignora a leitura do
 * cache, mas ainda grava o resultado novo.
 */
exports.evolucaoMensal = async (req, res, next) => {
  try {
    const {
      venc_de: vencDeParam,
      venc_ate: vencAteParam,
      renegociacao: renegociacaoParam,
      em_juridico: emJuridicoParam,
      bloqueado: bloqueadoParam,
      tipo_pendencia: tipoPendenciaParam,
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

    const { valor: tipoPendencia, erro: erroTipoPendencia } = validarTipoPendencia(tipoPendenciaParam);
    if (erroTipoPendencia) {
      return res.status(400).json({ error: erroTipoPendencia });
    }

    // AJUSTE 2 — mesma semântica de "forcar=true" do /resumo (ver docblock
    // acima): ignora a leitura do cache, mas ainda grava o resultado novo.
    const forcar = req.query.forcar === 'true';

    const chaveCache = `inadimplencia:evolucao-mensal:${vencDe}:${vencAte}:${renegociacao}:${emJuridico}:${bloqueado}:${tipoPendencia}`;
    const cacheado = forcar ? undefined : cache.get(chaveCache);
    if (cacheado) {
      return res.json(cacheado);
    }

    const franquiaId = await resolverFranquiaIdOuPadrao(req);

    const { validos: pagamentosValidos, resolucaoClientes: resolucaoDaExclusao } = await buscarPagamentosValidos(
      req.prisma,
      franquiaId,
      { vencDe, vencAte }
    );

    let conjuntoTrabalho = pagamentosValidos;
    if (renegociacao !== 'todos' || emJuridico !== 'todos' || bloqueado !== 'todos') {
      // AJUSTE 7 — reaproveita a resolução de clientes já feita pra exclusão
      // (quando existir) em vez de chamar a API do Asaas de novo pros mesmos
      // clientes.
      const idsParaResolver = pagamentosValidos.map((p) => p.customer);
      const { mapaClientes, associadoPorCpfCnpj } =
        resolucaoDaExclusao || (await resolverClientesEAssociados(req.prisma, franquiaId, idsParaResolver));
      conjuntoTrabalho = aplicarFiltrosCrossReference(
        pagamentosValidos,
        { renegociacao, emJuridico, bloqueado },
        mapaClientes,
        associadoPorCpfCnpj
      );
    }

    // AJUSTE CRÍTICO 3 — mesmo critério por status atual do /resumo (ver
    // docblock acima e STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA/
    // STATUS_ADIMPLENTE no topo do arquivo).
    const statusInadimplenteValidos = STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA[tipoPendencia];
    const meses = gerarChavesMeses(vencDe, vencAte);
    const porMes = new Map(meses.map((mes) => [mes, { valorTotalFaturado: 0, valorInadimplente: 0, valorAdimplente: 0 }]));

    for (const pagamento of conjuntoTrabalho) {
      const mes = pagamento.dueDate.slice(0, 7);
      const acumulado = porMes.get(mes);
      if (!acumulado) continue; // fora do intervalo pedido (não deveria acontecer, já filtrado pelo Asaas via dueDate[ge]/[le])

      const valor = Number(pagamento.value) || 0;
      acumulado.valorTotalFaturado += valor;

      if (statusInadimplenteValidos.includes(pagamento.status)) acumulado.valorInadimplente += valor;
      else if (STATUS_ADIMPLENTE.includes(pagamento.status)) acumulado.valorAdimplente += valor;
      // Nem um nem outro (ex.: PENDING, ainda não vencida): não soma em nenhum dos dois — ver docblock.
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
