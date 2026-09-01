# Plano técnico: sistema multi-franquia

Documento de trabalho — cobre o desenho antes de qualquer implementação (decisões já confirmadas em conversa: migração automática do admin com fallback break-glass, e isolamento de dados via Prisma Client Extension). Nada neste documento está implementado ainda; é a base pra revisão antes de eu começar a escrever schema/migração de verdade.

Fora de escopo aqui (registrado pra não esquecer, por pedido explícito): os fluxos de n8n (régua de cobrança, sync, cadastro/faturamento, geração de contratos) continuam sendo de uma franquia só até essa frente ser tratada separadamente depois.

---

## 1. Modelo de dados

### 1.1 `Franquia`

```prisma
model Franquia {
  id       String   @id @default(uuid())
  nome     String
  ativo    Boolean  @default(true)
  criadoEm DateTime @default(now()) @map("criado_em")

  usuarios Usuario[]
  // + uma relação implícita por tabela de negócio (associados, cadastros, etc.)

  @@map("franquias")
}
```

### 1.2 `Usuario` (substitui o login único `ADMIN_USER`/`ADMIN_PASSWORD`)

```prisma
model Usuario {
  id            String    @id @default(uuid())
  nome          String
  email         String    @unique
  senhaHash     String    @map("senha_hash")
  papel         String    // "SUPER_ADMIN" | "ADMIN_FRANQUIA" | "OPERADOR"
  franquiaId    String?   @map("franquia_id")   // null só para SUPER_ADMIN
  franquia      Franquia? @relation(fields: [franquiaId], references: [id])
  ativo         Boolean   @default(true)
  criadoEm      DateTime  @default(now()) @map("criado_em")
  ultimoLoginEm DateTime? @map("ultimo_login_em")

  @@index([franquiaId])
  @@map("usuarios")
}
```

Senha com `bcrypt` (custo 12), nunca texto puro — mesmo padrão de segurança já usado pra hash de refresh token/API key neste projeto (SHA-256 lá porque são segredos aleatórios comparados por igualdade; aqui é `bcrypt` porque é senha escolhida por humano, precisa de salt + custo ajustável).

**Confirmado: 1 usuário por franquia, travado no banco** — `@@unique([franquiaId])` no model `Usuario`, válido só quando `franquiaId` não é nulo (Postgres/Prisma ignoram `NULL` em índices únicos por padrão, então múltiplos `SUPER_ADMIN` com `franquiaId: null` continuam permitidos — só uma franquia não pode ter 2 usuários). Uma tentativa de `POST /api/usuarios` pra uma franquia que já tem usuário falha na constraint do banco (`P2002` no Prisma), não só na validação da tela — é a mesma garantia de "não existe convite pra sub-usuário" mesmo batendo direto na API.

**Papéis — simplificado pra 2 (decisão tomada com a liberdade que você deu):** como cada franquia tem exatamente 1 usuário, e esse usuário precisa necessariamente configurar as próprias credenciais (Asaas/Drive) já que ninguém mais vai fazer isso por ele, não existe cenário real onde faz sentido um "usuário da franquia sem acesso a Configurações" — `ADMIN_FRANQUIA` e `OPERADOR` teriam permissões idênticas na prática. Simplifiquei pra um papel só de franquia:

| Papel | Franquias | Controle Geral | Dashboard / Cadastro / Contratos / Inadimplência / Jurídico | Configurações (credenciais/integrações) |
|---|---|---|---|---|
| `SUPER_ADMIN` | Todas — **precisa escolher uma antes de ver qualquer tela operacional** (confirmado; nenhuma tela mistura dados de mais de uma franquia, nem pro super admin) | Sim, exclusivo | Sim (da franquia selecionada) | Sim (da franquia selecionada) |
| `FRANQUIA` | Só a própria | Não | Sim | Sim |

Se algum dia a trava de 1-usuário-por-franquia for relevada (não está nos planos agora), reintroduzir `ADMIN_FRANQUIA`/`OPERADOR` é só adicionar de volta os 2 valores do enum + os `if` de permissão — não exige mudança de schema, já que `papel` já é uma string livre validada em código, não um enum do Postgres.

Granularidade por recurso abaixo do papel fica pra uma segunda fase, como combinado — a extensão natural (não implementada agora) seria uma tabela `UsuarioPermissao (usuarioId, recurso)` com overrides.

### 1.3 `franquiaId` em todo model de negócio existente

Adicionar `franquiaId String @map("franquia_id")` (com FK pra `Franquia`, índice) em:

- `Associado`
- `CadastroEnviado`
- `ModeloContrato`
- `CobrancaIgnorada`
- `SyncLog`
- `ApiKey` (`NOT NULL` — ver correção abaixo, não fica nullable como na primeira versão deste plano)

`Cobranca` e `HistoricoStatusAssociado` **não** precisam do campo diretamente — já herdam o isolamento via `associado.franquiaId` (join), evita duplicar a coluna sem necessidade. O desenho de como isso funciona na prática (leitura, leitura por id, escrita) está detalhado na seção 4.

`Configuracao` (tabela chave→valor genérica: `asaas_api_key`, `drive_pasta_raiz_id`, `n8n_webhook_cadastro_url`, `inadimplencia_palavras_excluidas`, `inadimplencia_dias_tolerancia`, e a nova `google_service_account_json` — ver seção 3) muda a chave primária de `chave` sozinha pra composta `(chave, franquia_id)` — cada franquia tem sua própria linha por chave de configuração.

**Correção em relação à primeira versão deste plano** — `ApiKey.franquiaId` **não** vai ficar nullable/opcional: validando o desenho contra o código real de `sync.controller.js` (que roda autenticado por API key, não por usuário/JWT), percebi que ele cria `Associado` (`franquiaId` obrigatório, `NOT NULL`) e mexe em `Cobranca`/`HistoricoStatusAssociado` — se a API key usada não tiver uma franquia associada, esse fluxo não teria como saber em qual franquia gravar, e o sync pararia de funcionar assim que `franquiaId` virasse obrigatório em `Associado`. Então: `api_keys` ganha `franquia_id NOT NULL` igual às outras tabelas, e a migração (seção 5) atribui todas as chaves existentes à franquia única de hoje — o `n8n` continua rodando exatamente como roda hoje, só que agora "sabendo" (mesmo sem usar isso ainda) de qual franquia é. Isso não expande o escopo da frente do n8n (2.4) — só evita quebrar o que já funciona. Quando 2.4 acontecer, cada nova franquia ganha sua própria chave, já com a `franquia_id` certa, sem precisar de outra migração de schema.

### 1.4 `RefreshToken` — de `usuario` (string) pra `usuarioId` (FK)

O campo `usuario` (texto livre, hoje sempre o valor de `ADMIN_USER`) vira `usuarioId String @map("usuario_id")`, com FK pra `Usuario`. Migração de dados: na mesma migração que cria `Usuario` e semeia o `SUPER_ADMIN` (ver seção 2), qualquer `refresh_tokens` existente com `usuario = <ADMIN_USER migrado>` ganha o `usuario_id` desse novo registro; sessões órfãs (usuário que não bate com nada, cenário improvável mas possível se `ADMIN_USER` mudou entre deploys) são revogadas na migração — mais seguro que deixar pendurado.

---

## 2. Autenticação: migração do admin único

Confirmado: migração automática (mesmo padrão já usado pra migrar a API key legada neste projeto — `migrarChaveLegadaSeNecessario`) + `ADMIN_USER`/`ADMIN_PASSWORD` como *break-glass*.

**Na primeira subida depois desta migração:**

1. Se `usuarios` estiver vazia **e** `ADMIN_USER`/`ADMIN_PASSWORD` estiverem definidos, cria 1 `Usuario`: `papel: SUPER_ADMIN`, `franquiaId: null`, `email` = `ADMIN_USER` (se não parecer um e-mail válido, algo como `admin@local` — ajustável depois pela própria tela de Controle Geral), `senhaHash = bcrypt(ADMIN_PASSWORD)`.
2. `POST /api/login` deixa de comparar contra `env.adminUser`/`env.adminPassword` diretamente e passa a: (a) buscar `Usuario` por email; (b) se não achar **e** a tabela `usuarios` estiver vazia, cai no fallback break-glass (compara contra as env vars, cria a sessão como se fosse o `SUPER_ADMIN` migrado — útil se alguém truncar a tabela sem querer); (c) senão, 401 normal.
3. Login recusado também se `usuario.ativo === false` (ligação direta com "bloquear acesso imediatamente" do item 2.3) — e o **refresh** (`POST /api/refresh`) passa a checar `usuario.ativo` a cada troca, não só a validade do token em si. Isso é o que faz desativar alguém surtir efeito rápido: o próximo refresh dele (no máximo `JWT_EXPIRES_IN` = 15min depois) já falha, mesmo sem revogar token por token.
4. Access token ganha dois claims novos: `franquiaId` e `papel` (além de `sub`/`jti` que já existem) — o middleware de auth passa a expor `req.auth.franquiaId`/`req.auth.papel`, usados pela extension de isolamento (seção 4). Mudança de papel/franquia de um usuário só reflete no próximo refresh dele (mesma janela de ~15min já aceita no fix da Frente 1 — consistente, não é um trade-off novo).

---

## 3. Credenciais/integrações por franquia

Hoje: `asaas_api_key`, `drive_pasta_raiz_id`, `n8n_webhook_cadastro_url` na tabela `configuracoes` (globais); `GOOGLE_SERVICE_ACCOUNT_JSON` é variável de ambiente do processo (também global, e pior: nem dá pra ter duas ao mesmo tempo, já que é uma única variável de processo).

**Depois:**

- `configuracoes` ganha `franquia_id` na chave (seção 1.3) — cada franquia tem sua própria `asaas_api_key`/`drive_pasta_raiz_id`/`n8n_webhook_cadastro_url`, sem enxergar a das outras.
- `GOOGLE_SERVICE_ACCOUNT_JSON` sai de variável de ambiente e vira mais uma chave em `configuracoes` (por franquia) — aceitando o mesmo formato de hoje (JSON cru ou base64). `drive.service.js` deixa de ter um `clienteCache` único de processo e passa a montar/cachear um cliente Drive **por franquia** (cache em memória por `franquiaId`, invalidado se a credencial for trocada na tela).
- Migração: se `GOOGLE_SERVICE_ACCOUNT_JSON` estiver setada no ambiente no momento da migração, o valor é copiado automaticamente pra dentro de `configuracoes` da franquia default (seção 5) — zero passo manual pra quem já está configurado hoje. A variável de ambiente pode ficar como estava (não quebra nada), mas deixa de ser lida depois que existir uma configuração por franquia — só serve de semente, mesmo espírito do fallback de `API_KEY`/`JWT_SECRET` que já existe.
- Tela de Configurações passa a mostrar/editar só a integração da **própria** franquia do usuário logado (ou, pro `SUPER_ADMIN`, a franquia selecionada em algum seletor no topo — a definir na UI).

---

## 4. Isolamento de dados: Prisma Client Extension

Decisão confirmada: em vez de cada controller lembrar de escrever `where: { franquiaId }`, um wrapper central resolve isso uma vez.

Desenho: `src/config/prismaComEscopo.js` exporta uma função `prismaParaRequisicao(req)` que retorna um Prisma Client (via `prisma.$extends(...)`) com um middleware de query. Os models tenant-scoped se dividem em 2 grupos, tratados de forma estruturalmente diferente:

- **Escopo direto** (`associado`, `cadastroEnviado`, `modeloContrato`, `cobrancaIgnorada`, `syncLog`, `apiKey`) — têm a coluna `franquiaId` na própria tabela.
- **Escopo por relação** (`cobranca`, `historicoStatusAssociado`) — só têm `associadoId`; a franquia é sempre a do `associado` relacionado.

**Confirmando o desenho que você propôs pros 2 models de escopo por relação — está correto, ponto a ponto:**

- **Leitura (`findMany`/`findFirst`)**: em vez de `where: { franquiaId: X }`, injeta `where: { associado: { franquiaId: X } } }`, fazendo **merge** com um `where.associado` que o controller já tenha passado (ex.: filtro por `cpfCnpj` do associado) — nunca sobrescrevendo.
- **Leitura por id (`findUnique`)**: reescrita internamente como `findFirst` com a condição de id + `associado: { franquiaId: X }` — um id de outra franquia retorna "não encontrado" (`null`), nunca vaza o registro nem confirma a existência dele por um erro diferente.
- **Escrita (`create`/`update`/`delete`)**: sem coluna própria pra validar, faz um `associado.findFirst({ where: { id: data.associadoId ?? registroExistente.associadoId, franquiaId: X } })` antes da operação — rejeita se não achar (associado pertence a outra franquia, ou nem existe). Pra `update`/`delete` de um registro já existente, o `associadoId` vem do próprio registro (buscado primeiro), não do corpo da requisição, então não dá pra "trocar de dono" mandando um `associadoId` diferente no `data`.

**Refinamento que estou propondo (não muda o resultado, unifica a implementação):** aplicar esse mesmo padrão de "checar antes com `findFirst`, depois executar a operação original" também nas operações **singulares por chave única** dos models de escopo direto (`findUnique`, `update`, `delete` de `associado`, `apiKey`, etc.), em vez de tentar injetar `where: { ..., franquiaId: X }` diretamente dentro do `where` do `findUnique`/`update`/`delete`. Motivo: esses 3 métodos são tipados pelo Prisma como `WhereUniqueInput`, que historicamente nem sempre aceita de forma confiável combinar a chave única com um filtro extra (direto ou via relação) dependendo da versão do Prisma — então, em vez de ter 2 estratégias diferentes (uma pra escopo direto, outra pra escopo por relação) com riscos de compatibilidade diferentes, uso **a mesma estratégia nos dois grupos** pras operações singulares: `findFirst`/`findUnique` interno com id + filtro de franquia (direto ou via `associado`, conforme o model) → se não achar, retorna `null`/lança "não encontrado" → daí sim executa a operação original só com a chave (`update`/`delete` já confirmados como sendo daquela franquia). Já pra `findMany`/`updateMany`/`deleteMany`/`createMany`, o filtro entra direto no `where` normalmente (Prisma aceita filtro de relação nativamente nesses), sem precisar do passo extra.

Resultado prático: um único helper interno (`garantirRegistroDaFranquia(model, id, franquiaId, viaRelacaoAssociado?)`) cobre os 8 models tenant-scoped pras operações por chave única, e um segundo helper (`injetarFiltroFranquia(where, franquiaId, viaRelacaoAssociado?)`) cobre as operações "many". Menos código duplicado, e o comportamento pros 2 models de relação fica idêntico ao que você descreveu.

**Por que isso importa na prática, não só em teoria** — validei o desenho relendo o `sync.controller.js` de verdade: a reconciliação global de cobranças (a rotina que marca como "quitada" qualquer cobrança que sumiu do Asaas) roda um `prisma.cobranca.updateMany({ where: { status: {in: [...]}, vencimento: {gte, lte}, id: {notIn: idsGlobal} }, data: {status: 'quitada', ...} })` **sem nenhum filtro de associado ou franquia hoje**. Sem a extension cobrindo esse `updateMany` via relação, um sync de uma franquia poderia marcar como "quitada" cobranças de **outra** franquia por engano — é exatamente o tipo de bug que a extension automática evita e que seria fácil um controller esquecer de filtrar manualmente. Isso reforça que o isolamento precisa estar na extension, não só na disciplina de cada controller.

Para `SUPER_ADMIN` (`req.auth.papel === 'SUPER_ADMIN'`): a extension **não** injeta filtro nenhum por padrão (vê tudo), mas os controllers que precisam de uma visão por franquia específica (ex.: relatório filtrado) aceitam um parâmetro explícito (`?franquia_id=...`) que a extension então respeita — nunca automático/implícito pra esse papel, sempre um parâmetro visível na chamada.

Cada controller passa a receber `req.prisma` (montado por um middleware Express logo depois do `auth`, usando `req.auth`) em vez de importar `../config/prisma` direto — troca mecânica em todos os controllers listados no início deste documento (`associados`, `cadastros`, `contratos`, `inadimplencia`, `sync`, `config`), mas de baixo risco individual (é sempre a mesma troca: `const prisma = require(...)` vira `const prisma = req.prisma`). `sync.controller.js`/`cadastros.controller.js`, autenticados por API key (não JWT), recebem `req.prisma` escopado pela `franquiaId` da própria `ApiKey` usada — é justamente por isso que `ApiKey.franquiaId` precisa ser `NOT NULL` (seção 1.3): sem isso, essas duas rotas não teriam de onde tirar a franquia pra montar o `req.prisma`.

Teste dedicado a escrever pra essa extension especificamente (antes de qualquer controller usar): criar 2 franquias + 2 usuários (um de cada) + dados de ambas, confirmar que uma consulta pelo usuário A nunca retorna nada da franquia B, em cada operação (`findMany`, `findUnique` por id que pertence à outra franquia — deve dar "não encontrado", não vazar o registro —, `update`/`delete` em id de outra franquia, `create` tentando forçar `franquiaId` de outra franquia no corpo). Inclui casos específicos pra `Cobranca`/`HistoricoStatusAssociado`: ler/atualizar/excluir um registro de uma franquia autenticado como usuário de outra (deve falhar/vir vazio em todos os casos) e tentar criar um novo registro referenciando um `associadoId` de outra franquia (deve ser rejeitado). Esse teste é o que dá confiança real de que a extension está fechada, mais importante que testar controller por controller de novo.

---

## 5. Migração dos dados existentes

Passo a passo (migração hand-written em SQL, mesmo padrão já usado neste projeto):

1. `CREATE TABLE franquias` + `CREATE TABLE usuarios` (com `UNIQUE INDEX` em `franquia_id` de `usuarios`, `WHERE franquia_id IS NOT NULL` — a trava de 1-usuário-por-franquia, seção 1.2).
2. `INSERT INTO franquias (nome) VALUES ('Via Permuta Ribeirão Preto')` → guarda o id gerado. Nome editável depois a qualquer momento pela tela de Controle Geral (seção 6) — não é fixo, só o ponto de partida da migração.
3. Adiciona `franquia_id` **nullable** em `associados`, `cadastros_enviados`, `modelos_contrato`, `cobrancas_ignoradas`, `sync_log`, `api_keys`.
4. `UPDATE` em massa: preenche `franquia_id` = id da franquia criada no passo 2, em **todas** as tabelas do passo 3, `api_keys` incluída (correção da seção 1.3 — chaves existentes deixam de ser globais e passam a pertencer à franquia única de hoje, senão o sync quebra assim que `associados.franquia_id` virar obrigatório).
5. Torna `franquia_id` `NOT NULL` (com `FOREIGN KEY`) em **todas** as tabelas do passo 3, `api_keys` incluída.
6. `configuracoes`: adiciona `franquia_id`, migra as linhas existentes pra apontar pra franquia do passo 2, troca a chave primária pra `(chave, franquia_id)`.
7. Migração de aplicação (roda no primeiro boot, idempotente, não em SQL puro): semeia o `SUPER_ADMIN` a partir de `ADMIN_USER`/`ADMIN_PASSWORD` (seção 2); copia `GOOGLE_SERVICE_ACCOUNT_JSON` do ambiente pra `configuracoes` da franquia do passo 2, se estiver setada (seção 3).

Tudo reversível/auditável — nenhum dado é apagado, só rotulado com a franquia que já era implicitamente a única existente.

---

## 6. Nova aba "Controle Geral" (só `SUPER_ADMIN`)

- **Franquias**: listar, criar (nome), ativar/desativar. **Confirmado**: desativar bloqueia login de **todos** os usuários dela imediatamente — mesmo mecanismo do `ativo=false` de usuário individual (checado no login e a cada refresh, seção 2), só que aplicado a nível de franquia (o check de login/refresh passa a olhar `usuario.ativo && usuario.franquia?.ativo !== false`).
- **Usuários** (com filtro por franquia): listar, criar (nome, email, senha inicial, papel, franquia — exceto pra `SUPER_ADMIN`, que não tem franquia), editar papel, ativar/desativar (`ativo=false` → login recusado + refresh futuro recusado, ver seção 2). Como cada franquia só pode ter 1 usuário (constraint de banco, seção 1.2), essa tela não precisa de nenhum fluxo de "convidar/criar sub-usuário" dentro de uma franquia já ocupada — só cria o 1º (e único) usuário dela.
- Granularidade por recurso (2.3, "quais recursos o usuário pode acessar") — fica pra segunda fase, como combinado.

Novos endpoints (rascunho, ajusto no detalhamento): `GET/POST/PATCH /api/franquias`, `GET/POST/PATCH /api/usuarios` (todos exigindo `papel === 'SUPER_ADMIN'` num middleware novo, `exigirSuperAdmin`).

---

## 7. Ordem de implementação sugerida

Cada etapa é testável e "shippable" isoladamente (não precisa esperar tudo pronto pra ter valor):

1. **Schema + migração de dados** (seções 1, 5) — sem nenhuma mudança de comportamento ainda, só a base de dados pronta.
2. **Autenticação** (seção 2) — login passa a usar `Usuario`/`bcrypt`, token ganha `franquiaId`/`papel`. Sistema continua funcionando exatamente como hoje pra quem já usa (o admin migrado é `SUPER_ADMIN`, vê tudo, nada muda na prática ainda porque só existe 1 franquia).
3. **Isolamento** (seção 4) — extension + troca dos controllers. Testado a fundo (seção 4) antes de qualquer tela nova.
4. **Configurações por franquia** (seção 3).
5. **Tela Controle Geral** (seção 6) — só agora dá pra criar a 2ª franquia de verdade e ver o isolamento valendo em produção. `SUPER_ADMIN` obrigatoriamente escolhe uma franquia antes de ver Dashboard/Cadastro/Contratos/Inadimplência/Jurídico (confirmado — nenhuma tela mistura dados de mais de uma franquia ao mesmo tempo, nem pra ele).

Todas as perguntas em aberto da versão anterior deste plano já foram respondidas (nome da franquia, comportamento de desativação, obrigatoriedade de seleção de franquia pro `SUPER_ADMIN`) e estão incorporadas nas seções acima.
