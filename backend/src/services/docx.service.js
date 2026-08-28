const HTMLtoDOCX = require('html-to-docx');
const { corrigirHtmlParaDocx } = require('../lib/htmlParaDocxFix');

/**
 * Converte um HTML (já com os placeholders {{...}} resolvidos) num buffer
 * .docx. Usa "html-to-docx" (npm), sem depender de LibreOffice instalado
 * no servidor — testado contra títulos (h1-h6), negrito, itálico,
 * sublinhado, listas numeradas e com marcadores (<ol>/<ul>/<li>) e
 * alinhamento de texto: gera numeração automática nativa do Word
 * (numbering.xml com numFmt "decimal"/"bullet"), não texto "1. "/"•"
 * digitado. Ver README para o comparativo com LibreOffice headless.
 *
 * Antes de converter, roda `corrigirHtmlParaDocx` (ver
 * src/lib/htmlParaDocxFix.js) — contorna dois bugs reais do
 * "html-to-docx" 1.8.0 que fazem <em> sozinho e combinações de
 * negrito+itálico+sublinhado (ex.: <strong><em><u>texto</u></em></strong>,
 * exatamente como o Tiptap serializa) perderem formatação no .docx final.
 */
async function gerarDocxBuffer(html) {
  const htmlCorrigido = corrigirHtmlParaDocx(html);
  const buffer = await HTMLtoDOCX(htmlCorrigido, null, {
    table: { row: { cantSplit: true } },
    footer: false,
    pageNumber: false,
  });
  return buffer;
}

module.exports = { gerarDocxBuffer };
