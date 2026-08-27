const HTMLtoDOCX = require('html-to-docx');

/**
 * Converte um HTML (já com os placeholders {{...}} resolvidos) num buffer
 * .docx. Usa "html-to-docx" (npm), sem depender de LibreOffice instalado
 * no servidor — testado contra títulos (h1-h6), negrito e listas
 * numeradas (<ol>/<li>): gera numeração automática nativa do Word
 * (numbering.xml com numFmt "decimal"), não texto "1. " digitado. Ver
 * README para o comparativo com LibreOffice headless.
 */
async function gerarDocxBuffer(html) {
  const buffer = await HTMLtoDOCX(html, null, {
    table: { row: { cantSplit: true } },
    footer: false,
    pageNumber: false,
  });
  return buffer;
}

module.exports = { gerarDocxBuffer };
