"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listarContratos,
  criarContrato,
  atualizarContrato,
  removerContrato,
  ApiError,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import RichTextEditor from "@/components/RichTextEditor";
import { IconFileText, IconPlus, IconAlert } from "@/components/icons";

const TIPOS = [
  { valor: "TERMO", label: "Termo de Associação" },
  { valor: "ADITIVO", label: "Aditivo Contratual" },
];

function labelTipo(tipo) {
  return TIPOS.find((t) => t.valor === tipo)?.label || tipo;
}

const ESTADO_FORM_VAZIO = { nome: "", tipo: "TERMO", conteudo: "" };

export default function ContratosPage() {
  const [modelos, setModelos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const [formAberto, setFormAberto] = useState(false);
  const [editandoId, setEditandoId] = useState(null);
  const [form, setForm] = useState(ESTADO_FORM_VAZIO);
  const [salvando, setSalvando] = useState(false);
  const [erroForm, setErroForm] = useState("");

  const [confirmandoId, setConfirmandoId] = useState(null);
  const [processandoId, setProcessandoId] = useState(null);

  const carregarModelos = useCallback(async () => {
    setCarregando(true);
    setErro("");
    try {
      const dados = await listarContratos();
      setModelos(Array.isArray(dados) ? dados : []);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao carregar os modelos de contrato.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregarModelos();
  }, [carregarModelos]);

  function abrirNovo() {
    setEditandoId(null);
    setForm(ESTADO_FORM_VAZIO);
    setErroForm("");
    setFormAberto(true);
  }

  function abrirEdicao(modelo) {
    setEditandoId(modelo.id);
    setForm({ nome: modelo.nome, tipo: modelo.tipo, conteudo: modelo.conteudo });
    setErroForm("");
    setFormAberto(true);
  }

  function fecharForm() {
    setFormAberto(false);
    setEditandoId(null);
    setForm(ESTADO_FORM_VAZIO);
    setErroForm("");
  }

  async function handleSalvar() {
    if (!form.nome.trim()) {
      setErroForm('Informe o "Nome" do modelo.');
      return;
    }
    if (!form.conteudo || form.conteudo === "<p></p>") {
      setErroForm('O "Conteúdo" não pode ficar vazio.');
      return;
    }

    setSalvando(true);
    setErroForm("");
    try {
      if (editandoId) {
        await atualizarContrato(editandoId, form);
      } else {
        await criarContrato(form);
      }
      await carregarModelos();
      fecharForm();
    } catch (err) {
      setErroForm(err instanceof ApiError ? err.message : "Não foi possível salvar o modelo.");
    } finally {
      setSalvando(false);
    }
  }

  async function handleRemover(id) {
    setProcessandoId(id);
    try {
      await removerContrato(id);
      await carregarModelos();
      setConfirmandoId(null);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Não foi possível desativar o modelo.");
    } finally {
      setProcessandoId(null);
    }
  }

  async function handleReativar(id) {
    setProcessandoId(id);
    try {
      await atualizarContrato(id, { ativo: true });
      await carregarModelos();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Não foi possível reativar o modelo.");
    } finally {
      setProcessandoId(null);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-display text-xl font-bold text-foreground">Contratos</h2>
          <p className="text-sm text-muted-foreground">
            Modelos usados na geração automática de contratos (.docx) ao salvar um Cadastro.
          </p>
        </div>
        {!formAberto && (
          <button
            type="button"
            onClick={abrirNovo}
            className="flex items-center gap-1.5 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <IconPlus className="h-4 w-4" />
            Novo modelo
          </button>
        )}
      </div>

      {erro && (
        <ErrorBanner message={erro} onRetry={carregarModelos} />
      )}

      {formAberto ? (
        <section className="space-y-4 rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <IconFileText className="h-4.5 w-4.5" />
            </span>
            <h3 className="text-sm font-semibold text-foreground">
              {editandoId ? "Editar modelo" : "Novo modelo"}
            </h3>
          </div>

          <div className="flex items-start gap-2 rounded-xl border border-status-yellow/30 bg-status-yellow/10 px-3.5 py-2.5 text-xs text-foreground">
            <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-yellow" />
            <p>
              Digite as variáveis no formato <code className="rounded bg-surface-elevated px-1 py-0.5 font-mono">{"{{Nome Da Variável}}"}</code>{" "}
              como texto simples. Não formate uma placeholder pela metade (ex.: deixar só{" "}
              <code className="rounded bg-surface-elevated px-1 py-0.5 font-mono">{"{{Razão"}</code> em negrito) — a
              substituição procura a chave inteira e não vai encontrar.
            </p>
          </div>

          {erroForm && <ErrorBanner message={erroForm} />}

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Nome</label>
              <input
                type="text"
                value={form.nome}
                onChange={(e) => setForm((prev) => ({ ...prev, nome: e.target.value }))}
                placeholder="ex.: Termo de Associação"
                disabled={salvando}
                className="w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
              />
            </div>
            <div>
              <label className="mb-1.5 block text-xs text-muted-foreground">Tipo</label>
              <select
                value={form.tipo}
                onChange={(e) => setForm((prev) => ({ ...prev, tipo: e.target.value }))}
                disabled={salvando}
                className="w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {TIPOS.map((t) => (
                  <option key={t.valor} value={t.valor}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-xs text-muted-foreground">Conteúdo</label>
            <RichTextEditor
              value={form.conteudo}
              onChange={(html) => setForm((prev) => ({ ...prev, conteudo: html }))}
              disabled={salvando}
            />
          </div>

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={fecharForm}
              disabled={salvando}
              className="rounded-xl px-4 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
            >
              Cancelar
            </button>
            <button
              type="button"
              onClick={handleSalvar}
              disabled={salvando}
              className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {salvando && <Spinner className="h-3.5 w-3.5" />}
              Salvar
            </button>
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
          {carregando ? (
            <div className="flex justify-center py-10">
              <Spinner className="h-5 w-5" />
            </div>
          ) : modelos.length === 0 ? (
            <p className="py-6 text-center text-sm text-muted-foreground">
              Nenhum modelo de contrato cadastrado ainda.
            </p>
          ) : (
            <div className="space-y-2">
              {modelos.map((modelo) => (
                <div
                  key={modelo.id}
                  className={`rounded-xl border p-3.5 ${
                    modelo.ativo
                      ? "border-border-soft bg-surface-elevated"
                      : "border-border-soft/60 bg-surface-elevated/40 opacity-70"
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">{modelo.nome}</span>
                        <span className="inline-flex items-center rounded-full bg-accent/15 px-2 py-0.5 text-[11px] font-medium text-accent">
                          {labelTipo(modelo.tipo)}
                        </span>
                        {modelo.ativo ? (
                          <span className="inline-flex items-center rounded-full bg-status-green/15 px-2 py-0.5 text-[11px] font-medium text-status-green">
                            Ativo
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-status-red/15 px-2 py-0.5 text-[11px] font-medium text-status-red">
                            Inativo
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        Atualizado em {formatDateTime(modelo.atualizado_em)}
                      </p>
                    </div>

                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => abrirEdicao(modelo)}
                        className="rounded-lg border border-border-soft px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:bg-surface"
                      >
                        Editar
                      </button>

                      {modelo.ativo ? (
                        confirmandoId === modelo.id ? (
                          <>
                            <button
                              type="button"
                              onClick={() => setConfirmandoId(null)}
                              disabled={processandoId === modelo.id}
                              className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                            >
                              Cancelar
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRemover(modelo.id)}
                              disabled={processandoId === modelo.id}
                              className="flex items-center gap-1.5 rounded-lg bg-status-red px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                              {processandoId === modelo.id && <Spinner className="h-3 w-3" />}
                              Confirmar
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmandoId(modelo.id)}
                            className="rounded-lg border border-status-red/40 px-3 py-1.5 text-xs font-medium text-status-red transition-colors hover:bg-status-red/10"
                          >
                            Desativar
                          </button>
                        )
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleReativar(modelo.id)}
                          disabled={processandoId === modelo.id}
                          className="flex items-center gap-1.5 rounded-lg border border-status-green/40 px-3 py-1.5 text-xs font-medium text-status-green transition-colors hover:bg-status-green/10 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {processandoId === modelo.id && <Spinner className="h-3 w-3" />}
                          Reativar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  );
}
