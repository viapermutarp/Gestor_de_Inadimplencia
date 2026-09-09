const fs = require('fs');
const multer = require('multer');
const config = require('../config/env');
const armazenamento = require('../services/armazenamentoDocumentos.service');
const preview = require('../services/previewDocumento.service');

/**
 * Documentos anexados ao associado, visíveis no card do Kanban Jurídico
 * vinculado a ele (ver AJUSTE 11 — "Documentos anexados ao associado,
 * visíveis no card Jurídico"). Acesso: qualquer usuário com a tela Jurídico
 * liberada pode enviar/ver/baixar/excluir — mesmo "exigirRecurso('juridico')"
 * já usado no resto de juridico.routes.js, sem permissão nova (ver escopo
 * do pedido).
 *
 * Endpoints identificam o associado por "cpfCnpj" (não por "cardId" —
 * documentos sobrevivem à exclusão do card, ver docblock do model
 * DocumentoJuridico em schema.prisma), exceto download/exclusão, que usam o
 * "id" do próprio documento.
 */

// multer com memoryStorage (não diskStorage) de propósito: precisamos
// validar a assinatura real dos bytes (ver armazenamentoDocumentos.service.js)
// ANTES de decidir se/onde gravar em disco — com diskStorage o arquivo já
// teria sido escrito antes da validação rodar.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.juridicoUploadMaxBytes },
});

/**
 * BUG CORRIGIDO — nome de arquivo corrompido (acentos virando "CartÃ£o" em
 * vez de "Cartão"). Causa raiz confirmada por reprodução direta (não só
 * suposição): `multer` roda em cima do `busboy`, que decodifica o cabeçalho
 * `Content-Disposition: ...; filename="..."` do multipart como **Latin-1**
 * por padrão — mesmo quando o nome em si tem bytes UTF-8 de verdade (todo
 * navegador manda UTF-8 nesse campo, RFC 7578 não define charset explícito
 * pra ele, então bibliotecas antigas assumem Latin-1). Cada caractere
 * multi-byte UTF-8 (ex.: "ã" = `0xC3 0xA3`) acaba lido como 2 caracteres
 * Latin-1 separados (`Ã` + `£`), daí o "CartÃ£o". Reproduzido isoladamente
 * com `multer@1.4.5-lts.1` + `express`, tanto via `curl -F` quanto via
 * `fetch`/`FormData` nativos do Node (mesmo mecanismo que `lib/api.js` usa
 * no frontend) — os dois geram o mesmo `req.file.originalname` corrompido.
 * `Buffer.from(originalname, 'latin1').toString('utf8')` reverte
 * exatamente: reinterpreta os bytes que already estavam certos (só foram
 * DECODIFICADOS errado pelo busboy) como UTF-8 de verdade. Aplicado aqui,
 * uma única vez, logo depois que o multer termina de montar `req.file` —
 * assim todo consumidor downstream (validação, nome salvo em disco, nome
 * gravado no banco) já recebe o nome corrigido, sem precisar lembrar de
 * converter em cada lugar. Seguro pra nomes 100% ASCII (sem acentuação
 * nenhuma): Latin-1 e UTF-8 são idênticos nesse intervalo, então o
 * round-trip não altera nada.
 */
function corrigirEncodingNomeArquivo(nomeOriginal) {
  if (typeof nomeOriginal !== 'string') return nomeOriginal;
  return Buffer.from(nomeOriginal, 'latin1').toString('utf8');
}

/**
 * Wrapper em volta de "upload.single('arquivo')" pra converter erros do
 * multer (ex.: limite de tamanho excedido) numa resposta 400 com mensagem
 * amigável, em vez de cair no errorHandler genérico (que devolveria 500,
 * já que MulterError não tem ".status" — só o "ErroValidacaoDocumento" da
 * camada de validação de conteúdo tem).
 */
function uploadMiddleware(req, res, next) {
  upload.single('arquivo')(req, res, (err) => {
    if (!err) {
      if (req.file) req.file.originalname = corrigirEncodingNomeArquivo(req.file.originalname);
      return next();
    }
    if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
      const limiteMb = (config.juridicoUploadMaxBytes / (1024 * 1024)).toFixed(0);
      return res.status(400).json({ error: `Arquivo excede o tamanho máximo permitido (${limiteMb}MB).` });
    }
    if (err instanceof multer.MulterError) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  });
}

function campoPreenchido(valor) {
  return typeof valor === 'string' && valor.trim() !== '';
}

/**
 * "enviadoPor" é uma coluna solta, sem FK pra Usuario (ver docblock do
 * model) — mesmo padrão já usado em juridico.controller.js:listarHistoricoCard
 * pro mesmo problema (resolver nome de usuário sem relação Prisma pronta).
 */
async function mapaNomesUsuarios(req, documentos) {
  const ids = [...new Set(documentos.map((d) => d.enviadoPor).filter(Boolean))];
  if (!ids.length) return new Map();
  const usuarios = await req.prisma.usuario.findMany({
    where: { id: { in: ids } },
    select: { id: true, nome: true },
  });
  return new Map(usuarios.map((u) => [u.id, u.nome]));
}

function serializeDocumento(documento, nomePorUsuarioId = new Map()) {
  return {
    id: documento.id,
    cpf_cnpj: documento.cpfCnpj,
    nome_original: documento.nomeOriginal,
    tipo_mime: documento.tipoMime,
    tamanho_bytes: documento.tamanhoBytes,
    enviado_por: documento.enviadoPor,
    enviado_por_nome: documento.enviadoPor ? (nomePorUsuarioId.get(documento.enviadoPor) ?? null) : null,
    descricao: documento.descricao,
    criado_em: documento.criadoEm,
    // "caminho_arquivo" (caminho em disco) NUNCA é exposto — download só
    // via GET /api/juridico/documentos/:id/download (abaixo), que resolve o
    // caminho no servidor.
  };
}

/**
 * RFC 5987 — nome de arquivo com acentos/não-ASCII no Content-Disposition.
 * `disposicao`: "attachment" (download, força "salvar como") ou "inline"
 * (preview — pro navegador tentar exibir direto, ex.: PDF/imagem num
 * `<iframe>`/`<img>`, ver `previewDocumento` abaixo).
 */
function valorContentDisposition(nomeOriginal, disposicao = 'attachment') {
  const fallbackAscii = nomeOriginal.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `${disposicao}; filename="${fallbackAscii}"; filename*=UTF-8''${encodeURIComponent(nomeOriginal)}`;
}

// Tipos que são exibidos direto pelo navegador, sem conversão nenhuma —
// stream do arquivo original com Content-Disposition: inline (ver
// `previewDocumento` abaixo). Os outros dois tipos da allowlist (DOCX/
// XLSX) precisam virar HTML primeiro (ver `previewDocumento.service.js`).
const TIPOS_PREVIEW_STREAM = new Set(['application/pdf', 'image/jpeg', 'image/png']);
const TIPO_DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const TIPO_XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * POST /api/juridico/associados/:cpfCnpj/documentos — upload (multipart/
 * form-data, campo "arquivo"; "descricao" opcional). Valida o arquivo
 * (extensão + mimetype declarado + assinatura real dos bytes — ver
 * armazenamentoDocumentos.service.js) ANTES de gravar em disco ou criar o
 * registro; se a validação falhar, nada é persistido.
 */
exports.enviarDocumento = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;
    if (!req.file) {
      return res.status(400).json({ error: 'Nenhum arquivo enviado (campo "arquivo").' });
    }

    const associado = await req.prisma.associado.findUnique({ where: { cpfCnpj } });
    if (!associado) return res.status(404).json({ error: 'Associado não encontrado.' });

    armazenamento.validarArquivo({
      nomeOriginal: req.file.originalname,
      mimetype: req.file.mimetype,
      buffer: req.file.buffer,
    });

    const { caminhoArquivo, tamanhoBytes } = await armazenamento.salvarArquivo({
      cpfCnpj: associado.cpfCnpj,
      nomeOriginal: req.file.originalname,
      buffer: req.file.buffer,
    });

    const documento = await req.prisma.documentoJuridico.create({
      data: {
        cpfCnpj: associado.cpfCnpj,
        nomeOriginal: req.file.originalname,
        caminhoArquivo,
        tipoMime: req.file.mimetype,
        tamanhoBytes,
        enviadoPor: req.auth.user || null,
        descricao: campoPreenchido(req.body.descricao) ? req.body.descricao.trim() : null,
      },
    });

    const nomePorUsuarioId = await mapaNomesUsuarios(req, [documento]);
    res.status(201).json(serializeDocumento(documento, nomePorUsuarioId));
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/juridico/associados/:cpfCnpj/documentos — lista todos os
 * documentos do associado, independente de existir card aberto no momento
 * (ver docblock do model DocumentoJuridico em schema.prisma).
 */
exports.listarDocumentos = async (req, res, next) => {
  try {
    const { cpfCnpj } = req.params;
    const associado = await req.prisma.associado.findUnique({ where: { cpfCnpj } });
    if (!associado) return res.status(404).json({ error: 'Associado não encontrado.' });

    const documentos = await req.prisma.documentoJuridico.findMany({
      where: { cpfCnpj: associado.cpfCnpj },
      orderBy: { criadoEm: 'desc' },
    });

    const nomePorUsuarioId = await mapaNomesUsuarios(req, documentos);
    res.json(documentos.map((d) => serializeDocumento(d, nomePorUsuarioId)));
  } catch (err) {
    next(err);
  }
};

/** GET /api/juridico/documentos/:id/download */
exports.baixarDocumento = async (req, res, next) => {
  try {
    const documento = await req.prisma.documentoJuridico.findUnique({ where: { id: req.params.id } });
    if (!documento) return res.status(404).json({ error: 'Documento não encontrado.' });

    const caminhoAbsoluto = armazenamento.resolverCaminhoSeguro(documento.caminhoArquivo);
    if (!fs.existsSync(caminhoAbsoluto)) {
      return res.status(404).json({
        error:
          'Arquivo não encontrado em disco. Se isto acontecer em produção, verifique se o volume persistente do Jurídico (ver README) está configurado corretamente.',
      });
    }

    res.setHeader('Content-Type', documento.tipoMime);
    res.setHeader('Content-Disposition', valorContentDisposition(documento.nomeOriginal));
    res.sendFile(caminhoAbsoluto);
  } catch (err) {
    next(err);
  }
};

/**
 * GET /api/juridico/documentos/:id/preview — visualização INLINE (não
 * download), pra ser exibida dentro do próprio modal do card no frontend
 * (ver brief "Visualização inline de documentos"):
 *   - PDF e imagem (JPG/PNG): stream do arquivo ORIGINAL, sem conversão
 *     nenhuma — `Content-Disposition: inline` em vez de "attachment" é a
 *     única diferença real pro endpoint de download.
 *   - DOCX: convertido pra HTML na hora via `mammoth`.
 *   - XLSX: convertido pra tabela HTML na hora via `xlsx`/SheetJS
 *     (`sheet_to_html`, primeira aba).
 * Os dois últimos casos devolvem JSON (`{ tipo: "html", html }`, já
 * SANITIZADO — ver `previewDocumento.service.js`) em vez de stream, porque
 * o frontend precisa do HTML como string pra injetar num container
 * próprio (com scroll), não como um arquivo pra apontar um `<iframe>`.
 * Conversão SEM cache, de propósito (decisão consciente, ver escopo do
 * pedido — volume baixo de documentos hoje não justifica a complexidade de
 * invalidar cache no reenvio de um documento).
 *
 * Falha de conversão (arquivo corrompido, formato inesperado dentro do que
 * a extensão promete) devolve `422` com mensagem clara — nunca deixa o
 * erro estourar como 500 genérico — pro frontend cair no estado "Não foi
 * possível gerar visualização, baixe o arquivo" em vez de quebrar.
 */
exports.previewDocumento = async (req, res, next) => {
  try {
    const documento = await req.prisma.documentoJuridico.findUnique({ where: { id: req.params.id } });
    if (!documento) return res.status(404).json({ error: 'Documento não encontrado.' });

    const caminhoAbsoluto = armazenamento.resolverCaminhoSeguro(documento.caminhoArquivo);
    if (!fs.existsSync(caminhoAbsoluto)) {
      return res.status(404).json({
        error:
          'Arquivo não encontrado em disco. Se isto acontecer em produção, verifique se o volume persistente do Jurídico (ver README) está configurado corretamente.',
      });
    }

    if (TIPOS_PREVIEW_STREAM.has(documento.tipoMime)) {
      res.setHeader('Content-Type', documento.tipoMime);
      res.setHeader('Content-Disposition', valorContentDisposition(documento.nomeOriginal, 'inline'));
      return res.sendFile(caminhoAbsoluto);
    }

    const buffer = fs.readFileSync(caminhoAbsoluto);

    if (documento.tipoMime === TIPO_DOCX) {
      const html = await preview.converterDocxParaHtml(buffer);
      return res.json({ tipo: 'html', html });
    }

    if (documento.tipoMime === TIPO_XLSX) {
      const html = preview.converterXlsxParaHtml(buffer);
      return res.json({ tipo: 'html', html });
    }

    // Não deveria acontecer na prática — a allowlist de upload
    // (armazenamentoDocumentos.service.js) só aceita PDF/DOCX/XLSX/JPG/PNG,
    // e todos os 5 estão cobertos acima. Cobre só o caso de a allowlist ser
    // expandida no futuro sem um preview correspondente ser implementado
    // junto.
    return res.status(422).json({ error: 'Visualização não suportada para este tipo de arquivo.' });
  } catch (err) {
    next(err);
  }
};

/**
 * DELETE /api/juridico/documentos/:id — apaga o registro E o arquivo em
 * disco. Independente de qualquer card (ver docblock do model) — não há
 * nenhuma relação com cards_juridico aqui.
 */
exports.removerDocumento = async (req, res, next) => {
  try {
    const documento = await req.prisma.documentoJuridico.findUnique({ where: { id: req.params.id } });
    if (!documento) return res.status(404).json({ error: 'Documento não encontrado.' });

    await req.prisma.documentoJuridico.delete({ where: { id: req.params.id } });
    await armazenamento.removerArquivo(documento.caminhoArquivo);

    res.json({ ok: true });
  } catch (err) {
    if (err.code === 'P2025') return res.status(404).json({ error: 'Documento não encontrado.' });
    next(err);
  }
};

exports.uploadMiddleware = uploadMiddleware;
