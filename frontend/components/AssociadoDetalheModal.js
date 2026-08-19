"use client";

import { useEffect, useState } from "react";
import {
  getAssociadoDetalhe,
  patchNegociacao,
  getBloqueiosContador,
  resetarBloqueios,
  ApiError,
} from "@/lib/api";
import { getCobrancasAbertas } from "@/lib/atraso";
import { getIndicadorSemContato, formatUltimaObservacao } from "@/lib/contato";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import NegociacaoToggle from "@/components/NegociacaoToggle";
import SemContatoIndicador from "@/components/SemContatoIndicador";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconClose } from "@/components/icons";

const LIMITE_RISCO_CASHBACK = 4;

// Rótulos de cada campo que pode aparecer no histórico unificado (ver
// "historico" em GET /api/associados/:cpf_cnpj, campo "campo" de cada
// entrada) — mesmos textos usados nos toggles da tabela do Dashboard, para
// manter a terminologia consistente entre as duas telas.
const CAMPO_HISTORICO = {
  em_negociacao: { nome: "Negociação", true: "Em negociação", false: "Não em negociação" },
  bloqueado: { nome: "Bloqueio", true: "Bloqueado", false: "Não bloqueado" },
  em_juridico: { nome: "Jurídico", true: "Em jurídico", false: "Fora do jurídico" },
};

export default function AssociadoDetalheModal({ cpfCnpj, onClose, onAtualizado }) {
  const [associado, setAssociado] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [emNegociacao, setEmNegociacao] = useState(false);
  const [observacao, setObservacao] = useState("");
  const [salvando, setSalvando] = useState(false);
  const [salvo, setSalvo] = useState(false);

  const [contador, setContador] = useState(null);
  const [cicloResetadoEm, setCicloResetadoEm] = useState(null);
  const [carregandoContador, setCarregandoContador] = useState(true);
  const [confirmandoReset, setConfirmandoReset] = useState(false);
  const [resetando, setResetando] = useState(false);

  useEffect(() => {
    let ativo = true;
    setLoading(true);
    setCarregandoContador(true);
    setError("");
    setConfirmandoReset(false);

    getAssociadoDetalhe(cpfCnpj)
      .then((data) => {
        if (!ativo) return;
        setAssociado(data);
        setEmNegociacao(Boolean(data.em_negociacao));
        setObservacao(data.observacao || "");
      })
      .catch((err) => {
        if (!ativo) return;
        setError(err instanceof ApiError ? err.message : "Erro ao carregar detalhe do associado.");
      })
      .finally(() => {
        if (ativo) setLoading(false);
      });

    getBloqueiosContador(cpfCnpj)
      .then((data) => {
        if (!ativo) return;
        setContador(data.contador ?? 0);
        setCicloResetadoEm(data.ciclo_resetado_em ?? null);
      })
      .catch(() => {
        // Falha ao buscar o contador não deve impedir a exibição do resto do modal.
      })
      .finally(() => {
        if (ativo) setCarregandoContador(false);
      });

    return () => {
      ativo = false;
    };
  }, [cpfCnpj]);

  useEffect(() => {
    function handleEsc(e) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [onClose]);

  const houveAlteracao =
    associado &&
    (emNegociacao !== Boolean(associado.em_negociacao) || observacao !== (associado.observacao || ""));

  async function handleSalvar() {
    setSalvando(true);
    setError("");
    setSalvo(false);
    try {
      const atualizado = await patchNegociacao(cpfCnpj, {
        em_negociacao: emNegociacao,
        observacao,
      });
      setAssociado((prev) => ({ ...prev, ...atualizado }));
      onAtualizado?.(atualizado);
      setSalvo(true);
      setTimeout(() => setSalvo(false), 2500);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível salvar as alterações.");
    } finally {
      setSalvando(false);
    }
  }

  async function handleResetarContagem() {
    setResetando(true);
    setError("");
    try {
      const resp = await resetarBloqueios(cpfCnpj);
      setContador(0);
      setCicloResetadoEm(resp.ciclo_resetado_em ?? null);
      setConfirmandoReset(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Não foi possível resetar a contagem de bloqueios.");
    } finally {
      setResetando(false);
    }
  }

  const cobrancasAbertas = associado ? getCobrancasAbertas(associado) : [];
  const historico = associado?.historico || [];
  const indicadorSemContato = associado ? getIndicadorSemContato(associado) : null;
  const emRiscoCashback = !carregandoContador && (contador ?? 0) >= LIMITE_RISCO_CASHBACK;

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="scrollbar-thin flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-3xl border border-border-soft bg-surface shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-soft bg-surface/95 px-6 py-4 backdrop-blur">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">
              Detalhe do associado
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-bold text-foreground">
                {associado?.nome || "Carregando..."}
              </h2>
              {associado?.bloqueado && (
                <span className="rounded-full bg-status-red/15 px-2.5 py-0.5 text-[11px] font-semibold text-status-red ring-1 ring-status-red/40">
                  Bloqueado
                </span>
              )}
              {associado?.em_juridico && (
                <span className="rounded-full bg-status-orange/15 px-2.5 py-0.5 text-[11px] font-semibold text-status-orange ring-1 ring-status-orange/40">
                  Jurídico
                </span>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            aria-label="Fechar"
          >
            <IconClose className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 px-6 py-5">
          {error && <ErrorBanner message={error} />}

          {loading ? (
            <div className="flex justify-center py-16">
              <Spinner className="h-7 w-7" />
            </div>
          ) : associado ? (
            <>
              {/* Dados cadastrais */}
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Dados cadastrais
                </h3>
                <dl className="grid grid-cols-1 gap-3 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <div>
                    <dt className="text-xs text-muted-foreground">CPF/CNPJ</dt>
                    <dd className="font-mono text-sm font-medium text-foreground">{associado.cpf_cnpj}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Telefone</dt>
                    <dd className="font-mono text-sm font-medium text-foreground">{associado.telefone}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">E-mail</dt>
                    <dd className="text-sm font-medium text-foreground">{associado.email || "-"}</dd>
                  </div>
                  <div>
                    <dt className="text-xs text-muted-foreground">Cliente desde</dt>
                    <dd className="font-mono text-sm font-medium text-foreground">
                      {formatDate(associado.criado_em)}
                    </dd>
                  </div>
                </dl>
              </section>

              {/* Cobranças em aberto */}
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Cobranças em aberto ({cobrancasAbertas.length})
                </h3>
                {cobrancasAbertas.length === 0 ? (
                  <p className="rounded-2xl bg-surface-elevated p-4 text-sm text-muted-foreground">
                    Nenhuma cobrança em aberto.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {cobrancasAbertas.map((c) => (
                      <li
                        key={c.id}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-surface-elevated p-4"
                      >
                        <div>
                          <p className="font-mono text-sm font-semibold text-foreground">
                            {formatCurrency(c.valor)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {c.descricao ? `${c.descricao} · ` : ""}Vencimento:{" "}
                            <span className="font-mono">{formatDate(c.vencimento)}</span>
                          </p>
                        </div>
                        {c.link_pagamento && (
                          <a
                            href={c.link_pagamento}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-xl bg-primary px-3.5 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
                          >
                            Link de pagamento
                          </a>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              {/* Negociação */}
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Negociação
                </h3>
                <div className="space-y-3 rounded-2xl bg-surface-elevated p-4">
                  <div className="flex items-center justify-between">
                    <span className="text-sm font-medium text-foreground">Em negociação</span>
                    <NegociacaoToggle
                      checked={emNegociacao}
                      onChange={setEmNegociacao}
                      labelOn="Em negociação"
                      labelOff="Não em negociação"
                    />
                  </div>
                  <div>
                    <label htmlFor="observacao" className="mb-1.5 block text-xs text-muted-foreground">
                      Observação
                    </label>
                    <textarea
                      id="observacao"
                      rows={3}
                      value={observacao}
                      onChange={(e) => setObservacao(e.target.value)}
                      placeholder="Anotações sobre o acordo ou contato com o associado..."
                      className="w-full resize-none rounded-xl border border-border-soft bg-surface px-3 py-2 text-sm text-foreground placeholder:text-muted/60 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      {indicadorSemContato && <SemContatoIndicador tooltip={indicadorSemContato.tooltip} />}
                      <span>{formatUltimaObservacao(associado.observacao_atualizada_em)}</span>
                      {associado.observacao_atualizada_em && (
                        <span className="font-mono text-muted-foreground/70">
                          ({formatDateTime(associado.observacao_atualizada_em)})
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleSalvar}
                      disabled={!houveAlteracao || salvando}
                      className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {salvando && <Spinner className="h-3.5 w-3.5" />}
                      Salvar alterações
                    </button>
                    {salvo && <span className="text-xs font-medium text-status-green">Salvo com sucesso.</span>}
                  </div>
                </div>
              </section>

              {/* Controle de bloqueios */}
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Controle de bloqueios
                </h3>
                <div className="space-y-3 rounded-2xl bg-surface-elevated p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="text-xs text-muted-foreground">Bloqueios neste ciclo</p>
                      {carregandoContador ? (
                        <Spinner className="mt-1 h-4 w-4" />
                      ) : (
                        <p className="font-display text-2xl font-bold tabular-nums text-foreground">
                          {contador ?? 0}
                        </p>
                      )}
                      {cicloResetadoEm && (
                        <p className="text-xs text-muted-foreground">
                          Ciclo iniciado em{" "}
                          <span className="font-mono">{formatDateTime(cicloResetadoEm)}</span>
                        </p>
                      )}
                    </div>
                    {emRiscoCashback && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-status-red/15 px-3 py-1.5 text-xs font-semibold text-status-red ring-1 ring-status-red/40">
                        Risco de perda de cashback
                      </span>
                    )}
                  </div>

                  {!confirmandoReset ? (
                    <button
                      type="button"
                      onClick={() => setConfirmandoReset(true)}
                      className="rounded-xl border border-border-soft px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary hover:text-foreground"
                    >
                      Resetar contagem (nova renovação)
                    </button>
                  ) : (
                    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-status-yellow/40 bg-status-yellow/10 p-3">
                      <span className="text-xs text-foreground">
                        Confirma o reset da contagem? O histórico de bloqueios não será apagado, só o
                        ponto de partida do contador.
                      </span>
                      <div className="ml-auto flex shrink-0 gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmandoReset(false)}
                          disabled={resetando}
                          className="rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={handleResetarContagem}
                          disabled={resetando}
                          className="flex items-center gap-1.5 rounded-lg bg-status-yellow px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {resetando && <Spinner className="h-3 w-3" />}
                          Confirmar reset
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </section>

              {/* Histórico */}
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Histórico
                </h3>
                {historico.length === 0 ? (
                  <p className="rounded-2xl bg-surface-elevated p-4 text-sm text-muted-foreground">
                    Nenhuma alteração registrada até o momento.
                  </p>
                ) : (
                  <ul className="space-y-2">
                    {historico.map((h) => {
                      const campo = CAMPO_HISTORICO[h.campo] || {
                        nome: h.campo,
                        true: "Sim",
                        false: "Não",
                      };
                      return (
                        <li
                          key={h.id}
                          className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 rounded-2xl bg-surface-elevated p-3 text-sm"
                        >
                          <span className="text-foreground">
                            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                              {campo.nome}:
                            </span>{" "}
                            {campo[h.status_anterior]}
                            <span className="mx-2 text-muted-foreground">→</span>
                            {campo[h.status_novo]}
                          </span>
                          <span className="shrink-0 font-mono text-xs text-muted-foreground">
                            {formatDateTime(h.alterado_em)}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
