/**
 * Backfill único (uma vez só) para o AJUSTE 9 — "Exibir nome completo do
 * Asaas nos dados cadastrais do associado" (ver README, seção "AJUSTE 9").
 *
 * O novo campo Associado.nomeAsaas (coluna "nome_asaas") guarda o campo
 * "name" retornado pela API do Asaas VERBATIM (sem nenhum parsing/
 * tratamento — inclui o prefixo numérico que o Asaas usa, ex:
 * "45.493.621 ERICA DA COSTA ROSA"). A partir desta versão, o fluxo de sync
 * (POST /api/sync) já popula esse campo sozinho, mas SÓ para associados
 * cujo nomeAsaas ainda está nulo (decisão explícita do usuário — sync
 * incremental não re-busca associados que já têm o campo preenchido). Isso
 * quer dizer que todo associado já cadastrado ANTES desta versão nunca vai
 * ganhar um nomeAsaas sozinho (eles não vão passar por um "sync de
 * associado novo" de novo) — por isso este script existe: roda uma vez,
 * busca o nome no Asaas por CPF/CNPJ para cada associado com nomeAsaas
 * ainda nulo, e preenche.
 *
 * IMPORTANTE — leia antes de rodar:
 *   - Roda em modo DRY RUN por padrão — só consulta o Asaas e lista o que
 *     seria gravado, não muda nada no banco. Passe --confirm para aplicar.
 *   - Só LÊ da API do Asaas (GET, via asaas.service.js) e só ESCREVE no
 *     Postgres a coluna nome_asaas de associados já existentes (nunca cria,
 *     nunca apaga associado ou cobrança nenhuma, nunca toca outra coluna).
 *   - Nunca sobrescreve um nomeAsaas já preenchido — mesma regra do sync
 *     (roda de novo com segurança a qualquer momento; associados já
 *     preenchidos são ignorados automaticamente).
 *   - Multi-franquia: por padrão processa TODAS as franquias que têm uma
 *     chave de API do Asaas configurada (franquias sem chave configurada
 *     são listadas e puladas, não é erro). Use --franquia=<id> para
 *     restringir a uma franquia só.
 *   - Associados cujo CPF/CNPJ não é encontrado no Asaas (cliente removido,
 *     documento divergente) ou cuja franquia não tem chave configurada
 *     ficam de fora e são listados no relatório final de falhas — não
 *     travam o backfill dos demais.
 *
 * Uso (dentro do container/ambiente com DATABASE_URL apontando pro banco
 * certo, e com a(s) chave(s) de API do Asaas já configuradas):
 *   node scripts/backfill-nome-asaas.js                       # dry run, todas as franquias
 *   node scripts/backfill-nome-asaas.js --confirm             # aplica, todas as franquias
 *   node scripts/backfill-nome-asaas.js --franquia=<id> --confirm
 *   node scripts/backfill-nome-asaas.js --listar-franquias
 */
const { PrismaClient } = require('@prisma/client');
const { getAsaasApiKey } = require('../src/services/config.service');
const { buscarClientePorCpfCnpj, AsaasApiError } = require('../src/services/asaas.service');

const CONCORRENCIA = 5;

function parseArgs(argv) {
  const confirm = argv.includes('--confirm');
  const listarFranquias = argv.includes('--listar-franquias');
  const franquiaArg = argv.find((a) => a.startsWith('--franquia='));
  const franquiaId = franquiaArg ? franquiaArg.slice('--franquia='.length) : null;
  return { confirm, listarFranquias, franquiaId };
}

/** Processa uma franquia: busca associados com nomeAsaas nulo, consulta o
 * Asaas por CPF/CNPJ (concorrência limitada, mesmo padrão de
 * obterClientesPorId em asaas.service.js) e retorna o resultado por
 * associado, sem gravar nada ainda (gravação é feita por quem chama, só se
 * --confirm). */
async function processarFranquia(prisma, franquia) {
  const associados = await prisma.associado.findMany({
    where: { franquiaId: franquia.id, nomeAsaas: null },
    select: { id: true, cpfCnpj: true, nome: true },
    orderBy: { nome: 'asc' },
  });

  if (associados.length === 0) {
    return { franquia, associados: [], resultados: [] };
  }

  const resultados = new Array(associados.length);
  let cursor = 0;

  async function worker() {
    for (;;) {
      const indice = cursor++;
      if (indice >= associados.length) return;
      const associado = associados[indice];
      try {
        const nomeAsaas = await buscarClientePorCpfCnpj(associado.cpfCnpj, franquia.id);
        if (nomeAsaas) {
          resultados[indice] = { associado, nomeAsaas, erro: null };
        } else {
          resultados[indice] = {
            associado,
            nomeAsaas: null,
            erro: 'Nenhum cliente encontrado no Asaas com esse CPF/CNPJ (removido do Asaas ou documento divergente).',
          };
        }
      } catch (err) {
        const mensagem = err instanceof AsaasApiError ? err.message : err.message || String(err);
        resultados[indice] = { associado, nomeAsaas: null, erro: mensagem };
      }
    }
  }

  const workers = Array.from({ length: Math.min(CONCORRENCIA, associados.length) }, worker);
  await Promise.all(workers);

  return { franquia, associados, resultados };
}

async function main() {
  const { confirm, listarFranquias, franquiaId } = parseArgs(process.argv.slice(2));
  const prisma = new PrismaClient();

  try {
    const todasFranquias = await prisma.franquia.findMany({
      select: { id: true, nome: true },
      orderBy: { nome: 'asc' },
    });

    if (listarFranquias) {
      console.log('Franquias cadastradas:\n');
      for (const f of todasFranquias) {
        console.log(`  ${f.id}  ${f.nome}`);
      }
      return;
    }

    let franquiasAlvo = todasFranquias;
    if (franquiaId) {
      franquiasAlvo = todasFranquias.filter((f) => f.id === franquiaId);
      if (franquiasAlvo.length === 0) {
        console.error(`Franquia "${franquiaId}" não encontrada. Rode com --listar-franquias para ver os IDs válidos.`);
        process.exitCode = 1;
        return;
      }
    }

    // Só processa franquias com chave do Asaas configurada — sem chave,
    // buscarClientePorCpfCnpj lançaria AsaasApiError pra cada associado; é
    // mais claro pular a franquia inteira de uma vez e avisar.
    const franquiasComChave = [];
    const franquiasSemChave = [];
    for (const franquia of franquiasAlvo) {
      const chave = await getAsaasApiKey(franquia.id);
      if (chave) {
        franquiasComChave.push(franquia);
      } else {
        franquiasSemChave.push(franquia);
      }
    }

    if (franquiasSemChave.length > 0) {
      console.log('Franquias SEM chave de API do Asaas configurada (puladas):');
      for (const f of franquiasSemChave) {
        console.log(`  ${f.id}  ${f.nome}`);
      }
      console.log('');
    }

    if (franquiasComChave.length === 0) {
      console.log('Nenhuma franquia com chave do Asaas configurada — nada a fazer.');
      return;
    }

    console.log(`Processando ${franquiasComChave.length} franquia(s): ${franquiasComChave.map((f) => f.nome).join(', ')}\n`);

    let totalConsiderados = 0;
    let totalAtualizados = 0;
    const falhas = [];
    const atualizacoesParaAplicar = [];

    for (const franquia of franquiasComChave) {
      const { associados, resultados } = await processarFranquia(prisma, franquia);

      if (associados.length === 0) {
        console.log(`[${franquia.nome}] Nenhum associado com nomeAsaas pendente.`);
        continue;
      }

      console.log(`[${franquia.nome}] ${associados.length} associado(s) com nomeAsaas pendente:`);
      totalConsiderados += associados.length;

      for (const resultado of resultados) {
        const { associado, nomeAsaas, erro } = resultado;
        if (nomeAsaas) {
          console.log(`  ✓ ${associado.cpfCnpj}  ${associado.nome}  ->  "${nomeAsaas}"`);
          atualizacoesParaAplicar.push({ cpfCnpj: associado.cpfCnpj, nomeAsaas });
        } else {
          console.log(`  ✗ ${associado.cpfCnpj}  ${associado.nome}  ->  FALHA: ${erro}`);
          falhas.push({ franquia: franquia.nome, cpfCnpj: associado.cpfCnpj, nome: associado.nome, erro });
        }
      }
      console.log('');
    }

    if (!confirm) {
      console.log(
        `DRY RUN — ${atualizacoesParaAplicar.length} de ${totalConsiderados} seriam atualizados agora, ` +
          `${falhas.length} falhariam. Nada foi alterado no banco. Rode de novo com --confirm para aplicar.`
      );
      if (falhas.length > 0) {
        console.log('\nFalhas encontradas:');
        for (const f of falhas) {
          console.log(`  [${f.franquia}] ${f.cpfCnpj}  ${f.nome}  —  ${f.erro}`);
        }
      }
      return;
    }

    for (const atualizacao of atualizacoesParaAplicar) {
      await prisma.associado.update({
        where: { cpfCnpj: atualizacao.cpfCnpj },
        data: { nomeAsaas: atualizacao.nomeAsaas },
      });
      totalAtualizados += 1;
    }

    console.log(`\n✓ ${totalAtualizados} associado(s) atualizado(s) com nomeAsaas (de ${totalConsiderados} considerados).`);
    if (falhas.length > 0) {
      console.log(`✗ ${falhas.length} associado(s) NÃO atualizado(s):`);
      for (const f of falhas) {
        console.log(`  [${f.franquia}] ${f.cpfCnpj}  ${f.nome}  —  ${f.erro}`);
      }
    } else {
      console.log('Nenhuma falha.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error('Erro ao rodar o backfill de nomeAsaas:', err);
  process.exit(1);
});
