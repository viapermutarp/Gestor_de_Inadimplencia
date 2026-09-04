"use client";

import { useCallback, useEffect, useState } from "react";
import {
  getPalavrasExcluidas,
  atualizarPalavrasExcluidas,
  getExclusoes,
  criarExclusao,
  removerExclusao,
  ApiError,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconTag, IconChevronDown, IconClose } from "@/components/icons";

const INPUT =
  "w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Seção expansível/colapsável da tela de Taxa de Inadimplência para
 * gerenciar os dois mecanismos de exclusão de cobranças do cálculo (ver
 * backend: AJUSTE 1) — palavras-chave (exclusão automática por descrição,
 * CPF/CNPJ ou nome/razão social do associado — AJUSTE 7) e a lista manual
 * por ID de cobrança. Carrega os dados só na primeira vez
 * que é aberta (evita 2 chamadas extras à API em toda visita à página,
 * já que a maioria dos usuários provavelmente nunca abre este painel).
 *
 * `onAlterado` é chamado depois de qualquer mutação bem-sucedida (adicionar
 * palavra, remover palavra, adicionar exclusão, remover exclusão) — o
 * backend limpa o próprio cache do /resumo e /evolucao-mensal nesses casos,
 * então a página pai deve recarregar os dados principais para refletir a
 * mudança imediatamente (ver app/inadimplencia/page.js).
 */
export default function ExclusoesPanel({ onAlterado }) {
  const [aberto, setAberto] = useState(false);
  const [carregouUmaVez, setCarregouUmaVez] = useState(false);

  const [palavras, setPalavras] = useState([]);
  const [carregandoPalavras, setCarregandoPalavras] = useState(false);
  const [erroPalavras, setErroPalavras] = useState("");
  const [novaPalavra, setNovaPalavra] = useState("");
  const [salvandoPalavra, setSalvandoPalavra] = useState(false);

  const [exclusoes, setExclusoes] = useState([]);
  const [carregandoExclusoes, setCarregandoExclusoes] = useState(false);
  const [erroExclusoes, setErroExclusoes] = useState("");
  const [novoId, setNovoId] = useState("");
  const [novoMotivo, setNovoMotivo] = useState("");
  const [salvandoExclusao, setSalvandoExclusao] = useState(false);
  const [removendoId, setRemovendoId] = useState(null);

  const carregarPalavras = useCallback(async () => {
    setCarregandoPalavras(true);
    setErroPalavras("");
    try {
      const data = await getPalavrasExcluidas();
      setPalavras(Array.isArray(data?.palavras) ? data.palavras : []);
    } catch (err) {
      setErroPalavras(err instanceof ApiError ? err.message : "Erro ao carregar as palavras-chave excluídas.");
    } finally {
      setCarregandoPalavras(false);
    }
  }, []);

  const carregarExclusoes = useCallback(async () => {
    setCarregandoExclusoes(true);
    setErroExclusoes("");
    try {
      const data = await getExclusoes();
      setExclusoes(Array.isArray(data) ? data : []);
    } catch (err) {
      setErroExclusoes(err instanceof ApiError ? err.message : "Erro ao carregar as exclusões manuais.");
    } finally {
      setCarregandoExclusoes(false);
    }
  }, []);

  useEffect(() => {
    if (aberto && !carregouUmaVez) {
      setCarregouUmaVez(true);
      carregarPalavras();
      carregarExclusoes();
    }
  }, [aberto, carregouUmaVez, carregarPalavras, carregarExclusoes]);

  async function handleAdicionarPalavra(e) {
    e.preventDefault();
    const palavra = novaPalavra.trim();
    if (!palavra || palavras.includes(palavra)) return;

    setSalvandoPalavra(true);
    setErroPalavras("");
    try {
      const data = await atualizarPalavrasExcluidas([...palavras, palavra]);
      setPalavras(Array.isArray(data?.palavras) ? data.palavras : []);
      setNovaPalavra("");
      onAlterado?.();
    } catch (err) {
      setErroPalavras(err instanceof ApiError ? err.message : "Não foi possível adicionar a palavra.");
    } finally {
      setSalvandoPalavra(false);
    }
  }

  async function handleRemoverPalavra(palavra) {
    setSalvandoPalavra(true);
    setErroPalavras("");
    try {
      const data = await atualizarPalavrasExcluidas(palavras.filter((p) => p !== palavra));
      setPalavras(Array.isArray(data?.palavras) ? data.palavras : []);
      onAlterado?.();
    } catch (err) {
      setErroPalavras(err instanceof ApiError ? err.message : "Não foi possível remover a palavra.");
    } finally {
      setSalvandoPalavra(false);
    }
  }

  async function handleAdicionarExclusao(e) {
    e.preventDefault();
    const asaasPaymentId = novoId.trim();
    if (!asaasPaymentId) return;

    setSalvandoExclusao(true);
    setErroExclusoes("");
    try {
      await criarExclusao({ asaasPaymentId, motivo: novoMotivo.trim() });
      setNovoId("");
      setNovoMotivo("");
      await carregarExclusoes();
      onAlterado?.();
    } catch (err) {
      setErroExclusoes(err instanceof ApiError ? err.message : "Não foi possível adicionar a exclusão.");
    } finally {
      setSalvandoExclusao(false);
    }
  }

  async function handleRemoverExclusao(id) {
    setRemovendoId(id);
    setErroExclusoes("");
    try {
      await removerExclusao(id);
      setExclusoes((atual) => atual.filter((ex) => ex.id !== id));
      onAlterado?.();
    } catch (err) {
      setErroExclusoes(err instanceof ApiError ? err.message : "Não foi possível remover a exclusão.");
    } finally {
      setRemovendoId(null);
    }
  }

  return (
    <div className="rounded-2xl border border-border-soft bg-surface shadow-lg shadow-black/20">
      <button
        type="button"
        onClick={() => setAberto((v) => !v)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left"
        aria-expanded={aberto}
      >
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconTag className="h-4.5 w-4.5" />
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Gerenciar exclusões do cálculo</h3>
            <p className="text-xs text-muted-foreground">
              Palavras-chave e cobranças específicas ignoradas na Taxa de Inadimplência.
            </p>
          </div>
        </div>
        <IconChevronDown
          className={`h-4.5 w-4.5 shrink-0 text-muted-foreground transition-transform ${aberto ? "rotate-180" : ""}`}
        />
      </button>

      {aberto && (
        <div className="space-y-6 border-t border-border-soft p-5">
          {/* Palavras-chave */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Palavras-chave excluídas
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Cobrança cuja descrição, CPF/CNPJ ou nome/razão social do associado contenha uma dessas palavras
              (sem diferenciar maiúsculas/minúsculas, com ou sem pontuação no CPF/CNPJ) é excluída
              automaticamente do cálculo.
            </p>

            {erroPalavras && (
              <div className="mt-3">
                <ErrorBanner message={erroPalavras} onRetry={carregarPalavras} />
              </div>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              {carregandoPalavras ? (
                <Spinner className="h-5 w-5" />
              ) : palavras.length === 0 ? (
                <p className="text-sm text-muted-foreground">Nenhuma palavra-chave configurada.</p>
              ) : (
                palavras.map((palavra) => (
                  <span
                    key={palavra}
                    className="inline-flex items-center gap-1.5 rounded-full bg-surface-elevated px-3 py-1.5 text-xs text-foreground"
                  >
                    {palavra}
                    <button
                      type="button"
                      onClick={() => handleRemoverPalavra(palavra)}
                      disabled={salvandoPalavra}
                      className="text-muted-foreground transition-colors hover:text-status-red disabled:cursor-not-allowed disabled:opacity-50"
                      aria-label={`Remover palavra "${palavra}"`}
                    >
                      <IconClose className="h-3 w-3" />
                    </button>
                  </span>
                ))
              )}
            </div>

            <form onSubmit={handleAdicionarPalavra} className="mt-3 flex gap-2">
              <input
                type="text"
                value={novaPalavra}
                onChange={(e) => setNovaPalavra(e.target.value)}
                placeholder="Ex.: teste, cortesia..."
                disabled={salvandoPalavra}
                className={INPUT}
              />
              <button
                type="submit"
                disabled={!novaPalavra.trim() || salvandoPalavra}
                className="flex shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {salvandoPalavra && <Spinner className="h-3.5 w-3.5" />}
                Adicionar
              </button>
            </form>
          </div>

          {/* Exclusões manuais */}
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Cobranças ignoradas manualmente
            </h4>
            <p className="mt-1 text-xs text-muted-foreground">
              Exclui uma cobrança específica do Asaas pelo ID, independente da descrição.
            </p>

            {erroExclusoes && (
              <div className="mt-3">
                <ErrorBanner message={erroExclusoes} onRetry={carregarExclusoes} />
              </div>
            )}

            <div className="scrollbar-thin mt-3 overflow-x-auto rounded-xl border border-border-soft">
              <table className="w-full min-w-[520px] text-left text-sm">
                <thead>
                  <tr className="border-b border-border-soft bg-surface-elevated text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-4 py-2.5 font-semibold">ID da cobrança</th>
                    <th className="px-4 py-2.5 font-semibold">Motivo</th>
                    <th className="px-4 py-2.5 font-semibold">Adicionada em</th>
                    <th className="px-4 py-2.5 font-semibold" />
                  </tr>
                </thead>
                <tbody>
                  {carregandoExclusoes ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center">
                        <Spinner className="mx-auto h-5 w-5" />
                      </td>
                    </tr>
                  ) : exclusoes.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="px-4 py-8 text-center text-muted-foreground">
                        Nenhuma cobrança excluída manualmente.
                      </td>
                    </tr>
                  ) : (
                    exclusoes.map((ex) => (
                      <tr key={ex.id} className="border-b border-border-soft/60 last:border-0">
                        <td className="px-4 py-2.5 font-mono text-xs text-foreground">{ex.asaas_payment_id}</td>
                        <td className="px-4 py-2.5 text-xs text-muted-foreground">{ex.motivo || "—"}</td>
                        <td className="px-4 py-2.5 font-mono text-xs text-muted-foreground">
                          {formatDateTime(ex.criado_em)}
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <button
                            type="button"
                            onClick={() => handleRemoverExclusao(ex.id)}
                            disabled={removendoId === ex.id}
                            className="rounded-lg border border-status-red/40 px-2.5 py-1 text-xs font-medium text-status-red transition-colors hover:bg-status-red/10 disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            {removendoId === ex.id ? <Spinner className="h-3 w-3" /> : "Remover"}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <form onSubmit={handleAdicionarExclusao} className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto]">
              <input
                type="text"
                value={novoId}
                onChange={(e) => setNovoId(e.target.value)}
                placeholder="ID da cobrança (ex.: pay_123456)"
                disabled={salvandoExclusao}
                className={`${INPUT} font-mono`}
              />
              <input
                type="text"
                value={novoMotivo}
                onChange={(e) => setNovoMotivo(e.target.value)}
                placeholder="Motivo (opcional)"
                disabled={salvandoExclusao}
                className={INPUT}
              />
              <button
                type="submit"
                disabled={!novoId.trim() || salvandoExclusao}
                className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {salvandoExclusao && <Spinner className="h-3.5 w-3.5" />}
                Adicionar
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
