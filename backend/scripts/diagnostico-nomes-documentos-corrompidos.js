/**
 * Diagnóstico pontual pro bug "nome de arquivo corrompido" nos documentos
 * do Jurídico (ver AJUSTE 11 e o fix aplicado em
 * juridicoDocumentos.controller.js:corrigirEncodingNomeArquivo). Causa
 * raiz: até o fix, `multer` decodificava o nome do arquivo enviado como
 * Latin-1 mesmo quando o navegador mandava UTF-8 de verdade — todo
 * documento enviado ANTES do fix, com acento no nome (ex.: "Cartão.pdf"),
 * ficou salvo no banco com o nome corrompido (ex.: "CartÃ£o.pdf"). Uploads
 * NOVOS (depois do fix) já salvam certo — este script é só pra levantar o
 * estrago já feito.
 *
 * NÃO escreve nada por padrão (só SELECT via Prisma) — roda em modo
 * dry-run, listando os documentos afetados e o nome corrigido proposto pra
 * cada um, sem aplicar nada. Só grava no banco (UPDATE do campo
 * `nome_original`) se você passar explicitamente `--corrigir` — e mesmo
 * assim, cada linha "corrigida" é logada, pra dar pra conferir depois.
 *
 * IMPORTANTE — onde rodar: precisa da MESMA `DATABASE_URL` que o backend de
 * PRODUÇÃO usa, senão não vai achar os documentos reais. Rode dentro do
 * ambiente/container de produção (mesmo padrão de
 * scripts/diagnostico-ajuste8.js — ver docblock lá pra mais detalhe de
 * como acessar um shell no EasyPanel).
 *
 * Heurística de detecção (não é 100% infalível, mas de baixíssimo falso
 * positivo em nomes de arquivo reais em português): um nome "parece
 * corrompido" quando (a) contém "Ã" ou "Â" — as duas primeiras letras que
 * aparecem quando um caractere acentuado comum em português (ã, á, à, â,
 * ç, é, ê, í, ó, ô, õ, ú, ü — todos 2 bytes em UTF-8 começando com 0xC3 ou,
 * mais raramente, 0xC2) é lido errado como Latin-1; e (b) reinterpretar os
 * bytes do nome como Latin-1 e decodificar de novo como UTF-8
 * (exatamente o fix aplicado no controller) produz uma string VÁLIDA
 * (sem caractere de substituição `�`) E DIFERENTE da original. As duas
 * condições juntas descartam nomes que por acaso têm um "Ã"/"Â" legítimo
 * sem estarem corrompidos (nesse caso a reconversão ou não muda nada, ou
 * quebra em `�`).
 *
 * Uso:
 *   node scripts/diagnostico-nomes-documentos-corrompidos.js                # lista, não altera nada
 *   node scripts/diagnostico-nomes-documentos-corrompidos.js --franquia=<id> # só essa franquia
 *   node scripts/diagnostico-nomes-documentos-corrompidos.js --corrigir     # aplica o UPDATE nos que a heurística achou
 */
const prisma = require('../src/config/prisma');

function parseArgs(argv) {
  const args = { corrigir: false, franquiaId: null };
  for (const a of argv) {
    if (a === '--corrigir') args.corrigir = true;
    else if (a.startsWith('--franquia=')) args.franquiaId = a.slice('--franquia='.length);
  }
  return args;
}

function nomeCorrigidoOuNull(nomeOriginal) {
  if (typeof nomeOriginal !== 'string') return null;
  if (!/[ÃÂ]/.test(nomeOriginal)) return null; // filtro rápido — sem essas letras, não é esse tipo de corrupção

  const reconvertido = Buffer.from(nomeOriginal, 'latin1').toString('utf8');
  if (reconvertido.includes('�')) return null; // reconversão gerou lixo — não confia
  if (reconvertido === nomeOriginal) return null; // nada mudou — não é esse caso

  return reconvertido;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  const where = args.franquiaId ? { franquiaId: args.franquiaId } : {};
  const documentos = await prisma.documentoJuridico.findMany({
    where,
    orderBy: { criadoEm: 'asc' },
    include: { franquia: { select: { nome: true } } },
  });

  console.log(`Total de documentos verificados: ${documentos.length}${args.franquiaId ? ` (franquia ${args.franquiaId})` : ' (todas as franquias)'}`);

  const suspeitos = [];
  for (const doc of documentos) {
    const corrigido = nomeCorrigidoOuNull(doc.nomeOriginal);
    if (corrigido) suspeitos.push({ doc, corrigido });
  }

  console.log(`Documentos com nome aparentando corrupção (Latin-1 lido como UTF-8): ${suspeitos.length}\n`);

  if (suspeitos.length === 0) {
    console.log('Nenhum documento suspeito encontrado — nada a fazer.');
    await prisma.$disconnect();
    return;
  }

  for (const { doc, corrigido } of suspeitos) {
    console.log(`- id=${doc.id}`);
    console.log(`    franquia: ${doc.franquia?.nome ?? doc.franquiaId}`);
    console.log(`    cpf_cnpj: ${doc.cpfCnpj}`);
    console.log(`    criado_em: ${doc.criadoEm.toISOString()}`);
    console.log(`    nome atual (corrompido):  "${doc.nomeOriginal}"`);
    console.log(`    nome proposto (corrigido): "${corrigido}"`);
    console.log('');
  }

  if (!args.corrigir) {
    console.log(
      `Modo dry-run (padrão) — nada foi alterado. Revise a lista acima; se os nomes propostos estiverem certos, rode de novo com --corrigir pra aplicar.`
    );
    await prisma.$disconnect();
    return;
  }

  console.log('--corrigir informado — aplicando UPDATE em cada documento listado acima...\n');
  let corrigidos = 0;
  for (const { doc, corrigido } of suspeitos) {
    await prisma.documentoJuridico.update({
      where: { id: doc.id },
      data: { nomeOriginal: corrigido },
    });
    console.log(`  OK  id=${doc.id}: "${doc.nomeOriginal}" -> "${corrigido}"`);
    corrigidos++;
  }
  console.log(`\n${corrigidos} documento(s) corrigido(s).`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('ERRO:', err);
  await prisma.$disconnect();
  process.exit(1);
});
