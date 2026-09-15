/**
 * Diagnóstico pontual (não escreve nada no banco) — isola
 * `buscarCpfCnpjComCardJuridico` (inadimplencia.controller.js, AJUSTE 17) e
 * compara o Set de CPF/CNPJ que ela devolve contra a lista "de verdade" de
 * associados com card real no Jurídico da franquia, pra achar exatamente
 * onde a função diverge.
 *
 * Contexto: o diagnóstico anterior (diagnostico-juridico-sumindo.js) já
 * descartou CPF/CNPJ divergente entre `associados`/`pagamentos_asaas` e
 * vencimento fora do período pra Fernanda — ela tem card real, franquia
 * certa, e pagamento dentro do período batendo por CPF exato. Ou seja, o
 * problema não está no CRUZAMENTO com `pagamentos_asaas` — está em algum
 * lugar ANTES disso, na própria lógica que decide "quem tem card no
 * Jurídico" (`buscarCpfCnpjComCardJuridico`) ou em como esse resultado é
 * usado depois (`aplicarFiltroTipoInadimplente`, não investigado aqui —
 * primeiro isola-se a função pedida).
 *
 * `buscarCpfCnpjComCardJuridico` NÃO é exportada pelo controller (só
 * `exports.resumo`/`exports.evolucaoMensal`/etc. são) — não dá pra
 * `require` ela direto. Em vez de copiar o código e confiar "de olho" que
 * ficou idêntico, este script:
 *   1. Lê o `inadimplencia.controller.js` de verdade, no disco, na hora que
 *      roda;
 *   2. Extrai o corpo da função por contagem de chaves (balanced braces),
 *      a partir da assinatura `async function buscarCpfCnpjComCardJuridico(`;
 *   3. Compara (ignorando espaços) esse texto extraído contra a cópia
 *      hardcoded abaixo (`FONTE_ESPERADA`);
 *   4. Se divergir — a função no controller mudou desde que este script foi
 *      escrito — ABORTA com erro em vez de rodar uma lógica desatualizada
 *      silenciosamente.
 * Só depois de passar nesse self-check é que a função (a cópia, agora
 * PROVADAMENTE idêntica byte-a-byte ao controller real) roda de verdade
 * contra o banco.
 *
 * IMPORTANTE — onde rodar: mesma DATABASE_URL do backend de produção (ver
 * docblock de diagnostico-ajuste8.js/diagnostico-juridico-sumindo.js).
 * NÃO escreve nada: só leitura do arquivo do controller + SELECT via Prisma.
 *
 * Uso:
 *   node scripts/diagnostico-buscarcpfcnpj-juridico.js --listar-franquias
 *   node scripts/diagnostico-buscarcpfcnpj-juridico.js --franquia=<id>
 */
const fs = require('fs');
const path = require('path');

const { criarPrismaEscopado } = require('../src/config/prismaComEscopo');
const prismaBase = require('../src/config/prisma');

const CONTROLLER_PATH = path.join(__dirname, '..', 'src', 'controllers', 'inadimplencia.controller.js');
const NOME_FUNCAO = 'buscarCpfCnpjComCardJuridico';

// Cópia literal de `buscarCpfCnpjComCardJuridico` — CONFERIDA contra o
// controller real toda vez que este script roda (ver `autoVerificar` mais
// abaixo). Se o controller mudar, o script aborta em vez de rodar algo
// desatualizado — não precisa confiar de memória que isto ficou igual.
const FONTE_ESPERADA = `async function buscarCpfCnpjComCardJuridico(reqPrisma) {
  const cards = await reqPrisma.cardJuridico.findMany({
    where: { associadoId: { not: null } },
    select: { associado: { select: { cpfCnpj: true } } },
  });
  return new Set(cards.map((c) => c.associado?.cpfCnpj).filter(Boolean));
}`;

function normalizarEspacos(texto) {
  return texto.replace(/\s+/g, ' ').trim();
}

/** Extrai o corpo de uma função `async function nome(...) { ... }` por contagem de chaves. */
function extrairFuncao(codigoFonte, nomeFuncao) {
  const marcador = `async function ${nomeFuncao}(`;
  const inicio = codigoFonte.indexOf(marcador);
  if (inicio === -1) {
    throw new Error(`Não encontrei "async function ${nomeFuncao}(" em ${CONTROLLER_PATH} — a função foi renomeada/removida/movida?`);
  }
  const inicioChave = codigoFonte.indexOf('{', inicio);
  if (inicioChave === -1) throw new Error(`Encontrei a assinatura de "${nomeFuncao}" mas não a chave de abertura "{".`);

  let profundidade = 0;
  let fim = -1;
  for (let i = inicioChave; i < codigoFonte.length; i += 1) {
    if (codigoFonte[i] === '{') profundidade += 1;
    else if (codigoFonte[i] === '}') {
      profundidade -= 1;
      if (profundidade === 0) {
        fim = i;
        break;
      }
    }
  }
  if (fim === -1) throw new Error(`Não consegui achar a chave de fechamento de "${nomeFuncao}" (chaves desbalanceadas?).`);
  return codigoFonte.slice(inicio, fim + 1);
}

/**
 * Confere que FONTE_ESPERADA (a cópia usada por este script) é, ignorando
 * espaços/quebras de linha, EXATAMENTE igual ao que está hoje no controller
 * real. Aborta o script se divergir — é a garantia de que o que roda aqui
 * embaixo é "a função isolada", não uma reimplementação por memória.
 */
function autoVerificar() {
  const codigoFonte = fs.readFileSync(CONTROLLER_PATH, 'utf-8');
  const extraida = extrairFuncao(codigoFonte, NOME_FUNCAO);
  const extraidaNormalizada = normalizarEspacos(extraida);
  const esperadaNormalizada = normalizarEspacos(FONTE_ESPERADA);

  if (extraidaNormalizada !== esperadaNormalizada) {
    console.error(`\n✗ SELF-CHECK FALHOU: "${NOME_FUNCAO}" no controller NÃO bate com a cópia usada por este script.`);
    console.error('\n--- No controller (agora) ---');
    console.error(extraida);
    console.error('\n--- Neste script (FONTE_ESPERADA) ---');
    console.error(FONTE_ESPERADA);
    console.error('\nAtualize FONTE_ESPERADA neste arquivo pra bater com o controller antes de rodar de novo.\n');
    process.exit(1);
  }
  console.log(`✓ Self-check: "${NOME_FUNCAO}" extraída de inadimplencia.controller.js bate exatamente com a cópia usada por este script.\n`);
  return extraida;
}

/** A MESMA lógica de buscarCpfCnpjComCardJuridico, só que devolvendo os cards brutos também, pra podermos investigar cada passo. */
async function buscarCpfCnpjComCardJuridicoInstrumentado(reqPrisma) {
  const cards = await reqPrisma.cardJuridico.findMany({
    where: { associadoId: { not: null } },
    select: { associado: { select: { cpfCnpj: true } } },
  });
  const cpfCnpjSet = new Set(cards.map((c) => c.associado?.cpfCnpj).filter(Boolean));
  return { cards, cpfCnpjSet };
}

async function main() {
  const argv = process.argv.slice(2);
  const listarFranquias = argv.includes('--listar-franquias');
  const franquiaArg = argv.find((a) => a.startsWith('--franquia='));
  const franquiaId = franquiaArg ? franquiaArg.slice('--franquia='.length) : null;

  if (listarFranquias) {
    const franquias = await prismaBase.franquia.findMany({ select: { id: true, nome: true, ativo: true } });
    console.log('Franquias cadastradas:');
    for (const f of franquias) console.log(`  ${f.id}  ${f.nome}${f.ativo ? '' : '  (INATIVA)'}`);
    await prismaBase.$disconnect();
    return;
  }

  if (!franquiaId) {
    console.error('Faltou --franquia=<id>. Rode com --listar-franquias pra ver os IDs disponíveis.');
    process.exitCode = 1;
    return;
  }

  autoVerificar();

  const prisma = criarPrismaEscopado(franquiaId);

  console.log(`=== Isolando buscarCpfCnpjComCardJuridico — franquia ${franquiaId} ===\n`);

  // ---------- A. Roda a função (instrumentada) de verdade ----------
  const { cards: cardsBrutos, cpfCnpjSet } = await buscarCpfCnpjComCardJuridicoInstrumentado(prisma);
  console.log(`=== A — Saída de buscarCpfCnpjComCardJuridico ===`);
  console.log(`cards_juridico com associadoId != null encontrados: ${cardsBrutos.length}`);
  console.log(`Set resultante (depois de .map + .filter(Boolean)): ${cpfCnpjSet.size} cpf_cnpj distintos\n`);
  console.log('Lista completa do Set:');
  const listaSet = [...cpfCnpjSet].sort();
  if (listaSet.length === 0) {
    console.log('  (vazio)');
  } else {
    for (const cpf of listaSet) console.log(`  "${cpf}"`);
  }
  console.log('');

  // Quantos registros de `cardsBrutos` NÃO contribuíram um cpfCnpj pro Set
  // (associado veio null/undefined, OU cpfCnpj veio falsy — "", null,
  // undefined — e foi descartado por .filter(Boolean)). Isso é feito ANTES
  // de qualquer outra consulta, só reprocessando o resultado bruto que a
  // função de verdade já devolveu.
  const cardsSemContribuicao = cardsBrutos.filter((c) => !c.associado?.cpfCnpj);
  if (cardsSemContribuicao.length > 0) {
    console.log(`⚠ ${cardsSemContribuicao.length} card(s) com associadoId != null NÃO geraram cpf_cnpj no Set (associado.cpfCnpj vazio/nulo, ou relação "associado" veio vazia):`);
    for (const c of cardsSemContribuicao) {
      console.log(`  associado.cpfCnpj = ${JSON.stringify(c.associado?.cpfCnpj)}  (associado presente na relação: ${c.associado !== null && c.associado !== undefined})`);
    }
    console.log('');
  }

  // ---------- B. Lista "de verdade" — todos os cards com associado, franquia inteira ----------
  const cardsComDetalhe = await prisma.cardJuridico.findMany({
    where: { associadoId: { not: null } },
    select: {
      id: true,
      franquiaId: true,
      associadoId: true,
      etapa: { select: { nome: true } },
      associado: { select: { id: true, nome: true, cpfCnpj: true, franquiaId: true } },
    },
    orderBy: { criadoEm: 'asc' },
  });
  console.log(`=== B — Todos os cards do Jurídico com associado, franquia inteira (${cardsComDetalhe.length}) ===`);
  for (const c of cardsComDetalhe) {
    console.log(`  ${c.associado?.nome ?? '(associado ausente!)'}`);
    console.log(`    card_id: ${c.id}  etapa: "${c.etapa?.nome ?? '?'}"  card.franquia_id: ${c.franquiaId}`);
    if (c.associado) {
      console.log(`    associado_id: ${c.associado.id}  associado.franquia_id: ${c.associado.franquiaId}  cpf_cnpj: "${c.associado.cpfCnpj}"`);
    } else {
      console.log(`    associado_id (FK no card): ${c.associadoId}  -> não retornou registro em "associados" (órfão?)`);
    }
  }
  console.log('');

  // ---------- C. Diff: cada card de B está representado no Set de A? ----------
  console.log('=== C — Divergência: cards com associado real que NÃO aparecem no Set de buscarCpfCnpjComCardJuridico ===');
  let divergencias = 0;
  for (const c of cardsComDetalhe) {
    const cpf = c.associado?.cpfCnpj;
    const noSet = cpf ? cpfCnpjSet.has(cpf) : false;
    if (!noSet) {
      divergencias += 1;
      console.log(`  ✗ ${c.associado?.nome ?? '(associado ausente)'}  cpf_cnpj=${JSON.stringify(cpf)}  card_id=${c.id}`);
      if (!c.associado) {
        console.log('      motivo: a relação "associado" não retornou registro nenhum pro associadoId do card (órfão) — investigar associados.controller.js/exclusão em cascata.');
      } else if (!cpf) {
        console.log('      motivo: associado.cpfCnpj é vazio/nulo — .filter(Boolean) descarta esse card do Set mesmo ele tendo um associado válido.');
      } else if (c.franquiaId !== c.associado.franquiaId) {
        console.log(`      motivo: card.franquia_id (${c.franquiaId}) != associado.franquia_id (${c.associado.franquiaId}) — card e associado em franquias diferentes (não deveria acontecer, mas explicaria não aparecer pro filtro desta franquia).`);
      } else {
        console.log('      motivo: NENHUM dos acima — cpf_cnpj presente, franquias batem, e mesmo assim não está no Set. Precisa investigar a query em si (nome do campo, tipo de dado, charset).');
      }
    }
  }
  if (divergencias === 0) {
    console.log('  Nenhuma — todo card com associado real está corretamente representado no Set. buscarCpfCnpjComCardJuridico está OK; o bug está em outro lugar do pipeline (ex.: aplicarFiltroTipoInadimplente, ou em como o Set é usado depois).');
  } else {
    console.log(`\n  Total: ${divergencias} de ${cardsComDetalhe.length} card(s) divergindo.`);
  }
  console.log('');

  // ---------- D. Diff reverso: algo no Set que não corresponde a nenhum card de B? ----------
  const cpfsEmB = new Set(cardsComDetalhe.map((c) => c.associado?.cpfCnpj).filter(Boolean));
  const sobrandoNoSet = listaSet.filter((cpf) => !cpfsEmB.has(cpf));
  if (sobrandoNoSet.length > 0) {
    console.log(`=== D — cpf_cnpj no Set que NÃO correspondem a nenhum card da lista B (inesperado, ${sobrandoNoSet.length}) ===`);
    for (const cpf of sobrandoNoSet) console.log(`  "${cpf}"`);
    console.log('');
  }

  console.log('=== Fim — cola este console inteiro de volta na conversa ===');
  await prismaBase.$disconnect();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
