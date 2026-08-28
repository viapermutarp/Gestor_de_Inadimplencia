"use client";

import { useEffect } from "react";
import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle, FontFamily, FontSize } from "@tiptap/extension-text-style";

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

// Fontes usadas nos contratos reais da Via Permuta. Nomes com espaço
// (Courier New, Times New Roman) exigem o fix em htmlParaDocxFix.js no
// backend (ver test-docx-fonte-tamanho.js) — sem ele o .docx gerado sai
// com o nome da fonte quebrado.
const FONTES = [
  { valor: "", rotulo: "Fonte padrão" },
  { valor: "Courier New", rotulo: "Courier New" },
  { valor: "Arial", rotulo: "Arial" },
  { valor: "Times New Roman", rotulo: "Times New Roman" },
  { valor: "Calibri", rotulo: "Calibri" },
];

// Cobre pelo menos a faixa 8-14pt pedida (9pt e 12pt são os tamanhos
// usados nos contratos reais).
const TAMANHOS_FONTE = [8, 9, 10, 11, 12, 13, 14];

const SELECT_BASE =
  "h-8 rounded-lg border border-border-soft bg-surface px-2 text-xs text-foreground transition-colors focus:outline-none focus:border-primary disabled:cursor-not-allowed disabled:opacity-40";

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
 * Fonte (font-family) e tamanho (font-size) usam `@tiptap/extension-text-style`
 * (pacote oficial do Tiptap — inclui TextStyle, FontFamily e FontSize
 * prontos, sem precisar de extensão de terceiros nem de atributo
 * customizado). Os dois atributos ficam na mesma mark "textStyle" e saem
 * como um único <span style="font-family: ...; font-size: ..."> no HTML —
 * validado (test-docx-fonte-tamanho.js, backend) que esse span, mesmo
 * combinado com negrito/itálico/sublinhado, gera .docx com fonte e
 * tamanho corretos.
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
      TextStyle,
      FontFamily,
      FontSize,
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
        <span className="mx-1 h-5 w-px bg-border-soft" />
        <select
          title="Fonte"
          disabled={disabled}
          className={`${SELECT_BASE} w-36`}
          value={editor.getAttributes("textStyle").fontFamily || ""}
          onChange={(e) => {
            const valor = e.target.value;
            if (valor) {
              editor.chain().focus().setFontFamily(valor).run();
            } else {
              editor.chain().focus().unsetFontFamily().run();
            }
          }}
        >
          {FONTES.map((f) => (
            <option key={f.valor} value={f.valor}>
              {f.rotulo}
            </option>
          ))}
        </select>
        <select
          title="Tamanho da fonte"
          disabled={disabled}
          className={`${SELECT_BASE} w-24`}
          value={(editor.getAttributes("textStyle").fontSize || "").replace("pt", "")}
          onChange={(e) => {
            const valor = e.target.value;
            if (valor) {
              editor.chain().focus().setFontSize(`${valor}pt`).run();
            } else {
              editor.chain().focus().unsetFontSize().run();
            }
          }}
        >
          <option value="">Tamanho</option>
          {TAMANHOS_FONTE.map((tamanho) => (
            <option key={tamanho} value={tamanho}>
              {tamanho}pt
            </option>
          ))}
        </select>
      </div>

      <div className="px-3.5 py-3">
        <EditorContent editor={editor} />
      </div>
    </div>
  );
}
