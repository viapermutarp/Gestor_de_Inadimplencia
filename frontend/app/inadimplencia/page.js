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
import { IconKey, IconRefresh, IconCheck } from "@/components/icons";

const OPCOES_FAIXA = [
  { value: "todas", label: "Todas" },
  { value: "ate_vencimento", label: "Até o vencimento" },
  { value: "1_20", label: "1-20 dias" },
  { value: "21_30", label: "21-30 dias" },
  { value: "31_40", label: "31-40 dias" },
  { value: "41_50", label: "41-50 dias" },
  { value: "51_100", label: "51-100 dias" },
  { value: "acima_100", label: "100+ dias" },
];

// Opções do filtro "Tipo de pendência" (AJUSTE 4) — separa, dentro de
// "Valor inadimplente", as cobranças vencidas (status OVERDUE no Asaas) das
// confirmadas/crédito futuro (status CONFIRMED, dinheiro ainda não caiu na
// conta). Igual aos demais filtros "pesados" da tela (período, status do
// associado), só aplica de fato depois do botão "Aplicar".
const OPCOES_TIPO_PENDENCIA = [
  { value: "todos", label: "Todas" },
  { value: "vencidas", label: "Só vencidas" },
  { value: "confirmadas", label: "Só confirmadas" },
];

const STATUS_ASSOCIADO_VAZIO = { emNegociacao: false, bloqueado: false, emJuridico: false };

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

export default function InadimplenciaPage() {
  // Filtros que disparam uma nova chamada à API (só mudam de fato depois de
  // "Aplicar" — cada troca chama o Asaas de novo, que pode demorar alguns
  // segundos, então não faz sentido buscar a cada tecla/seleção).
  const [vencDeInput, setVencDeInput] = useState("");
  const [vencAteInput, setVencAteInput] = useState("");
  // "Status do associado" consolida os três filtros (renegociação/bloqueado/
  // jurídico) num único multi-select — cada chave marcada vira "sim" na
  // chamada à API, desmarcada vira "todos" (ver `params` em carregarDados).
  const [statusInput, setStatusInput] = useState(STATUS_ASSOCIADO_VAZIO);
  // "Tipo de pendência" (AJUSTE 4) — mesmo padrão dos filtros acima: só
  // aplica de fato depois de "Aplicar" (afeta valor_inadimplente, então
  // dispara nova chamada ao Asaas).
  const [tipoPendenciaInput, setTipoPendenciaInput] = useState("todos");

  const [vencDe, setVencDe] = useState("");
  const [vencAte, setVencAte] = useState("");
  const [status, setStatus] = useState(STATUS_ASSOCIADO_VAZIO);
  const [tipoPendencia, setTipoPendencia] = useState("todos");

  // Toggle "Em aberto hoje" x "Histórico do período" do card de faixas —
  // diferente dos demais filtros, aplica na hora (não fica atrás do botão
  // "Aplicar"): é um controle do próprio card, não um filtro de consulta
  // pesado como vencimento/status do associado.
  const [visaoFaixas, setVisaoFaixas] = useState("aberto");

  // "Faixa de atraso" é só um destaque visual sobre o gráfico de faixas — a
  // API sempre devolve as 6 somas do período inteiro (não filtra por
  // faixa), então não há chamada nova aqui: aplica na hora, tanto pelo
  // dropdown quanto clicando numa barra do gráfico.
  const [faixaSelecionada, setFaixaSelecionada] = useState("todas");

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

  // Busca /resumo e /evolucao-mensal juntos, com os mesmos filtros — os dois
  // endpoints compartilham a mesma base de cálculo no backend (mesma
  // exclusão combinada, mesmos cross-references de renegociação/jurídico).
  // Erros de "chave do Asaas não configurada" só disparam o banner de
  // /resumo (a seção inteira, incluindo o gráfico de evolução, já fica
  // escondida nesse caso — ver JSX abaixo), então o erro equivalente vindo
  // de /evolucao-mensal é silenciado para não duplicar a mensagem.
  //
  // `forcar`: quando true, passa "forcar=true" pros dois endpoints — o
  // backend ignora o cache dessa chamada (sempre busca dados frescos do
  // Asaas), mas ainda grava o resultado novo no cache pras próximas. Usado
  // pelo botão "Atualizar" (ver handleAtualizar).
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
        renegociacao: status.emNegociacao ? "sim" : "todos",
        emJuridico: status.emJuridico ? "sim" : "todos",
        bloqueado: status.bloqueado ? "sim" : "todos",
        tipoPendencia,
        forcar,
      };

      const resumoPromise = getResumoInadimplencia({ ...params, visaoFaixas })
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
    [vencDe, vencAte, status, tipoPendencia, visaoFaixas]
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

  function handleAplicar() {
    setVencDe(vencDeInput);
    setVencAte(vencAteInput);
    setStatus(statusInput);
    setTipoPendencia(tipoPendenciaInput);
  }

  function handleLimpar() {
    setVencDeInput("");
    setVencAteInput("");
    setStatusInput(STATUS_ASSOCIADO_VAZIO);
    setTipoPendenciaInput("todos");
    setFaixaSelecionada("todas");
    setVencDe("");
    setVencAte("");
    setStatus(STATUS_ASSOCIADO_VAZIO);
    setTipoPendencia("todos");
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
          {/* Filtros */}
          <div className="rounded-2xl border border-border-soft bg-surface p-4 shadow-lg shadow-black/20">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
              <Campo label="Vencimento de">
                <DatePicker value={vencDeInput} onChange={setVencDeInput} placeholder="Últimos 12 meses" />
              </Campo>
              <Campo label="Vencimento até">
                <DatePicker value={vencAteInput} onChange={setVencAteInput} placeholder="Hoje" />
              </Campo>
              <Campo label="Faixa de atraso">
                <select
                  className={INPUT}
                  value={faixaSelecionada}
                  onChange={(e) => setFaixaSelecionada(e.target.value)}
                >
                  {OPCOES_FAIXA.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Campo>
              <Campo label="Status do associado">
                <StatusAssociadoFilter value={statusInput} onChange={setStatusInput} />
              </Campo>
              <Campo label="Tipo de pendência">
                <select
                  className={INPUT}
                  value={tipoPendenciaInput}
                  onChange={(e) => setTipoPendenciaInput(e.target.value)}
                >
                  {OPCOES_TIPO_PENDENCIA.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </Campo>
              <div className="flex items-end gap-2">
                <button
                  type="button"
                  onClick={handleAplicar}
                  disabled={loading}
                  className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
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
            </div>

            {loading && (
              <p className="mt-3 flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner className="h-3 w-3" />
                Consultando a API do Asaas — isso pode levar alguns segundos.
              </p>
            )}
          </div>

          {erro && <ErrorBanner message={erro} onRetry={carregarDados} />}

          <ResumoInadimplenciaCards resumo={resumo} loading={loading} />

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
              faixaSelecionada={faixaSelecionada}
              onSelecionarFaixa={setFaixaSelecionada}
              loading={loading}
              totalInadimplente={resumo?.valor_inadimplente}
              visaoFaixas={visaoFaixas}
              onAlterarVisaoFaixas={setVisaoFaixas}
            />
            <TopDevedores devedores={resumo?.top_devedores} loading={loading} />
          </div>

          <EvolucaoMensalChart dados={evolucaoMensal} loading={loadingEvolucao} erro={erroEvolucao} />

          <ExclusoesPanel onAlterado={carregarDados} />
        </>
      )}
    </div>
  );
}
