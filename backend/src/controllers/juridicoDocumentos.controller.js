const fs = require('fs');
const multer = require('multer');
const config = require('../config/env');
const armazenamento = require('../services/armazenamentoDocumentos.service');

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
 * Wrapper em volta de "upload.single('arquivo')" pra converter erros do
 * multer (ex.: limite de tamanho excedido) numa resposta 400 com mensagem
 * amigável, em vez de cair no errorHandler genérico (que devolveria 500,
 * já que MulterError não tem ".status" — só o "ErroValidacaoDocumento" da
 * camada de validação de conteúdo tem).
 */
function uploadMiddleware(req, res, next) {
  upload.single('arquivo')(req, res, (err) => {
    if (!err) return next();
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

/** RFC 5987 — nome de arquivo com acentos/não-ASCII no Content-Disposition. */
function valorContentDisposition(nomeOriginal) {
  const fallbackAscii = nomeOriginal.replace(/[^\x20-\x7E]/g, '_').replace(/"/g, "'");
  return `attachment; filename="${fallbackAscii}"; filename*=UTF-8''${encodeURIComponent(nomeOriginal)}`;
}

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
