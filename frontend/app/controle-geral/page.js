"use client";

import { useCallback, useEffect, useState } from "react";
import {
  listarFranquias,
  criarFranquia,
  atualizarFranquia,
  excluirFranquiaPermanentemente,
  criarUsuarioExtra,
  atualizarStatusUsuario,
  atualizarRecursosUsuario,
  resetarSenhaUsuario,
  getPerfil,
  atualizarPerfil,
  ApiError,
} from "@/lib/api";
import { formatDateTime } from "@/lib/format";
import { RECURSOS, CHAVES_RECURSOS } from "@/lib/recursos";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconBuilding, IconUser, IconPlus, IconLock, IconShield, IconAlert } from "@/components/icons";

/** Checkboxes de "recursosPermitidos" — reaproveitado no form de criar franquia (usuário titular), criar usuário extra e editar telas de um usuário existente. Por USUÁRIO desde o ajuste "Super Admin pode adicionar mais de 1 usuário numa franquia" (ver docs/plano-multi-franquia.md, seção 8, item 8). */
function CheckboxesRecursos({ selecionados, onAlternar, disabled }) {
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3">
      {RECURSOS.map((r) => (
        <label key={r.chave} className="flex items-center gap-2 text-xs text-foreground">
          <input
            type="checkbox"
            checked={selecionados.includes(r.chave)}
            onChange={() => onAlternar(r.chave)}
            disabled={disabled}
            className="h-3.5 w-3.5 rounded border-border-soft accent-primary"
          />
          {r.label}
        </label>
      ))}
    </div>
  );
}

function alternarChave(lista, chave) {
  return lista.includes(chave) ? lista.filter((c) => c !== chave) : [...lista, chave];
}

export default function ControleGeralPage() {
  const [franquias, setFranquias] = useState([]);
  const [carregandoFranquias, setCarregandoFranquias] = useState(true);
  const [erroFranquias, setErroFranquias] = useState("");

  const [mostrarFormCriar, setMostrarFormCriar] = useState(false);
  const [novaFranquiaNome, setNovaFranquiaNome] = useState("");
  const [novoUsuarioNome, setNovoUsuarioNome] = useState("");
  const [novoUsuarioEmail, setNovoUsuarioEmail] = useState("");
  const [novoUsuarioSenha, setNovoUsuarioSenha] = useState("");
  // Todos marcados por padrão (mais fácil desmarcar o que não quer do que
  // esquecer de marcar o que precisa) — ver escopo do pedido, item 2.3.
  const [recursosNovaFranquia, setRecursosNovaFranquia] = useState(CHAVES_RECURSOS);
  const [criandoFranquia, setCriandoFranquia] = useState(false);
  const [erroCriarFranquia, setErroCriarFranquia] = useState("");

  const [editandoNomeId, setEditandoNomeId] = useState(null);
  const [nomeEditado, setNomeEditado] = useState("");
  const [salvandoNomeId, setSalvandoNomeId] = useState(null);

  // Telas liberadas — desde o ajuste "Super Admin pode adicionar mais de 1
  // usuário numa franquia", o controle é por USUÁRIO (não mais por
  // franquia): "editandoRecursosId" guarda o id do USUÁRIO sendo editado.
  const [editandoRecursosId, setEditandoRecursosId] = useState(null);
  const [recursosEditados, setRecursosEditados] = useState([]);
  const [salvandoRecursosId, setSalvandoRecursosId] = useState(null);

  // Adicionar usuário extra a uma franquia já existente (mesmo ajuste) —
  // "adicionandoUsuarioFranquiaId" guarda o id da FRANQUIA cujo formulário
  // está aberto (só um por vez, igual ao form de criar franquia).
  const [adicionandoUsuarioFranquiaId, setAdicionandoUsuarioFranquiaId] = useState(null);
  const [novoUsuarioExtraNome, setNovoUsuarioExtraNome] = useState("");
  const [novoUsuarioExtraEmail, setNovoUsuarioExtraEmail] = useState("");
  const [novoUsuarioExtraSenha, setNovoUsuarioExtraSenha] = useState("");
  const [recursosNovoUsuarioExtra, setRecursosNovoUsuarioExtra] = useState(CHAVES_RECURSOS);
  const [criandoUsuarioExtra, setCriandoUsuarioExtra] = useState(false);
  const [erroUsuarioExtra, setErroUsuarioExtra] = useState("");

  const [confirmandoStatusFranquiaId, setConfirmandoStatusFranquiaId] = useState(null);
  const [alterandoStatusFranquiaId, setAlterandoStatusFranquiaId] = useState(null);

  // Ajuste "Excluir franquia permanentemente" (ALTO RISCO) — franquia
  // (objeto completo, não só o id, pra o modal exibir o nome sem precisar
  // buscar de novo) selecionada pra exclusão definitiva. Fluxo totalmente
  // separado de confirmandoStatusFranquiaId acima (que é só ativar/
  // desativar, reversível) — ver ModalExcluirFranquia mais abaixo.
  const [franquiaParaExcluir, setFranquiaParaExcluir] = useState(null);

  const [confirmandoStatusUsuarioId, setConfirmandoStatusUsuarioId] = useState(null);
  const [alterandoStatusUsuarioId, setAlterandoStatusUsuarioId] = useState(null);

  const [resetandoSenhaId, setResetandoSenhaId] = useState(null);
  const [novaSenhaReset, setNovaSenhaReset] = useState("");
  const [salvandoReset, setSalvandoReset] = useState(false);
  const [erroReset, setErroReset] = useState("");
  const [resetOkId, setResetOkId] = useState(null);

  const [erroLinha, setErroLinha] = useState({});

  const [perfil, setPerfil] = useState(null);
  const [carregandoPerfil, setCarregandoPerfil] = useState(true);
  const [erroPerfil, setErroPerfil] = useState("");
  const [nomePerfil, setNomePerfil] = useState("");
  const [emailPerfil, setEmailPerfil] = useState("");
  const [senhaAtualPerfil, setSenhaAtualPerfil] = useState("");
  const [senhaNovaPerfil, setSenhaNovaPerfil] = useState("");
  const [salvandoPerfil, setSalvandoPerfil] = useState(false);
  const [erroSalvarPerfil, setErroSalvarPerfil] = useState("");
  const [perfilSalvo, setPerfilSalvo] = useState(false);

  const carregarFranquias = useCallback(async () => {
    setCarregandoFranquias(true);
    setErroFranquias("");
    try {
      const data = await listarFranquias();
      setFranquias(Array.isArray(data) ? data : []);
    } catch (err) {
      setErroFranquias(err instanceof ApiError ? err.message : "Erro ao carregar as franquias.");
    } finally {
      setCarregandoFranquias(false);
    }
  }, []);

  const carregarPerfil = useCallback(async () => {
    setCarregandoPerfil(true);
    setErroPerfil("");
    try {
      const data = await getPerfil();
      setPerfil(data);
      setNomePerfil(data.nome || "");
      setEmailPerfil(data.email || "");
    } catch (err) {
      setErroPerfil(err instanceof ApiError ? err.message : "Erro ao carregar o perfil.");
    } finally {
      setCarregandoPerfil(false);
    }
  }, []);

  useEffect(() => {
    carregarFranquias();
    carregarPerfil();
  }, [carregarFranquias, carregarPerfil]);

  function marcarErroLinha(id, mensagem) {
    setErroLinha((prev) => ({ ...prev, [id]: mensagem }));
  }

  async function handleCriarFranquia(e) {
    e.preventDefault();
    setErroCriarFranquia("");

    if (!novaFranquiaNome.trim() || !novoUsuarioNome.trim() || !novoUsuarioEmail.trim() || !novoUsuarioSenha) {
      setErroCriarFranquia("Preencha o nome da franquia e os dados do usuário titular.");
      return;
    }

    setCriandoFranquia(true);
    try {
      await criarFranquia({
        nome: novaFranquiaNome.trim(),
        usuario: { nome: novoUsuarioNome.trim(), email: novoUsuarioEmail.trim(), senha: novoUsuarioSenha },
        recursosPermitidos: recursosNovaFranquia,
      });
      setNovaFranquiaNome("");
      setNovoUsuarioNome("");
      setNovoUsuarioEmail("");
      setNovoUsuarioSenha("");
      setRecursosNovaFranquia(CHAVES_RECURSOS);
      setMostrarFormCriar(false);
      await carregarFranquias();
    } catch (err) {
      setErroCriarFranquia(err instanceof ApiError ? err.message : "Erro ao criar a franquia.");
    } finally {
      setCriandoFranquia(false);
    }
  }

  function iniciarEdicaoRecursos(usuario) {
    setEditandoRecursosId(usuario.id);
    setRecursosEditados(usuario.recursos_permitidos || []);
  }

  async function salvarRecursos(id) {
    setSalvandoRecursosId(id);
    marcarErroLinha(id, "");
    try {
      await atualizarRecursosUsuario(id, recursosEditados);
      setEditandoRecursosId(null);
      await carregarFranquias();
    } catch (err) {
      marcarErroLinha(id, err instanceof ApiError ? err.message : "Erro ao salvar os recursos.");
    } finally {
      setSalvandoRecursosId(null);
    }
  }

  function iniciarAdicaoUsuarioExtra(franquiaId) {
    setAdicionandoUsuarioFranquiaId(franquiaId);
    setNovoUsuarioExtraNome("");
    setNovoUsuarioExtraEmail("");
    setNovoUsuarioExtraSenha("");
    setRecursosNovoUsuarioExtra(CHAVES_RECURSOS);
    setErroUsuarioExtra("");
  }

  async function handleCriarUsuarioExtra(e, franquiaId) {
    e.preventDefault();
    setErroUsuarioExtra("");

    if (!novoUsuarioExtraNome.trim() || !novoUsuarioExtraEmail.trim() || !novoUsuarioExtraSenha) {
      setErroUsuarioExtra("Preencha nome, e-mail e senha do novo usuário.");
      return;
    }

    setCriandoUsuarioExtra(true);
    try {
      await criarUsuarioExtra(franquiaId, {
        nome: novoUsuarioExtraNome.trim(),
        email: novoUsuarioExtraEmail.trim(),
        senha: novoUsuarioExtraSenha,
        recursosPermitidos: recursosNovoUsuarioExtra,
      });
      setAdicionandoUsuarioFranquiaId(null);
      await carregarFranquias();
    } catch (err) {
      setErroUsuarioExtra(err instanceof ApiError ? err.message : "Erro ao adicionar o usuário.");
    } finally {
      setCriandoUsuarioExtra(false);
    }
  }

  function iniciarEdicaoNome(franquia) {
    setEditandoNomeId(franquia.id);
    setNomeEditado(franquia.nome);
  }

  async function salvarNome(id) {
    if (!nomeEditado.trim()) return;
    setSalvandoNomeId(id);
    marcarErroLinha(id, "");
    try {
      await atualizarFranquia(id, { nome: nomeEditado.trim() });
      setEditandoNomeId(null);
      await carregarFranquias();
    } catch (err) {
      marcarErroLinha(id, err instanceof ApiError ? err.message : "Erro ao salvar o nome.");
    } finally {
      setSalvandoNomeId(null);
    }
  }

  async function alternarStatusFranquia(franquia) {
    setAlterandoStatusFranquiaId(franquia.id);
    marcarErroLinha(franquia.id, "");
    try {
      await atualizarFranquia(franquia.id, { ativo: !franquia.ativo });
      setConfirmandoStatusFranquiaId(null);
      await carregarFranquias();
    } catch (err) {
      marcarErroLinha(franquia.id, err instanceof ApiError ? err.message : "Erro ao alterar o status.");
    } finally {
      setAlterandoStatusFranquiaId(null);
    }
  }

  async function alternarStatusUsuario(usuario) {
    setAlterandoStatusUsuarioId(usuario.id);
    marcarErroLinha(usuario.id, "");
    try {
      await atualizarStatusUsuario(usuario.id, !usuario.ativo);
      setConfirmandoStatusUsuarioId(null);
      await carregarFranquias();
    } catch (err) {
      marcarErroLinha(usuario.id, err instanceof ApiError ? err.message : "Erro ao alterar o status.");
    } finally {
      setAlterandoStatusUsuarioId(null);
    }
  }

  function iniciarReset(usuarioId) {
    setResetandoSenhaId(usuarioId);
    setNovaSenhaReset("");
    setErroReset("");
    setResetOkId(null);
  }

  async function confirmarReset(usuarioId) {
    if (!novaSenhaReset || novaSenhaReset.length < 8) {
      setErroReset("A senha precisa ter pelo menos 8 caracteres.");
      return;
    }
    setSalvandoReset(true);
    setErroReset("");
    try {
      await resetarSenhaUsuario(usuarioId, novaSenhaReset);
      setResetandoSenhaId(null);
      setNovaSenhaReset("");
      setResetOkId(usuarioId);
      setTimeout(() => setResetOkId(null), 4000);
    } catch (err) {
      setErroReset(err instanceof ApiError ? err.message : "Erro ao resetar a senha.");
    } finally {
      setSalvandoReset(false);
    }
  }

  async function handleSalvarPerfil(e) {
    e.preventDefault();
    setErroSalvarPerfil("");
    setPerfilSalvo(false);

    if (!senhaAtualPerfil) {
      setErroSalvarPerfil('Informe a "Senha atual" para confirmar qualquer alteração.');
      return;
    }

    setSalvandoPerfil(true);
    try {
      const atualizado = await atualizarPerfil({
        nome: nomePerfil.trim() !== perfil?.nome ? nomePerfil.trim() : undefined,
        email: emailPerfil.trim() !== perfil?.email ? emailPerfil.trim() : undefined,
        senhaAtual: senhaAtualPerfil,
        senhaNova: senhaNovaPerfil || undefined,
      });
      setPerfil(atualizado);
      setSenhaAtualPerfil("");
      setSenhaNovaPerfil("");
      setPerfilSalvo(true);
      setTimeout(() => setPerfilSalvo(false), 4000);
    } catch (err) {
      setErroSalvarPerfil(err instanceof ApiError ? err.message : "Erro ao salvar o perfil.");
    } finally {
      setSalvandoPerfil(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h2 className="flex items-center gap-2 font-display text-xl font-bold text-foreground">
          <IconShield className="h-5 w-5 text-accent" />
          Controle Geral
        </h2>
        <p className="text-sm text-muted-foreground">
          Gerencie franquias, o acesso dos usuários e as suas próprias credenciais de administrador geral.
        </p>
      </div>

      {/* Franquias */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
              <IconBuilding className="h-4.5 w-4.5" />
            </span>
            <h3 className="text-sm font-semibold text-foreground">Franquias</h3>
          </div>
          <button
            type="button"
            onClick={() => setMostrarFormCriar((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <IconPlus className="h-3.5 w-3.5" />
            Nova franquia
          </button>
        </div>

        {mostrarFormCriar && (
          <form
            onSubmit={handleCriarFranquia}
            className="mt-4 space-y-3 rounded-xl border border-border-soft bg-surface-elevated p-4"
          >
            <p className="text-xs text-muted-foreground">
              Toda franquia nasce com exatamente 1 usuário titular — preencha os dados dele junto.
            </p>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Nome da franquia</label>
              <input
                type="text"
                value={novaFranquiaNome}
                onChange={(e) => setNovaFranquiaNome(e.target.value)}
                placeholder="Ex.: Via Permuta Campinas"
                disabled={criandoFranquia}
                className="w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Nome do usuário</label>
                <input
                  type="text"
                  value={novoUsuarioNome}
                  onChange={(e) => setNovoUsuarioNome(e.target.value)}
                  disabled={criandoFranquia}
                  className="w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">E-mail do usuário</label>
                <input
                  type="email"
                  value={novoUsuarioEmail}
                  onChange={(e) => setNovoUsuarioEmail(e.target.value)}
                  disabled={criandoFranquia}
                  className="w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
              </div>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Senha inicial (mín. 8 caracteres)</label>
              <input
                type="password"
                value={novoUsuarioSenha}
                onChange={(e) => setNovoUsuarioSenha(e.target.value)}
                disabled={criandoFranquia}
                className="w-full rounded-xl border border-border-soft bg-surface px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">
                Telas liberadas pra esta franquia
              </label>
              <CheckboxesRecursos
                selecionados={recursosNovaFranquia}
                onAlternar={(chave) => setRecursosNovaFranquia((prev) => alternarChave(prev, chave))}
                disabled={criandoFranquia}
              />
            </div>

            {erroCriarFranquia && <ErrorBanner message={erroCriarFranquia} />}

            <div className="flex items-center gap-2">
              <button
                type="submit"
                disabled={criandoFranquia}
                className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
              >
                {criandoFranquia && <Spinner className="h-3.5 w-3.5" />}
                Criar franquia
              </button>
              <button
                type="button"
                onClick={() => setMostrarFormCriar(false)}
                disabled={criandoFranquia}
                className="rounded-xl px-3 py-2.5 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Cancelar
              </button>
            </div>
          </form>
        )}

        {erroFranquias && (
          <div className="mt-4">
            <ErrorBanner message={erroFranquias} onRetry={carregarFranquias} />
          </div>
        )}

        <div className="mt-4 space-y-3">
          {carregandoFranquias ? (
            <div className="flex justify-center py-6">
              <Spinner className="h-5 w-5" />
            </div>
          ) : franquias.length === 0 ? (
            <p className="py-4 text-center text-xs text-muted-foreground">Nenhuma franquia cadastrada ainda.</p>
          ) : (
            franquias.map((franquia) => (
              <div
                key={franquia.id}
                className={`rounded-xl border p-4 ${
                  franquia.ativo ? "border-border-soft bg-surface-elevated" : "border-status-red/30 bg-surface-elevated/60"
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    {editandoNomeId === franquia.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          type="text"
                          value={nomeEditado}
                          onChange={(e) => setNomeEditado(e.target.value)}
                          disabled={salvandoNomeId === franquia.id}
                          autoFocus
                          className="min-w-0 flex-1 rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                        />
                        <button
                          type="button"
                          onClick={() => salvarNome(franquia.id)}
                          disabled={salvandoNomeId === franquia.id}
                          className="shrink-0 rounded-lg bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                        >
                          {salvandoNomeId === franquia.id ? <Spinner className="h-3 w-3" /> : "Salvar"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditandoNomeId(null)}
                          disabled={salvandoNomeId === franquia.id}
                          className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-semibold text-foreground">{franquia.nome}</span>
                        {franquia.ativo ? (
                          <span className="inline-flex items-center rounded-full bg-status-green/15 px-2 py-0.5 text-[11px] font-medium text-status-green">
                            Ativa
                          </span>
                        ) : (
                          <span className="inline-flex items-center rounded-full bg-status-red/15 px-2 py-0.5 text-[11px] font-medium text-status-red">
                            Inativa
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => iniciarEdicaoNome(franquia)}
                          className="text-[11px] font-medium text-primary hover:underline"
                        >
                          editar nome
                        </button>
                      </div>
                    )}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Criada em {formatDateTime(franquia.criado_em)}
                    </p>
                  </div>

                  {confirmandoStatusFranquiaId === franquia.id ? (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmandoStatusFranquiaId(null)}
                        disabled={alterandoStatusFranquiaId === franquia.id}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                      >
                        Cancelar
                      </button>
                      <button
                        type="button"
                        onClick={() => alternarStatusFranquia(franquia)}
                        disabled={alterandoStatusFranquiaId === franquia.id}
                        className={`flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-semibold text-background transition-opacity hover:opacity-90 disabled:opacity-50 ${
                          franquia.ativo ? "bg-status-red" : "bg-status-green"
                        }`}
                      >
                        {alterandoStatusFranquiaId === franquia.id && <Spinner className="h-3 w-3" />}
                        Confirmar
                      </button>
                    </div>
                  ) : (
                    <div className="flex shrink-0 items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmandoStatusFranquiaId(franquia.id)}
                        className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors ${
                          franquia.ativo
                            ? "border-status-red/40 text-status-red hover:bg-status-red/10"
                            : "border-status-green/40 text-status-green hover:bg-status-green/10"
                        }`}
                      >
                        {franquia.ativo ? "Desativar franquia" : "Reativar franquia"}
                      </button>
                      {/* Distinta de "Desativar" (reversível, só bloqueia
                          login) — hard delete definitivo, ver
                          ModalExcluirFranquia. */}
                      <button
                        type="button"
                        onClick={() => setFranquiaParaExcluir(franquia)}
                        className="rounded-lg border border-status-red/40 px-3 py-1.5 text-xs font-medium text-status-red hover:bg-status-red/10"
                      >
                        Excluir franquia
                      </button>
                    </div>
                  )}
                </div>

                {erroLinha[franquia.id] && (
                  <div className="mt-3">
                    <ErrorBanner message={erroLinha[franquia.id]} />
                  </div>
                )}

                {/* Usuários da franquia — desde o ajuste "Super Admin pode
                    adicionar mais de 1 usuário numa franquia" (ver
                    docs/plano-multi-franquia.md, seção 8, item 8), uma
                    franquia pode ter N usuários, cada um com telas
                    liberadas PRÓPRIAS (movido de Franquia.recursos_permitidos
                    pra Usuario.recursos_permitidos). */}
                {(franquia.usuarios || []).length === 0 ? (
                  <div className="mt-3 rounded-lg border border-border-soft/70 bg-surface p-3">
                    <p className="text-xs text-muted-foreground">Nenhum usuário vinculado a esta franquia.</p>
                  </div>
                ) : (
                  (franquia.usuarios || []).map((usuario) => (
                    <div key={usuario.id} className="mt-3 rounded-lg border border-border-soft/70 bg-surface p-3">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="flex items-center gap-2 text-sm text-foreground">
                          <IconUser className="h-4 w-4 text-muted-foreground" />
                          <span className="font-medium">{usuario.nome}</span>
                          <span className="text-xs text-muted-foreground">{usuario.email}</span>
                          {usuario.ativo ? (
                            <span className="inline-flex items-center rounded-full bg-status-green/15 px-2 py-0.5 text-[10px] font-medium text-status-green">
                              Ativo
                            </span>
                          ) : (
                            <span className="inline-flex items-center rounded-full bg-status-red/15 px-2 py-0.5 text-[10px] font-medium text-status-red">
                              Bloqueado
                            </span>
                          )}
                        </div>

                        <div className="flex shrink-0 items-center gap-2">
                          {confirmandoStatusUsuarioId === usuario.id ? (
                            <>
                              <button
                                type="button"
                                onClick={() => setConfirmandoStatusUsuarioId(null)}
                                disabled={alterandoStatusUsuarioId === usuario.id}
                                className="text-xs font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
                              >
                                Cancelar
                              </button>
                              <button
                                type="button"
                                onClick={() => alternarStatusUsuario(usuario)}
                                disabled={alterandoStatusUsuarioId === usuario.id}
                                className={`rounded-lg px-2.5 py-1 text-xs font-semibold text-background hover:opacity-90 disabled:opacity-50 ${
                                  usuario.ativo ? "bg-status-red" : "bg-status-green"
                                }`}
                              >
                                Confirmar
                              </button>
                            </>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setConfirmandoStatusUsuarioId(usuario.id)}
                              className={`rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors ${
                                usuario.ativo
                                  ? "border-status-red/40 text-status-red hover:bg-status-red/10"
                                  : "border-status-green/40 text-status-green hover:bg-status-green/10"
                              }`}
                            >
                              {usuario.ativo ? "Bloquear" : "Desbloquear"}
                            </button>
                          )}

                          <button
                            type="button"
                            onClick={() => iniciarReset(usuario.id)}
                            className="flex items-center gap-1 rounded-lg border border-border-soft px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                          >
                            <IconLock className="h-3 w-3" />
                            Resetar senha
                          </button>
                        </div>
                      </div>

                      {erroLinha[usuario.id] && (
                        <div className="mt-2">
                          <ErrorBanner message={erroLinha[usuario.id]} />
                        </div>
                      )}

                      {resetOkId === usuario.id && (
                        <p className="mt-2 text-xs font-medium text-status-green">Senha atualizada com sucesso.</p>
                      )}

                      {resetandoSenhaId === usuario.id && (
                        <div className="mt-3 flex flex-col gap-2 rounded-lg border border-border-soft bg-surface-elevated p-3 sm:flex-row sm:items-center">
                          <input
                            type="password"
                            value={novaSenhaReset}
                            onChange={(e) => setNovaSenhaReset(e.target.value)}
                            placeholder="Nova senha (mín. 8 caracteres)"
                            disabled={salvandoReset}
                            autoFocus
                            className="min-w-0 flex-1 rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                          />
                          <div className="flex shrink-0 items-center gap-2">
                            <button
                              type="button"
                              onClick={() => confirmarReset(usuario.id)}
                              disabled={salvandoReset}
                              className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                            >
                              {salvandoReset && <Spinner className="h-3 w-3" />}
                              Salvar
                            </button>
                            <button
                              type="button"
                              onClick={() => setResetandoSenhaId(null)}
                              disabled={salvandoReset}
                              className="text-xs font-medium text-muted-foreground hover:text-foreground"
                            >
                              Cancelar
                            </button>
                          </div>
                          {erroReset && <p className="text-xs text-status-red sm:ml-2">{erroReset}</p>}
                        </div>
                      )}

                      {/* Telas liberadas — agora por usuário (ver docblock acima) */}
                      <div className="mt-3 rounded-lg border border-border-soft/70 bg-surface-elevated/60 p-2.5">
                        {editandoRecursosId === usuario.id ? (
                          <div className="space-y-2.5">
                            <CheckboxesRecursos
                              selecionados={recursosEditados}
                              onAlternar={(chave) => setRecursosEditados((prev) => alternarChave(prev, chave))}
                              disabled={salvandoRecursosId === usuario.id}
                            />
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => salvarRecursos(usuario.id)}
                                disabled={salvandoRecursosId === usuario.id}
                                className="flex items-center gap-1.5 rounded-lg bg-primary px-2.5 py-1 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                              >
                                {salvandoRecursosId === usuario.id && <Spinner className="h-3 w-3" />}
                                Salvar
                              </button>
                              <button
                                type="button"
                                onClick={() => setEditandoRecursosId(null)}
                                disabled={salvandoRecursosId === usuario.id}
                                className="text-xs font-medium text-muted-foreground hover:text-foreground"
                              >
                                Cancelar
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="mr-1 text-[11px] font-medium text-muted-foreground">Telas liberadas:</span>
                            {RECURSOS.filter((r) => (usuario.recursos_permitidos || []).includes(r.chave)).map((r) => (
                              <span
                                key={r.chave}
                                className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary"
                              >
                                {r.label}
                              </span>
                            ))}
                            {(usuario.recursos_permitidos || []).length === 0 && (
                              <span className="text-[11px] text-status-red">nenhuma tela liberada</span>
                            )}
                            <button
                              type="button"
                              onClick={() => iniciarEdicaoRecursos(usuario)}
                              className="text-[11px] font-medium text-primary hover:underline"
                            >
                              editar
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  ))
                )}

                {/* Adicionar usuário extra (ver escopo do ajuste "Super Admin
                    pode adicionar mais de 1 usuário numa franquia") */}
                {adicionandoUsuarioFranquiaId === franquia.id ? (
                  <form
                    onSubmit={(e) => handleCriarUsuarioExtra(e, franquia.id)}
                    className="mt-3 space-y-3 rounded-lg border border-border-soft bg-surface-elevated p-3"
                  >
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">Nome</label>
                        <input
                          type="text"
                          value={novoUsuarioExtraNome}
                          onChange={(e) => setNovoUsuarioExtraNome(e.target.value)}
                          disabled={criandoUsuarioExtra}
                          autoFocus
                          className="w-full rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                        />
                      </div>
                      <div>
                        <label className="mb-1 block text-xs font-medium text-muted-foreground">E-mail</label>
                        <input
                          type="email"
                          value={novoUsuarioExtraEmail}
                          onChange={(e) => setNovoUsuarioExtraEmail(e.target.value)}
                          disabled={criandoUsuarioExtra}
                          className="w-full rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="mb-1 block text-xs font-medium text-muted-foreground">Senha inicial (mín. 8 caracteres)</label>
                      <input
                        type="password"
                        value={novoUsuarioExtraSenha}
                        onChange={(e) => setNovoUsuarioExtraSenha(e.target.value)}
                        disabled={criandoUsuarioExtra}
                        className="w-full rounded-lg border border-border-soft bg-surface px-2.5 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                      />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Telas liberadas pra este usuário</label>
                      <CheckboxesRecursos
                        selecionados={recursosNovoUsuarioExtra}
                        onAlternar={(chave) => setRecursosNovoUsuarioExtra((prev) => alternarChave(prev, chave))}
                        disabled={criandoUsuarioExtra}
                      />
                    </div>

                    {erroUsuarioExtra && <ErrorBanner message={erroUsuarioExtra} />}

                    <div className="flex items-center gap-2">
                      <button
                        type="submit"
                        disabled={criandoUsuarioExtra}
                        className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
                      >
                        {criandoUsuarioExtra && <Spinner className="h-3 w-3" />}
                        Adicionar usuário
                      </button>
                      <button
                        type="button"
                        onClick={() => setAdicionandoUsuarioFranquiaId(null)}
                        disabled={criandoUsuarioExtra}
                        className="text-xs font-medium text-muted-foreground hover:text-foreground"
                      >
                        Cancelar
                      </button>
                    </div>
                  </form>
                ) : (
                  <button
                    type="button"
                    onClick={() => iniciarAdicaoUsuarioExtra(franquia.id)}
                    className="mt-3 flex items-center gap-1.5 rounded-lg border border-dashed border-border-soft px-3 py-2 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
                  >
                    <IconPlus className="h-3.5 w-3.5" />
                    Adicionar usuário
                  </button>
                )}
              </div>
            ))
          )}
        </div>
      </section>

      {/* Meu perfil */}
      <section className="rounded-2xl border border-border-soft bg-surface p-5 shadow-lg shadow-black/20">
        <div className="flex items-center gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconUser className="h-4.5 w-4.5" />
          </span>
          <h3 className="text-sm font-semibold text-foreground">Meu perfil (administrador geral)</h3>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">
          Troque seu próprio nome, e-mail ou senha. Qualquer alteração aqui exige a senha atual.
        </p>

        {carregandoPerfil ? (
          <div className="flex justify-center py-6">
            <Spinner className="h-5 w-5" />
          </div>
        ) : erroPerfil ? (
          <div className="mt-3">
            <ErrorBanner message={erroPerfil} onRetry={carregarPerfil} />
          </div>
        ) : (
          <form onSubmit={handleSalvarPerfil} className="mt-4 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Nome</label>
                <input
                  type="text"
                  value={nomePerfil}
                  onChange={(e) => setNomePerfil(e.target.value)}
                  disabled={salvandoPerfil}
                  className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">E-mail</label>
                <input
                  type="email"
                  value={emailPerfil}
                  onChange={(e) => setEmailPerfil(e.target.value)}
                  disabled={salvandoPerfil}
                  className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
              </div>
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Senha nova (opcional)</label>
                <input
                  type="password"
                  value={senhaNovaPerfil}
                  onChange={(e) => setSenhaNovaPerfil(e.target.value)}
                  placeholder="Deixe em branco para não trocar"
                  disabled={salvandoPerfil}
                  className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Senha atual (obrigatória)</label>
                <input
                  type="password"
                  value={senhaAtualPerfil}
                  onChange={(e) => setSenhaAtualPerfil(e.target.value)}
                  disabled={salvandoPerfil}
                  className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
                />
              </div>
            </div>

            {erroSalvarPerfil && <ErrorBanner message={erroSalvarPerfil} />}
            {perfilSalvo && <p className="text-xs font-medium text-status-green">Perfil atualizado com sucesso.</p>}

            <button
              type="submit"
              disabled={salvandoPerfil}
              className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {salvandoPerfil && <Spinner className="h-3.5 w-3.5" />}
              Salvar alterações
            </button>
          </form>
        )}
      </section>

      {franquiaParaExcluir && (
        <ModalExcluirFranquia
          franquia={franquiaParaExcluir}
          onFechar={() => setFranquiaParaExcluir(null)}
          onExcluida={async () => {
            setFranquiaParaExcluir(null);
            await carregarFranquias();
          }}
        />
      )}
    </div>
  );
}

/**
 * Modal de confirmação de duas etapas pra "Excluir franquia" (ALTO RISCO,
 * ver escopo do ajuste "Excluir franquia permanentemente" e o docblock de
 * excluirPermanentemente em franquias.controller.js). Mesmo padrão do
 * "delete repo" do GitHub: só habilita o botão de excluir depois do
 * usuário digitar o nome EXATO da franquia — o backend confere de novo do
 * lado dele (nunca confia só nisso aqui). Deixa explícito no texto que é
 * irreversível e que contas externas (Asaas/Bling/Drive) não são tocadas.
 */
function ModalExcluirFranquia({ franquia, onFechar, onExcluida }) {
  const [nomeDigitado, setNomeDigitado] = useState("");
  const [excluindo, setExcluindo] = useState(false);
  const [erro, setErro] = useState("");

  const nomeConfere = nomeDigitado.trim() === franquia.nome;

  async function handleExcluir() {
    if (!nomeConfere || excluindo) return;
    setExcluindo(true);
    setErro("");
    try {
      await excluirFranquiaPermanentemente(franquia.id, nomeDigitado.trim());
      await onExcluida();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao excluir a franquia.");
      setExcluindo(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-md rounded-2xl border border-status-red/40 bg-surface p-5 shadow-2xl">
        <div className="mb-3 flex items-center gap-2">
          <IconAlert className="h-5 w-5 text-status-red" />
          <h3 className="font-display text-base font-bold text-foreground">Excluir franquia permanentemente</h3>
        </div>

        <p className="text-sm text-foreground">
          Isso apaga <strong>{franquia.nome}</strong> e TODOS os dados dela dentro do Gestor — usuários, associados/cadastros, cobranças, cards e histórico do Jurídico, configurações etc. — de forma{" "}
          <strong>irreversível</strong>. Diferente de &ldquo;Desativar&rdquo;, não tem como desfazer nem reativar depois.
        </p>

        <p className="mt-2 text-xs text-muted-foreground">
          Contas em serviços externos (Asaas, Bling, Google Drive) NÃO são apagadas por aqui — só os dados dentro do Gestor.
        </p>

        <div className="mt-4">
          <label className="mb-1 block text-xs font-medium text-muted-foreground">
            Digite <strong>{franquia.nome}</strong> pra confirmar
          </label>
          <input
            type="text"
            value={nomeDigitado}
            onChange={(e) => setNomeDigitado(e.target.value)}
            disabled={excluindo}
            autoFocus
            className="w-full rounded-xl border border-status-red/40 bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-status-red focus:outline-none focus:ring-2 focus:ring-status-red/30 disabled:opacity-60"
          />
        </div>

        {erro && (
          <div className="mt-3">
            <ErrorBanner message={erro} />
          </div>
        )}

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            type="button"
            onClick={onFechar}
            disabled={excluindo}
            className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground disabled:opacity-50"
          >
            Cancelar
          </button>
          <button
            type="button"
            onClick={handleExcluir}
            disabled={!nomeConfere || excluindo}
            className="flex items-center gap-2 rounded-xl bg-status-red px-4 py-2.5 text-sm font-semibold text-background transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {excluindo && <Spinner className="h-3.5 w-3.5" />}
            Excluir permanentemente
          </button>
        </div>
      </div>
    </div>
  );
}
