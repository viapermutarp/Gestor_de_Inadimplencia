// Contorna três limitações reais encontradas em "html-to-docx" 1.8.0
// (confirmadas lendo o código-fonte da lib e validadas gerando .docx reais
// e inspecionando o XML resultante — não é suposição):
//
// 1) A lib reconhece <i> como itálico, mas tem um switch interno
//    (dentro de buildRun, em html-to-docx.umd.js) que NÃO tem um "case"
//    pra <em> — só <i>. Como o Tiptap exporta itálico como <em> (padrão
//    HTML), qualquer <em> sozinho perde a formatação inteira ao virar
//    .docx (texto sai normal, sem itálico nenhum).
//
// 2) Mais sério: qualquer tag de formatação (<strong>/<b>/<i>/<u>/<ins>)
//    que tenha como ÚNICO filho outra tag de formatação PERDE a própria
//    formatação — só a tag mais interna da cadeia sobrevive no .docx
//    final. Isso acontece porque o código dessa lib só "persiste" a
//    formatação de um nível quando esse nível tem mais de 1 filho; com
//    exatamente 1 filho (o caso comum de aninhamento limpo, que é
//    EXATAMENTE como o Tiptap serializa uma seleção com múltiplas marcas
//    — ex.: negrito+itálico+sublinhado vira <strong><em><u>texto</u></em></strong>,
//    sem nenhum irmão) a formatação da tag externa é descartada.
//    Isso vale também quando o <strong><em>...</em></strong> vem dentro
//    de um <span style="..."> (caso de fonte/tamanho combinados com
//    negrito/itálico) — o span tem seu próprio caminho de código
//    (buildRunOrRuns), mas ele delega pro mesmo buildRun problemático
//    pra processar a cadeia de formatação interna, então o mesmo bug (e o
//    mesmo fix) se aplica.
//
// 3) A lib NÃO decodifica entidades HTML (ex.: &quot;) dentro do valor do
//    atributo style antes de interpretar font-family. Nomes de fonte com
//    mais de uma palavra (ex.: "Courier New", "Times New Roman") são
//    naturalmente serializados pelo Tiptap/DOM como
//    style="font-family: &quot;Courier New&quot;" (aspas reais viram
//    entidade ao virar string HTML — isso é serialização HTML padrão, não
//    peculiaridade do Tiptap). A lib usa esse valor cru sem decodificar a
//    entidade, então o nome da fonte sai truncado/quebrado no .docx
//    (confirmado gerando o arquivo e inspecionando w:rFonts). Fontes de
//    uma palavra só (Arial, Calibri) não têm esse problema, só as com
//    espaço.
//
// O fix: (a) normaliza <em> -> <i>; (b) pra cada tag de formatação com
// exatamente 1 filho que também é uma tag de formatação, injeta um
// espaço de largura zero (U+200B, invisível, não imprime, não afeta
// texto/placeholders já resolvidos) como um filho irmão extra — isso
// tira o código da lib do caminho com bug, sem qualquer efeito visual no
// documento final. Repetido em loop até estabilizar, pra cobrir cadeias
// de 3 níveis (negrito+itálico+sublinhado juntos); (c) remove aspas
// (simples ou duplas) de cada nome dentro de font-family no atributo
// style — como o cheerio já decodifica a entidade ao ler o atributo, a
// remoção acontece nos caracteres reais, e o valor final (sem aspas) sai
// sem precisar de entidade nenhuma na hora de serializar de volta pra
// HTML, contornando o bug 3 por completo (nomes com espaço continuam
// funcionando sem aspas, já testado).
//
// Ver test-docx-formatacao-combinada.js e test-docx-fonte-tamanho.js pra
// as suítes de regressão que geram .docx reais e conferem o XML gerado,
// cobrindo exatamente os casos que motivaram este arquivo.

const cheerio = require('cheerio');

const ESPACO_LARGURA_ZERO = '​';
const TAGS_FORMATACAO = new Set(['strong', 'b', 'i', 'u', 'ins']);

/**
 * Remove aspas simples/duplas de cada nome de fonte dentro do valor de
 * font-family (ex.: 'font-family: "Courier New", Arial' vira
 * 'font-family: Courier New, Arial'). Ver bug 3 acima.
 */
function removerAspasDeFontFamily(styleValue) {
  return styleValue.replace(/font-family\s*:\s*([^;]+)/i, (match, valor) => {
    const semAspas = valor
      .split(',')
      .map((parte) => parte.trim().replace(/^['"]+|['"]+$/g, ''))
      .join(', ');
    return `font-family: ${semAspas}`;
  });
}

/**
 * Aplica os três ajustes acima num HTML antes de mandar pro
 * `html-to-docx`. Idempotente e segura de rodar em qualquer HTML — não
 * assume nada além de que <em>/<strong>/<i>/<u>/<b>/<ins> seguem a
 * semântica HTML padrão (sem atributos customizados nessas tags, que é
 * exatamente o que o RichTextEditor da tela de Contratos produz).
 */
function corrigirHtmlParaDocx(html) {
  if (!html) return html;

  const $ = cheerio.load(html, null, false);

  $('em').each((_, el) => {
    el.tagName = 'i';
    el.name = 'i';
  });

  $('[style*="font-family"]').each((_, el) => {
    const $el = $(el);
    const styleAtual = $el.attr('style');
    if (styleAtual) {
      $el.attr('style', removerAspasDeFontFamily(styleAtual));
    }
  });

  let mudou = true;
  let seguranca = 0;
  // Cadeias mais longas (3+ níveis) só ficam totalmente corrigidas depois
  // de várias passadas — cada passada resolve um nível por vez. 20
  // iterações é bem mais que suficiente pra qualquer HTML real de
  // contrato (uma cadeia de formatação nunca passaria de 4-5 níveis).
  while (mudou && seguranca < 20) {
    mudou = false;
    $('strong, b, i, u, ins').each((_, el) => {
      const $el = $(el);
      const filhos = $el.contents();
      if (filhos.length !== 1) return;
      const unico = filhos.get(0);
      if (unico.type === 'tag' && TAGS_FORMATACAO.has(unico.tagName || unico.name)) {
        $el.prepend(ESPACO_LARGURA_ZERO);
        mudou = true;
      }
    });
    seguranca += 1;
  }

  return $.html();
}

module.exports = { corrigirHtmlParaDocx };
