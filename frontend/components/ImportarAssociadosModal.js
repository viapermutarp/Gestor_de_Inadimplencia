"use client";

import { useState } from "react";
import { previewImportacaoAssociados, aplicarImportacaoAssociados, ApiError } from "@/lib/api";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconClose, IconUpload, IconCheck, IconAlert } from "@/components/icons";

/**
 * AJUSTE 19 — importação em lote de CSV (exportação de contatos do Bling)
 * na aba "Associados". Fluxo em 3 passos, conforme o brief:
 *   1. "selecionar": escolhe o arquivo e chama POST /api/associados/importar
 *      (só leitura no backend — nada é gravado ainda).
 *   2. "revisao": mostra "novos" (serão criados automaticamente, sem
 *      decisão), "erros" (linha sem CPF/CNPJ válido, informativo) e
 *      "conflitos" — aqui o usuário decide POR ASSOCIADO ("Atualizar" ou
 *      "Pular"), nunca em massa (pedido explícito do brief). O botão
 *      "Aplicar importação" só habilita quando todo conflito tiver decisão.
 *   3. "resultado": chama POST /api/associados/importar/aplicar e mostra
 *      criados/atualizados/pulados/erros.
 */

const CAMPOS_COMPARACAO = [
  { chave: "razao_social", label: "Razão social" },
  { chave: "nome_fantasia", label: "Nome fantasia" },
  { chave: "celular", label: "Celular" },
  { chave: "email_cadastro", label: "E-mail" },
  { chave: "endereco", label: "Endereço" },
  { chave: "cidade", label: "Cidade" },
  { chave: "uf", label: "UF" },
];

function ComparacaoConflito({ conflito, decisao, onDecidir }) {
  return (
    <div className="rounded-2xl border border-status-yellow/30 bg-status-yellow/5 p-4">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <p className="font-mono text-sm font-semibold text-foreground">{conflito.cpf_cnpj}</p>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => onDecidir(conflito.cpf_cnpj, "atualizar")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              decisao === "atualizar"
                ? "bg-primary text-primary-foreground"
                : "border border-border-soft text-muted-foreground hover:text-foreground"
            }`}
          >
            Atualizar
          </button>
          <button
            type="button"
            onClick={() => onDecidir(conflito.cpf_cnpj, "pular")}
            className={`rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors ${
              decisao === "pular"
                ? "bg-status-red text-white"
                : "border border-border-soft text-muted-foreground hover:text-foreground"
            }`}
          >
            Pular
          </button>
        </div>
      </div>
      <div className="grid grid-cols-1 gap-x-4 gap-y-2 text-xs sm:grid-cols-2">
        <p className="col-span-full font-semibold uppercase tracking-wide text-muted-foreground">
          Já cadastrado <span className="mx-1">→</span> Na planilha
        </p>
        {CAMPOS_COMPARACAO.map(({ chave, label }) => {
          const atual = conflito.atual?.[chave] || "-";
          const novo = conflito[chave] || "-";
          const mudou = atual !== novo;
          return (
            <div key={chave} className="flex items-baseline justify-between gap-2 rounded-lg bg-surface px-2.5 py-1.5">
              <span className="shrink-0 text-muted-foreground">{label}</span>
              <span className={`truncate text-right ${mudou ? "text-foreground" : "text-muted-foreground"}`}>
                {atual} {mudou && <span className="text-accent">→ {novo}</span>}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function ImportarAssociadosModal({ onClose, onImportado }) {
  const [passo, setPasso] = useState("selecionar");
  const [arquivo, setArquivo] = useState(null);
  const [analisando, setAnalisando] = useState(false);
  const [erroAnalise, setErroAnalise] = useState("");

  const [preview, setPreview] = useState(null); // { total_linhas, delimitador_detectado, novos, conflitos, erros }
  const [decisoes, setDecisoes] = useState({}); // { [cpf_cnpj]: "atualizar" | "pular" }

  const [aplicando, setAplicando] = useState(false);
  const [erroAplicar, setErroAplicar] = useState("");
  const [resultado, setResultado] = useState(null);

  async function handleAnalisar() {
    if (!arquivo) return;
    setAnalisando(true);
    setErroAnalise("");
    try {
      const data = await previewImportacaoAssociados(arquivo);
      setPreview(data);
      setDecisoes({});
      setPasso("revisao");
    } catch (err) {
      setErroAnalise(err instanceof ApiError ? err.message : "Não foi possível analisar o arquivo.");
    } finally {
      setAnalisando(false);
    }
  }

  function handleDecidir(cpfCnpj, acao) {
    setDecisoes((prev) => ({ ...prev, [cpfCnpj]: acao }));
  }

  const conflitos = preview?.conflitos ?? [];
  const todosDecididos = conflitos.every((c) => decisoes[c.cpf_cnpj]);

  async function handleAplicar() {
    setAplicando(true);
    setErroAplicar("");
    try {
      const resp = await aplicarImportacaoAssociados({
        novos: preview.novos,
        decisoes: conflitos.map((c) => ({ ...c, acao: decisoes[c.cpf_cnpj] })),
      });
      setResultado(resp);
      setPasso("resultado");
      onImportado?.();
    } catch (err) {
      setErroAplicar(err instanceof ApiError ? err.message : "Não foi possível aplicar a importação.");
    } finally {
      setAplicando(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={passo === "resultado" ? onClose : undefined}
    >
      <div
        className="scrollbar-thin flex max-h-[90vh] w-full max-w-2xl flex-col overflow-y-auto rounded-3xl border border-border-soft bg-surface shadow-2xl shadow-black/50"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-border-soft bg-surface/95 px-6 py-4 backdrop-blur">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-accent">Aba Associados</p>
            <h2 className="font-display text-lg font-bold text-foreground">Importar CSV do Bling</h2>
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

        <div className="space-y-5 px-6 py-5">
          {passo === "selecionar" && (
            <>
              <p className="text-sm text-muted-foreground">
                Envie o CSV de exportação de contatos do Bling. Colunas reconhecidas: Nome, Fantasia,
                CNPJ / CPF, Endereço, Número, Complemento, Bairro, CEP, Cidade, UF, Celular, Fone e E-mail —
                outras colunas (Estado civil, Profissão, Vendedor etc.) são ignoradas.
              </p>
              {erroAnalise && <ErrorBanner message={erroAnalise} />}
              <div className="rounded-2xl border border-dashed border-border-soft bg-surface-elevated p-6 text-center">
                <input
                  type="file"
                  accept=".csv,text/csv"
                  onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
                  className="w-full text-sm text-muted-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3.5 file:py-2 file:text-sm file:font-semibold file:text-primary-foreground hover:file:bg-primary-hover"
                />
                {arquivo && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Selecionado: <span className="font-medium text-foreground">{arquivo.name}</span>
                  </p>
                )}
              </div>
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleAnalisar}
                  disabled={!arquivo || analisando}
                  className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {analisando ? <Spinner className="h-3.5 w-3.5" /> : <IconUpload className="h-4 w-4" />}
                  Analisar arquivo
                </button>
              </div>
            </>
          )}

          {passo === "revisao" && preview && (
            <>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-status-green/10 p-3">
                  <p className="font-display text-xl font-bold text-status-green">{preview.novos.length}</p>
                  <p className="text-xs text-muted-foreground">Novos</p>
                </div>
                <div className="rounded-xl bg-status-yellow/10 p-3">
                  <p className="font-display text-xl font-bold text-status-yellow">{conflitos.length}</p>
                  <p className="text-xs text-muted-foreground">Conflitos</p>
                </div>
                <div className="rounded-xl bg-status-red/10 p-3">
                  <p className="font-display text-xl font-bold text-status-red">{preview.erros.length}</p>
                  <p className="text-xs text-muted-foreground">Erros</p>
                </div>
              </div>

              {erroAplicar && <ErrorBanner message={erroAplicar} />}

              {conflitos.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Conflitos — CPF/CNPJ já cadastrado (decida um por um)
                  </h3>
                  <div className="space-y-3">
                    {conflitos.map((c) => (
                      <ComparacaoConflito
                        key={c.cpf_cnpj}
                        conflito={c}
                        decisao={decisoes[c.cpf_cnpj]}
                        onDecidir={handleDecidir}
                      />
                    ))}
                  </div>
                </section>
              )}

              {preview.novos.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Novos associados (serão criados automaticamente)
                  </h3>
                  <ul className="max-h-40 space-y-1 overflow-y-auto rounded-2xl bg-surface-elevated p-3 text-xs">
                    {preview.novos.map((n) => (
                      <li key={n.cpf_cnpj} className="flex justify-between gap-3 px-1 py-0.5">
                        <span className="truncate text-foreground">{n.razao_social || n.nome_fantasia || "-"}</span>
                        <span className="shrink-0 font-mono text-muted-foreground">{n.cpf_cnpj}</span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              {preview.erros.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Linhas ignoradas (erro)
                  </h3>
                  <ul className="space-y-1 rounded-2xl bg-status-red/5 p-3 text-xs text-foreground">
                    {preview.erros.map((e) => (
                      <li key={e.linha} className="flex items-start gap-2">
                        <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-red" />
                        <span>
                          Linha {e.linha}: {e.motivo}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}

              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  onClick={() => setPasso("selecionar")}
                  disabled={aplicando}
                  className="rounded-xl border border-border-soft px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  Voltar
                </button>
                <button
                  type="button"
                  onClick={handleAplicar}
                  disabled={!todosDecididos || aplicando || (preview.novos.length === 0 && conflitos.length === 0)}
                  className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {aplicando && <Spinner className="h-3.5 w-3.5" />}
                  Aplicar importação
                </button>
              </div>
              {!todosDecididos && conflitos.length > 0 && (
                <p className="text-right text-xs text-muted-foreground">
                  Decida &ldquo;Atualizar&rdquo; ou &ldquo;Pular&rdquo; para todos os conflitos antes de aplicar.
                </p>
              )}
            </>
          )}

          {passo === "resultado" && resultado && (
            <>
              <div className="flex flex-col items-center gap-2 py-4 text-center">
                <span className="flex h-12 w-12 items-center justify-center rounded-full bg-status-green/15 text-status-green">
                  <IconCheck className="h-6 w-6" />
                </span>
                <h3 className="font-display text-lg font-bold text-foreground">Importação aplicada</h3>
              </div>
              <div className="grid grid-cols-3 gap-3 text-center">
                <div className="rounded-xl bg-status-green/10 p-3">
                  <p className="font-display text-xl font-bold text-status-green">{resultado.criados}</p>
                  <p className="text-xs text-muted-foreground">Criados</p>
                </div>
                <div className="rounded-xl bg-primary/10 p-3">
                  <p className="font-display text-xl font-bold text-primary">{resultado.atualizados}</p>
                  <p className="text-xs text-muted-foreground">Atualizados</p>
                </div>
                <div className="rounded-xl bg-surface-elevated p-3">
                  <p className="font-display text-xl font-bold text-muted-foreground">{resultado.pulados}</p>
                  <p className="text-xs text-muted-foreground">Pulados</p>
                </div>
              </div>
              {resultado.erros?.length > 0 && (
                <section>
                  <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Erros ao aplicar
                  </h3>
                  <ul className="space-y-1 rounded-2xl bg-status-red/5 p-3 text-xs text-foreground">
                    {resultado.erros.map((e, i) => (
                      <li key={i} className="flex items-start gap-2">
                        <IconAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-status-red" />
                        <span>
                          {e.cpf_cnpj ? `${e.cpf_cnpj}: ` : ""}
                          {e.motivo}
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
                >
                  Concluir
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
