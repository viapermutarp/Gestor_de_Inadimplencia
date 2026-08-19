"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  getApiKeyMascarada,
  regenerarApiKey,
  getSyncLog,
  getAsaasKeyMascarada,
  atualizarAsaasKey,
  getToleranciaDias,
  atualizarToleranciaDias,
  ApiError,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconKey, IconHistory, IconClock } from "@/components/icons";

export default function ConfiguracoesPage() {
  const [apiKeyMascarada, setApiKeyMascarada] = useState(null);
  const [carregandoChave, setCarregandoChave] = useState(true);
  const [erroChave, setErroChave] = useState("");

  const [confirmandoRegenerar, setConfirmandoRegenerar] = useState(false);
  const [regenerando, setRegenerando] = useState(false);
  const [novaChave, setNovaChave] = useState(null);
  const [copiado, setCopiado] = useState(false);

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

  const carregarApiKey = useCallback(async () => {
    setCarregandoChave(true);
    setErroChave("");
    try {
      const data = await getApiKeyMascarada();
      setApiKeyMascarada(data.api_key);
    } catch (err) {
      setErroChave(err instanceof ApiError ? err.message : "Erro ao carregar a API key.");
    } finally {
      setCarregandoChave(false);
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

  useEffect(() => {
    carregarApiKey();
    carregarLogs();
    carregarAsaasKey();
    carregarTolerancia();
  }, [carregarApiKey, carregarLogs, carregarAsaasKey, carregarTolerancia]);

  async function handleRegenerar() {
    setRegenerando(true);
    setErroChave("");
    try {
      const data = await regenerarApiKey();
      setNovaChave(data.api_key);
      setConfirmandoRegenerar(false);
      await carregarApiKey();
    } catch (err) {
      setErroChave(err instanceof ApiError ? err.message : "Não foi possível regenerar a API key.");
    } finally {
      setRegenerando(false);
    }
  }

  async function handleCopiar() {
    if (!novaChave) return;
    try {
      await navigator.clipboard.writeText(novaChave);
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      // Sem permissão de clipboard — o usuário ainda pode selecionar o texto manualmente.
    }
  }

  function fecharRevelacao() {
    setNovaChave(null);
    setCopiado(false);
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

      {/* Chave de API */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconKey className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Chave de API</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Usada por integrações externas (ex.: n8n) para autenticar chamadas em{" "}
          <code className="rounded bg-surface-elevated px-1 py-0.5 font-mono text-[11px]">
            POST /api/sync
          </code>{" "}
          e demais endpoints protegidos.
        </p>

        {erroChave && (
          <div className="mt-3">
            <ErrorBanner message={erroChave} onRetry={carregarApiKey} />
          </div>
        )}

        <div className="mt-4 flex w-full min-w-0 items-center gap-3">
          <code
            className="scrollbar-thin block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 font-mono text-sm text-foreground"
            title={apiKeyMascarada || undefined}
          >
            {carregandoChave ? <Spinner className="h-4 w-4" /> : apiKeyMascarada || "—"}
          </code>
        </div>

        <div className="mt-4">
          {!confirmandoRegenerar ? (
            <button
              type="button"
              onClick={() => setConfirmandoRegenerar(true)}
              className="rounded-xl bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
            >
              Regenerar API Key
            </button>
          ) : (
            <div className="space-y-3 rounded-xl border border-status-yellow/40 bg-status-yellow/10 p-4">
              <p className="text-sm text-foreground">
                Isso vai gerar uma chave nova e <strong>invalidar a chave atual imediatamente</strong>.
                Qualquer integração ativa (ex.: automações no n8n) vai parar de funcionar até ser
                atualizada com a nova chave. Tem certeza?
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => setConfirmandoRegenerar(false)}
                  disabled={regenerando}
                  className="rounded-lg px-3.5 py-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={handleRegenerar}
                  disabled={regenerando}
                  className="flex items-center gap-2 rounded-lg bg-status-yellow px-3.5 py-2 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {regenerando && <Spinner className="h-3.5 w-3.5" />}
                  Confirmar regeneração
                </button>
              </div>
            </div>
          )}
        </div>
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
            className="scrollbar-thin block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 font-mono text-sm text-foreground"
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
      {novaChave && (
        <div
          className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
          onClick={fecharRevelacao}
        >
          <div
            className="w-full max-w-lg rounded-3xl border border-border-soft bg-surface p-6 shadow-2xl shadow-black/50"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="font-display text-lg font-bold text-foreground">Nova API Key gerada</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Guarde esta chave agora — por segurança, ela <strong>não será exibida completa
              novamente</strong>. Atualize imediatamente qualquer sistema integrado (ex.: automações no
              n8n) com o novo valor abaixo.
            </p>

            <div className="mt-4 flex min-w-0 items-center gap-2">
              <code className="scrollbar-thin block min-w-0 flex-1 overflow-x-auto whitespace-nowrap rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 font-mono text-xs text-foreground">
                {novaChave}
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
