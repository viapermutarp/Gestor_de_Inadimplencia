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
 * `pending`/`overdue` cujo `id_externo` já está `RECEIVED`/`RECEIVED_IN_CASH`
 * em `pagamentos_asaas` é marcada `quitada` — a mesma comparação POR
 * COBRANÇA INDIVIDUAL (nunca por associado inteiro) já validada em
 * `scripts/diagnostico-cobrancas-presas-sistemico.js`, reaproveitando a
 * lógica de `src/services/cobrancasPresas.service.js` (nenhuma lógica
 * duplicada entre os três caminhos: este script, o endpoint HTTP, e o
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
 *   - Roda em modo DRY RUN por padrão — só reporta o que seria quitado, não
 *     escreve nada no banco. Passe --confirm para aplicar de verdade (é
 *     assim que um agendador externo deve chamar este script na prática,
 *     depois de já ter sido validado em dry-run pelo menos uma vez).
 *   - `quitadaEm` grava o `paymentDate` real do Asaas (não "agora") — ver
 *     docblock de `aplicarQuitacao` no serviço.
 *   - Não é hard delete: os registros continuam no banco, só mudam de
 *     status (mesmo comportamento de `POST /api/sync` e de
 *     `scripts/reconciliar-cobrancas-presas.js`).
 *   - Guardrail de segurança: recusa aplicar (--confirm) se o total de
 *     presas encontradas passar muito do esperado, a não ser que --force
 *     também seja passado — evita quitar em massa por engano se algo
 *     inesperado acontecer nos dados (ex.: pagamentos_asaas com um bug
 *     upstream marcando muita coisa como RECEIVED por engano).
 *   - Multi-franquia: por padrão processa TODAS as franquias. Use
 *     --franquia=<id> pra restringir a uma só (mesmo padrão de
 *     reconciliar-pagamentos-asaas.js).
 *   - Idempotente: rodar de novo não encontra mais nada pras cobranças já
 *     quitadas na rodada anterior (elas deixam de aparecer no filtro
 *     pending/overdue).
 *
 * Uso (dentro do container/ambiente com DATABASE_URL apontando pro banco
 * certo):
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js                    # dry run, todas as franquias
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js --confirm          # aplica
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js --franquia=<id> --confirm
 *   node scripts/reconciliar-cobrancas-quitadas-no-asaas.js --confirm --force  # ignora o guardrail
 */
const prismaBase = require('../src/config/prisma');
const { buscarCobrancasPresas, aplicarQuitacao } = require('../src/services/cobrancasPresas.service');

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

  if (presas.length === 0) {
    console.log('\nNenhuma cobrança presa encontrada — nada a fazer.');
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
          `→ pagamentos_asaas status=${p.status}  paymentDate=${p.paymentDate ?? '(null)'}`
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
    console.log(`⚠️  ${aproximadas.length} delas sem paymentDate em pagamentos_asaas (inesperado) — quitada_em gravado como "agora".`);
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
