"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  listarApiKeys,
  criarApiKey,
  revogarApiKey,
  getSyncLog,
  getAsaasKeyMascarada,
  atualizarAsaasKey,
  getWebhookCadastroUrl,
  atualizarWebhookCadastroUrl,
  getToleranciaDias,
  atualizarToleranciaDias,
  getDrivePastaRaiz,
  atualizarDrivePastaRaiz,
  ApiError,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconKey, IconHistory, IconClock, IconFileText } from "@/components/icons";

export default function ConfiguracoesPage() {
  const [apiKeys, setApiKeys] = useState([]);
  const [carregandoChaves, setCarregandoChaves] = useState(true);
  const [erroChaves, setErroChaves] = useState("");

  const [novoNomeChave, setNovoNomeChave] = useState("");
  const [criandoChave, setCriandoChave] = useState(false);
  const [chaveRevelada, setChaveRevelada] = useState(null);
  const [copiado, setCopiado] = useState(false);

  const [confirmandoRevogarId, setConfirmandoRevogarId] = useState(null);
  const [revogandoId, setRevogandoId] = useState(null);

  const [webhookCadastroUrl, setWebhookCadastroUrl] = useState(null);
  const [carregandoWebhookCadastro, setCarregandoWebhookCadastro] = useState(true);
  const [erroWebhookCadastro, setErroWebhookCadastro] = useState("");
  const [novoWebhookCadastro, setNovoWebhookCadastro] = useState("");
  const [salvandoWebhookCadastro, setSalvandoWebhookCadastro] = useState(false);
  const [webhookCadastroSalvo, setWebhookCadastroSalvo] = useState(false);

  const [logs, setLogs] = useState([]);
  const [carregandoLogs, setCarregandoLogs] = useState(true);
  const [erroLogs, setErroLogs] = useState("");

  const [asaasKeyMascarada, setAsaasKeyMascarada] = useState(null);
  const [carregandoAsaasKey, setCarregandoAsaasKey] = useState(true);
  const [erroAsaasKey, setErroAsaasKey] = useState("");
  const [novaAsaasChave, setNovaAsaasChave] = useState("");
  const [salvandoAsaasChave, setSalvandoAsaasChave] = useState(false);
  const [asaasChaveSalva, setAsaasChaveSalva] = useState(false);

  const [toleranciaDias, setToleranciaDias] = useState(null);
  const [carregandoTolerancia, setCarregandoTolerancia] = useState(true);
  const [erroTolerancia, setErroTolerancia] = useState("");
  const [toleranciaInput, setToleranciaInput] = useState("");
  const [salvandoTolerancia, setSalvandoTolerancia] = useState(false);
  const [toleranciaSalva, setToleranciaSalva] = useState(false);

  const [drivePastaRaizId, setDrivePastaRaizId] = useState(null);
  const [carregandoDrivePastaRaiz, setCarregandoDrivePastaRaiz] = useState(true);
  const [erroDrivePastaRaiz, setErroDrivePastaRaiz] = useState("");
  const [novoDrivePastaRaiz, setNovoDrivePastaRaiz] = useState("");
  const [salvandoDrivePastaRaiz, setSalvandoDrivePastaRaiz] = useState(false);
  const [drivePastaRaizSalva, setDrivePastaRaizSalva] = useState(false);

  const carregarApiKeys = useCallback(async () => {
    setCarregandoChaves(true);
    setErroChaves("");
    try {
      const data = await listarApiKeys();
      setApiKeys(Array.isArray(data) ? data : []);
    } catch (err) {
      setErroChaves(err instanceof ApiError ? err.message : "Erro ao carregar as API keys.");
    } finally {
      setCarregandoChaves(false);
    }
  }, []);

  const carregarWebhookCadastro = useCallback(async () => {
    setCarregandoWebhookCadastro(true);
    setErroWebhookCadastro("");
    try {
      const data = await getWebhookCadastroUrl();
      setWebhookCadastroUrl(data.n8n_webhook_cadastro_url);
      setNovoWebhookCadastro(data.n8n_webhook_cadastro_url || "");
    } catch (err) {
      setErroWebhookCadastro(
        err instanceof ApiError ? err.message : "Erro ao carregar a URL do webhook de cadastro."
      );
    } finally {
      setCarregandoWebhookCadastro(false);
    }
  }, []);

  const carregarLogs = useCallback(async () => {
    setCarregandoLogs(true);
    setErroLogs("");
    try {
      const data = await getSyncLog();
      setLogs(Array.isArray(data) ? data : []);
    } catch (err) {
      setErroLogs(err instanceof ApiError ? err.message : "Erro ao carregar o log de sincronizações.");
    } finally {
      setCarregandoLogs(false);
    }
  }, []);

  const carregarAsaasKey = useCallback(async () => {
    setCarregandoAsaasKey(true);
    setErroAsaasKey("");
    try {
      const data = await getAsaasKeyMascarada();
      setAsaasKeyMascarada(data.asaas_api_key);
    } catch (err) {
      setErroAsaasKey(err instanceof ApiError ? err.message : "Erro ao carregar a chave do Asaas.");
    } finally {
      setCarregandoAsaasKey(false);
    }
  }, []);

  const carregarTolerancia = useCallback(async () => {
    setCarregandoTolerancia(true);
    setErroTolerancia("");
    try {
      const data = await getToleranciaDias();
      setToleranciaDias(data.dias);
      setToleranciaInput(String(data.dias));
    } catch (err) {
      setErroTolerancia(err instanceof ApiError ? err.message : "Erro ao carregar o período de tolerância.");
    } finally {
      setCarregandoTolerancia(false);
    }
  }, []);

  const carregarDrivePastaRaiz = useCallback(async () => {
    setCarregandoDrivePastaRaiz(true);
    setErroDrivePastaRaiz("");
    try {
      const data = await getDrivePastaRaiz();
      setDrivePastaRaizId(data.drive_pasta_raiz_id);
      setNovoDrivePastaRaiz(data.drive_pasta_raiz_id || "");
    } catch (err) {
      setErroDrivePastaRaiz(
        err instanceof ApiError ? err.message : "Erro ao carregar a pasta raiz do Drive."
      );
    } finally {
      setCarregandoDrivePastaRaiz(false);
    }
  }, []);

  useEffect(() => {
    carregarApiKeys();
    carregarWebhookCadastro();
    carregarLogs();
    carregarAsaasKey();
    carregarTolerancia();
    carregarDrivePastaRaiz();
  }, [
    carregarApiKeys,
    carregarWebhookCadastro,
    carregarLogs,
    carregarAsaasKey,
    carregarTolerancia,
    carregarDrivePastaRaiz,
  ]);

  async function handleCriarChave() {
    if (!novoNomeChave.trim()) return;
    setCriandoChave(true);
    setErroChaves("");
    try {
      const nova = await criarApiKey(novoNomeChave.trim());
      setChaveRevelada(nova);
      setNovoNomeChave("");
      await carregarApiKeys();
    } catch (err) {
      setErroChaves(err instanceof ApiError ? err.message : "Não foi possível gerar a nova chave.");
    } finally {
      setCriandoChave(false);
    }
  }

  async function handleRevogar(id) {
    setRevogandoId(id);
    setErroChaves("");
    try {
      await revogarApiKey(id);
      setConfirmandoRevogarId(null);
      await carregarApiKeys();
    } catch (err) {
      setErroChaves(err instanceof ApiError ? err.message : "Não foi possível revogar a chave.");
    } finally {
      setRevogandoId(null);
    }
  }

  async function handleCopiar() {
    if (!chaveRevelada?.chave) return;
    try {
      await navigator.clipboard.writeText(chaveRevelada.chave);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sem permissão de clipboard — o usuário ainda pode selecionar o texto manualmente.
    }
  }

  function fecharRevelacao() {
    setChaveRevelada(null);
    setCopiado(false);
  }

  async function handleSalvarWebhookCadastro() {
    if (!novoWebhookCadastro.trim()) return;
    setSalvandoWebhookCadastro(true);
    setErroWebhookCadastro("");
    setWebhookCadastroSalvo(false);
    try {
      const data = await atualizarWebhookCadastroUrl(novoWebhookCadastro.trim());
      setWebhookCadastroUrl(data.n8n_webhook_cadastro_url);
      setWebhookCadastroSalvo(true);
      setTimeout(() => setWebhookCadastroSalvo(false), 2500);
    } catch (err) {
      setErroWebhookCadastro(
        err instanceof ApiError ? err.message : "Não foi possível salvar a URL do webhook."
      );
    } finally {
      setSalvandoWebhookCadastro(false);
    }
  }

  async function handleSalvarDrivePastaRaiz() {
    if (!novoDrivePastaRaiz.trim()) return;
    setSalvandoDrivePastaRaiz(true);
    setErroDrivePastaRaiz("");
    setDrivePastaRaizSalva(false);
    try {
      const data = await atualizarDrivePastaRaiz(novoDrivePastaRaiz.trim());
      setDrivePastaRaizId(data.drive_pasta_raiz_id);
      setNovoDrivePastaRaiz(data.drive_pasta_raiz_id || "");
      setDrivePastaRaizSalva(true);
      setTimeout(() => setDrivePastaRaizSalva(false), 2500);
    } catch (err) {
      setErroDrivePastaRaiz(
        err instanceof ApiError ? err.message : "Não foi possível salvar a pasta raiz do Drive."
      );
    } finally {
      setSalvandoDrivePastaRaiz(false);
    }
  }

  async function handleSalvarAsaasChave() {
    if (!novaAsaasChave.trim()) return;
    setSalvandoAsaasChave(true);
    setErroAsaasKey("");
    setAsaasChaveSalva(false);
    try {
      const data = await atualizarAsaasKey(novaAsaasChave.trim());
      setAsaasKeyMascarada(data.asaas_api_key);
      setNovaAsaasChave("");
      setAsaasChaveSalva(true);
      setTimeout(() => setAsaasChaveSalva(false), 2500);
    } catch (err) {
      setErroAsaasKey(err instanceof ApiError ? err.message : "Não foi possível salvar a chave do Asaas.");
    } finally {
      setSalvandoAsaasChave(false);
    }
  }

  const toleranciaInputValida = (() => {
    if (toleranciaInput.trim() === "") return false;
    const n = Number(toleranciaInput);
    return Number.isInteger(n) && n >= 0 && n <= 30;
  })();

  async function handleSalvarTolerancia() {
    if (!toleranciaInputValida) return;
    setSalvandoTolerancia(true);
    setErroTolerancia("");
    setToleranciaSalva(false);
    try {
      const data = await atualizarToleranciaDias(Number(toleranciaInput));
      setToleranciaDias(data.dias);
      setToleranciaInput(String(data.dias));
      setToleranciaSalva(true);
      setTimeout(() => setToleranciaSalva(false), 2500);
    } catch (err) {
      setErroTolerancia(err instanceof ApiError ? err.message : "Não foi possível salvar o período de tolerância.");
    } finally {
      setSalvandoTolerancia(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="font-display text-xl font-bold text-foreground">Configurações</h2>
        <p className="text-sm text-muted-foreground">
          Gerencie a chave de integração da API e acompanhe as sincronizações recentes.
        </p>
      </div>

      {/* Chaves de API */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconKey className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Chaves de API</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Usadas por integrações externas (ex.: n8n) para autenticar chamadas em{" "}
          <code className="rounded bg-surface-elevated px-1 py-0.5 font-mono text-[11px]">
            POST /api/sync
          </code>{" "}
          e demais endpoints protegidos. Gere uma chave por integração para poder revogar uma sem
          derrubar as outras.
        </p>

        {erroChaves && (
          <div className="mt-3">
            <ErrorBanner message={erroChaves} onRetry={carregarApiKeys} />
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={novoNomeChave}
            onChange={(e) => setNovoNomeChave(e.target.value)}
            placeholder="Nome da chave (ex.: n8n - Sync Cobrança)"
            disabled={criandoChave}
            className="w-full min-w-0 flex-1 rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleCriarChave}
            disabled={!novoNomeChave.trim() || criandoChave}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {criandoChave && <Spinner className="h-3.5 w-3.5" />}
            Gerar nova chave
          </button>
        </div>

        <div className="mt-4 space-y-2">
          {carregandoChaves ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-5 w-5" />
            </div>
          ) : apiKeys.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Nenhuma chave cadastrada ainda.</p>
          ) : (
            apiKeys.map((chave) => (
              <div
                key={chave.id}
                className={`rounded-xl border p-3.5 ${
                  chave.ativa ? "border-border-soft bg-surface-elevated" : "border-border-soft/60 bg-surface-elevated/40 opacity-70"
                }`}
              >
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">{chave.nome}</span>
                      {chave.ativa ? (
                        <span className="inline-flex items-center rounded-full bg-status-green/15 px-2 py-0.5 text-[11px] font-medium text-status-green">
                          Ativa
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-status-red/15 px-2 py-0.5 text-[11px] font-medium text-status-red">
                          Revogada
                        </span>
                      )}
                    </div>
                    <code className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                      {chave.chave_mascarada}
                    </code>
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Criada em {formatDateTime(chave.criada_em)}
                      {chave.ultimo_uso_em
                        ? ` · Último uso em ${formatDateTime(chave.ultimo_uso_em)}`
                        : " · Nunca usada"}
                    </p>
                  </div>

                  {chave.ativa &&
                    (confirmandoRevogarId === chave.id ? (
                      <div className="flex shrink-0 items-center gap-2">
                        <button
                          type="button"
                          onClick={() => setConfirmandoRevogarId(null)}
                          disabled={revogandoId === chave.id}
                          className="text-xs font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          onClick={() => handleRevogar(chave.id)}
                          disabled={revogandoId === chave.id}
                          className="flex items-center gap-1.5 rounded-lg bg-status-red px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                          {revogandoId === chave.id && <Spinner className="h-3 w-3" />}
                          Confirmar
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmandoRevogarId(chave.id)}
                        className="shrink-0 rounded-lg border border-status-red/40 px-3 py-1.5 text-xs font-medium text-status-red transition-colors hover:bg-status-red/10"
                      >
                        Revogar
                      </button>
                    ))}
                </div>
              </div>
            ))
          )}
        </div>
      </section>

      {/* Webhook de Cadastro/Faturamento */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconKey className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Webhook de Cadastro/Faturamento</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          URL do fluxo do n8n chamada por{" "}
          <code className="rounded bg-surface-elevated px-1 py-0.5 font-mono text-[11px]">
            POST /api/cadastros
          </code>{" "}
          (tela{" "}
          <Link href="/cadastro" className="text-accent hover:underline">
            Cadastro
          </Link>
          ) para criar cliente/cobrança no Bling e no Asaas.
        </p>

        {erroWebhookCadastro && (
          <div className="mt-3">
            <ErrorBanner message={erroWebhookCadastro} onRetry={carregarWebhookCadastro} />
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="url"
            value={novoWebhookCadastro}
            onChange={(e) => setNovoWebhookCadastro(e.target.value)}
            placeholder="https://..."
            disabled={carregandoWebhookCadastro || salvandoWebhookCadastro}
            className="w-full min-w-0 flex-1 rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSalvarWebhookCadastro}
            disabled={!novoWebhookCadastro.trim() || salvandoWebhookCadastro || carregandoWebhookCadastro}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {salvandoWebhookCadastro && <Spinner className="h-3.5 w-3.5" />}
            Salvar
          </button>
        </div>

        {!carregandoWebhookCadastro && !webhookCadastroUrl && (
          <p className="mt-2 text-xs text-status-yellow">
            Ainda não configurada — o envio de cadastros vai falhar até uma URL ser salva.
          </p>
        )}
        {webhookCadastroSalvo && (
          <span className="mt-2 block text-xs font-medium text-status-green">Salvo com sucesso.</span>
        )}
      </section>

      {/* Pasta raiz do Google Drive */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconFileText className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Pasta raiz do Google Drive</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Pasta-mãe onde ficam as pastas de cada associado. Usada na{" "}
          <Link href="/cadastro" className="text-accent hover:underline">
            geração automática de contratos
          </Link>{" "}
          para criar a pasta do associado e subir os .docx gerados a partir dos modelos em{" "}
          <Link href="/contratos" className="text-accent hover:underline">
            Contratos
          </Link>
          . Aceita o ID da pasta ou o link completo do Drive.
        </p>

        {erroDrivePastaRaiz && (
          <div className="mt-3">
            <ErrorBanner message={erroDrivePastaRaiz} onRetry={carregarDrivePastaRaiz} />
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="text"
            value={novoDrivePastaRaiz}
            onChange={(e) => setNovoDrivePastaRaiz(e.target.value)}
            placeholder="ID da pasta ou https://drive.google.com/drive/folders/..."
            disabled={carregandoDrivePastaRaiz || salvandoDrivePastaRaiz}
            className="w-full min-w-0 flex-1 rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSalvarDrivePastaRaiz}
            disabled={!novoDrivePastaRaiz.trim() || salvandoDrivePastaRaiz || carregandoDrivePastaRaiz}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {salvandoDrivePastaRaiz && <Spinner className="h-3.5 w-3.5" />}
            Salvar
          </button>
        </div>

        {!carregandoDrivePastaRaiz && !drivePastaRaizId && (
          <p className="mt-2 text-xs text-status-yellow">
            Ainda não configurada — contratos com modelos selecionados não vão subir pro Drive até uma
            pasta raiz ser salva.
          </p>
        )}
        {drivePastaRaizSalva && (
          <span className="mt-2 block text-xs font-medium text-status-green">Salvo com sucesso.</span>
        )}
      </section>

      {/* Chave de API do Asaas */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconKey className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Chave de API do Asaas</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Usada pela tela{" "}
          <Link href="/inadimplencia" className="text-accent hover:underline">
            Taxa de Inadimplência
          </Link>{" "}
          para consultar pagamentos diretamente na API do Asaas. Tratada como sensível: nunca é exibida por
          inteiro depois de salva, só mascarada.
        </p>

        {erroAsaasKey && (
          <div className="mt-3">
            <ErrorBanner message={erroAsaasKey} onRetry={carregarAsaasKey} />
          </div>
        )}

        <div className="mt-4 flex w-full min-w-0 items-center gap-3">
          <code
            className="block min-w-0 flex-1 break-all rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 font-mono text-sm text-foreground"
            title={asaasKeyMascarada || undefined}
          >
            {carregandoAsaasKey ? <Spinner className="h-4 w-4" /> : asaasKeyMascarada || "Não configurada"}
          </code>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            type="password"
            value={novaAsaasChave}
            onChange={(e) => setNovaAsaasChave(e.target.value)}
            placeholder="$aact_prod_..."
            disabled={salvandoAsaasChave}
            className="w-full flex-1 rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 font-mono text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:cursor-not-allowed disabled:opacity-60"
          />
          <button
            type="button"
            onClick={handleSalvarAsaasChave}
            disabled={!novaAsaasChave.trim() || salvandoAsaasChave}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {salvandoAsaasChave && <Spinner className="h-3.5 w-3.5" />}
            Salvar
          </button>
        </div>
        {asaasChaveSalva && <span className="mt-2 block text-xs font-medium text-status-green">Salvo com sucesso.</span>}
      </section>

      {/* Período de Tolerância */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconClock className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Período de Tolerância</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Usado no cálculo da{" "}
          <Link href="/inadimplencia" className="text-accent hover:underline">
            Taxa de Inadimplência
          </Link>{" "}
          para decidir quando uma cobrança em atraso passa a contar como inadimplente.
        </p>

        {erroTolerancia && (
          <div className="mt-3">
            <ErrorBanner message={erroTolerancia} onRetry={carregarTolerancia} />
          </div>
        )}

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <div className="flex w-full max-w-[160px] items-center gap-2 rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 focus-within:border-primary focus-within:ring-2 focus-within:ring-primary/40">
            {carregandoTolerancia ? (
              <Spinner className="h-4 w-4" />
            ) : (
              <>
                <input
                  type="number"
                  min={0}
                  max={30}
                  step={1}
                  value={toleranciaInput}
                  onChange={(e) => setToleranciaInput(e.target.value)}
                  disabled={salvandoTolerancia}
                  className="w-full min-w-0 bg-transparent text-sm text-foreground focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
                />
                <span className="shrink-0 text-xs text-muted-foreground">dias</span>
              </>
            )}
          </div>
          <button
            type="button"
            onClick={handleSalvarTolerancia}
            disabled={!toleranciaInputValida || salvandoTolerancia || carregandoTolerancia}
            className="flex shrink-0 items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {salvandoTolerancia && <Spinner className="h-3.5 w-3.5" />}
            Salvar
          </button>
        </div>

        <p className="mt-2 text-xs text-muted-foreground">
          Atrasos de até {toleranciaDias ?? 0} {toleranciaDias === 1 ? "dia não é considerado" : "dias não são considerados"}{" "}
          inadimplência, para absorver variações normais de processamento bancário (ex.: float de fim de semana).
        </p>

        {toleranciaSalva && <span className="mt-2 block text-xs font-medium text-status-green">Salvo com sucesso.</span>}
      </section>

      {/* Log de sincronizações */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconHistory className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Log de sincronizações</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">Últimas 20 execuções de POST /api/sync.</p>

        {erroLogs && (
          <div className="mt-3">
            <ErrorBanner message={erroLogs} onRetry={carregarLogs} />
          </div>
        )}

        <div className="scrollbar-thin mt-4 overflow-x-auto rounded-xl border border-border-soft">
          <table className="w-full min-w-[480px] text-left text-sm">
            <thead>
              <tr className="border-b border-border-soft bg-surface-elevated text-xs uppercase tracking-wide text-muted-foreground">
                <th className="px-4 py-2.5 font-semibold">Data/hora</th>
                <th className="px-4 py-2.5 font-semibold">Associados processados</th>
                <th className="px-4 py-2.5 font-semibold">Status</th>
              </tr>
            </thead>
            <tbody>
              {carregandoLogs ? (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center">
                    <Spinner className="mx-auto h-5 w-5" />
                  </td>
                </tr>
              ) : logs.length === 0 ? (
                <tr>
                  <td colSpan={3} className="px-4 py-10 text-center text-muted-foreground">
                    Nenhuma sincronização registrada ainda.
                  </td>
                </tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="border-b border-border-soft/60 last:border-0">
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground">
                      {formatDateTime(log.executado_em)}
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-foreground">
                      {log.total_associados_processados}
                    </td>
                    <td className="px-4 py-2.5">
                      {log.sucesso ? (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-status-green/15 px-2.5 py-1 text-xs font-medium text-status-green">
                          <span className="h-1.5 w-1.5 rounded-full bg-status-green" />
                          Sucesso
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-status-red/15 px-2.5 py-1 text-xs font-medium text-status-red">
                          <span className="h-1.5 w-1.5 rounded-full bg-status-red" />
                          Falha
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* Modal de revelação da nova chave */}
      {chaveRevelada && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={fecharRevelacao}
        >
          <div
            className="w-full max-w-lg rounded-3xl border border-border-soft bg-surface p-6 shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-foreground">
              Chave &ldquo;{chaveRevelada.nome}&rdquo; gerada
            </h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Guarde esta chave agora — por segurança, ela <strong>não será exibida completa
              novamente</strong>. Atualize imediatamente o sistema integrado (ex.: automação no n8n)
              com o novo valor abaixo.
            </p>

            <div className="mt-4 flex min-w-0 items-center gap-2">
              <code className="block min-w-0 flex-1 break-all rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 font-mono text-xs text-foreground">
                {chaveRevelada.chave}
              </code>
              <button
                type="button"
                onClick={handleCopiar}
                className="shrink-0 rounded-xl bg-primary px-3.5 py-2.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
              >
                {copiado ? "Copiado!" : "Copiar"}
              </button>
            </div>

            <button
              type="button"
              onClick={fecharRevelacao}
              className="mt-5 w-full rounded-xl border border-border-soft px-4 py-2.5 text-sm font-medium text-foreground transition-colors hover:bg-surface-hover"
            >
              Entendi, fechar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
