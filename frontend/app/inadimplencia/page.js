"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getResumoInadimplencia, getEvolucaoMensal, getToleranciaDias, ApiError } from "@/lib/api";
import { formatCurrency } from "@/lib/format";
import DatePicker from "@/components/DatePicker";
import ResumoInadimplenciaCards from "@/components/ResumoInadimplenciaCards";
import FaixasChart from "@/components/FaixasChart";
import TopDevedores from "@/components/TopDevedores";
import EvolucaoMensalChart from "@/components/EvolucaoMensalChart";
import ExclusoesPanel from "@/components/ExclusoesPanel";
import ErrorBanner from "@/components/ErrorBanner";
import Spinner from "@/components/Spinner";
import StatusAssociadoFilter from "@/components/StatusAssociadoFilter";
import MultiCheckboxFilter from "@/components/MultiCheckboxFilter";
import { IconKey, IconRefresh, IconCheck } from "@/components/icons";

// "Faixa de atraso" (AJUSTE 15, item 5 do brief) — mesmas 7 faixas de
// sempre (ver FaixasChart.js), rótulos "Em dia"/"Acima de 100" alinhados
// com o texto do brief (o backend/gráfico continuam usando as chaves
// originais "ate_vencimento"/"acima_100" — só o rótulo do FILTRO mudou).
const OPCOES_FAIXA = [
  { valor: "ate_vencimento", label: "Em dia" },
  { valor: "1_20", label: "1-20 dias" },
  { valor: "21_30", label: "21-30 dias" },
  { valor: "31_40", label: "31-40 dias" },
  { valor: "41_50", label: "41-50 dias" },
  { valor: "51_100", label: "51-100 dias" },
  { valor: "acima_100", label: "Acima de 100" },
];

// "Situação da cobrança" (AJUSTE 15, item 3 do brief) — filtro de
// POPULAÇÃO novo (afeta até valor_total_faturado, diferente do antigo
// "Tipo de pendência", removido desta tela — ver nota abaixo). "Todas" (o
// sentinel do MultiCheckboxFilter) = sem filtro algum; os dois valores
// marcados juntos = união dos dois grupos (ainda diferente de "sem
// filtro" — ver README do backend, seção "AJUSTE 15").
const OPCOES_SITUACAO = [
  { valor: "em_aberto", label: "Em aberto" },
  { valor: "pagas", label: "Pagas" },
];

// Sub-filtro condicional de "Em aberto" (AJUSTE 15, correção pós-entrega)
// — reaproveita o parâmetro `tipo_pendencia` que já existe no backend
// desde o AJUSTE 4 (nenhum parâmetro novo), só volta a expor a
// granularidade vencida/confirmada na UI, agora aninhada sob "Em aberto"
// em vez de um dropdown próprio. "todos" é o valor que o backend já usa
// como padrão/"sem filtro" (rótulo da UI é "Vencidas e confirmadas", mais
// claro que "Todas" bem do lado de outro "Todas" do dropdown pai).
const OPCOES_TIPO_PENDENCIA_SUB = [
  { valor: "todos", label: "Vencidas e confirmadas" },
  { valor: "vencidas", label: "Só vencidas" },
  { valor: "confirmadas", label: "Só confirmadas" },
];

// "Filtrar período por" (AJUSTE 15, item 2 do brief) — decide qual campo
// de data o período "De"/"Até" filtra. "vencimento" é o padrão (mesmo
// comportamento de sempre, sem regressão).
const OPCOES_FILTRO_PERIODO = [
  { valor: "emissao", label: "Data de emissão" },
  { valor: "vencimento", label: "Data de vencimento" },
  { valor: "pagamento", label: "Data de pagamento/recebimento" },
];

// "status" consolida "Em negociação"/"Bloqueado" e o novo "Tipo de
// inadimplente" (Ativo/Jurídico/Crítico, combinável) num único
// multi-select — ver StatusAssociadoFilter.js.
const STATUS_ASSOCIADO_VAZIO = { emNegociacao: false, bloqueado: false, tipoInadimplente: [] };

const INPUT =
  "w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40";

function Campo({ label, className = "", children }) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-xs text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}

// Bloco visual da barra de filtros (AJUSTE 15 — Layout: "todos os filtros
// ficam agrupados no topo da tela... reorganizar visualmente em
// blocos/seções (Período, Situação, Análise, Faixa, Tipo de
// inadimplente), não uma lista corrida como hoje"). Cada bloco é uma
// sub-área com título próprio dentro do mesmo card de filtros.
function BlocoFiltro({ titulo, className = "", children }) {
  return (
    <div className={`rounded-xl border border-border-soft/60 bg-surface-elevated/40 p-3 ${className}`}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{titulo}</p>
      {children}
    </div>
  );
}

// Toggle de 2 opções (mesmo padrão visual do antigo toggle "Em aberto
// hoje"/"Histórico do período", que morava no cabeçalho de FaixasChart —
// AJUSTE 15 moveu esse controle pra dentro do bloco "Análise" da barra de
// filtros, renomeando os rótulos conforme o brief: "Situação atual" e
// "Fechamento histórico do mês").
function ToggleDuasOpcoes({ opcoes, value, onChange }) {
  return (
    <div className="flex w-full rounded-xl border border-border-soft bg-surface-elevated p-1 text-xs font-medium">
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          onClick={() => onChange(o.valor)}
          className={`flex-1 rounded-lg px-3 py-1.5 transition-colors ${
            value === o.valor ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function InadimplenciaPage() {
  // Filtros que disparam uma nova chamada à API (só mudam de fato depois de
  // "Aplicar" — cada troca chama o Asaas de novo, que pode demorar alguns
  // segundos, então não faz sentido buscar a cada tecla/seleção).
  const [vencDeInput, setVencDeInput] = useState("");
  const [vencAteInput, setVencAteInput] = useState("");
  // "Filtrar período por" (AJUSTE 15) — qual campo de data o período acima
  // filtra ("vencimento"|"emissao"|"pagamento"). Aplicar-gated junto com
  // "De"/"Até", já que os três formam a mesma janela de período.
  const [filtroPeriodoInput, setFiltroPeriodoInput] = useState("vencimento");
  // "Situação da cobrança" (AJUSTE 15) — array de "em_aberto"|"pagas",
  // vazio = sem filtro. Filtro de população, então Aplicar-gated (dispara
  // nova chamada ao Asaas, igual período/status do associado).
  const [situacaoInput, setSituacaoInput] = useState([]);
  // Sub-filtro "Vencidas e confirmadas"/"Só vencidas"/"Só confirmadas",
  // visível só quando "Em aberto" está marcado em "Situação da cobrança"
  // (AJUSTE 15, correção pós-entrega — ver OPCOES_TIPO_PENDENCIA_SUB
  // acima). "todos" é o default (idêntico ao comportamento de produção
  // pra quem não mexer nessa opção). Aplicar-gated junto com `situacao`
  // (afeta `valor_inadimplente`, então precisa de nova chamada).
  const [tipoPendenciaInput, setTipoPendenciaInput] = useState("todos");
  // "Status do associado" consolida negociação/bloqueado/tipo de
  // inadimplente num único multi-select — cada chave marcada vira "sim" na
  // chamada à API (negociação/bloqueado), desmarcada vira "todos"; "Tipo de
  // inadimplente" vai direto como array pro parâmetro `tipo_inadimplente`
  // (ver `params` em carregarDados).
  const [statusInput, setStatusInput] = useState(STATUS_ASSOCIADO_VAZIO);

  const [vencDe, setVencDe] = useState("");
  const [vencAte, setVencAte] = useState("");
  const [filtroPeriodo, setFiltroPeriodo] = useState("vencimento");
  const [situacao, setSituacao] = useState([]);
  const [tipoPendencia, setTipoPendencia] = useState("todos");
  const [status, setStatus] = useState(STATUS_ASSOCIADO_VAZIO);

  // Toggle "Situação atual" x "Fechamento histórico do mês" (bloco
  // "Análise" — AJUSTE 15, item 4 do brief; nomes/posição novos do
  // controle que já existia como "Em aberto hoje"/"Histórico do período",
  // ver AJUSTE 6) — além do gráfico de faixas (uso original), também
  // controla os 3 cards do topo (`valor_inadimplente`/`valor_adimplente`/
  // taxa) — mesmo parâmetro `visao` do backend. Diferente dos filtros
  // acima, aplica na hora (não fica atrás do botão "Aplicar"): é um
  // controle de modo de exibição, não um filtro de consulta pesado como
  // vencimento/situação/status do associado.
  const [visao, setVisao] = useState("aberto");

  // "Faixa de atraso" (bloco "Faixa" — AJUSTE 15, item 5: virou múltipla
  // escolha) é só um destaque visual sobre o gráfico de faixas — a API
  // sempre devolve as 7 somas do período inteiro (não filtra por faixa),
  // então não há chamada nova aqui: aplica na hora, tanto pelos checkboxes
  // quanto clicando numa barra do gráfico. Array vazio = "Todas" (nenhum
  // destaque/esmaecimento).
  const [faixasSelecionadas, setFaixasSelecionadas] = useState([]);

  const [resumo, setResumo] = useState(null);
  const [loading, setLoading] = useState(true);
  const [erro, setErro] = useState("");
  const [chaveAsaasNaoConfigurada, setChaveAsaasNaoConfigurada] = useState(false);

  // Período de tolerância vigente (dias corridos, GET/PATCH em Configurações)
  // — só para exibir a nota abaixo dos cards; não muda com os filtros da
  // página, então basta buscar uma vez ao montar (não entra em carregarDados).
  const [toleranciaDias, setToleranciaDias] = useState(0);

  const [evolucaoMensal, setEvolucaoMensal] = useState([]);
  const [loadingEvolucao, setLoadingEvolucao] = useState(true);
  const [erroEvolucao, setErroEvolucao] = useState("");

  // Botão "Atualizar" (forcar=true) — estado separado de loading/loadingEvolucao
  // porque precisa de feedback próprio (spinner no botão + "Atualizado agora"
  // por alguns segundos), mesmo reaproveitando a mesma função carregarDados.
  const [atualizando, setAtualizando] = useState(false);
  const [atualizadoAgora, setAtualizadoAgora] = useState(false);

  // Busca /resumo e /evolucao-mensal juntos, com os MESMOS filtros — os dois
  // endpoints compartilham a mesma base de cálculo no backend (mesma
  // exclusão combinada, mesmos cross-references de renegociação/jurídico) e,
  // desde o AJUSTE 13 (reunião Suelen + Roberto, 08/09), também o mesmo
  // "visao" — é exatamente essa unificação que corrige o gráfico de
  // evolução mensal não bater com os cards do topo quando "Histórico do
  // período" está selecionado (o card e o ponto do gráfico pro mesmo mês
  // passam a usar o mesmo critério). Erros de "chave do Asaas não
  // configurada" só disparam o banner de /resumo (a seção inteira, incluindo
  // o gráfico de evolução, já fica escondida nesse caso — ver JSX abaixo),
  // então o erro equivalente vindo de /evolucao-mensal é silenciado para não
  // duplicar a mensagem.
  //
  // `forcar`: quando true, passa "forcar=true" pros dois endpoints — o
  // backend ignora o cache dessa chamada (sempre busca dados frescos do
  // Asaas), mas ainda grava o resultado novo no cache pras próximas. Usado
  // pelo botão "Atualizar" (ver handleAtualizar).
  //
  // AJUSTE 15: "Tipo de pendência" (AJUSTE 4) saiu como dropdown próprio
  // da barra de filtros — a lista de blocos do brief (Período/Situação/
  // Análise/Faixa/Tipo de inadimplente) não tinha um lugar pra ele, e a
  // nova "Situação da cobrança" cobre a distinção mais usada na prática
  // (em aberto x pagas). Correção pós-entrega (mesmo AJUSTE 15): a
  // granularidade vencida/confirmada voltou como sub-filtro condicional
  // dentro de "Em aberto" (`tipoPendencia` acima), reaproveitando o MESMO
  // parâmetro `tipo_pendencia` do backend, sem nenhuma mudança lá — ver
  // OPCOES_TIPO_PENDENCIA_SUB. "em_juridico" (tri-state antigo) saiu da
  // chamada e não voltou: foi substituído de vez por `tipoInadimplente`
  // abaixo, que cobre o mesmo caso (e mais) via `tipo_inadimplente`.
  const carregarDados = useCallback(
    async (forcar = false) => {
      setLoading(true);
      setLoadingEvolucao(true);
      setErro("");
      setErroEvolucao("");
      setChaveAsaasNaoConfigurada(false);

      const params = {
        vencDe: vencDe || undefined,
        vencAte: vencAte || undefined,
        filtroPeriodo,
        situacao,
        // Sub-filtro de "Em aberto" (AJUSTE 15, correção pós-entrega) — só
        // faz sentido mandar `tipo_pendencia` quando "Em aberto" está de
        // fato entre as situações filtradas; fora disso o parâmetro não
        // teria nenhum efeito mesmo (ver STATUS_INADIMPLENTE_POR_TIPO_PENDENCIA
        // no backend — só se aplica dentro do subconjunto "em aberto"), e
        // omiti-lo mantém `tipoPendencia` sempre "todos" no backend, o
        // mesmo default de sempre.
        tipoPendencia: situacao.includes("em_aberto") ? tipoPendencia : undefined,
        renegociacao: status.emNegociacao ? "sim" : "todos",
        bloqueado: status.bloqueado ? "sim" : "todos",
        tipoInadimplente: status.tipoInadimplente,
        visao,
        forcar,
      };

      const resumoPromise = getResumoInadimplencia(params)
        .then((data) => setResumo(data))
        .catch((err) => {
          if (err instanceof ApiError && err.status === 400 && /asaas-key/i.test(err.message)) {
            setChaveAsaasNaoConfigurada(true);
          } else {
            setErro(err instanceof ApiError ? err.message : "Erro ao consultar a taxa de inadimplência.");
          }
        })
        .finally(() => setLoading(false));

      const evolucaoPromise = getEvolucaoMensal(params)
        .then((data) => setEvolucaoMensal(Array.isArray(data) ? data : []))
        .catch((err) => {
          const eChaveAusente = err instanceof ApiError && err.status === 400 && /asaas-key/i.test(err.message);
          if (!eChaveAusente) {
            setErroEvolucao(err instanceof ApiError ? err.message : "Erro ao consultar a evolução mensal.");
          }
        })
        .finally(() => setLoadingEvolucao(false));

      await Promise.all([resumoPromise, evolucaoPromise]);
    },
    [vencDe, vencAte, filtroPeriodo, situacao, tipoPendencia, status, visao]
  );

  useEffect(() => {
    carregarDados();
  }, [carregarDados]);

  useEffect(() => {
    getToleranciaDias()
      .then((data) => setToleranciaDias(data?.dias || 0))
      .catch(() => {
        // Discreto o suficiente pra não valer um ErrorBanner próprio — na
        // pior das hipóteses a nota de tolerância simplesmente não aparece.
      });
  }, []);

  async function handleAtualizar() {
    setAtualizando(true);
    setAtualizadoAgora(false);
    await carregarDados(true);
    setAtualizando(false);
    setAtualizadoAgora(true);
    setTimeout(() => setAtualizadoAgora(false), 4000);
  }

  // "Em aberto" desmarcado (ou "Todas" escolhida, que limpa a seleção
  // inteira) esconde o sub-filtro na UI — junto, reseta o valor dele pro
  // default, pra não guardar escondida uma escolha que o usuário não vê
  // mais (AJUSTE 15, correção pós-entrega).
  function handleSituacaoInputChange(novaSelecao) {
    setSituacaoInput(novaSelecao);
    if (!novaSelecao.includes("em_aberto")) {
      setTipoPendenciaInput("todos");
    }
  }

  function handleAplicar() {
    setVencDe(vencDeInput);
    setVencAte(vencAteInput);
    setFiltroPeriodo(filtroPeriodoInput);
    setSituacao(situacaoInput);
    setTipoPendencia(tipoPendenciaInput);
    setStatus(statusInput);
  }

  function handleLimpar() {
    setVencDeInput("");
    setVencAteInput("");
    setFiltroPeriodoInput("vencimento");
    setSituacaoInput([]);
    setTipoPendenciaInput("todos");
    setStatusInput(STATUS_ASSOCIADO_VAZIO);
    setFaixasSelecionadas([]);
    setVencDe("");
    setVencAte("");
    setFiltroPeriodo("vencimento");
    setSituacao([]);
    setTipoPendencia("todos");
    setStatus(STATUS_ASSOCIADO_VAZIO);
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">Taxa de Inadimplência</h2>
          <p className="text-sm text-muted-foreground">
            Calculada em tempo real a partir dos pagamentos registrados no Asaas.
          </p>
        </div>

        {!chaveAsaasNaoConfigurada && (
          <div className="flex items-center gap-3">
            {atualizadoAgora && (
              <span className="flex items-center gap-1.5 text-xs font-medium text-status-green">
                <IconCheck className="h-3.5 w-3.5" />
                Atualizado agora
              </span>
            )}
            <button
              type="button"
              onClick={handleAtualizar}
              disabled={atualizando || loading}
              className="flex shrink-0 items-center gap-2 rounded-xl border border-border-soft bg-surface px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-60"
            >
              {atualizando ? <Spinner className="h-3.5 w-3.5" /> : <IconRefresh className="h-3.5 w-3.5" />}
              Atualizar
            </button>
          </div>
        )}
      </div>

      {chaveAsaasNaoConfigurada ? (
        <div className="rounded-2xl border border-status-yellow/40 bg-status-yellow/10 p-6 text-center">
          <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full bg-status-yellow/20 text-status-yellow">
            <IconKey className="h-5 w-5" />
          </span>
          <p className="mt-3 text-sm font-semibold text-foreground">Chave de API do Asaas não configurada.</p>
          <p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">
            Para calcular a taxa de inadimplência, primeiro configure a chave de API do Asaas na tela de
            Configurações.
          </p>
          <Link
            href="/configuracoes"
            className="mt-4 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            Ir para Configurações
          </Link>
        </div>
      ) : (
        <>
          {/* Filtros — reorganizados em blocos/seções (AJUSTE 15): Período,
              Situação, Análise, Faixa, Tipo de inadimplente. */}
          <div className="rounded-2xl border border-border-soft bg-surface p-4 shadow-lg shadow-black/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-5">
              <BlocoFiltro titulo="Período">
                <div className="space-y-2">
                  <div className="grid grid-cols-2 gap-2">
                    <Campo label="De">
                      <DatePicker value={vencDeInput} onChange={setVencDeInput} placeholder="Últimos 12 meses" />
                    </Campo>
                    <Campo label="Até">
                      <DatePicker value={vencAteInput} onChange={setVencAteInput} placeholder="Hoje" />
                    </Campo>
                  </div>
                  <Campo label="Filtrar período por">
                    <select
                      className={INPUT}
                      value={filtroPeriodoInput}
                      onChange={(e) => setFiltroPeriodoInput(e.target.value)}
                    >
                      {OPCOES_FILTRO_PERIODO.map((o) => (
                        <option key={o.valor} value={o.valor}>
                          {o.label}
                        </option>
                      ))}
                    </select>
                  </Campo>
                </div>
              </BlocoFiltro>

              <BlocoFiltro titulo="Situação">
                <Campo label="Situação da cobrança">
                  <MultiCheckboxFilter
                    labelTodas="Todas"
                    opcoes={OPCOES_SITUACAO}
                    value={situacaoInput}
                    onChange={handleSituacaoInputChange}
                    subGrupo={{
                      paraValor: "em_aberto",
                      opcoes: OPCOES_TIPO_PENDENCIA_SUB,
                      value: tipoPendenciaInput,
                      onChange: setTipoPendenciaInput,
                    }}
                  />
                </Campo>
              </BlocoFiltro>

              <BlocoFiltro titulo="Análise">
                <Campo label="Tipo de análise">
                  <ToggleDuasOpcoes
                    opcoes={[
                      { valor: "aberto", label: "Situação atual" },
                      { valor: "historico", label: "Fechamento histórico do mês" },
                    ]}
                    value={visao}
                    onChange={setVisao}
                  />
                </Campo>
              </BlocoFiltro>

              <BlocoFiltro titulo="Faixa">
                <Campo label="Faixa de atraso">
                  <MultiCheckboxFilter
                    labelTodas="Todas"
                    opcoes={OPCOES_FAIXA}
                    value={faixasSelecionadas}
                    onChange={setFaixasSelecionadas}
                  />
                </Campo>
              </BlocoFiltro>

              <BlocoFiltro titulo="Tipo de inadimplente" className="sm:col-span-2 xl:col-span-1">
                <Campo label="Status do associado">
                  <StatusAssociadoFilter value={statusInput} onChange={setStatusInput} />
                </Campo>
              </BlocoFiltro>
            </div>

            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                onClick={handleAplicar}
                disabled={loading}
                className="flex items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
              >
                {loading && <Spinner className="h-3.5 w-3.5" />}
                Aplicar
              </button>
              <button
                type="button"
                onClick={handleLimpar}
                disabled={loading}
                className="rounded-xl border border-border-soft px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
              >
                Limpar
              </button>
            </div>

            {loading && (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="h-3 w-3" />
                Consultando a API do Asaas — isso pode levar alguns segundos.
              </p>
            )}
          </div>

          {erro && <ErrorBanner message={erro} onRetry={carregarDados} />}

          <ResumoInadimplenciaCards resumo={resumo} loading={loading} visao={visao} />

          {!loading && resumo?.excluidos?.quantidade > 0 && (
            <p className="-mt-2 text-xs text-muted-foreground">
              {resumo.excluidos.quantidade}{" "}
              {resumo.excluidos.quantidade === 1 ? "cobrança excluída" : "cobranças excluídas"} (
              {formatCurrency(resumo.excluidos.valor)}) desta análise — ver{" "}
              <span className="text-foreground">&ldquo;Gerenciar exclusões do cálculo&rdquo;</span> abaixo.
            </p>
          )}

          {!loading && toleranciaDias > 0 && (
            <p className="-mt-2 text-xs text-muted-foreground">
              Tolerância de {toleranciaDias} {toleranciaDias === 1 ? "dia aplicada" : "dias aplicada"} nesta análise —
              ajuste em{" "}
              <Link href="/configuracoes" className="text-foreground hover:underline">
                Configurações
              </Link>
              .
            </p>
          )}

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
            <FaixasChart
              faixas={resumo?.faixas}
              faixasSelecionadas={faixasSelecionadas}
              onSelecionarFaixa={setFaixasSelecionadas}
              loading={loading}
              // CORREÇÃO: o percentual de cada faixa deve ser sobre o valor
              // total faturado do período, não sobre o valor inadimplente
              // (senão uma faixa isolada pode dar >100% — ver FaixasChart.js).
              totalFaturado={resumo?.valor_total_faturado}
              visao={visao}
            />
            <TopDevedores devedores={resumo?.top_devedores} loading={loading} />
          </div>

          <EvolucaoMensalChart dados={evolucaoMensal} loading={loadingEvolucao} erro={erroEvolucao} visao={visao} />

          <ExclusoesPanel onAlterado={carregarDados} />
        </>
      )}
    </div>
  );
}
