const fs = require('fs');
const path = require('path');
const config = require('../config/env');

/**
 * Armazenamento em disco dos documentos anexados ao Jurídico (ver AJUSTE 11
 * — "Documentos anexados ao associado, visíveis no card Jurídico").
 *
 * Estrutura de pastas: "<JURIDICO_UPLOADS_DIR>/<cpf_cnpj só dígitos>/
 * <timestamp>-<nome-sanitizado>" (ver escopo do pedido). O CPF/CNPJ é
 * normalizado (só dígitos) SÓ pra nome de pasta — o valor gravado na coluna
 * "cpf_cnpj" da tabela é o mesmo valor já usado em Associado.cpfCnpj (ver
 * docblock do model DocumentoJuridico em schema.prisma), sem reformatar.
 *
 * Validação de tipo de arquivo em duas camadas, ambas obrigatórias (nunca
 * confiamos só na extensão do nome, conforme pedido explícito no escopo):
 *   1) Extensão do nome do arquivo E o mimetype DECLARADO pelo navegador
 *      (multipart/form-data) precisam bater com um tipo da allowlist.
 *   2) Os primeiros bytes do arquivo (assinatura/"magic bytes") precisam
 *      corresponder ao tipo — isso é o que de fato bloqueia um executável
 *      renomeado pra ".pdf": o conteúdo real não tem a assinatura "%PDF-",
 *      então é rejeitado mesmo que nome e Content-Type mintam.
 *
 * Decisão consciente: NÃO usamos a lib "file-type" (detecção de mimetype
 * por conteúdo) porque as versões atuais dela são ESM-only e quebrariam o
 * require() deste projeto (CommonJS). A verificação por assinatura de bytes
 * feita à mão aqui não distingue DOCX de XLSX com 100% de certeza usando só
 * os 4 primeiros bytes (os dois são arquivos ZIP — "PK\x03\x04"), então
 * complementamos com uma checagem adicional (heurística, não um parser de
 * ZIP completo): procurar pelas entradas típicas "word/" (DOCX) ou "xl/"
 * (XLSX) em algum lugar dos bytes do arquivo — presentes sem compressão nos
 * cabeçalhos locais de qualquer DOCX/XLSX gerado por ferramentas reais
 * (Word, Excel, LibreOffice, html-to-docx). O que isso garante de verdade,
 * com certeza absoluta, é a ameaça citada no escopo: "rejeitar tipos
 * executáveis mesmo que renomeados" — um executável (assinatura "MZ" ou
 * ELF) nunca passa nenhuma destas checagens.
 */

class ErroValidacaoDocumento extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroValidacaoDocumento';
    this.status = 400;
  }
}

function ehZip(buffer) {
  return (
    buffer.length >= 4 &&
    buffer[0] === 0x50 &&
    buffer[1] === 0x4b &&
    buffer[2] === 0x03 &&
    buffer[3] === 0x04
  );
}

function zipContemEntrada(buffer, marcador) {
  // Heurística intencional (ver docblock do arquivo) — não é um parser de
  // ZIP completo, só uma busca pela string em algum lugar dos bytes.
  return buffer.toString('latin1').includes(marcador);
}

function ehPdf(buffer) {
  return buffer.length >= 5 && buffer.slice(0, 5).toString('latin1') === '%PDF-';
}

function ehJpeg(buffer) {
  return buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
}

function ehPng(buffer) {
  const assinatura = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (buffer.length < assinatura.length) return false;
  return assinatura.every((byte, i) => buffer[i] === byte);
}

/**
 * Allowlist de tipos permitidos (ver escopo: "PDF, DOCX, XLSX, JPG/PNG —
 * lista de permissão por extensão + mime-type, fácil de expandir depois").
 * Pra adicionar um novo tipo no futuro, basta uma nova entrada aqui com sua
 * própria checagem de assinatura.
 */
const TIPOS_PERMITIDOS = {
  pdf: { mimes: ['application/pdf'], assinatura: ehPdf },
  docx: {
    mimes: ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    assinatura: (buffer) => ehZip(buffer) && zipContemEntrada(buffer, 'word/'),
  },
  xlsx: {
    mimes: ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    assinatura: (buffer) => ehZip(buffer) && zipContemEntrada(buffer, 'xl/'),
  },
  jpg: { mimes: ['image/jpeg'], assinatura: ehJpeg },
  jpeg: { mimes: ['image/jpeg'], assinatura: ehJpeg },
  png: { mimes: ['image/png'], assinatura: ehPng },
};

/**
 * Remove componentes de diretório (defesa contra path traversal do tipo
 * "../../etc/passwd") e qualquer caractere fora de uma allowlist segura,
 * mantendo a extensão original. "path.basename" já descarta qualquer
 * separador de diretório (tanto "/" quanto "\", inclusive em payload tipo
 * "..%2f..%2f" já decodificado); o replace abaixo é uma segunda camada
 * pros caracteres que sobrarem.
 */
function sanitizarNomeArquivo(nomeOriginal) {
  const base = path.basename(String(nomeOriginal || '').trim());
  const semDiacriticos = base.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const limpo = semDiacriticos.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_{2,}/g, '_');
  const semPontosNoInicio = limpo.replace(/^\.+/, '');
  return semPontosNoInicio || 'arquivo';
}

/** Só dígitos — usado apenas para nomear a pasta (ver docblock do arquivo). */
function normalizarCpfCnpj(valor) {
  return String(valor || '').replace(/\D/g, '');
}

function extensaoDe(nomeSanitizado) {
  return path.extname(nomeSanitizado).toLowerCase().replace(/^\./, '');
}

/**
 * Resolve um caminho relativo (gravado em "documentos_juridico.caminho_
 * arquivo") pro caminho absoluto real em disco, garantindo que o resultado
 * fique DENTRO do diretório raiz de uploads — defesa em profundidade contra
 * path traversal, além da sanitização já feita no nome do arquivo na hora
 * de salvar.
 */
function resolverCaminhoSeguro(caminhoRelativo) {
  const raiz = path.resolve(config.juridicoUploadsDir);
  const destino = path.resolve(raiz, caminhoRelativo);
  if (destino !== raiz && !destino.startsWith(raiz + path.sep)) {
    throw new ErroValidacaoDocumento('Caminho de arquivo inválido.');
  }
  return destino;
}

/**
 * Valida um arquivo recebido (buffer em memória, via multer memoryStorage —
 * ver juridicoDocumentos.controller.js) contra a allowlist de tipos, o
 * mimetype declarado E a assinatura real dos bytes. Lança
 * ErroValidacaoDocumento (status 400) se qualquer checagem falhar.
 */
function validarArquivo({ nomeOriginal, mimetype, buffer }) {
  if (!buffer || !buffer.length) {
    throw new ErroValidacaoDocumento('Arquivo vazio ou não enviado.');
  }
  if (buffer.length > config.juridicoUploadMaxBytes) {
    const limiteMb = (config.juridicoUploadMaxBytes / (1024 * 1024)).toFixed(0);
    throw new ErroValidacaoDocumento(`Arquivo excede o tamanho máximo permitido (${limiteMb}MB).`);
  }

  const nomeSanitizado = sanitizarNomeArquivo(nomeOriginal);
  const extensao = extensaoDe(nomeSanitizado);
  const tipo = TIPOS_PERMITIDOS[extensao];
  if (!tipo) {
    throw new ErroValidacaoDocumento(
      `Tipo de arquivo não permitido: "${extensao || '(sem extensão)'}". Tipos aceitos: PDF, DOCX, XLSX, JPG, PNG.`
    );
  }
  if (!tipo.mimes.includes(mimetype)) {
    throw new ErroValidacaoDocumento('O tipo do arquivo enviado não corresponde à extensão informada.');
  }
  if (!tipo.assinatura(buffer)) {
    throw new ErroValidacaoDocumento(
      'O conteúdo do arquivo não corresponde ao tipo declarado (arquivo corrompido, renomeado ou de um tipo não permitido).'
    );
  }

  return { extensao, nomeSanitizado };
}

/**
 * Grava o arquivo em disco sob "<uploadsDir>/<cpfCnpj só dígitos>/
 * <timestamp>-<nome-sanitizado>" e devolve o caminho RELATIVO (é isso que
 * fica gravado em "documentos_juridico.caminho_arquivo" — nunca o caminho
 * absoluto, pra não acoplar o registro ao caminho físico de um ambiente
 * específico).
 *
 * Não valida o arquivo — chame "validarArquivo(...)" ANTES (o controller
 * faz isso, pra poder responder 400 com uma mensagem específica sem deixar
 * nada gravado em disco quando a validação falha).
 */
async function salvarArquivo({ cpfCnpj, nomeOriginal, buffer }) {
  const cpfCnpjDigits = normalizarCpfCnpj(cpfCnpj);
  if (!cpfCnpjDigits) {
    throw new ErroValidacaoDocumento('CPF/CNPJ inválido.');
  }
  const nomeSanitizado = sanitizarNomeArquivo(nomeOriginal);

  const nomeArquivo = `${Date.now()}-${nomeSanitizado}`;
  const caminhoRelativo = `${cpfCnpjDigits}/${nomeArquivo}`;
  const caminhoAbsoluto = resolverCaminhoSeguro(caminhoRelativo);

  await fs.promises.mkdir(path.dirname(caminhoAbsoluto), { recursive: true });
  await fs.promises.writeFile(caminhoAbsoluto, buffer);

  return { caminhoArquivo: caminhoRelativo, tamanhoBytes: buffer.length };
}

/**
 * Remove o arquivo do disco. Tolerante a arquivo já ausente (ENOENT) — não
 * deve travar a exclusão do registro no banco por causa de um arquivo que,
 * por qualquer motivo (ex.: volume perdido, limpeza manual), já não existe
 * mais fisicamente.
 */
async function removerArquivo(caminhoArquivo) {
  try {
    const caminhoAbsoluto = resolverCaminhoSeguro(caminhoArquivo);
    await fs.promises.unlink(caminhoAbsoluto);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      throw err;
    }
  }
}

module.exports = {
  ErroValidacaoDocumento,
  TIPOS_PERMITIDOS,
  sanitizarNomeArquivo,
  normalizarCpfCnpj,
  validarArquivo,
  salvarArquivo,
  removerArquivo,
  resolverCaminhoSeguro,
};
