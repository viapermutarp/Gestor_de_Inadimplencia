"use client";

import { useEffect, useState } from "react";
import { getAssociadoDetalhe, ApiError } from "@/lib/api";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconClose } from "@/components/icons";

/**
 * AJUSTE 19 — detalhe da aba "Associados". Reaproveita GET
 * /api/associados/:cpfCnpj (mesmo endpoint do Dashboard, ver
 * associados.routes.js — aceita tanto o recurso "dashboard" quanto
 * "associados"), mas mostra um recorte DIFERENTE: aqui o foco é o cadastro
 * (todos os campos do item 1 do brief) — sem os controles de negociação/
 * bloqueio/reset, que continuam exclusivos do Dashboard. Puramente somente
 * leitura: nenhuma ação de escrita aqui.
 */
function Campo({ label, valor }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{valor || "-"}</dd>
    </div>
  );
}

export default function AssociadoCadastroDetalheModal({ cpfCnpj, onClose }) {
  const [associado, setAssociado] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let ativo = true;
    setLoading(true);
    setError("");

    getAssociadoDetalhe(cpfCnpj)
      .then((data) => {
        if (ativo) setAssociado(data);
      })
      .catch((err) => {
        if (ativo) setError(err instanceof ApiError ? err.message : "Erro ao carregar detalhe do associado.");
      })
      .finally(() => {
        if (ativo) setLoading(false);
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
              Cadastro do associado
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-bold text-foreground">
                {associado?.razao_social || associado?.nome || "Carregando..."}
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
              {associado?.em_negociacao && (
                <span className="rounded-full bg-status-yellow/15 px-2.5 py-0.5 text-[11px] font-semibold text-status-yellow ring-1 ring-status-yellow/40">
                  Em negociação
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
              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Identificação
                </h3>
                <dl className="grid grid-cols-1 gap-3 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <Campo label="Tipo de pessoa" valor={associado.tipo_pessoa === "PJ" ? "Pessoa Jurídica" : associado.tipo_pessoa === "PF" ? "Pessoa Física" : null} />
                  <Campo label="CPF/CNPJ" valor={<span className="font-mono">{associado.cpf_cnpj}</span>} />
                  <Campo label="Razão social" valor={associado.razao_social} />
                  <Campo label="Nome fantasia" valor={associado.nome_fantasia} />
                  <Campo label="Nome (sistema)" valor={associado.nome} />
                  <Campo label="Nome no Asaas" valor={associado.nome_asaas} />
                </dl>
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Contato
                </h3>
                <dl className="grid grid-cols-1 gap-3 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <Campo label="Contato" valor={associado.contato_nome} />
                  <Campo label="Celular (Cadastro)" valor={<span className="font-mono">{associado.celular}</span>} />
                  <Campo label="Telefone (sistema)" valor={<span className="font-mono">{associado.telefone}</span>} />
                  <Campo label="E-mail (Cadastro)" valor={associado.email_cadastro} />
                  <Campo label="E-mail (sistema)" valor={associado.email} />
                </dl>
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Endereço
                </h3>
                <dl className="grid grid-cols-1 gap-3 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <Campo label="CEP" valor={associado.cep} />
                  <Campo label="Endereço" valor={associado.endereco} />
                  <Campo label="Número" valor={associado.numero} />
                  <Campo label="Complemento" valor={associado.complemento} />
                  <Campo label="Bairro" valor={associado.bairro} />
                  <Campo label="Cidade" valor={associado.cidade} />
                  <Campo label="UF" valor={associado.uf} />
                </dl>
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Faturamento
                </h3>
                <dl className="grid grid-cols-1 gap-3 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <Campo label="Descrição do serviço" valor={associado.descricao_servico} />
                  <Campo label="Valor total" valor={associado.valor_total != null ? formatCurrency(associado.valor_total) : null} />
                  <Campo label="Valor de entrada" valor={associado.valor_entrada != null ? formatCurrency(associado.valor_entrada) : null} />
                  <Campo label="Data de entrada" valor={associado.data_entrada ? formatDate(associado.data_entrada) : null} />
                  <Campo label="Número de parcelas" valor={associado.numero_parcelas} />
                  <Campo label="Valor da parcela" valor={associado.valor_parcela != null ? formatCurrency(associado.valor_parcela) : null} />
                  <Campo label="Data de vencimento" valor={associado.data_vencimento ? formatDate(associado.data_vencimento) : null} />
                  <Campo label="Desconto por parcela" valor={associado.desconto_parcela != null ? formatCurrency(associado.desconto_parcela) : null} />
                </dl>
                {associado.observacoes_cadastro && (
                  <p className="mt-3 rounded-2xl bg-surface-elevated p-4 text-sm text-foreground">
                    <span className="mb-1 block text-xs text-muted-foreground">Observações do Cadastro</span>
                    {associado.observacoes_cadastro}
                  </p>
                )}
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Sistema
                </h3>
                <dl className="grid grid-cols-1 gap-3 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <Campo label="Cliente desde" valor={formatDate(associado.criado_em)} />
                  <Campo label="Atualizado em" valor={formatDateTime(associado.atualizado_em)} />
                </dl>
              </section>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
