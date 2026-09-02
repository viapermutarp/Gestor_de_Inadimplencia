"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  listarEtapasJuridico,
  criarEtapaJuridico,
  renomearEtapaJuridico,
  reordenarEtapasJuridico,
  removerEtapaJuridico,
  buscarAssociadosJuridico,
  criarCardJuridico,
  atualizarCardJuridico,
  moverCardJuridico,
  removerCardJuridico,
  ApiError,
} from "@/lib/api";
import { formatCurrency, formatDate } from "@/lib/format";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import { IconPlus, IconClose, IconUser, IconSearch, IconClock, IconScale } from "@/components/icons";

// Kanban "Jurídico" (aba nova — ver escopo do pedido, item 1). Sem
// biblioteca de drag and drop (o projeto não usa nenhuma) — implementado
// com a API nativa do HTML5 (draggable + onDragStart/onDragOver/onDrop).
// Nenhuma atualização otimista: toda ação (mover card, reordenar coluna,
// criar/editar/excluir) chama a API e depois recarrega o board inteiro —
// mesmo padrão já usado em Controle Geral (carregarFranquias() após cada
// mutação), mais simples que reconciliar "ordem" no cliente.

export default function JuridicoPage() {
  const [etapas, setEtapas] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");
  const [mutando, setMutando] = useState(false);

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    try {
      const data = await listarEtapasJuridico();
      setEtapas(Array.isArray(data) ? data : []);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao carregar o quadro.");
    } finally {
      setCarregando(false);
    }
  }, []);

  useEffect(() => {
    carregar();
  }, [carregar]);

  // --- Nova etapa (coluna) ---
  const [criandoEtapa, setCriandoEtapa] = useState(false);
  const [nomeNovaEtapa, setNomeNovaEtapa] = useState("");
  const [erroNovaEtapa, setErroNovaEtapa] = useState("");

  async function handleCriarEtapa(e) {
    e.preventDefault();
    if (!nomeNovaEtapa.trim()) return;
    setMutando(true);
    setErroNovaEtapa("");
    try {
      await criarEtapaJuridico(nomeNovaEtapa.trim());
      setNomeNovaEtapa("");
      setCriandoEtapa(false);
      await carregar();
    } catch (err) {
      setErroNovaEtapa(err instanceof ApiError ? err.message : "Erro ao criar a etapa.");
    } finally {
      setMutando(false);
    }
  }

  // --- Renomear etapa ---
  const [editandoEtapaId, setEditandoEtapaId] = useState(null);
  const [nomeEtapaEditado, setNomeEtapaEditado] = useState("");

  async function salvarNomeEtapa(id) {
    if (!nomeEtapaEditado.trim()) return;
    setMutando(true);
    try {
      await renomearEtapaJuridico(id, nomeEtapaEditado.trim());
      setEditandoEtapaId(null);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao renomear a etapa.");
    } finally {
      setMutando(false);
    }
  }

  // --- Excluir etapa (com confirmação se tiver card dentro) ---
  const [confirmandoExclusaoEtapa, setConfirmandoExclusaoEtapa] = useState(null); // { id, nome, totalCards } | null

  async function pedirExclusaoEtapa(etapa) {
    setMutando(true);
    try {
      await removerEtapaJuridico(etapa.id);
      await carregar(); // etapa vazia: já removeu de primeira
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setConfirmandoExclusaoEtapa({ id: etapa.id, nome: etapa.nome, totalCards: etapa.cards.length });
      } else {
        setErro(err instanceof ApiError ? err.message : "Erro ao excluir a etapa.");
      }
    } finally {
      setMutando(false);
    }
  }

  async function confirmarExclusaoEtapa() {
    if (!confirmandoExclusaoEtapa) return;
    setMutando(true);
    try {
      await removerEtapaJuridico(confirmandoExclusaoEtapa.id, { confirmar: true });
      setConfirmandoExclusaoEtapa(null);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao excluir a etapa.");
    } finally {
      setMutando(false);
    }
  }

  // --- Drag and drop: colunas ---
  const etapaArrastada = useRef(null);

  function onDragStartEtapa(id) {
    etapaArrastada.current = id;
  }

  async function onDropEtapa(idDestino) {
    const idOrigem = etapaArrastada.current;
    etapaArrastada.current = null;
    if (!idOrigem || idOrigem === idDestino) return;

    const ids = etapas.map((e) => e.id);
    const origemIdx = ids.indexOf(idOrigem);
    const destinoIdx = ids.indexOf(idDestino);
    if (origemIdx === -1 || destinoIdx === -1) return;
    ids.splice(origemIdx, 1);
    ids.splice(destinoIdx, 0, idOrigem);

    setMutando(true);
    try {
      await reordenarEtapasJuridico(ids);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao reordenar as etapas.");
    } finally {
      setMutando(false);
    }
  }

  // --- Drag and drop: cards ---
  const cardArrastado = useRef(null); // { id, etapaId }

  function onDragStartCard(card, etapaId) {
    cardArrastado.current = { id: card.id, etapaId };
  }

  async function onDropCard(etapaDestinoId, indice) {
    const arrastado = cardArrastado.current;
    cardArrastado.current = null;
    if (!arrastado) return;

    setMutando(true);
    try {
      await moverCardJuridico(arrastado.id, { etapaId: etapaDestinoId, indice });
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao mover o card.");
    } finally {
      setMutando(false);
    }
  }

  // --- Card: criar/editar ---
  const [modalCard, setModalCard] = useState(null); // { etapaId, cardExistente? } | null

  async function handleExcluirCard(card) {
    setMutando(true);
    try {
      await removerCardJuridico(card.id);
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao excluir o card.");
    } finally {
      setMutando(false);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 font-display text-xl font-bold text-foreground">
            <IconScale className="h-5 w-5 text-accent" />
            Jurídico
          </h2>
          <p className="text-sm text-muted-foreground">
            Acompanhe os casos em andamento — arraste os cards entre as etapas conforme o processo avança.
          </p>
        </div>
        {!criandoEtapa && (
          <button
            type="button"
            onClick={() => setCriandoEtapa(true)}
            className="flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover"
          >
            <IconPlus className="h-3.5 w-3.5" />
            Nova etapa
          </button>
        )}
      </div>

      {erro && <ErrorBanner message={erro} onRetry={carregar} />}

      {criandoEtapa && (
        <form onSubmit={handleCriarEtapa} className="flex items-center gap-2 rounded-xl border border-border-soft bg-surface p-3">
          <input
            type="text"
            value={nomeNovaEtapa}
            onChange={(e) => setNomeNovaEtapa(e.target.value)}
            placeholder="Nome da etapa (ex.: Notificação)"
            autoFocus
            disabled={mutando}
            className="min-w-0 flex-1 rounded-lg border border-border-soft bg-surface-elevated px-3 py-2 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
          />
          <button
            type="submit"
            disabled={mutando}
            className="flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary-hover disabled:opacity-50"
          >
            {mutando && <Spinner className="h-3 w-3" />}
            Criar
          </button>
          <button
            type="button"
            onClick={() => {
              setCriandoEtapa(false);
              setNomeNovaEtapa("");
              setErroNovaEtapa("");
            }}
            disabled={mutando}
            className="shrink-0 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            Cancelar
          </button>
          {erroNovaEtapa && <p className="text-xs text-status-red">{erroNovaEtapa}</p>}
        </form>
      )}

      {carregando ? (
        <div className="flex justify-center py-16">
          <Spinner className="h-6 w-6" />
        </div>
      ) : etapas.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-border-soft bg-surface px-6 py-16 text-center">
          <span className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/15 text-primary">
            <IconScale className="h-6 w-6" />
          </span>
          <h3 className="font-display text-base font-bold text-foreground">Nenhuma etapa criada ainda</h3>
          <p className="max-w-sm text-sm text-muted-foreground">
            Crie a primeira etapa (ex.: &quot;Notificação&quot;) pra começar a organizar os casos jurídicos.
          </p>
        </div>
      ) : (
        <div className="flex gap-4 overflow-x-auto pb-4">
          {etapas.map((etapa) => (
            <ColunaEtapa
              key={etapa.id}
              etapa={etapa}
              onDragStartEtapa={onDragStartEtapa}
              onDropEtapa={onDropEtapa}
              onDragStartCard={onDragStartCard}
              onDropCard={onDropCard}
              editando={editandoEtapaId === etapa.id}
              nomeEditado={nomeEtapaEditado}
              onIniciarEdicao={() => {
                setEditandoEtapaId(etapa.id);
                setNomeEtapaEditado(etapa.nome);
              }}
              onMudarNome={setNomeEtapaEditado}
              onSalvarNome={() => salvarNomeEtapa(etapa.id)}
              onCancelarEdicao={() => setEditandoEtapaId(null)}
              onExcluir={() => pedirExclusaoEtapa(etapa)}
              onNovoCard={() => setModalCard({ etapaId: etapa.id })}
              onEditarCard={(card) => setModalCard({ etapaId: etapa.id, cardExistente: card })}
              onExcluirCard={handleExcluirCard}
              mutando={mutando}
            />
          ))}
        </div>
      )}

      {confirmandoExclusaoEtapa && (
        <ModalConfirmarExclusaoEtapa
          etapa={confirmandoExclusaoEtapa}
          mutando={mutando}
          onCancelar={() => setConfirmandoExclusaoEtapa(null)}
          onConfirmar={confirmarExclusaoEtapa}
        />
      )}

      {modalCard && (
        <ModalCard
          etapaId={modalCard.etapaId}
          cardExistente={modalCard.cardExistente}
          onFechar={() => setModalCard(null)}
          onSalvo={async () => {
            setModalCard(null);
            await carregar();
          }}
        />
      )}
    </div>
  );
}

function ColunaEtapa({
  etapa,
  onDragStartEtapa,
  onDropEtapa,
  onDragStartCard,
  onDropCard,
  editando,
  nomeEditado,
  onIniciarEdicao,
  onMudarNome,
  onSalvarNome,
  onCancelarEdicao,
  onExcluir,
  onNovoCard,
  onEditarCard,
  onExcluirCard,
  mutando,
}) {
  return (
    <div
      className="flex w-72 shrink-0 flex-col rounded-2xl border border-border-soft bg-surface"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        onDropCard(etapa.id, etapa.cards.length);
      }}
    >
      <div
        draggable={!editando}
        onDragStart={() => onDragStartEtapa(etapa.id)}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.stopPropagation();
          e.preventDefault();
          onDropEtapa(etapa.id);
        }}
        className="flex items-center justify-between gap-2 border-b border-border-soft px-3.5 py-3 cursor-grab active:cursor-grabbing"
      >
        {editando ? (
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            <input
              type="text"
              value={nomeEditado}
              onChange={(e) => onMudarNome(e.target.value)}
              autoFocus
              disabled={mutando}
              className="min-w-0 flex-1 rounded-lg border border-border-soft bg-surface-elevated px-2 py-1 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            <button type="button" onClick={onSalvarNome} disabled={mutando} className="shrink-0 text-xs font-semibold text-primary hover:underline">
              Salvar
            </button>
            <button type="button" onClick={onCancelarEdicao} disabled={mutando} className="shrink-0 text-xs text-muted-foreground hover:text-foreground">
              Cancelar
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={onIniciarEdicao} className="min-w-0 flex-1 truncate text-left text-sm font-semibold text-foreground hover:underline">
              {etapa.nome}
            </button>
            <span className="shrink-0 rounded-full bg-surface-elevated px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {etapa.cards.length}
            </span>
            <button
              type="button"
              onClick={onExcluir}
              disabled={mutando}
              className="shrink-0 rounded-lg p-1 text-muted-foreground transition-colors hover:bg-status-red/10 hover:text-status-red disabled:opacity-50"
              title="Excluir etapa"
            >
              <IconClose className="h-3.5 w-3.5" />
            </button>
          </>
        )}
      </div>

      <div className="flex-1 space-y-2 p-2.5">
        {etapa.cards.map((card, index) => (
          <CardJuridico
            key={card.id}
            card={card}
            onDragStart={() => onDragStartCard(card, etapa.id)}
            onDropAntes={(e) => {
              e.stopPropagation();
              e.preventDefault();
              onDropCard(etapa.id, index);
            }}
            onEditar={() => onEditarCard(card)}
            onExcluir={() => onExcluirCard(card)}
          />
        ))}

        <button
          type="button"
          onClick={onNovoCard}
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-border-soft py-2.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary"
        >
          <IconPlus className="h-3.5 w-3.5" />
          Novo card
        </button>
      </div>
    </div>
  );
}

function CardJuridico({ card, onDragStart, onDropAntes, onEditar, onExcluir }) {
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropAntes}
      className="cursor-grab space-y-2 rounded-xl border border-border-soft bg-surface-elevated p-3 text-sm shadow-sm shadow-black/10 active:cursor-grabbing"
    >
      {card.associado ? (
        <div className="space-y-1">
          <div className="flex items-center gap-1.5 font-semibold text-foreground">
            <IconUser className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{card.associado.nome}</span>
          </div>
          <p className="text-xs text-muted-foreground">{card.associado.cpf_cnpj} · {card.associado.telefone}</p>
          <p className="text-xs font-medium text-status-red">{formatCurrency(card.associado.valor_em_aberto)} em aberto</p>
        </div>
      ) : (
        <div className="space-y-1">
          <p className="font-semibold text-foreground">{card.titulo}</p>
          {card.descricao && <p className="text-xs text-muted-foreground">{card.descricao}</p>}
          {card.observacoes && <p className="text-xs text-muted-foreground italic">{card.observacoes}</p>}
        </div>
      )}

      {(card.responsavel || card.prazo) && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border-soft/70 pt-2 text-[11px] text-muted-foreground">
          {card.responsavel && <span>Resp.: {card.responsavel}</span>}
          {card.prazo && (
            <span className="flex items-center gap-1">
              <IconClock className="h-3 w-3" />
              {formatDate(card.prazo)}
            </span>
          )}
        </div>
      )}

      <div className="flex items-center gap-3 pt-1 text-[11px] font-medium">
        <button type="button" onClick={onEditar} className="text-primary hover:underline">
          Editar
        </button>
        <button type="button" onClick={onExcluir} className="text-status-red hover:underline">
          Excluir
        </button>
      </div>
    </div>
  );
}

function ModalConfirmarExclusaoEtapa({ etapa, mutando, onCancelar, onConfirmar }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-border-soft bg-surface p-5 shadow-2xl">
        <h3 className="font-display text-base font-bold text-foreground">Excluir etapa &quot;{etapa.nome}&quot;?</h3>
        <p className="mt-2 text-sm text-muted-foreground">
          Esta etapa tem {etapa.totalCards} card(s). Excluir a etapa remove os cards junto — essa ação não pode ser desfeita.
        </p>
        <div className="mt-4 flex items-center justify-end gap-2">
          <button type="button" onClick={onCancelar} disabled={mutando} className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
            Cancelar
          </button>
          <button
            type="button"
            onClick={onConfirmar}
            disabled={mutando}
            className="flex items-center gap-1.5 rounded-lg bg-status-red px-3.5 py-2 text-sm font-semibold text-background hover:opacity-90 disabled:opacity-50"
          >
            {mutando && <Spinner className="h-3.5 w-3.5" />}
            Excluir etapa e cards
          </button>
        </div>
      </div>
    </div>
  );
}

function ModalCard({ etapaId, cardExistente, onFechar, onSalvo }) {
  const ehEdicao = Boolean(cardExistente);
  const ehVinculado = ehEdicao && Boolean(cardExistente.associado);

  const [origem, setOrigem] = useState(ehVinculado ? "associado" : "livre"); // "associado" | "livre"
  const [buscaAssociado, setBuscaAssociado] = useState("");
  const [resultadosBusca, setResultadosBusca] = useState([]);
  const [buscando, setBuscando] = useState(false);
  const [associadoSelecionado, setAssociadoSelecionado] = useState(ehVinculado ? cardExistente.associado : null);

  const [titulo, setTitulo] = useState(ehEdicao && !ehVinculado ? cardExistente.titulo || "" : "");
  const [descricao, setDescricao] = useState(ehEdicao ? cardExistente.descricao || "" : "");
  const [observacoes, setObservacoes] = useState(ehEdicao ? cardExistente.observacoes || "" : "");
  const [responsavel, setResponsavel] = useState(ehEdicao ? cardExistente.responsavel || "" : "");
  const [prazo, setPrazo] = useState(ehEdicao && cardExistente.prazo ? cardExistente.prazo.slice(0, 10) : "");

  const [salvando, setSalvando] = useState(false);
  const [erro, setErro] = useState("");

  useEffect(() => {
    if (origem !== "associado" || ehEdicao || !buscaAssociado.trim()) {
      setResultadosBusca([]);
      return;
    }
    let cancelado = false;
    setBuscando(true);
    const timeout = setTimeout(async () => {
      try {
        const data = await buscarAssociadosJuridico(buscaAssociado.trim());
        if (!cancelado) setResultadosBusca(Array.isArray(data) ? data : []);
      } catch {
        if (!cancelado) setResultadosBusca([]);
      } finally {
        if (!cancelado) setBuscando(false);
      }
    }, 350);
    return () => {
      cancelado = true;
      clearTimeout(timeout);
    };
  }, [buscaAssociado, origem, ehEdicao]);

  async function handleSubmit(e) {
    e.preventDefault();
    setErro("");

    if (!ehEdicao && origem === "associado" && !associadoSelecionado) {
      setErro("Selecione um associado pra vincular.");
      return;
    }
    if (origem === "livre" && !titulo.trim()) {
      setErro('Informe o "Título" do card.');
      return;
    }

    setSalvando(true);
    try {
      if (ehEdicao) {
        await atualizarCardJuridico(cardExistente.id, {
          titulo: ehVinculado ? undefined : titulo.trim(),
          descricao: ehVinculado ? undefined : descricao.trim() || null,
          observacoes: ehVinculado ? undefined : observacoes.trim() || null,
          responsavel: responsavel.trim() || null,
          prazo: prazo || null,
        });
      } else {
        await criarCardJuridico({
          etapaId,
          associadoId: origem === "associado" ? associadoSelecionado.id : undefined,
          titulo: origem === "livre" ? titulo.trim() : undefined,
          descricao: origem === "livre" ? descricao.trim() || undefined : undefined,
          observacoes: origem === "livre" ? observacoes.trim() || undefined : undefined,
          responsavel: responsavel.trim() || undefined,
          prazo: prazo || undefined,
        });
      }
      await onSalvo();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao salvar o card.");
    } finally {
      setSalvando(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4">
      <div className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl border border-border-soft bg-surface p-5 shadow-2xl">
        <div className="mb-4 flex items-center justify-between">
          <h3 className="font-display text-base font-bold text-foreground">{ehEdicao ? "Editar card" : "Novo card"}</h3>
          <button type="button" onClick={onFechar} className="rounded-lg p-1 text-muted-foreground hover:text-foreground">
            <IconClose className="h-4 w-4" />
          </button>
        </div>

        {!ehEdicao && (
          <div className="mb-4 flex rounded-xl border border-border-soft p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => setOrigem("associado")}
              className={`flex-1 rounded-lg py-1.5 transition-colors ${origem === "associado" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Vincular associado
            </button>
            <button
              type="button"
              onClick={() => setOrigem("livre")}
              className={`flex-1 rounded-lg py-1.5 transition-colors ${origem === "livre" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Livre
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          {origem === "associado" ? (
            ehEdicao ? (
              <div className="rounded-xl border border-border-soft bg-surface-elevated p-3 text-sm">
                <p className="font-semibold text-foreground">{cardExistente.associado.nome}</p>
                <p className="text-xs text-muted-foreground">
                  {cardExistente.associado.cpf_cnpj} · {cardExistente.associado.telefone}
                </p>
              </div>
            ) : associadoSelecionado ? (
              <div className="flex items-center justify-between gap-2 rounded-xl border border-border-soft bg-surface-elevated p-3 text-sm">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">{associadoSelecionado.nome}</p>
                  <p className="text-xs text-muted-foreground">{associadoSelecionado.cpf_cnpj}</p>
                </div>
                <button type="button" onClick={() => setAssociadoSelecionado(null)} className="shrink-0 text-xs font-medium text-primary hover:underline">
                  Trocar
                </button>
              </div>
            ) : (
              <div>
                <label className="mb-1 block text-xs font-medium text-muted-foreground">Buscar por nome, CPF/CNPJ ou telefone</label>
                <div className="relative">
                  <IconSearch className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <input
                    type="text"
                    value={buscaAssociado}
                    onChange={(e) => setBuscaAssociado(e.target.value)}
                    placeholder="Digite pra buscar..."
                    autoFocus
                    className="w-full rounded-xl border border-border-soft bg-surface-elevated py-2.5 pl-9 pr-3 text-sm text-foreground placeholder:text-muted/50 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40"
                  />
                </div>
                {buscando && (
                  <div className="flex justify-center py-3">
                    <Spinner className="h-4 w-4" />
                  </div>
                )}
                {!buscando && resultadosBusca.length > 0 && (
                  <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                    {resultadosBusca.map((a) => (
                      <li key={a.id}>
                        <button
                          type="button"
                          onClick={() => setAssociadoSelecionado(a)}
                          className="w-full rounded-lg border border-border-soft px-3 py-2 text-left text-sm hover:border-primary/40 hover:bg-surface-elevated"
                        >
                          <p className="font-medium text-foreground">{a.nome}</p>
                          <p className="text-xs text-muted-foreground">
                            {a.cpf_cnpj} · {formatCurrency(a.valor_em_aberto)} em aberto
                          </p>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )
          ) : (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Título</label>
              <input
                type="text"
                value={titulo}
                onChange={(e) => setTitulo(e.target.value)}
                disabled={salvando}
                autoFocus
                className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>
          )}

          {origem === "livre" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Descrição (opcional)</label>
              <textarea
                value={descricao}
                onChange={(e) => setDescricao(e.target.value)}
                disabled={salvando}
                rows={2}
                className="w-full resize-none rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>
          )}

          {origem === "livre" && (
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Observações (opcional)</label>
              <textarea
                value={observacoes}
                onChange={(e) => setObservacoes(e.target.value)}
                disabled={salvando}
                rows={2}
                className="w-full resize-none rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Responsável (opcional)</label>
              <input
                type="text"
                value={responsavel}
                onChange={(e) => setResponsavel(e.target.value)}
                disabled={salvando}
                className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Prazo (opcional)</label>
              <input
                type="date"
                value={prazo}
                onChange={(e) => setPrazo(e.target.value)}
                disabled={salvando}
                className="w-full rounded-xl border border-border-soft bg-surface-elevated px-3.5 py-2.5 text-sm text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
              />
            </div>
          </div>

          {erro && <ErrorBanner message={erro} />}

          <div className="flex items-center justify-end gap-2 pt-1">
            <button type="button" onClick={onFechar} disabled={salvando} className="rounded-lg px-3 py-2 text-sm font-medium text-muted-foreground hover:text-foreground">
              Cancelar
            </button>
            <button
              type="submit"
              disabled={salvando}
              className="flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
            >
              {salvando && <Spinner className="h-3.5 w-3.5" />}
              {ehEdicao ? "Salvar alterações" : "Criar card"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
