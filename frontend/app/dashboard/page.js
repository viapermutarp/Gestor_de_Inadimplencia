"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getAssociados,
  getResumo,
  patchNegociacao,
  patchBloqueio,
  patchJuridico,
  dispararSincronizacao,
  ApiError,
} from "@/lib/api";
import { getPiorDiasDiferenca, getSomaValorAberto, getStatusAtraso, STATUS_COLOR_CLASSES } from "@/lib/atraso";
import { getIndicadorSemContato } from "@/lib/contato";
import { formatCurrency } from "@/lib/format";
import NegociacaoToggle from "@/components/NegociacaoToggle";
import StatusAtrasoBadge from "@/components/StatusAtrasoBadge";
import SemContatoIndicador from "@/components/SemContatoIndicador";
import PaginacaoControles from "@/components/PaginacaoControles";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import AssociadoDetalheModal from "@/components/AssociadoDetalheModal";
import ResumoCards from "@/components/ResumoCards";
import { IconSearch, IconRefresh, IconCheck, IconAlert } from "@/components/icons";

const LIMITE_POR_PAGINA = 100;
const PAGINACAO_PADRAO = {
  pagina_atual: 1,
  total_paginas: 1,
  total_registros: 0,
  por_pagina: LIMITE_POR_PAGINA,
};

// Atalhos de filtro. Cada um mapeia para o parâmetro correspondente aceito
// por GET /api/associados (ver lib/api.js) — "todos" não envia filtro nenhum.
const FILTROS = [
  { value: "todos", label: "Todos", apiParam: null },
  { value: "em_negociacao", label: "Em Negociação", apiParam: "emNegociacao" },
  { value: "bloqueados", label: "Bloqueados", apiParam: "bloqueado" },
  { value: "juridico", label: "Jurídico", apiParam: "emJuridico" },
];

export default function DashboardPage() {
  // Página atual da tabela (server-side: filtro + busca + paginação vão
  // todos na chamada à API, que já retorna a fatia pedida, já ordenada pelo
  // atraso mais crítico primeiro — não há mais ordenação no cliente).
  const [associados, setAssociados] = useState([]);
  const [paginacao, setPaginacao] = useState(PAGINACAO_PADRAO);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [filtro, setFiltro] = useState("todos");
  const [buscaInput, setBuscaInput] = useState("");
  const [busca, setBusca] = useState("");

  const [togglingNegociacaoCpf, setTogglingNegociacaoCpf] = useState(null);
  const [togglingBloqueioCpf, setTogglingBloqueioCpf] = useState(null);
  const [togglingJuridicoCpf, setTogglingJuridicoCpf] = useState(null);
  const [selectedCpfCnpj, setSelectedCpfCnpj] = useState(null);

  // Números agregados dos cards de resumo, vindos direto de
  // GET /api/associados/resumo (uma única chamada, calculada no banco) —
  // sempre a carteira inteira, independente do filtro/busca/página ativos
  // na tabela.
  const [resumo, setResumo] = useState(null);
  const [resumoLoading, setResumoLoading] = useState(true);

  // Botão "Atualizar" — re-busca a página atual da tabela + os cards de
  // resumo sem precisar de F5. Estado próprio (separado de loading/
  // resumoLoading) só para dar feedback visual no botão (spinner enquanto
  // roda, "Atualizado agora" por alguns segundos depois) — mesmo padrão já
  // usado na tela de Taxa de Inadimplência.
  const [atualizando, setAtualizando] = useState(false);
  const [atualizadoAgora, setAtualizadoAgora] = useState(false);
  // Mensagem de aviso quando o webhook de sincronização (n8n -> Asaas)
  // falha ou dá timeout — não impede a re-busca normal em seguida, só avisa
  // que os dados podem não estar 100% frescos desta vez.
  const [erroSincronizacao, setErroSincronizacao] = useState("");

  // Busca com debounce (evita uma chamada à API a cada tecla) — troca de
  // busca sempre volta a tabela para a página 1.
  useEffect(() => {
    const t = setTimeout(() => {
      setBusca(buscaInput.trim());
      setPage(1);
    }, 350);
    return () => clearTimeout(t);
  }, [buscaInput]);

  function handleFiltroChange(valor) {
    setFiltro(valor);
    setPage(1);
  }

  const carregarPagina = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const filtroAtivo = FILTROS.find((f) => f.value === filtro);
      const params = { page, limit: LIMITE_POR_PAGINA };
      if (busca) params.busca = busca;
      if (filtroAtivo?.apiParam) params[filtroAtivo.apiParam] = true;

      const data = await getAssociados(params);
      setAssociados(Array.isArray(data?.dados) ? data.dados : []);
      setPaginacao(data?.paginacao ?? PAGINACAO_PADRAO);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao carregar associados.");
    } finally {
      setLoading(false);
    }
  }, [filtro, busca, page]);

  useEffect(() => {
    carregarPagina();
  }, [carregarPagina]);

  // Carrega os cards de resumo com uma única chamada a GET /api/associados/resumo
  // (números agregados no banco, sem trazer os registros individuais).
  const carregarResumo = useCallback(async () => {
    setResumoLoading(true);
    try {
      const data = await getResumo();
      setResumo(data);
    } catch {
      // Falha ao montar o resumo não deve travar a tabela — o erro principal
      // já é reportado por `carregarPagina`.
    } finally {
      setResumoLoading(false);
    }
  }, []);

  useEffect(() => {
    carregarResumo();
  }, [carregarResumo]);

  // 1. Dispara o webhook do n8n (sincroniza com o Asaas e já deixa nosso
  //    banco atualizado quando responde). 2. Só depois de essa chamada
  //    retornar (sucesso ou falha) é que re-busca tabela + cards — assim, se
  //    a sincronização deu certo, a re-busca já reflete os dados novos.
  //    3. Se o webhook falhar/der timeout, mostra um aviso mas ainda assim
  //    faz a re-busca normal (não trava o botão) — os dados locais podem já
  //    estar atualizados de uma sincronização anterior.
  async function handleAtualizar() {
    setAtualizando(true);
    setAtualizadoAgora(false);
    setErroSincronizacao("");

    let sincronizacaoOk = true;
    try {
      await dispararSincronizacao();
    } catch (err) {
      sincronizacaoOk = false;
      setErroSincronizacao(
        err instanceof ApiError ? err.message : "Não foi possível sincronizar com o Asaas."
      );
    }

    await Promise.all([carregarPagina(), carregarResumo()]);
    setAtualizando(false);

    if (sincronizacaoOk) {
      setAtualizadoAgora(true);
      setTimeout(() => setAtualizadoAgora(false), 4000);
    }
  }

  /**
   * Atualiza um campo booleano do associado localmente na tabela, com
   * rollback em caso de erro. Também ajusta o contador correspondente nos
   * cards de resumo (+1/-1) de forma otimista — evita ter que re-buscar o
   * resumo inteiro a cada toggle, já que o efeito sobre o agregado é sempre
   * previsível (só o contador daquele campo muda, em exatamente 1).
   */
  function criarHandlerToggle({ campo, resumoCampo, setToggling, chamarApi, mensagemErro }) {
    return async (associado, novoValor) => {
      setToggling(associado.cpf_cnpj);
      const anterior = associado[campo];

      const aplicarAssociados = (valor) => (a) =>
        a.cpf_cnpj === associado.cpf_cnpj ? { ...a, [campo]: valor } : a;
      const ajustarResumo = (valorTransicao) => (prev) =>
        prev ? { ...prev, [resumoCampo]: prev[resumoCampo] + (valorTransicao ? 1 : -1) } : prev;

      setAssociados((prev) => prev.map(aplicarAssociados(novoValor)));
      setResumo(ajustarResumo(novoValor));

      try {
        await chamarApi(associado, novoValor);
      } catch (err) {
        setAssociados((prev) => prev.map(aplicarAssociados(anterior)));
        setResumo(ajustarResumo(anterior));
        setError(err instanceof ApiError ? err.message : mensagemErro);
      } finally {
        setToggling(null);
      }
    };
  }

  const handleToggleNegociacao = criarHandlerToggle({
    campo: "em_negociacao",
    resumoCampo: "em_negociacao",
    setToggling: setTogglingNegociacaoCpf,
    chamarApi: (associado, novoValor) =>
      patchNegociacao(associado.cpf_cnpj, {
        em_negociacao: novoValor,
        observacao: associado.observacao ?? undefined,
      }),
    mensagemErro: "Não foi possível atualizar a negociação.",
  });

  const handleToggleBloqueio = criarHandlerToggle({
    campo: "bloqueado",
    resumoCampo: "bloqueados",
    setToggling: setTogglingBloqueioCpf,
    chamarApi: (associado, novoValor) => patchBloqueio(associado.cpf_cnpj, { bloqueado: novoValor }),
    mensagemErro: "Não foi possível atualizar o bloqueio.",
  });

  const handleToggleJuridico = criarHandlerToggle({
    campo: "em_juridico",
    resumoCampo: "em_juridico",
    setToggling: setTogglingJuridicoCpf,
    chamarApi: (associado, novoValor) => patchJuridico(associado.cpf_cnpj, { em_juridico: novoValor }),
    mensagemErro: "Não foi possível atualizar o status jurídico.",
  });

  // O modal de detalhe também pode mudar `em_negociacao` (junto com a
  // observação) via "Salvar alterações" — se mudar, ajusta o card
  // correspondente do mesmo jeito que os toggles da tabela.
  function handleAssociadoAtualizado(atualizado) {
    const anterior = associados.find((a) => a.cpf_cnpj === atualizado.cpf_cnpj);

    setAssociados((prev) =>
      prev.map((a) => (a.cpf_cnpj === atualizado.cpf_cnpj ? { ...a, ...atualizado } : a))
    );

    if (anterior && Boolean(anterior.em_negociacao) !== Boolean(atualizado.em_negociacao)) {
      const delta = atualizado.em_negociacao ? 1 : -1;
      setResumo((prev) => (prev ? { ...prev, em_negociacao: prev.em_negociacao + delta } : prev));
    }
  }

  return (
    <div className="space-y-6">
      <ResumoCards resumo={resumo} loading={resumoLoading} />

      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full sm:max-w-xs">
          <IconSearch className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
          <input
            type="text"
            value={buscaInput}
            onChange={(e) => setBuscaInput(e.target.value)}
            placeholder="Buscar por nome, CPF/CNPJ ou telefone"
            className="w-full rounded-xl border border-border-soft bg-surface px-10 py-2.5 text-sm text-foreground placeholder:text-muted/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex flex-wrap rounded-xl border border-border-soft bg-surface p-1 text-sm">
            {FILTROS.map((f) => (
              <button
                key={f.value}
                type="button"
                onClick={() => handleFiltroChange(f.value)}
                className={`rounded-lg px-3.5 py-1.5 font-medium transition-colors ${
                  filtro === f.value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {atualizadoAgora && (
            <span className="flex items-center gap-1.5 text-xs font-medium text-status-green">
              <IconCheck className="h-3.5 w-3.5" />
              Atualizado agora
            </span>
          )}
          {erroSincronizacao && (
            <span
              className="flex items-center gap-1.5 text-xs font-medium text-status-yellow"
              title={erroSincronizacao}
            >
              <IconAlert className="h-3.5 w-3.5" />
              Sincronização falhou, exibindo últimos dados
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
      </div>

      {error && <ErrorBanner message={error} onRetry={carregarPagina} />}

      <div className="overflow-hidden rounded-2xl border border-border-soft bg-surface shadow-lg shadow-black/20">
        <div className="scrollbar-thin overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead>
              <tr className="border-b border-border-soft text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-5 py-3.5 font-semibold">Nome</th>
                <th className="px-5 py-3.5 font-semibold">CPF/CNPJ</th>
                <th className="px-5 py-3.5 font-semibold">Telefone</th>
                <th className="px-5 py-3.5 font-semibold">Atraso</th>
                <th className="px-5 py-3.5 font-semibold">Valor em aberto</th>
                <th className="px-5 py-3.5 text-center font-semibold">Em negociação</th>
                <th className="px-5 py-3.5 text-center font-semibold">Bloqueado</th>
                <th className="px-5 py-3.5 text-center font-semibold">Jurídico</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center">
                    <Spinner className="mx-auto h-6 w-6" />
                  </td>
                </tr>
              ) : associados.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-5 py-12 text-center text-muted-foreground">
                    Nenhum associado encontrado.
                  </td>
                </tr>
              ) : (
                associados.map((associado) => {
                  const piorDias = getPiorDiasDiferenca(associado);
                  const status = getStatusAtraso(piorDias);
                  const somaAberto = getSomaValorAberto(associado);
                  const classesStatus = STATUS_COLOR_CLASSES[status.color];
                  const indicadorSemContato = getIndicadorSemContato(associado);

                  return (
                    <tr
                      key={associado.cpf_cnpj}
                      onClick={() => setSelectedCpfCnpj(associado.cpf_cnpj)}
                      className={`cursor-pointer border-b border-border-soft/60 transition-colors last:border-0 ${classesStatus.row}`}
                    >
                      <td
                        className={`px-5 py-3.5 font-medium text-foreground ${classesStatus.rail}`}
                      >
                        <div className="flex items-center gap-2">
                          <span>{associado.nome}</span>
                          {indicadorSemContato && (
                            <SemContatoIndicador tooltip={indicadorSemContato.tooltip} />
                          )}
                        </div>
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">
                        {associado.cpf_cnpj}
                      </td>
                      <td className="px-5 py-3.5 font-mono text-xs text-muted-foreground">
                        {associado.telefone}
                      </td>
                      <td className="px-5 py-3.5">
                        <StatusAtrasoBadge status={status} />
                      </td>
                      <td className="px-5 py-3.5 font-mono font-normal text-foreground">
                        {formatCurrency(somaAberto)}
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex justify-center">
                          <NegociacaoToggle
                            checked={Boolean(associado.em_negociacao)}
                            loading={togglingNegociacaoCpf === associado.cpf_cnpj}
                            onChange={(novoValor) => handleToggleNegociacao(associado, novoValor)}
                            labelOn="Em negociação"
                            labelOff="Não em negociação"
                          />
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex justify-center">
                          <NegociacaoToggle
                            checked={Boolean(associado.bloqueado)}
                            loading={togglingBloqueioCpf === associado.cpf_cnpj}
                            onChange={(novoValor) => handleToggleBloqueio(associado, novoValor)}
                            labelOn="Bloqueado"
                            labelOff="Não bloqueado"
                          />
                        </div>
                      </td>
                      <td className="px-5 py-3.5">
                        <div className="flex justify-center">
                          <NegociacaoToggle
                            checked={Boolean(associado.em_juridico)}
                            loading={togglingJuridicoCpf === associado.cpf_cnpj}
                            onChange={(novoValor) => handleToggleJuridico(associado, novoValor)}
                            labelOn="Em jurídico"
                            labelOff="Fora do jurídico"
                          />
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        <PaginacaoControles paginacao={paginacao} onChangePage={setPage} disabled={loading} />
      </div>

      {selectedCpfCnpj && (
        <AssociadoDetalheModal
          cpfCnpj={selectedCpfCnpj}
          onClose={() => setSelectedCpfCnpj(null)}
          onAtualizado={handleAssociadoAtualizado}
        />
      )}
    </div>
  );
}
