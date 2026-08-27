"use client";

import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";

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

/**
 * Editor rich text (Tiptap) usado na tela de Contratos pra montar o
 * conteúdo dos modelos. Exporta/importa HTML com <strong>, <h1-h3> e
 * <ol>/<li> — únicos recursos de formatação expostos na barra de
 * ferramentas, já que é só o que os placeholders {{...}} do contrato
 * precisam preservar. Colar texto copiado do Word normalmente preserva
 * negrito/títulos automaticamente (StarterKit já lida com o paste-HTML).
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
      </div>

      <div className="px-3.5 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
