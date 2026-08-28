"use client";

import { useEffect, useState } from "react";
import { criarCadastro, listarContratos, ApiError } from "@/lib/api";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import DatePicker from "@/components/DatePicker";
import {
  maskCpfCnpj,
  maskCep,
  maskCelular,
  isValidEmail,
  digitosParaCentavos,
  formatCentavosInput,
  centavosParaDecimalString,
  UFS,
  DESCRICOES_SERVICO,
  OPCOES_PARCELAS,
} from "@/lib/mascaras";
import {
  IconReceipt,
  IconMapPin,
  IconUser,
  IconBanknote,
  IconCheckCircle,
  IconAlert,
} from "@/components/icons";

const ESTADO_INICIAL = {
  tipoPessoa: "PJ",
  razaoSocial: "",
  nomeFantasia: "",
  cnpjCpf: "",
  cep: "",
  endereco: "",
  numero: "",
  complemento: "",
  bairro: "",
  cidade: "",
  uf: "",
  contato: "",
  celular: "",
  email: "",
  descricaoServico: "",
  numeroParcelas: "1",
  dataVencimento: "",
  dataEntrada: "",
  observacoes: "",
  nomePasta: "",
  creditosVps: "0",
  modelosContratoIds: [],
};

const OPCOES_CREDITOS_VPS = [
  { valor: "0", label: "Nenhum" },
  { valor: "2000", label: "2.000" },
  { valor: "8000", label: "8.000" },
];

const INPUT =
  "w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60";
const INPUT_MONO = `${INPUT} font-mono`;

function Campo({ label, opcional, className = "", children }) {
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

function Secao({ icon, titulo, children }) {
  return (
    <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
      <div className="flex items-center gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
          {icon}
        </span>
        <h3 className="text-sm font-semibold text-foreground">{titulo}</h3>
      </div>
      <div className="mt-4 grid grid-cols-1 gap-4 sm:grid-cols-2">{children}</div>
    </section>
  );
}

export default function CadastroPage() {
  const [form, setForm] = useState(ESTADO_INICIAL);
  const [valorEntradaCentavos, setValorEntradaCentavos] = useState(null);
  const [valorTotalCentavos, setValorTotalCentavos] = useState(null);
  const [descontoParcelaCentavos, setDescontoParcelaCentavos] = useState(null);

  const [erros, setErros] = useState([]);
  const [erroEnvio, setErroEnvio] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [sucesso, setSucesso] = useState(false);
  // Link de pagamento devolvido pelo n8n (cliente criado no Bling, cobrança
  // gerada no Asaas) — só preenchido quando o cadastro realmente deu certo
  // do lado de lá, não só porque a chamada HTTP ao nosso backend voltou 201.
  const [linkPagamento, setLinkPagamento] = useState("");

  // Modelos de contrato ativos, pra montar a lista de checkboxes de
  // "Contratos a gerar" — carregados uma vez ao abrir a tela.
  const [modelosDisponiveis, setModelosDisponiveis] = useState([]);
  const [carregandoModelos, setCarregandoModelos] = useState(true);

  useEffect(() => {
    listarContratos({ ativo: true })
      .then((dados) => setModelosDisponiveis(Array.isArray(dados) ? dados : []))
      .catch(() => setModelosDisponiveis([]))
      .finally(() => setCarregandoModelos(false));
  }, []);

  function atualizarCampo(campo, valor) {
    setForm((prev) => ({ ...prev, [campo]: valor }));
  }

  function handleTipoPessoa(tipo) {
    setForm((prev) => ({ ...prev, tipoPessoa: tipo, cnpjCpf: "" }));
  }

  function toggleModeloContrato(id) {
    setForm((prev) => {
      const jaSelecionado = prev.modelosContratoIds.includes(id);
      return {
        ...prev,
        modelosContratoIds: jaSelecionado
          ? prev.modelosContratoIds.filter((x) => x !== id)
          : [...prev.modelosContratoIds, id],
      };
    });
  }

  // Preview de "Valor da Parcela" — só exibição, mesma fórmula usada de
  // verdade no backend na hora de gerar o contrato (token {{Valor da
  // Parcela}} em contratosGeracao.service.js). Recalculada a cada render a
  // partir dos campos já existentes, sem estado próprio. Com 1 parcela (ou
  // sem "Valor Total" ainda preenchido) fica em branco — não é validação,
  // só não faz sentido mostrar um "valor da parcela" nesses casos.
  const numeroParcelasPreview = parseInt(form.numeroParcelas, 10) || 1;
  const valorParcelaPreview =
    numeroParcelasPreview > 1 && valorTotalCentavos
      ? formatCentavosInput(
          Math.round(((valorTotalCentavos || 0) - (valorEntradaCentavos || 0)) / numeroParcelasPreview)
        )
      : "";

  function limparFormulario() {
    setForm(ESTADO_INICIAL);
    setValorEntradaCentavos(null);
    setValorTotalCentavos(null);
    setDescontoParcelaCentavos(null);
  }

  function validar() {
    const novosErros = [];
    if (!form.cnpjCpf.trim()) novosErros.push('Informe o "CNPJ/CPF".');
    if (!form.razaoSocial.trim() && !form.contato.trim()) {
      novosErros.push('Informe "Razão Social" ou "Contato".');
    }
    if (!form.descricaoServico) novosErros.push('Selecione a "Descrição do Serviço".');
    if (!valorTotalCentavos) novosErros.push('Informe o "Valor Total".');
    if (form.email.trim() && !isValidEmail(form.email)) {
      novosErros.push('O "E-mail" informado não é válido.');
    }
    return novosErros;
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setErroEnvio("");
    setSucesso(false);
    setLinkPagamento("");

    const novosErros = validar();
    setErros(novosErros);
    if (novosErros.length > 0) return;

    const payload = {
      "Tipo de Pessoa": form.tipoPessoa,
      "Razão Social": form.razaoSocial.trim(),
      "Nome Fantasia": form.nomeFantasia.trim(),
      "CNPJ/CPF": form.cnpjCpf.trim(),
      CEP: form.cep.trim(),
      "Endereço": form.endereco.trim(),
      "Número": form.numero.trim(),
      Complemento: form.complemento.trim(),
      Bairro: form.bairro.trim(),
      Cidade: form.cidade.trim(),
      UF: form.uf,
      Contato: form.contato.trim(),
      Celular: form.celular.trim(),
      "E-mail": form.email.trim(),
      "Descrição do Serviço": form.descricaoServico,
      "Valor da Entrada": centavosParaDecimalString(valorEntradaCentavos),
      "Número de Parcelas": form.numeroParcelas,
      "Valor Total": centavosParaDecimalString(valorTotalCentavos),
      "Data Vencimento": form.dataVencimento,
      "Data da Entrada": form.dataEntrada,
      "Observações": form.observacoes.trim(),
      "Desconto Parcela": centavosParaDecimalString(descontoParcelaCentavos),
      "Créditos VP$": form.creditosVps,
      // "nomePasta"/"modelosContratoIds" são metadados internos da geração
      // de contratos (backend os separa do restante do payload antes de
      // repassar ao n8n — nunca chegam lá).
      nomePasta: form.nomePasta.trim(),
      modelosContratoIds: form.modelosContratoIds,
    };

    setEnviando(true);
    try {
      const resultado = await criarCadastro(payload);

      // POST /api/cadastros sempre responde 201 (o registro em si foi
      // salvo) — quem diz se o n8n de fato criou o cliente/cobrança é
      // "status" no corpo, não o status HTTP. "erro" cobre tanto falha de
      // transporte (timeout, webhook fora do ar) quanto falha de negócio
      // que o próprio n8n reportou (CPF inválido, cliente já existe etc.).
      if (resultado?.status === "erro") {
        setErroEnvio(
          resultado.resposta_n8n || "Não foi possível concluir o cadastro. Tente novamente."
        );
        return;
      }

      setSucesso(true);
      setLinkPagamento(resultado?.link_pagamento || "");
      limparFormulario();
    } catch (err) {
      setErroEnvio(err instanceof ApiError ? err.message : "Não foi possível enviar o cadastro.");
    } finally {
      setEnviando(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="font-display text-xl font-bold text-foreground">Cadastro</h2>
        <p className="text-sm text-muted-foreground">
          Preencha os dados abaixo para enviar um novo cadastro/faturamento.
        </p>
      </div>

      {sucesso && (
        <div className="flex items-start gap-3 rounded-xl border border-status-green/30 bg-status-green/10 px-4 py-3 text-sm text-foreground">
          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-status-green/20 text-status-green">
            <IconCheckCircle className="h-5 w-5" />
          </span>
          <div className="space-y-1">
            <p>
              <strong className="font-semibold">Cadastro enviado com sucesso.</strong> O formulário
              foi limpo para o próximo cadastro.
            </p>
            {linkPagamento && (
              <p>
                Link de pagamento:{" "}
                <a
                  href={linkPagamento}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-medium text-primary underline underline-offset-2 hover:text-primary-hover"
                >
                  {linkPagamento}
                </a>
              </p>
            )}
          </div>
        </div>
      )}

      {erroEnvio && <ErrorBanner message={erroEnvio} />}

      <form onSubmit={handleSubmit} className="space-y-6">
        {erros.length > 0 && (
          <div className="rounded-xl border border-status-red/30 bg-status-red/10 px-4 py-3 text-sm text-foreground">
            <p className="mb-1.5 flex items-center gap-2 font-semibold">
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-status-red/20 text-status-red">
                <IconAlert className="h-3.5 w-3.5" />
              </span>
              Corrija os campos abaixo antes de enviar:
            </p>
            <ul className="ml-8 list-disc space-y-0.5 text-muted-foreground">
              {erros.map((erro) => (
                <li key={erro}>{erro}</li>
              ))}
            </ul>
          </div>
        )}

        {/* Identificação */}
        <Secao icon={<IconReceipt className="h-4.5 w-4.5" />} titulo="Identificação">
          <Campo label="Tipo de Pessoa" className="sm:col-span-2">
            <div className="inline-flex rounded-xl border border-border-soft bg-surface p-1">
              {["PJ", "PF"].map((tipo) => (
                <button
                  key={tipo}
                  type="button"
                  onClick={() => handleTipoPessoa(tipo)}
                  className={`rounded-lg px-6 py-1.5 text-sm font-medium transition-colors ${
                    form.tipoPessoa === tipo
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {tipo}
                </button>
              ))}
            </div>
          </Campo>

          <Campo label="Razão Social">
            <input
              type="text"
              className={INPUT}
              value={form.razaoSocial}
              onChange={(e) => atualizarCampo("razaoSocial", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="Nome Fantasia">
            <input
              type="text"
              className={INPUT}
              value={form.nomeFantasia}
              onChange={(e) => atualizarCampo("nomeFantasia", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="CNPJ/CPF" className="sm:col-span-2">
            <input
              type="text"
              inputMode="numeric"
              className={INPUT_MONO}
              value={form.cnpjCpf}
              onChange={(e) => atualizarCampo("cnpjCpf", maskCpfCnpj(e.target.value, form.tipoPessoa))}
              placeholder={form.tipoPessoa === "PF" ? "000.000.000-00" : "00.000.000/0000-00"}
              disabled={enviando}
            />
          </Campo>
        </Secao>

        {/* Endereço */}
        <Secao icon={<IconMapPin className="h-4.5 w-4.5" />} titulo="Endereço">
          <Campo label="CEP">
            <input
              type="text"
              inputMode="numeric"
              className={INPUT_MONO}
              value={form.cep}
              onChange={(e) => atualizarCampo("cep", maskCep(e.target.value))}
              placeholder="00000-000"
              disabled={enviando}
            />
          </Campo>

          <Campo label="Número">
            <input
              type="text"
              className={INPUT}
              value={form.numero}
              onChange={(e) => atualizarCampo("numero", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="Endereço" className="sm:col-span-2">
            <input
              type="text"
              className={INPUT}
              value={form.endereco}
              onChange={(e) => atualizarCampo("endereco", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="Complemento" opcional>
            <input
              type="text"
              className={INPUT}
              value={form.complemento}
              onChange={(e) => atualizarCampo("complemento", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="Bairro">
            <input
              type="text"
              className={INPUT}
              value={form.bairro}
              onChange={(e) => atualizarCampo("bairro", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="Cidade">
            <input
              type="text"
              className={INPUT}
              value={form.cidade}
              onChange={(e) => atualizarCampo("cidade", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="UF">
            <select
              className={INPUT}
              value={form.uf}
              onChange={(e) => atualizarCampo("uf", e.target.value)}
              disabled={enviando}
            >
              <option value="">Selecione...</option>
              {UFS.map((uf) => (
                <option key={uf} value={uf}>
                  {uf}
                </option>
              ))}
            </select>
          </Campo>
        </Secao>

        {/* Contato */}
        <Secao icon={<IconUser className="h-4.5 w-4.5" />} titulo="Contato">
          <Campo label="Contato">
            <input
              type="text"
              className={INPUT}
              value={form.contato}
              onChange={(e) => atualizarCampo("contato", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="Celular">
            <input
              type="text"
              inputMode="numeric"
              className={INPUT_MONO}
              value={form.celular}
              onChange={(e) => atualizarCampo("celular", maskCelular(e.target.value))}
              placeholder="(00) 00000-0000"
              disabled={enviando}
            />
          </Campo>

          <Campo label="E-mail" className="sm:col-span-2">
            <input
              type="email"
              className={INPUT}
              value={form.email}
              onChange={(e) => atualizarCampo("email", e.target.value)}
              placeholder="nome@empresa.com"
              disabled={enviando}
            />
          </Campo>
        </Secao>

        {/* Faturamento */}
        <Secao icon={<IconBanknote className="h-4.5 w-4.5" />} titulo="Faturamento">
          <Campo label="Descrição do Serviço" className="sm:col-span-2">
            <select
              className={INPUT}
              value={form.descricaoServico}
              onChange={(e) => atualizarCampo("descricaoServico", e.target.value)}
              disabled={enviando}
            >
              <option value="">Selecione...</option>
              {DESCRICOES_SERVICO.map((opcao) => (
                <option key={opcao} value={opcao}>
                  {opcao}
                </option>
              ))}
            </select>
          </Campo>

          <Campo label="Nome da pasta" opcional>
            <input
              type="text"
              className={INPUT}
              value={form.nomePasta}
              onChange={(e) => atualizarCampo("nomePasta", e.target.value)}
              placeholder="ex.: Empresa XYZ Ltda"
              disabled={enviando}
            />
          </Campo>

          <Campo label="Créditos VP$" opcional>
            <select
              className={INPUT}
              value={form.creditosVps}
              onChange={(e) => atualizarCampo("creditosVps", e.target.value)}
              disabled={enviando}
            >
              {OPCOES_CREDITOS_VPS.map((opcao) => (
                <option key={opcao.valor} value={opcao.valor}>
                  {opcao.label}
                </option>
              ))}
            </select>
          </Campo>

          <Campo label="Contratos a gerar" opcional className="sm:col-span-2">
            {carregandoModelos ? (
              <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
                <Spinner className="h-3.5 w-3.5" />
                Carregando modelos...
              </div>
            ) : modelosDisponiveis.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Nenhum modelo de contrato ativo cadastrado.
              </p>
            ) : (
              <div className="flex flex-wrap gap-x-5 gap-y-2">
                {modelosDisponiveis.map((modelo) => (
                  <label
                    key={modelo.id}
                    className="flex cursor-pointer items-center gap-2 text-sm text-foreground"
                  >
                    <input
                      type="checkbox"
                      checked={form.modelosContratoIds.includes(modelo.id)}
                      onChange={() => toggleModeloContrato(modelo.id)}
                      disabled={enviando}
                      className="h-4 w-4 rounded border-border-soft text-primary focus:ring-primary/40"
                    />
                    {modelo.nome}
                  </label>
                ))}
              </div>
            )}
          </Campo>

          <Campo label="Valor da Entrada" opcional>
            <input
              type="text"
              inputMode="numeric"
              className={INPUT_MONO}
              value={formatCentavosInput(valorEntradaCentavos)}
              onChange={(e) => setValorEntradaCentavos(digitosParaCentavos(e.target.value))}
              placeholder="R$ 0,00"
              disabled={enviando}
            />
          </Campo>

          <Campo label="Data da Entrada" opcional>
            <DatePicker
              value={form.dataEntrada}
              onChange={(iso) => atualizarCampo("dataEntrada", iso)}
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Relevante quando houver &ldquo;Valor da Entrada&rdquo;. Se ficar vazio, assume-se a
              data de envio deste cadastro.
            </p>
          </Campo>

          <Campo label="Número de Parcelas">
            <select
              className={INPUT}
              value={form.numeroParcelas}
              onChange={(e) => atualizarCampo("numeroParcelas", e.target.value)}
              disabled={enviando}
            >
              {OPCOES_PARCELAS.map((n) => (
                <option key={n} value={String(n)}>
                  {n}x
                </option>
              ))}
            </select>
          </Campo>

          <Campo label="Valor da Parcela" opcional>
            <input
              type="text"
              readOnly
              disabled
              className={`${INPUT_MONO} cursor-not-allowed`}
              value={valorParcelaPreview}
              placeholder="R$ 0,00"
            />
            <p className="mt-1 text-[11px] text-muted-foreground">
              Só um preview — o cálculo de verdade é feito na geração do contrato.
            </p>
          </Campo>

          <Campo label="Valor Total">
            <input
              type="text"
              inputMode="numeric"
              className={INPUT_MONO}
              value={formatCentavosInput(valorTotalCentavos)}
              onChange={(e) => setValorTotalCentavos(digitosParaCentavos(e.target.value))}
              placeholder="R$ 0,00"
              disabled={enviando}
            />
          </Campo>

          <Campo label="Data Vencimento">
            <DatePicker
              value={form.dataVencimento}
              onChange={(iso) => atualizarCampo("dataVencimento", iso)}
            />
          </Campo>

          <Campo label="Observações" className="sm:col-span-2">
            <textarea
              rows={3}
              className={`${INPUT} resize-none`}
              value={form.observacoes}
              onChange={(e) => atualizarCampo("observacoes", e.target.value)}
              disabled={enviando}
            />
          </Campo>

          <Campo label="Desconto Parcela" opcional>
            <input
              type="text"
              inputMode="numeric"
              className={INPUT_MONO}
              value={formatCentavosInput(descontoParcelaCentavos)}
              onChange={(e) => setDescontoParcelaCentavos(digitosParaCentavos(e.target.value))}
              placeholder="R$ 0,00"
              disabled={enviando}
            />
          </Campo>
        </Secao>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={enviando}
            className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-60"
          >
            {enviando && <Spinner className="h-4 w-4" />}
            {enviando ? "Enviando..." : "Enviar cadastro"}
          </button>
        </div>
      </form>
    </div>
  );
}
