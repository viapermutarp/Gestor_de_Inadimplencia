"use client";

import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";

const BOTAO_BASE =
  "flex h-8 min-w-8 items-center justify-center rounded-lg px-2 text-xs font-semibold transition-colors";

function BotaoToolbar({ ativo, disabled, onClick, children, title }) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      // Evita que o clique no botão tire o foco/seleção de texto do
      // editor antes do comando (toggleBold etc.) rodar.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`${BOTAO_BASE} disabled:cursor-not-allowed disabled:opacity-40 ${
        ativo
          ? "bg-primary text-primary-foreground"
          : "text-muted-foreground hover:bg-surface hover:text-foreground"
      }`}
    >
      {children}
    </button>
  );
}

const ALINHAMENTO_ICONE = {
  left: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-4 w-4">
      <path d="M4 6h16M4 12h10M4 18h13" />
    </svg>
  ),
  center: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-4 w-4">
      <path d="M4 6h16M7 12h10M5.5 18h13" />
    </svg>
  ),
  right: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-4 w-4">
      <path d="M4 6h16M10 12h10M7 18h13" />
    </svg>
  ),
  justify: (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" className="h-4 w-4">
      <path d="M4 6h16M4 12h16M4 18h16" />
    </svg>
  ),
};

const ALINHAMENTOS = [
  { valor: "left", titulo: "Alinhar à esquerda" },
  { valor: "center", titulo: "Centralizar" },
  { valor: "right", titulo: "Alinhar à direita" },
  { valor: "justify", titulo: "Justificar" },
];

/**
 * Editor rich text (Tiptap) usado na tela de Contratos pra montar o
 * conteúdo dos modelos. Exporta/importa HTML com <strong>, <em>, <u>,
 * <h1-h3>, <ol>/<ul>/<li> e alinhamento de texto (style="text-align: ...")
 * — os recursos de formatação expostos na barra de ferramentas, pensados
 * pro que os placeholders {{...}} e a redação de um contrato precisam
 * preservar. Colar texto copiado do Word normalmente preserva
 * negrito/itálico/sublinhado/títulos automaticamente (StarterKit já lida
 * com o paste-HTML).
 *
 * Itálico, sublinhado e lista com marcadores já vêm inclusos no
 * StarterKit 3.x (não precisam de extensão separada) — só não estavam
 * expostos na barra de ferramentas antes. Alinhamento de texto não faz
 * parte do StarterKit, por isso a extensão `@tiptap/extension-text-align`
 * separada, aplicada a parágrafos e títulos.
 *
 * "value"/"onChange" seguem o padrão de um input controlado — "onChange"
 * é chamado com o HTML atual (editor.getHTML()) a cada edição.
 */
export default function RichTextEditor({ value, onChange, disabled }) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Desliga recursos que não fazem sentido pra um contrato — mantém
        // o editor simples e focado no que os modelos realmente usam.
        codeBlock: false,
        code: false,
        strike: false,
        blockquote: false,
        horizontalRule: false,
      }),
      TextAlign.configure({
        types: ["heading", "paragraph"],
      }),
    ],
    content: value || "",
    editable: !disabled,
    immediatelyRender: false,
    onUpdate: ({ editor: ed }) => {
      onChange?.(ed.getHTML());
    },
    editorProps: {
      attributes: {
        class: "prose-contrato min-h-[220px] max-w-none focus:outline-none",
      },
    },
  });

  // Mantém o editor sincronizado se "value" mudar de fora (ex.: ao trocar
  // de modelo selecionado num formulário que reaproveita o mesmo editor).
  useEffect(() => {
    if (!editor || value === undefined) return;
    if (value !== editor.getHTML()) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [value, editor]);

  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [disabled, editor]);

  if (!editor) return null;

  return (
    <div className="overflow-hidden rounded-xl border border-border-soft bg-surface">
      <div className="flex flex-wrap items-center gap-1 border-b border-border-soft bg-surface-elevated px-2 py-1.5">
        <BotaoToolbar
          title="Negrito"
          disabled={disabled}
          ativo={editor.isActive("bold")}
          onClick={() => editor.chain().focus().toggleBold().run()}
        >
          <span className="font-bold">B</span>
        </BotaoToolbar>
        <BotaoToolbar
          title="Itálico"
          disabled={disabled}
          ativo={editor.isActive("italic")}
          onClick={() => editor.chain().focus().toggleItalic().run()}
        >
          <span className="italic">I</span>
        </BotaoToolbar>
        <BotaoToolbar
          title="Sublinhado"
          disabled={disabled}
          ativo={editor.isActive("underline")}
          onClick={() => editor.chain().focus().toggleUnderline().run()}
        >
          <span className="underline">U</span>
        </BotaoToolbar>
        <span className="mx-1 h-5 w-px bg-border-soft" />
        <BotaoToolbar
          title="Título 1"
          disabled={disabled}
          ativo={editor.isActive("heading", { level: 1 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}
        >
          H1
        </BotaoToolbar>
        <BotaoToolbar
          title="Título 2"
          disabled={disabled}
          ativo={editor.isActive("heading", { level: 2 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}
        >
          H2
        </BotaoToolbar>
        <BotaoToolbar
          title="Título 3"
          disabled={disabled}
          ativo={editor.isActive("heading", { level: 3 })}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}
        >
          H3
        </BotaoToolbar>
        <span className="mx-1 h-5 w-px bg-border-soft" />
        <BotaoToolbar
          title="Lista numerada"
          disabled={disabled}
          ativo={editor.isActive("orderedList")}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}
        >
          1.
        </BotaoToolbar>
        <BotaoToolbar
          title="Lista com marcadores"
          disabled={disabled}
          ativo={editor.isActive("bulletList")}
          onClick={() => editor.chain().focus().toggleBulletList().run()}
        >
          •
        </BotaoToolbar>
        <span className="mx-1 h-5 w-px bg-border-soft" />
        {ALINHAMENTOS.map((a) => (
          <BotaoToolbar
            key={a.valor}
            title={a.titulo}
            disabled={disabled}
            ativo={editor.isActive({ textAlign: a.valor })}
            onClick={() => editor.chain().focus().setTextAlign(a.valor).run()}
          >
            {ALINHAMENTO_ICONE[a.valor]}
          </BotaoToolbar>
        ))}
      </div>

      <div className="px-3.5 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
