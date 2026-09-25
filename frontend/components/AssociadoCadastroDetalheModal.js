"use client";

import { useEffect, useState } from "react";
import {
  getAssociadoDetalhe,
  excluirCadastroAssociado,
  editarCadastroAssociado,
  ApiError,
} from "@/lib/api";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import {
  maskCep,
  maskCelular,
  isValidEmail,
  digitosParaCentavos,
  formatCentavosInput,
  UFS,
  DESCRICOES_SERVICO,
  OPCOES_PARCELAS,
} from "@/lib/mascaras";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import DatePicker from "@/components/DatePicker";
import { IconClose, IconAlert } from "@/components/icons";

/**
 * AJUSTE 19 — detalhe da aba "Associados". Reaproveita GET
 * /api/associados/:cpfCnpj (mesmo endpoint do Dashboard, ver
 * associados.routes.js — aceita tanto o recurso "dashboard" quanto
 * "associados"), mas mostra um recorte DIFERENTE: aqui o foco é o cadastro
 * (todos os campos do item 1 do brief) — sem os controles de negociação/
 * bloqueio/reset, que continuam exclusivos do Dashboard.
 *
 * AJUSTE 20 — ganhou a ação "Excluir cadastro" (botão no rodapé).
 * Confirmação simples (`window.confirm`, mesmo padrão já usado pra excluir
 * documento jurídico — não o padrão "digite o nome" da franquia, essa ação é
 * bem menos destrutiva). Ao confirmar, chama `onCadastroExcluido` (o pai
 * fecha o modal e recarrega a lista).
 *
 * AJUSTE 21 — ganhou o modo de edição ("Editar" -> campos viram inputs,
 * "Salvar"/"Cancelar"). Reaproveita os MESMOS componentes de input do
 * formulário de Cadastro (app/cadastro/page.js: máscaras de CEP/celular,
 * campos monetários em centavos, DatePicker, selects de UF/Descrição do
 * Serviço/Número de Parcelas) — mesma consistência visual e de validação
 * client-side pedida no brief. "Valor da Parcela" continua um PREVIEW
 * calculado no cliente (nunca um input editável), igual ao Cadastro — o
 * PATCH nunca manda "valor_parcela" explicitamente, deixando o backend
 * recalcular sozinho a partir de valor_total/valor_entrada/numero_parcelas
 * (sempre presentes no body deste modal, já que o form mostra todos os
 * campos de uma vez — ver docblock de `editarCadastro` no backend pra como
 * o recálculo funciona).
 */
function Campo({ label, valor }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium text-foreground">{valor || "-"}</dd>
    </div>
  );
}

function CampoEditavel({ label, opcional, className = "", children }) {
  return (
    <div className={className}>
      <label className="mb-1.5 block text-xs text-muted-foreground">
        {label}
        {opcional && <span className="text-muted/60"> (opcional)</span>}
      </label>
      {children}
    </div>
  );
}

const INPUT =
  "w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60";
const INPUT_MONO = `${INPUT} font-mono`;

/** Converte um valor decimal já salvo (string "1234.56" vinda do backend, ou number) para centavos (inteiro) | null — inverso de `centavosParaDecimalString` de lib/mascaras.js. */
function decimalParaCentavos(valor) {
  if (valor === null || valor === undefined || valor === "") return null;
  const numero = Number(valor);
  if (Number.isNaN(numero)) return null;
  return Math.round(numero * 100);
}

/** Centavos (inteiro ou null) -> string decimal | null pro body do PATCH — null explícito LIMPA o campo (diferente de centavosParaDecimalString, que sempre devolve "0.00"). */
function centavosParaDecimalOuNull(centavos) {
  if (centavos === null || centavos === undefined) return null;
  return (Number(centavos) / 100).toFixed(2);
}

/** ISO datetime devolvido pelo backend ("2026-09-25T00:00:00.000Z") -> "YYYY-MM-DD" esperado pelo DatePicker. */
function isoParaDataInput(valor) {
  if (!valor) return "";
  return String(valor).slice(0, 10);
}

/** Monta o estado editável do formulário a partir do associado carregado (snake_case -> camelCase, mesma forma de ESTADO_INICIAL em app/cadastro/page.js). */
function montarFormEdit(associado) {
  return {
    tipoPessoa: associado.tipo_pessoa === "PF" ? "PF" : "PJ",
    razaoSocial: associado.razao_social || "",
    nomeFantasia: associado.nome_fantasia || "",
    cep: associado.cep || "",
    endereco: associado.endereco || "",
    numero: associado.numero || "",
    complemento: associado.complemento || "",
    bairro: associado.bairro || "",
    cidade: associado.cidade || "",
    uf: associado.uf || "",
    contatoNome: associado.contato_nome || "",
    celular: associado.celular || "",
    emailCadastro: associado.email_cadastro || "",
    descricaoServico: associado.descricao_servico || "",
    dataEntrada: isoParaDataInput(associado.data_entrada),
    numeroParcelas: associado.numero_parcelas ? String(associado.numero_parcelas) : "1",
    dataVencimento: isoParaDataInput(associado.data_vencimento),
    observacoesCadastro: associado.observacoes_cadastro || "",
  };
}

export default function AssociadoCadastroDetalheModal({ cpfCnpj, onClose, onCadastroExcluido }) {
  const [associado, setAssociado] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [excluindo, setExcluindo] = useState(false);

  const [editando, setEditando] = useState(false);
  const [formEdit, setFormEdit] = useState(null);
  const [valorEntradaCentavos, setValorEntradaCentavos] = useState(null);
  const [valorTotalCentavos, setValorTotalCentavos] = useState(null);
  const [descontoParcelaCentavos, setDescontoParcelaCentavos] = useState(null);
  const [errosEdicao, setErrosEdicao] = useState([]);
  const [salvando, setSalvando] = useState(false);

  function atualizarCampoEdit(campo, valor) {
    setFormEdit((prev) => ({ ...prev, [campo]: valor }));
  }

  function iniciarEdicao() {
    setFormEdit(montarFormEdit(associado));
    setValorEntradaCentavos(decimalParaCentavos(associado.valor_entrada));
    setValorTotalCentavos(decimalParaCentavos(associado.valor_total));
    setDescontoParcelaCentavos(decimalParaCentavos(associado.desconto_parcela));
    setErrosEdicao([]);
    setEditando(true);
  }

  function cancelarEdicao() {
    setEditando(false);
    setFormEdit(null);
    setErrosEdicao([]);
  }

  // Preview de "Valor da Parcela" — mesma fórmula/mesmo caráter de preview
  // (não editável) do formulário de Cadastro.
  const numeroParcelasPreview = formEdit ? parseInt(formEdit.numeroParcelas, 10) || 1 : 1;
  const valorParcelaPreview =
    numeroParcelasPreview > 1 && valorTotalCentavos
      ? formatCentavosInput(
          Math.round(((valorTotalCentavos || 0) - (valorEntradaCentavos || 0)) / numeroParcelasPreview)
        )
      : "";

  async function handleSalvar() {
    if (!formEdit || salvando) return;

    const novosErros = [];
    if (formEdit.emailCadastro.trim() && !isValidEmail(formEdit.emailCadastro)) {
      novosErros.push('O "E-mail (Cadastro)" informado não é válido.');
    }
    setErrosEdicao(novosErros);
    if (novosErros.length > 0) return;

    const payload = {
      tipo_pessoa: formEdit.tipoPessoa,
      razao_social: formEdit.razaoSocial.trim(),
      nome_fantasia: formEdit.nomeFantasia.trim(),
      cep: formEdit.cep.trim(),
      endereco: formEdit.endereco.trim(),
      numero: formEdit.numero.trim(),
      complemento: formEdit.complemento.trim(),
      bairro: formEdit.bairro.trim(),
      cidade: formEdit.cidade.trim(),
      uf: formEdit.uf,
      contato_nome: formEdit.contatoNome.trim(),
      celular: formEdit.celular.trim(),
      email_cadastro: formEdit.emailCadastro.trim(),
      descricao_servico: formEdit.descricaoServico,
      valor_entrada: centavosParaDecimalOuNull(valorEntradaCentavos),
      data_entrada: formEdit.dataEntrada,
      numero_parcelas: formEdit.numeroParcelas,
      valor_total: centavosParaDecimalOuNull(valorTotalCentavos),
      data_vencimento: formEdit.dataVencimento,
      desconto_parcela: centavosParaDecimalOuNull(descontoParcelaCentavos),
      observacoes_cadastro: formEdit.observacoesCadastro.trim(),
      // "valor_parcela" propositalmente NÃO entra aqui — deixa o backend
      // recalcular sozinho a partir dos 3 campos acima (sempre presentes
      // neste payload).
    };

    setSalvando(true);
    setError("");
    try {
      const atualizado = await editarCadastroAssociado(cpfCnpj, payload);
      setAssociado(atualizado);
      setEditando(false);
      setFormEdit(null);
    } catch (err) {
      setErrosEdicao([err instanceof ApiError ? err.message : "Erro ao salvar o cadastro."]);
    } finally {
      setSalvando(false);
    }
  }

  async function handleExcluirCadastro() {
    if (excluindo) return;
    const confirmado = window.confirm(
      "Isso vai apagar os dados de cadastro deste associado — endereço, contato e faturamento. " +
        "O associado continua no sistema, só esses dados somem. Confirmar?"
    );
    if (!confirmado) return;

    setExcluindo(true);
    setError("");
    try {
      await excluirCadastroAssociado(cpfCnpj);
      onCadastroExcluido?.();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Erro ao excluir cadastro.");
      setExcluindo(false);
    }
  }

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
          ) : associado && editando && formEdit ? (
            <>
              {errosEdicao.length > 0 && (
                <div className="rounded-xl border border-status-red/30 bg-status-red/10 px-4 py-3 text-sm text-foreground">
                  <p className="mb-1.5 flex items-center gap-2 font-semibold">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-status-red/20 text-status-red">
                      <IconAlert className="h-3.5 w-3.5" />
                    </span>
                    Corrija os campos abaixo antes de salvar:
                  </p>
                  <ul className="ml-8 list-disc space-y-0.5 text-muted-foreground">
                    {errosEdicao.map((erro) => (
                      <li key={erro}>{erro}</li>
                    ))}
                  </ul>
                </div>
              )}

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Identificação
                </h3>
                <div className="grid grid-cols-1 gap-4 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <CampoEditavel label="CPF/CNPJ">
                    <input type="text" disabled className={`${INPUT_MONO} cursor-not-allowed`} value={associado.cpf_cnpj || ""} />
                  </CampoEditavel>
                  <CampoEditavel label="Tipo de Pessoa">
                    <div className="inline-flex rounded-xl border border-border-soft bg-surface p-1">
                      {["PJ", "PF"].map((tipo) => (
                        <button
                          key={tipo}
                          type="button"
                          onClick={() => atualizarCampoEdit("tipoPessoa", tipo)}
                          disabled={salvando}
                          className={`rounded-lg px-6 py-1.5 text-sm font-medium transition-colors ${
                            formEdit.tipoPessoa === tipo
                              ? "bg-primary text-primary-foreground"
                              : "text-muted-foreground hover:text-foreground"
                          }`}
                        >
                          {tipo}
                        </button>
                      ))}
                    </div>
                  </CampoEditavel>
                  <CampoEditavel label="Razão Social">
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.razaoSocial}
                      onChange={(e) => atualizarCampoEdit("razaoSocial", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="Nome Fantasia">
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.nomeFantasia}
                      onChange={(e) => atualizarCampoEdit("nomeFantasia", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                </div>
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Contato
                </h3>
                <div className="grid grid-cols-1 gap-4 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <CampoEditavel label="Contato">
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.contatoNome}
                      onChange={(e) => atualizarCampoEdit("contatoNome", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="Celular">
                    <input
                      type="text"
                      inputMode="numeric"
                      className={INPUT_MONO}
                      value={formEdit.celular}
                      onChange={(e) => atualizarCampoEdit("celular", maskCelular(e.target.value))}
                      placeholder="(00) 00000-0000"
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="E-mail (Cadastro)" className="sm:col-span-2">
                    <input
                      type="email"
                      className={INPUT}
                      value={formEdit.emailCadastro}
                      onChange={(e) => atualizarCampoEdit("emailCadastro", e.target.value)}
                      placeholder="nome@empresa.com"
                      disabled={salvando}
                    />
                  </CampoEditavel>
                </div>
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Endereço
                </h3>
                <div className="grid grid-cols-1 gap-4 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <CampoEditavel label="CEP">
                    <input
                      type="text"
                      inputMode="numeric"
                      className={INPUT_MONO}
                      value={formEdit.cep}
                      onChange={(e) => atualizarCampoEdit("cep", maskCep(e.target.value))}
                      placeholder="00000-000"
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="Número">
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.numero}
                      onChange={(e) => atualizarCampoEdit("numero", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="Endereço" className="sm:col-span-2">
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.endereco}
                      onChange={(e) => atualizarCampoEdit("endereco", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="Complemento" opcional>
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.complemento}
                      onChange={(e) => atualizarCampoEdit("complemento", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="Bairro">
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.bairro}
                      onChange={(e) => atualizarCampoEdit("bairro", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="Cidade">
                    <input
                      type="text"
                      className={INPUT}
                      value={formEdit.cidade}
                      onChange={(e) => atualizarCampoEdit("cidade", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                  <CampoEditavel label="UF">
                    <select
                      className={INPUT}
                      value={formEdit.uf}
                      onChange={(e) => atualizarCampoEdit("uf", e.target.value)}
                      disabled={salvando}
                    >
                      <option value="">Selecione...</option>
                      {UFS.map((uf) => (
                        <option key={uf} value={uf}>
                          {uf}
                        </option>
                      ))}
                    </select>
                  </CampoEditavel>
                </div>
              </section>

              <section>
                <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  Faturamento
                </h3>
                <div className="grid grid-cols-1 gap-4 rounded-2xl bg-surface-elevated p-4 sm:grid-cols-2">
                  <CampoEditavel label="Descrição do Serviço" className="sm:col-span-2">
                    <select
                      className={INPUT}
                      value={formEdit.descricaoServico}
                      onChange={(e) => atualizarCampoEdit("descricaoServico", e.target.value)}
                      disabled={salvando}
                    >
                      <option value="">Selecione...</option>
                      {DESCRICOES_SERVICO.map((opcao) => (
                        <option key={opcao} value={opcao}>
                          {opcao}
                        </option>
                      ))}
                    </select>
                  </CampoEditavel>

                  <CampoEditavel label="Valor da Entrada" opcional>
                    <input
                      type="text"
                      inputMode="numeric"
                      className={INPUT_MONO}
                      value={formatCentavosInput(valorEntradaCentavos)}
                      onChange={(e) => setValorEntradaCentavos(digitosParaCentavos(e.target.value))}
                      placeholder="R$ 0,00"
                      disabled={salvando}
                    />
                  </CampoEditavel>

                  <CampoEditavel label="Data da Entrada" opcional>
                    <DatePicker
                      value={formEdit.dataEntrada}
                      onChange={(iso) => atualizarCampoEdit("dataEntrada", iso)}
                    />
                  </CampoEditavel>

                  <CampoEditavel label="Número de Parcelas">
                    <select
                      className={INPUT}
                      value={formEdit.numeroParcelas}
                      onChange={(e) => atualizarCampoEdit("numeroParcelas", e.target.value)}
                      disabled={salvando}
                    >
                      {OPCOES_PARCELAS.map((n) => (
                        <option key={n} value={String(n)}>
                          {n}x
                        </option>
                      ))}
                    </select>
                  </CampoEditavel>

                  <CampoEditavel label="Valor da Parcela" opcional>
                    <input
                      type="text"
                      readOnly
                      disabled
                      className={`${INPUT_MONO} cursor-not-allowed`}
                      value={valorParcelaPreview}
                      placeholder="R$ 0,00"
                    />
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Recalculado automaticamente a partir de Valor Total, Valor da Entrada e Número
                      de Parcelas.
                    </p>
                  </CampoEditavel>

                  <CampoEditavel label="Valor Total">
                    <input
                      type="text"
                      inputMode="numeric"
                      className={INPUT_MONO}
                      value={formatCentavosInput(valorTotalCentavos)}
                      onChange={(e) => setValorTotalCentavos(digitosParaCentavos(e.target.value))}
                      placeholder="R$ 0,00"
                      disabled={salvando}
                    />
                  </CampoEditavel>

                  <CampoEditavel label="Data Vencimento">
                    <DatePicker
                      value={formEdit.dataVencimento}
                      onChange={(iso) => atualizarCampoEdit("dataVencimento", iso)}
                    />
                  </CampoEditavel>

                  <CampoEditavel label="Desconto Parcela" opcional>
                    <input
                      type="text"
                      inputMode="numeric"
                      className={INPUT_MONO}
                      value={formatCentavosInput(descontoParcelaCentavos)}
                      onChange={(e) => setDescontoParcelaCentavos(digitosParaCentavos(e.target.value))}
                      placeholder="R$ 0,00"
                      disabled={salvando}
                    />
                  </CampoEditavel>

                  <CampoEditavel label="Observações" className="sm:col-span-2">
                    <textarea
                      rows={3}
                      className={`${INPUT} resize-none`}
                      value={formEdit.observacoesCadastro}
                      onChange={(e) => atualizarCampoEdit("observacoesCadastro", e.target.value)}
                      disabled={salvando}
                    />
                  </CampoEditavel>
                </div>
              </section>
            </>
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

        {associado && (
          <div className="sticky bottom-0 z-10 flex justify-end gap-3 border-t border-border-soft bg-surface/95 px-6 py-4 backdrop-blur">
            {editando ? (
              <>
                <button
                  type="button"
                  onClick={cancelarEdicao}
                  disabled={salvando}
                  className="rounded-xl border border-border-soft px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleSalvar}
                  disabled={salvando}
                  className="flex items-center gap-2 rounded-xl bg-primary px-3.5 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {salvando && <Spinner className="h-4 w-4" />}
                  {salvando ? "Salvando..." : "Salvar"}
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={handleExcluirCadastro}
                  disabled={excluindo}
                  className="rounded-xl border border-status-red/40 bg-status-red/10 px-3.5 py-2 text-sm font-medium text-status-red transition-colors hover:bg-status-red/20 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {excluindo ? "Excluindo..." : "Excluir cadastro"}
                </button>
                <button
                  type="button"
                  onClick={iniciarEdicao}
                  className="rounded-xl border border-border-soft bg-surface px-3.5 py-2 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
                >
                  Editar
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
