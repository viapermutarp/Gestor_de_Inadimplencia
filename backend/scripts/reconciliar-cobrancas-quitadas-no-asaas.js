/**
 * Reconciliação periódica de `cobrancas` via `pagamentos_asaas` (AJUSTE 18)
 * — rede de segurança contínua contra a lacuna estrutural da janela
 * rolante do n8n.
 *
 * CAUSA RAIZ (confirmada investigando o caso "Marcela", CPF
 * 27649948000129 — ver `scripts/diagnostico-marcela-cobranca-presa.js`):
 * `POST /api/sync` reconcilia cobranças pagas usando a `janela`
 * (`-53/+5 dias de hoje`) que o n8n manda a cada chamada — mas essa janela
 * só anda pra frente. Uma cobrança cujo `vencimento` envelhece além do
 * início da janela fica permanentemente fora de alcance de QUALQUER
 * reconciliação futura baseada nesse payload, mesmo que seja paga depois.
 *
 * Este script (e o endpoint HTTP irmão, `POST /api/sync/reconciliar-cobrancas-quitadas`)
 * é uma segunda via, independente do payload do n8n: usa `pagamentos_asaas`
 * (atualizado continuamente via webhook — AJUSTE 14 — sem limite de janela
 * por data de vencimento) como fonte de verdade. Toda `Cobranca`
 * `pending`/`overdue` cujo `id_externo` já está em STATUS_ADIMPLENTE_ASAAS
 * (RECEIVED/RECEIVED_IN_CASH/CONFIRMED) em `pagamentos_asaas` é marcada
 * `quitada` — a mesma comparação POR COBRANÇA INDIVIDUAL (nunca por
 * associado inteiro) já validada em
 * `scripts/diagnostico-cobrancas-presas-sistemico.js`, reaproveitando a
 * lógica de `src/services/cobrancasPresas.service.js` (nenhuma lógica
 * duplicada entre os caminhos: este script, o endpoint HTTP, e o
 * diagnóstico manual).
 *
 * NÃO substitui `POST /api/sync` — continua sendo a fonte primária de
 * novidade (cobrança nova, valor mudado, mudança de status ainda não
 * refletida aqui). Isto só fecha o buraco temporal que a janela rolante
 * deixa aberto pra quitações que "envelheceram" pra fora dela.
 *
 * SEM agendador interno (mesmo padrão do resto do projeto — ver docblock
 * de `scripts/reconciliar-pagamentos-asaas.js`): feito pra ser chamado por
 * um agendador de fora (cron do host, ou um workflow n8n agendado — igual
 * ao "Sync Horário" que já dispara `POST /api/sync`). Frequência sugerida:
 * DIÁRIA — o objetivo é só pegar o que escapou da janela, não novidade em
 * tempo real (isso continua sendo `POST /api/sync`, horário).
 *
 * IMPORTANTE — leia antes de rodar:
 *   - Roda em modo DRY RUN por padrão — só reporta o que seria quitado/
 *     removido, não escreve nada no banco. Passe --confirm para aplicar de
 *     verdade (é assim que um agendador externo deve chamar este script na
 *     prática, depois de já ter sido validado em dry-run pelo menos uma
 *     vez).
 *   - `quitadaEm` grava a data real do Asaas — `paymentDate` ??
 *     `clientPaymentDate` ?? `confirmedDate` ?? "agora" (AJUSTE 22, revisão
 *     pré-commit, item 2 — ver docblock de `aplicarQuitacao` no serviço).
 *   - Não é hard delete: os registros continuam no banco, só mudam de
 *     status (mesmo comportamento de `POST /api/sync` e de
 *     `scripts/reconciliar-cobrancas-presas.js`).
 *   - Guardrail de segurança pras "presas": recusa aplicar (--confirm) se o
 *     total de presas encontradas passar muito do esperado, a não ser que
 *     --force também seja passado — evita quitar em massa por engano se
 *     algo inesperado acontecer nos dados (ex.: pagamentos_asaas com um bug
 *     upstream marcando muita coisa como RECEIVED por engano).
 *   - Guardrail de segurança pras "removida" (AJUSTE 22, revisão
 *     pré-commit, item 4 — `LIMITE_GUARDRAIL_REMOVIDAS`, ver docblock em
 *     `cobrancasRemovidas.service.js`): se, numa mesma franquia, mais de
 *     `LIMITE_GUARDRAIL_REMOVIDAS` candidatas forem confirmadas como
 *     "removida" nesta rodada, NENHUMA é aplicada pra aquela franquia —
 *     reportado, sem --force pra ignorar isto (diferente do guardrail das
 *     "presas" acima) — revise manualmente antes de aplicar via
 *     `scripts/corrigir-cobrancas-removidas-asaas.js`.
 *   - Multi-franquia: por padrão processa TODAS as franquias. Use
 *     --franquia=<id> pra restringir a uma só (mesmo padrão de
 *     reconciliar-pagamentos-asaas.js). Cada franquia é uma chamada
 *     separada a `confirmarERemoverSemCorrespondencia` — o guardrail de
 *     remoção é avaliado POR FRANQUIA, não pra soma de todas.
 *   - Idempotente: rodar de novo não encontra mais nada pras cobranças já
 *     quitadas/removidas na rodada anterior (deixam de aparecer no filtro
 *     pending/overdue).
 *
 * AJUSTE 22 — além de quitar "presas", este script CONFIRMA VIA API DO
 * ASAAS cada cobrança "sem correspondência em pagamentos_asaas" e marca
 * "removida" as que o Asaas confirma como `deleted: true`, ou "quitada" as
 * que o Asaas confirma em STATUS_ADIMPLENTE_ASAAS — nunca pela ausência
 * local sozinha (ver `src/services/cobrancasRemovidas.service.js`).
 *
 * REVISÃO PRÉ-COMMIT (item 1) — este script REAPROVEITA
 * `confirmarERemoverSemCorrespondencia`, a MESMA função usada por
 * `POST /api/sync/reconciliar-cobrancas-quitadas` (nenhuma lógica própria
 * de classificação/aplicação aqui) — o script CLI e o endpoint HTTP voltam
 * a ser equivalentes ponto a ponto, inclusive pra CONFIRMED. Em modo dry
 * run (padrão), chama com `aplicar: false` — ainda faz as chamadas ao Asaas
 * (Fase 1 de classificação, ver docblock de `reconciliarCandidatasEmLote`),
 * só não escreve nada, pra já mostrar de antemão o que "--confirm" faria
 * (inclusive o que o guardrail de remoção bloquearia).
 *
 * Uso (dentro do container/ambiente com DATABASE_URL apontando pro banco
 * certo):
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js                    # dry run, todas as franquias
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js --confirm          # aplica
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js --franquia=<id> --confirm
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js --confirm --force  # ignora o guardrail das "presas" (o guardrail de remoção não tem --force)
 */
const prismaBase = require('../src/config/prisma');
const { buscarCobrancasPresas, aplicarQuitacao } = require('../src/services/cobrancasPresas.service');
const { LIMITE_GUARDRAIL_REMOVIDAS, confirmarERemoverSemCorrespondencia } = require('../src/services/cobrancasRemovidas.service');

const LIMITE_SEGURANCA_SEM_FORCE = 60;

function parseArgs(argv) {
  const confirm = argv.includes('--confirm');
  const force = argv.includes('--force');
  const franquiaArg = argv.find((a) => a.startsWith('--franquia='));
  const franquiaId = franquiaArg ? franquiaArg.slice('--franquia='.length) : null;
  return { confirm, force, franquiaId };
}

function formatarBRL(valor) {
  return `R$ ${Number(valor).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function main() {
  const { confirm, force, franquiaId } = parseArgs(process.argv.slice(2));

  console.log(
    `\nReconciliação de cobranças quitadas no Asaas — ${confirm ? 'APLICANDO (--confirm)' : 'DRY RUN'}` +
      (franquiaId ? ` — restrito à franquia ${franquiaId}` : ' — todas as franquias') +
      '\n'
  );

  const { presas, comIdExterno, semIdExterno, semCorrespondencia } = await buscarCobrancasPresas({ franquiaId });

  console.log(
    `${comIdExterno.length} cobrança(s) pending/overdue com id_externo verificada(s) ` +
      `(${semIdExterno.length} sem id_externo, fora do escopo deste método; ${semCorrespondencia.length} sem correspondência em pagamentos_asaas).`
  );

  // AJUSTE 22 (revisão pré-commit, item 1) — reaproveita a MESMA
  // confirmarERemoverSemCorrespondencia do endpoint HTTP irmão. Agrupado
  // por franquia: a função exige uma franquiaId única por chamada (pra
  // resolver a API key certa via requisitar/getAsaasApiKey), mas este
  // script (ao contrário do endpoint, sempre escopado a uma franquia) pode
  // processar TODAS numa rodada só quando --franquia não é passado — então
  // roda uma chamada por franquia representada em "semCorrespondencia"
  // (com --franquia, é sempre uma franquia só, já filtrada por
  // buscarCobrancasPresas). O guardrail de remoção (LIMITE_GUARDRAIL_REMOVIDAS)
  // é avaliado dentro de cada chamada — ou seja, por franquia, não pra soma
  // de todas nesta rodada.
  const semCorrespondenciaPorFranquia = new Map();
  for (const cobranca of semCorrespondencia) {
    const fId = cobranca.associado?.franquiaId;
    if (!fId) continue; // defensivo — não deveria acontecer, mas sem franquia não dá pra escolher a chave certa
    if (!semCorrespondenciaPorFranquia.has(fId)) semCorrespondenciaPorFranquia.set(fId, []);
    semCorrespondenciaPorFranquia.get(fId).push(cobranca);
  }

  const resultadoRemovidas = { quitadas: [], removidas: [], naoResolvidas: [], removidasBloqueadasGuardrail: [] };
  for (const [fId, itens] of semCorrespondenciaPorFranquia.entries()) {
    const parcial = await confirmarERemoverSemCorrespondencia(itens, fId, { aplicar: confirm });
    resultadoRemovidas.quitadas.push(...parcial.quitadas);
    resultadoRemovidas.removidas.push(...parcial.removidas);
    resultadoRemovidas.naoResolvidas.push(...parcial.naoResolvidas);
    resultadoRemovidas.removidasBloqueadasGuardrail.push(...parcial.removidasBloqueadasGuardrail);
  }

  if (semCorrespondencia.length > 0) {
    console.log(`\n${semCorrespondencia.length} cobrança(s) sem correspondência em pagamentos_asaas — confirmação via Asaas:`);
    const todasClassificadas = [
      ...resultadoRemovidas.quitadas,
      ...resultadoRemovidas.removidas,
      ...resultadoRemovidas.removidasBloqueadasGuardrail,
      ...resultadoRemovidas.naoResolvidas,
    ];
    for (const item of todasClassificadas) {
      const c = item.cobranca;
      console.log(
        `  ${c.associado?.nome ?? '?'} (${c.associado?.cpfCnpj ?? '?'})  cobranca id=${c.id}  id_externo=${c.idExterno}  ` +
          `valor=${formatarBRL(c.valor)}  → ${item.acao}${item.detalhe ? ` (${item.detalhe})` : ''}`
      );
    }
    // "confirmada(s) como removida(s)" soma aplicadas + bloqueadas pelo
    // guardrail (as duas categorias FORAM confirmadas pelo Asaas como
    // deleted:true — a diferença é só se a aplicação foi permitida ou não,
    // detalhado no aviso do guardrail logo abaixo quando houver bloqueadas).
    const totalRemovidaConfirmada = resultadoRemovidas.removidas.length + resultadoRemovidas.removidasBloqueadasGuardrail.length;
    console.log(
      `  → ${resultadoRemovidas.quitadas.length} confirmada(s) como quitada(s), ` +
        `${totalRemovidaConfirmada} confirmada(s) como removida(s) no Asaas` +
        `${resultadoRemovidas.removidasBloqueadasGuardrail.length > 0 ? ` (${resultadoRemovidas.removidas.length} aplicada(s), ${resultadoRemovidas.removidasBloqueadasGuardrail.length} bloqueada(s) pelo guardrail — ver aviso abaixo)` : ''} ` +
        `(as demais: existem sob outro status, não encontradas, ou falha na consulta — nenhuma dessas é tocada).`
    );
    if (resultadoRemovidas.removidasBloqueadasGuardrail.length > 0) {
      console.log(
        `\n⚠️  ${resultadoRemovidas.removidasBloqueadasGuardrail.length} cobrança(s) confirmada(s) como removida, mas NÃO aplicada(s) — ` +
          `guardrail de segurança (mais de ${LIMITE_GUARDRAIL_REMOVIDAS} remoções confirmadas numa mesma franquia nesta execução). ` +
          'Permanecem pending/overdue. Revise manualmente antes de aplicar (não há --force pra este guardrail).'
      );
    }
    if (resultadoRemovidas.removidas.length > 0 || resultadoRemovidas.quitadas.length > 0) {
      if (confirm) {
        console.log(
          `\n✓ ${resultadoRemovidas.quitadas.length} cobrança(s) sem correspondência marcada(s) como "quitada", ` +
            `${resultadoRemovidas.removidas.length} marcada(s) como "removida".`
        );
      } else {
        console.log(
          `\nDRY RUN — ${resultadoRemovidas.quitadas.length} cobrança(s) sem correspondência seria(m) marcada(s) como "quitada", ` +
            `${resultadoRemovidas.removidas.length} seria(m) marcada(s) como "removida". Rode de novo com --confirm para aplicar.`
        );
      }
    }
  }

  if (presas.length === 0 && resultadoRemovidas.removidas.length === 0 && resultadoRemovidas.quitadas.length === 0) {
    console.log('\nNenhuma cobrança presa, quitada (sem correspondência) nem removida confirmada — nada a fazer.');
    return;
  }

  if (presas.length === 0) {
    console.log('\nNenhuma cobrança presa encontrada — nada a quitar por essa via (ver resultado da confirmação via Asaas acima).');
    return;
  }

  // Agrupa por franquia só pra exibição (mesmo estilo de relatório-por-franquia
  // de reconciliar-pagamentos-asaas.js) — a busca já veio filtrada quando
  // --franquia foi passado, então isto é só cosmético.
  const porFranquia = new Map();
  let valorTotal = 0;
  for (const item of presas) {
    const fId = item.cobranca.associado?.franquiaId ?? '(desconhecida)';
    if (!porFranquia.has(fId)) porFranquia.set(fId, []);
    porFranquia.get(fId).push(item);
    valorTotal += Number(item.cobranca.valor);
  }

  console.log(`\n${presas.length} cobrança(s) presa(s) encontrada(s), de ${porFranquia.size} franquia(s), total ${formatarBRL(valorTotal)}:\n`);
  for (const [fId, itens] of porFranquia.entries()) {
    const totalFranquia = itens.reduce((soma, it) => soma + Number(it.cobranca.valor), 0);
    console.log(`  franquia ${fId}: ${itens.length} cobrança(s), ${formatarBRL(totalFranquia)}`);
    for (const { cobranca: c, pagamento: p } of itens) {
      console.log(
        `    ${c.associado?.nome ?? '?'} (${c.associado?.cpfCnpj ?? '?'})  cobranca id=${c.id}  id_externo=${c.idExterno}  ` +
          `valor=${formatarBRL(c.valor)}  vencimento=${new Date(c.vencimento).toISOString().slice(0, 10)}  ` +
          `→ pagamentos_asaas status=${p.status}  paymentDate=${p.paymentDate ?? '(null)'}  clientPaymentDate=${p.clientPaymentDate ?? '(null)'}  confirmedDate=${p.confirmedDate ?? '(null)'}`
      );
    }
  }

  if (!confirm) {
    console.log(`\nDRY RUN — ${presas.length} cobrança(s) seria(m) marcada(s) como "quitada". Nada foi alterado. Rode de novo com --confirm para aplicar.`);
    return;
  }

  if (presas.length > LIMITE_SEGURANCA_SEM_FORCE && !force) {
    console.error(
      `\n⚠️  ${presas.length} presa(s) é bem mais que o esperado pra uma rodada diária. ` +
        'Recusando aplicar por segurança — revise a lista acima e, se estiver correta, rode de novo com --confirm --force.'
    );
    process.exitCode = 1;
    return;
  }

  const aplicados = await aplicarQuitacao(presas);
  const aproximadas = aplicados.filter((a) => a.quitadaEmAproximada);
  console.log(`\n✓ ${aplicados.length} cobrança(s) marcada(s) como "quitada".`);
  if (aproximadas.length > 0) {
    console.log(
      `⚠️  ${aproximadas.length} delas sem paymentDate/clientPaymentDate/confirmedDate em pagamentos_asaas (inesperado) — quitada_em gravado como "agora".`
    );
  }
}

main()
  .catch((err) => {
    console.error('Erro ao rodar a reconciliação de cobranças quitadas no Asaas:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prismaBase.$disconnect();
  });
