"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams, useRouter } from "next/navigation";
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
  historicoCardJuridico,
  listarDocumentosJuridico,
  uploadDocumentoJuridico,
  removerDocumentoJuridico,
  baixarDocumentoJuridico,
  visualizarDocumentoJuridico,
  ApiError,
} from "@/lib/api";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import Spinner from "@/components/Spinner";
import ErrorBanner from "@/components/ErrorBanner";
import {
  IconPlus,
  IconClose,
  IconUser,
  IconSearch,
  IconClock,
  IconScale,
  IconHistory,
  IconFileText,
  IconExpand,
} from "@/components/icons";

// Tamanho máximo de upload — mesmo valor default do backend
// (JURIDICO_UPLOAD_MAX_BYTES, ver src/config/env.js). Só usado aqui pra dar
// feedback imediato no cliente antes de gastar uma requisição; o backend
// sempre valida de novo (é a fonte de verdade real, inclusive se
// JURIDICO_UPLOAD_MAX_BYTES for configurado diferente em produção).
const TAMANHO_MAXIMO_DOCUMENTO_BYTES = 20 * 1024 * 1024;
const EXTENSOES_DOCUMENTO_ACEITAS = ".pdf,.docx,.xlsx,.jpg,.jpeg,.png";

function formatarTamanhoArquivo(bytes) {
  const num = Number(bytes);
  if (!Number.isFinite(num) || num < 0) return "-";
  if (num < 1024) return `${num} B`;
  if (num < 1024 * 1024) return `${(num / 1024).toFixed(1)} KB`;
  return `${(num / (1024 * 1024)).toFixed(1)} MB`;
}

// Kanban "Jurídico" (aba nova — ver escopo do pedido, item 1). Sem
// biblioteca de drag and drop (o projeto não usa nenhuma) — implementado
// com a API nativa do HTML5 (draggable + onDragStart/onDragOver/onDrop).
// Nenhuma atualização otimista: toda ação (mover card, reordenar coluna,
// criar/editar/excluir) chama a API e depois recarrega o board inteiro —
// mesmo padrão já usado em Controle Geral (carregarFranquias() após cada
// mutação), mais simples que reconciliar "ordem" no cliente.

// "useSearchParams" (usado abaixo pra ler "?card=<id>") exige um limite de
// Suspense acima dele em Server Components/App Router — o board de verdade
// mora em "JuridicoBoard"; o export default só adiciona esse limite.
export default function JuridicoPage() {
  return (
    <Suspense fallback={<div className="flex justify-center py-16"><Spinner className="h-6 w-6" /></div>}>
      <JuridicoBoard />
    </Suspense>
  );
}

function JuridicoBoard() {
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

  // AJUSTE 10 — Ligação Dashboard -> Jurídico: quando o Dashboard avisa que
  // um associado já tem um card aberto, o link do aviso traz pra cá com
  // "?card=<id>" — depois que o board carrega, rola até esse card e aplica
  // um destaque temporário (4s), pra o usuário localizá-lo sem precisar
  // procurar coluna por coluna. Só tenta uma vez por visita a esta página
  // (destacarTentadoRef) — se o card não for encontrado (já foi movido pra
  // outra franquia, excluído entre o aviso e o clique, etc.), desiste
  // silenciosamente e limpa a URL do mesmo jeito.
  const searchParams = useSearchParams();
  const router = useRouter();
  const cardAlvoId = searchParams.get("card");
  const [cardDestacadoId, setCardDestacadoId] = useState(null);
  const destacarTentadoRef = useRef(false);

  useEffect(() => {
    if (!cardAlvoId || destacarTentadoRef.current || carregando) return;
    destacarTentadoRef.current = true;

    const existeNoBoard = etapas.some((etapa) => etapa.cards.some((c) => c.id === cardAlvoId));
    if (existeNoBoard) {
      setCardDestacadoId(cardAlvoId);
      const el = document.getElementById(`card-juridico-${cardAlvoId}`);
      if (el) el.scrollIntoView({ behavior: "smooth", block: "center", inline: "center" });
      setTimeout(() => setCardDestacadoId(null), 4000);
    }

    router.replace("/juridico");
  }, [cardAlvoId, etapas, carregando, router]);

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
              cardDestacadoId={cardDestacadoId}
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
  cardDestacadoId,
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
            destacado={card.id === cardDestacadoId}
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

function CardJuridico({ card, onDragStart, onDropAntes, onEditar, onExcluir, destacado }) {
  return (
    <div
      id={`card-juridico-${card.id}`}
      draggable
      onDragStart={onDragStart}
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropAntes}
      className={`cursor-grab space-y-2 rounded-xl border bg-surface-elevated p-3 text-sm shadow-sm shadow-black/10 transition-shadow active:cursor-grabbing ${
        destacado ? "border-status-orange ring-2 ring-status-orange/60" : "border-border-soft"
      }`}
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

  // Aba "Histórico" só existe em edição (card novo ainda não tem eventos).
  // Aba "Documentos" (AJUSTE 11) só existe pra card VINCULADO a associado
  // ("ehVinculado") — documentos são ligados por cpfCnpj do associado, não
  // fazem sentido pra card livre (não tem associado nenhum pra anexar a).
  const [aba, setAba] = useState("dados"); // "dados" | "historico" | "documentos"

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
          descricao: descricao.trim() || null,
          observacoes: observacoes.trim() || null,
          responsavel: responsavel.trim() || null,
          prazo: prazo || null,
        });
      } else {
        await criarCardJuridico({
          etapaId,
          associadoId: origem === "associado" ? associadoSelecionado.id : undefined,
          titulo: origem === "livre" ? titulo.trim() : undefined,
          descricao: descricao.trim() || undefined,
          observacoes: observacoes.trim() || undefined,
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

        {ehEdicao && (
          <div className="mb-4 flex rounded-xl border border-border-soft p-1 text-xs font-medium">
            <button
              type="button"
              onClick={() => setAba("dados")}
              className={`flex-1 rounded-lg py-1.5 transition-colors ${aba === "dados" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Dados
            </button>
            <button
              type="button"
              onClick={() => setAba("historico")}
              className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 transition-colors ${aba === "historico" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              <IconHistory className="h-3.5 w-3.5" />
              Histórico
            </button>
            {ehVinculado && (
              <button
                type="button"
                onClick={() => setAba("documentos")}
                className={`flex flex-1 items-center justify-center gap-1.5 rounded-lg py-1.5 transition-colors ${aba === "documentos" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                <IconFileText className="h-3.5 w-3.5" />
                Documentos
              </button>
            )}
          </div>
        )}

        {ehEdicao && aba === "historico" ? (
          <HistoricoCard cardId={cardExistente.id} />
        ) : ehEdicao && aba === "documentos" && ehVinculado ? (
          <DocumentosCard cpfCnpj={cardExistente.associado.cpf_cnpj} />
        ) : (
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
        )}
      </div>
    </div>
  );
}

// Rótulos amigáveis pros valores de "campo_alterado" gravados pelo backend
// (ver CAMPOS_HISTORICO_CARD e registrarHistoricoCard em
// juridico.controller.js) — qualquer valor não mapeado aqui aparece cru,
// então não precisa manter as duas listas 100% sincronizadas.
const CAMPO_HISTORICO_LABEL = {
  criacao: "Card criado",
  exclusao: "Card excluído",
  etapa: "Etapa",
  titulo: "Título",
  descricao: "Descrição",
  observacoes: "Observações",
  responsavel: "Responsável",
  prazo: "Prazo",
};

// Aba "Histórico" do ModalCard (ajuste: visualizar histórico do card). Busca
// só quando a aba é aberta (sem cache entre aberturas — mesmo padrão de
// "sempre recarrega" usado no resto da página). Mais recente primeiro já
// vem garantido pelo backend (orderBy criadoEm desc).
function HistoricoCard({ cardId }) {
  const [eventos, setEventos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  useEffect(() => {
    let cancelado = false;
    setCarregando(true);
    setErro("");
    historicoCardJuridico(cardId)
      .then((data) => {
        if (!cancelado) setEventos(Array.isArray(data) ? data : []);
      })
      .catch((err) => {
        if (!cancelado) setErro(err instanceof ApiError ? err.message : "Erro ao carregar o histórico.");
      })
      .finally(() => {
        if (!cancelado) setCarregando(false);
      });
    return () => {
      cancelado = true;
    };
  }, [cardId]);

  if (carregando) {
    return (
      <div className="flex justify-center py-6">
        <Spinner className="h-5 w-5" />
      </div>
    );
  }

  if (erro) return <ErrorBanner message={erro} />;

  if (eventos.length === 0) {
    return <p className="py-4 text-center text-sm text-muted-foreground">Nenhum registro de histórico ainda.</p>;
  }

  return (
    <ul className="max-h-[55vh] space-y-2 overflow-y-auto">
      {eventos.map((ev) => (
        <li key={ev.id} className="rounded-xl border border-border-soft bg-surface-elevated p-3 text-sm">
          <div className="flex items-center justify-between gap-2">
            <span className="font-semibold text-foreground">{CAMPO_HISTORICO_LABEL[ev.campo_alterado] || ev.campo_alterado}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{formatDateTime(ev.criado_em)}</span>
          </div>
          {(ev.valor_anterior !== null || ev.valor_novo !== null) && (
            <p className="mt-1 text-xs text-muted-foreground">
              <span className="line-through">{ev.valor_anterior ?? "vazio"}</span>
              {" → "}
              <span className="text-foreground">{ev.valor_novo ?? "vazio"}</span>
            </p>
          )}
          <p className="mt-1 text-xs text-muted-foreground">{ev.usuario_nome || "Sistema (API)"}</p>
        </li>
      ))}
    </ul>
  );
}

function escapeHtml(valor) {
  return String(valor)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Monta o documento HTML completo escrito na aba nova de "Abrir em tela
 * cheia" pra DOCX/XLSX (ver `handleAbrirTelaCheia` em DocumentosCard — PDF/
 * imagem não passam por aqui, só abrem o blob já carregado direto). O HTML
 * de "htmlConteudo" já chega sanitizado duas vezes (backend + DOMPurify, ver
 * `visualizarDocumentoJuridico` em lib/api.js) — só falta deixar
 * "apresentável": fundo branco fixo (não o tema escuro do app — é conteúdo
 * de documento pra leitura, não uma tela do sistema), a mesma fonte de
 * corpo do app (IBM Plex Sans, via Google Fonts direto — o app carrega essa
 * fonte com "next/font/google", que faz self-host só dentro do bundle do
 * Next, sem uma URL própria pra reaproveitar aqui numa aba separada) e um
 * container de largura confortável de leitura, centralizado. Tabelas
 * largas (ex.: XLSX com muitas colunas) ficam dentro de um wrapper com
 * scroll horizontal PRÓPRIO — sem isso, uma tabela larga estouraria a
 * largura do container inteiro em vez de só rolar por dentro dela.
 */
function montarHtmlPreviewTelaCheia(nomeArquivo, htmlConteudo) {
  const tituloSeguro = escapeHtml(nomeArquivo || "Documento");
  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${tituloSeguro}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600;700&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  html, body {
    margin: 0;
    background: #ffffff;
    color: #1a1a1a;
    font-family: "IBM Plex Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  }
  .documento-cabecalho {
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 24px 0 24px;
  }
  .documento-cabecalho h1 {
    font-size: 1.15rem;
    font-weight: 600;
    margin: 0 0 4px 0;
    word-break: break-word;
  }
  .documento-cabecalho p {
    margin: 0 0 20px 0;
    font-size: 0.8rem;
    color: #6b7280;
  }
  .documento-corpo {
    max-width: 900px;
    margin: 0 auto;
    padding: 0 24px 56px 24px;
    line-height: 1.6;
    font-size: 0.95rem;
    border-top: 1px solid #e5e7eb;
    padding-top: 20px;
  }
  .documento-corpo img { max-width: 100%; }
  .documento-corpo table { border-collapse: collapse; width: 100%; }
  .documento-corpo td, .documento-corpo th {
    border: 1px solid #e5e7eb;
    padding: 6px 10px;
    text-align: left;
    white-space: nowrap;
  }
  /* Wrapper com scroll horizontal próprio — uma tabela com muitas colunas
     (XLSX largo) rola por dentro dela, sem estourar a largura confortável
     de leitura do container inteiro (ver docblock desta função). */
  .documento-tabela-scroll { max-width: 100%; overflow-x: auto; }
</style>
</head>
<body>
  <div class="documento-cabecalho">
    <h1>${tituloSeguro}</h1>
    <p>Visualização gerada pelo Gestor de Inadimplência</p>
  </div>
  <div class="documento-corpo"><div class="documento-tabela-scroll">${htmlConteudo}</div></div>
</body>
</html>`;
}

// Aba "Documentos" do ModalCard (AJUSTE 11 — "Documentos anexados ao
// associado, visíveis no card Jurídico"). Ligados por "cpfCnpj" do
// associado, não por "cardId" — por isso continuam existindo (e reaparecem
// aqui) mesmo se o card for excluído e um novo for criado depois pro mesmo
// associado (ver docblock do model DocumentoJuridico no backend). Só
// aparece pra card VINCULADO (ver "ehVinculado" em ModalCard) — card livre
// não tem associado nenhum pra anexar documento.
function DocumentosCard({ cpfCnpj }) {
  const [documentos, setDocumentos] = useState([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState("");

  const [arquivo, setArquivo] = useState(null);
  const [descricao, setDescricao] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [erroEnvio, setErroEnvio] = useState("");
  const inputArquivoRef = useRef(null);

  const [baixandoId, setBaixandoId] = useState(null);
  const [excluindoId, setExcluindoId] = useState(null);

  // Visualização inline (ver brief "Visualização inline de documentos") —
  // só um documento por vez fica expandido; "previewConteudo" guarda o
  // formato já normalizado por `visualizarDocumentoJuridico`
  // ({ tipo: "arquivo", url, mime } pra PDF/imagem via blob URL local, ou
  // { tipo: "html", html } já sanitizado pra DOCX/XLSX).
  const [previewAbertoId, setPreviewAbertoId] = useState(null);
  const [previewCarregando, setPreviewCarregando] = useState(false);
  const [previewErro, setPreviewErro] = useState("");
  const [previewConteudo, setPreviewConteudo] = useState(null);
  const previewUrlRef = useRef(null);

  // Blob URL do preview atual (PDF/imagem) precisa ser revogado explicitamente
  // — tanto ao trocar/fechar o preview quanto ao desmontar o componente
  // (fechar o modal do card sem clicar em "Visualizar" de novo) — senão vaza
  // memória a cada documento aberto.
  useEffect(() => {
    return () => {
      if (previewUrlRef.current) window.URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  function fecharPreview() {
    if (previewUrlRef.current) {
      window.URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewAbertoId(null);
    setPreviewConteudo(null);
    setPreviewErro("");
    setPreviewCarregando(false);
  }

  async function handleVisualizar(doc) {
    if (previewAbertoId === doc.id) {
      fecharPreview();
      return;
    }
    if (previewUrlRef.current) {
      window.URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreviewAbertoId(doc.id);
    setPreviewConteudo(null);
    setPreviewErro("");
    setPreviewCarregando(true);
    try {
      const resultado = await visualizarDocumentoJuridico(doc.id);
      if (resultado.tipo === "arquivo") previewUrlRef.current = resultado.url;
      setPreviewConteudo(resultado);
    } catch (err) {
      // Mensagem do backend (422, ex.: "arquivo corrompido ou em formato
      // inesperado") já é clara o bastante pra mostrar direto; qualquer
      // outro erro (rede, 404 etc.) cai no texto genérico pedido no brief.
      setPreviewErro(
        err instanceof ApiError ? err.message : "Não foi possível gerar visualização, baixe o arquivo."
      );
    } finally {
      setPreviewCarregando(false);
    }
  }

  /**
   * Botão "Abrir em tela cheia" (aditivo — o preview pequeno acima continua
   * exatamente como estava, esse é só um caminho alternativo pra quem quer
   * mais espaço). Só aparece quando o preview do documento já carregou com
   * sucesso (`previewConteudo`), então nunca precisa buscar nada de novo —
   * reaproveita o mesmo conteúdo já em memória:
   *   - PDF/imagem: `previewConteudo.url` já é um blob local do arquivo
   *     original — o navegador sabe renderizar isso nativamente numa aba,
   *     sem HTML/CSS nenhum da nossa parte.
   *   - DOCX/XLSX: não existe uma URL de arquivo pra abrir direto (é HTML
   *     convertido) — abre uma aba em branco e escreve nela um documento
   *     "apresentável" (ver `montarHtmlPreviewTelaCheia` acima).
   * `window.open` chamado direto (síncrono) dentro do próprio `onClick`,
   * nunca depois de um `await` — é isso que evita o bloqueador de pop-up
   * do navegador. Se ainda assim vier bloqueado (`null`), avisa em vez de
   * falhar silenciosamente.
   */
  function handleAbrirTelaCheia(doc) {
    if (!previewConteudo) return;

    if (previewConteudo.tipo === "arquivo") {
      const aba = window.open(previewConteudo.url, "_blank");
      if (!aba) setErro("Não foi possível abrir em tela cheia — verifique se o navegador bloqueou o pop-up.");
      return;
    }

    const aba = window.open("", "_blank");
    if (!aba) {
      setErro("Não foi possível abrir em tela cheia — verifique se o navegador bloqueou o pop-up.");
      return;
    }
    aba.document.write(montarHtmlPreviewTelaCheia(doc.nome_original, previewConteudo.html));
    aba.document.close();
  }

  const carregar = useCallback(async () => {
    setCarregando(true);
    setErro("");
    try {
      const data = await listarDocumentosJuridico(cpfCnpj);
      setDocumentos(Array.isArray(data) ? data : []);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao carregar os documentos.");
    } finally {
      setCarregando(false);
    }
  }, [cpfCnpj]);

  useEffect(() => {
    carregar();
  }, [carregar]);

  async function handleEnviar(e) {
    e.preventDefault();
    setErroEnvio("");

    if (!arquivo) {
      setErroEnvio("Selecione um arquivo.");
      return;
    }
    // Checagem no cliente só pra feedback imediato — o backend sempre
    // valida de novo (é a fonte de verdade real, ver
    // armazenamentoDocumentos.service.js).
    if (arquivo.size > TAMANHO_MAXIMO_DOCUMENTO_BYTES) {
      setErroEnvio(
        `Arquivo excede o tamanho máximo permitido (${(TAMANHO_MAXIMO_DOCUMENTO_BYTES / (1024 * 1024)).toFixed(0)}MB).`
      );
      return;
    }

    setEnviando(true);
    try {
      await uploadDocumentoJuridico(cpfCnpj, { arquivo, descricao: descricao.trim() || undefined });
      setArquivo(null);
      setDescricao("");
      if (inputArquivoRef.current) inputArquivoRef.current.value = "";
      await carregar();
    } catch (err) {
      setErroEnvio(err instanceof ApiError ? err.message : "Erro ao enviar o documento.");
    } finally {
      setEnviando(false);
    }
  }

  async function handleBaixar(doc) {
    setBaixandoId(doc.id);
    try {
      await baixarDocumentoJuridico(doc.id, doc.nome_original);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao baixar o documento.");
    } finally {
      setBaixandoId(null);
    }
  }

  async function handleExcluir(doc) {
    if (!window.confirm(`Excluir o documento "${doc.nome_original}"? Esta ação não pode ser desfeita.`)) return;
    setExcluindoId(doc.id);
    try {
      await removerDocumentoJuridico(doc.id);
      if (previewAbertoId === doc.id) fecharPreview();
      await carregar();
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : "Erro ao excluir o documento.");
    } finally {
      setExcluindoId(null);
    }
  }

  return (
    <div className="max-h-[55vh] space-y-3 overflow-y-auto">
      <form onSubmit={handleEnviar} className="space-y-2 rounded-xl border border-border-soft bg-surface-elevated p-3">
        <div>
          <label className="mb-1 block text-xs font-medium text-muted-foreground">Novo documento</label>
          <input
            ref={inputArquivoRef}
            type="file"
            accept={EXTENSOES_DOCUMENTO_ACEITAS}
            onChange={(e) => setArquivo(e.target.files?.[0] || null)}
            disabled={enviando}
            className="w-full text-xs text-foreground file:mr-3 file:rounded-lg file:border-0 file:bg-primary file:px-3 file:py-1.5 file:text-xs file:font-semibold file:text-primary-foreground disabled:opacity-60"
          />
          <p className="mt-1 text-[11px] text-muted-foreground">PDF, DOCX, XLSX, JPG ou PNG — até 20MB.</p>
        </div>
        <input
          type="text"
          value={descricao}
          onChange={(e) => setDescricao(e.target.value)}
          disabled={enviando}
          placeholder="Descrição (opcional)"
          className="w-full rounded-lg border border-border-soft bg-surface px-3 py-2 text-xs text-foreground focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60"
        />
        {erroEnvio && <ErrorBanner message={erroEnvio} />}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={enviando || !arquivo}
            className="flex items-center gap-2 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50"
          >
            {enviando && <Spinner className="h-3.5 w-3.5" />}
            Enviar
          </button>
        </div>
      </form>

      {erro && <ErrorBanner message={erro} />}

      {carregando ? (
        <div className="flex justify-center py-6">
          <Spinner className="h-5 w-5" />
        </div>
      ) : documentos.length === 0 ? (
        <p className="py-4 text-center text-sm text-muted-foreground">Nenhum documento anexado ainda.</p>
      ) : (
        <ul className="space-y-2">
          {documentos.map((doc) => (
            <li key={doc.id} className="rounded-xl border border-border-soft bg-surface-elevated p-3 text-sm">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="truncate font-semibold text-foreground">{doc.nome_original}</p>
                  <p className="text-xs text-muted-foreground">
                    {formatarTamanhoArquivo(doc.tamanho_bytes)} · {formatDateTime(doc.criado_em)}
                  </p>
                  {doc.descricao && <p className="mt-1 text-xs text-muted-foreground">{doc.descricao}</p>}
                  <p className="mt-1 text-[11px] text-muted-foreground">{doc.enviado_por_nome || "Sistema (API)"}</p>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1 text-xs font-medium">
                  <button
                    type="button"
                    onClick={() => handleVisualizar(doc)}
                    disabled={previewCarregando && previewAbertoId === doc.id}
                    className="text-primary hover:underline disabled:opacity-50"
                  >
                    {previewAbertoId === doc.id
                      ? previewCarregando
                        ? "Carregando..."
                        : "Fechar"
                      : "Visualizar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleBaixar(doc)}
                    disabled={baixandoId === doc.id}
                    className="text-primary hover:underline disabled:opacity-50"
                  >
                    {baixandoId === doc.id ? "Baixando..." : "Baixar"}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleExcluir(doc)}
                    disabled={excluindoId === doc.id}
                    className="text-status-red hover:underline disabled:opacity-50"
                  >
                    {excluindoId === doc.id ? "Excluindo..." : "Excluir"}
                  </button>
                </div>
              </div>

              {previewAbertoId === doc.id && (
                <div className="mt-3 border-t border-border-soft pt-3">
                  <div className="relative">
                    {/* Aditivo — o preview pequeno abaixo continua igual; isso só
                        oferece um caminho alternativo pra quem quer mais espaço.
                        Só aparece depois que o preview termina de carregar com
                        sucesso (senão não há nada ainda pra abrir em tela cheia). */}
                    {previewConteudo && (
                      <button
                        type="button"
                        onClick={() => handleAbrirTelaCheia(doc)}
                        title="Abrir em tela cheia"
                        aria-label="Abrir em tela cheia"
                        className="absolute right-2 top-2 z-10 rounded-lg bg-surface-elevated/90 p-1.5 text-muted-foreground shadow-sm ring-1 ring-border-soft transition-colors hover:text-foreground hover:bg-surface-elevated"
                      >
                        <IconExpand className="h-4 w-4" />
                      </button>
                    )}
                    {previewCarregando ? (
                      <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                        <Spinner className="h-4 w-4" />
                        Gerando visualização...
                      </div>
                    ) : previewErro ? (
                      <div className="space-y-2">
                        <ErrorBanner message={previewErro} />
                        <button
                          type="button"
                          onClick={() => handleBaixar(doc)}
                          disabled={baixandoId === doc.id}
                          className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                        >
                          {baixandoId === doc.id ? "Baixando..." : "Baixar o arquivo"}
                        </button>
                      </div>
                    ) : previewConteudo?.tipo === "arquivo" && previewConteudo.mime.startsWith("application/pdf") ? (
                      <iframe
                        src={previewConteudo.url}
                        title={doc.nome_original}
                        className="h-[70vh] w-full rounded-lg border border-border-soft bg-white"
                      />
                    ) : previewConteudo?.tipo === "arquivo" && previewConteudo.mime.startsWith("image/") ? (
                      // eslint-disable-next-line @next/next/no-img-element -- "src" é um blob URL local (autenticado na hora, revogado ao trocar/fechar o preview), não uma URL estática que o otimizador de imagem do Next consiga tratar.
                      <img
                        src={previewConteudo.url}
                        alt={doc.nome_original}
                        className="max-h-[70vh] w-full rounded-lg border border-border-soft object-contain"
                      />
                    ) : previewConteudo?.tipo === "html" ? (
                      // HTML já sanitizado (backend + DOMPurify em visualizarDocumentoJuridico,
                      // ver lib/api.js) — nunca renderizar HTML de documento aqui sem essa dupla
                      // sanitização.
                      <div
                        className="max-h-[70vh] overflow-auto rounded-lg border border-border-soft bg-white p-3 text-xs text-neutral-900"
                        dangerouslySetInnerHTML={{ __html: previewConteudo.html }}
                      />
                    ) : null}
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
