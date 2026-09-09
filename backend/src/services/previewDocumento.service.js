const mammoth = require('mammoth');
const XLSX = require('xlsx');
const sanitizeHtml = require('sanitize-html');

/**
 * Visualização inline de documentos do Jurídico (ver brief "Visualização
 * inline de documentos", endpoint `GET /api/juridico/documentos/:id/
 * preview` em `juridicoDocumentos.controller.js`). PDF e imagem (JPG/PNG)
 * não passam por aqui — são stream direto do arquivo original, sem
 * conversão nenhuma (ver controller). Este serviço cobre só os dois tipos
 * que precisam virar HTML pra serem visualizáveis no navegador: DOCX (via
 * `mammoth`) e XLSX (via `xlsx`/SheetJS, `sheet_to_html`).
 *
 * SEGURANÇA — sanitização obrigatória: o HTML que sai de `mammoth`/
 * `sheet_to_html` vem do CONTEÚDO de um arquivo enviado por um usuário
 * (nada garante que o docx/xlsx não foi manipulado à mão pra incluir, por
 * exemplo, um hyperlink com esquema `javascript:` ou uma imagem com `src`
 * apontando pra algo indevido) — nunca é seguro jogar esse HTML direto num
 * `dangerouslySetInnerHTML` sem sanitizar antes. Sanitizamos AQUI, no
 * backend (fonte única da verdade — o frontend sanitiza de novo com
 * DOMPurify antes de renderizar, como camada extra, mas não depende disso:
 * o HTML que sai desta função já é seguro por si só), com uma allowlist
 * explícita de tags/atributos/esquemas de URL via `sanitize-html` — nunca
 * uma blocklist (mais fácil esquecer de bloquear algo do que esquecer de
 * permitir algo).
 */

class ErroPreviewDocumento extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroPreviewDocumento';
    this.status = 422;
  }
}

const OPCOES_SANITIZE = {
  allowedTags: sanitizeHtml.defaults.allowedTags.concat([
    'img',
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'u',
    's',
    'del',
    'ins',
    'sup',
    'sub',
    'span',
    'br',
    'hr',
    'table',
    'thead',
    'tbody',
    'tfoot',
    'tr',
    'th',
    'td',
    'caption',
    'colgroup',
    'col',
  ]),
  allowedAttributes: {
    '*': ['style', 'colspan', 'rowspan', 'align', 'valign', 'width', 'height', 'class'],
    a: ['href', 'name', 'target', 'rel'],
    img: ['src', 'alt', 'width', 'height'],
  },
  // Allowlist de esquema de URL — bloqueia "javascript:", "vbscript:" e
  // qualquer outro esquema executável; "data:" só é permitido em <img>
  // (mammoth embute imagens do docx como "data:image/...;base64,...").
  allowedSchemes: ['http', 'https', 'mailto'],
  allowedSchemesByTag: { img: ['http', 'https', 'data'] },
  // Nenhum <style>/<script> nunca (não estão na allowlist de tags acima,
  // então já cairiam fora — mas listar explicitamente documenta a decisão
  // e blinda contra uma futura mudança na allowlist acima que esqueça
  // disso).
  disallowedTagsMode: 'discard',
  transformTags: {
    // Qualquer link que sobreviver à sanitização abre em nova aba sem
    // "window.opener" exposto (defesa padrão contra reverse tabnabbing) —
    // aplicado a TODO <a>, não só os de origem duvidosa, porque não dá pra
    // distinguir "link legítimo do documento" de "link malicioso" só pela
    // sintaxe.
    a: sanitizeHtml.simpleTransform('a', { rel: 'noopener noreferrer', target: '_blank' }),
  },
};

function sanitizar(html) {
  return sanitizeHtml(html, OPCOES_SANITIZE);
}

/**
 * ACHADO REAL EM TESTE (não é teórico) — `XLSX.read()` do SheetJS NÃO lança
 * erro pra bytes que não são um XLSX de verdade: ele faz "sniffing" e tenta
 * interpretar qualquer coisa (inclusive texto puro/lixo) como CSV, gerando
 * uma "planilha" com o lixo dentro em vez de falhar. Isso quebrava a
 * garantia pedida no brief ("se a conversão falhar... devolver erro
 * claro") — um XLSX corrompido silenciosamente virava uma tabela HTML com
 * lixo em vez de cair no 422. `validarArquivo` (armazenamentoDocumentos.
 * service.js) já confere a assinatura ZIP no upload, então isto é defesa em
 * profundidade pro caso do arquivo corromper DEPOIS de salvo (disco, ou o
 * cenário do volume persistente do EasyPanel ainda não confirmado — ver
 * README) — mesma checagem de assinatura ZIP ("PK\x03\x04") usada lá.
 */
function ehZip(buffer) {
  return (
    Buffer.isBuffer(buffer) &&
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

/** DOCX -> HTML (mammoth) já sanitizado. Lança ErroPreviewDocumento se a conversão falhar. */
async function converterDocxParaHtml(buffer) {
  let resultado;
  try {
    resultado = await mammoth.convertToHtml({ buffer });
  } catch (err) {
    throw new ErroPreviewDocumento(
      'Não foi possível gerar a visualização deste documento (arquivo corrompido ou em formato inesperado).'
    );
  }
  return sanitizar(resultado.value);
}

/** XLSX -> tabela HTML (SheetJS, primeira aba) já sanitizada. Lança ErroPreviewDocumento se falhar. */
function converterXlsxParaHtml(buffer) {
  // Ver docblock de "ehZip" acima — sem esta checagem, XLSX.read() aceita
  // silenciosamente bytes que não são um XLSX de verdade.
  if (!ehZip(buffer)) {
    throw new ErroPreviewDocumento(
      'Não foi possível gerar a visualização desta planilha (arquivo corrompido ou em formato inesperado).'
    );
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: 'buffer' });
  } catch (err) {
    throw new ErroPreviewDocumento(
      'Não foi possível gerar a visualização desta planilha (arquivo corrompido ou em formato inesperado).'
    );
  }

  const primeiraAba = workbook.SheetNames[0];
  if (!primeiraAba) {
    throw new ErroPreviewDocumento('A planilha não tem nenhuma aba pra exibir.');
  }

  let htmlBruto;
  try {
    htmlBruto = XLSX.utils.sheet_to_html(workbook.Sheets[primeiraAba]);
  } catch (err) {
    throw new ErroPreviewDocumento(
      'Não foi possível gerar a visualização desta planilha (arquivo corrompido ou em formato inesperado).'
    );
  }

  return sanitizar(htmlBruto);
}

module.exports = {
  ErroPreviewDocumento,
  converterDocxParaHtml,
  converterXlsxParaHtml,
  sanitizar,
};
