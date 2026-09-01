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

**Papéis e o que cada um vê:**

| Papel | Franquias | Controle Geral | Dashboard / Cadastro / Contratos / Inadimplência / Jurídico | Configurações (credenciais/integrações) |
|---|---|---|---|---|
| `SUPER_ADMIN` | Todas (seleciona qual ver, ou visão consolidada) | Sim, exclusivo | Sim (qualquer franquia) | Sim (qualquer franquia) |
| `ADMIN_FRANQUIA` | Só a própria | Não | Sim (só a própria) | Sim (só a própria) |
| `OPERADOR` | Só a própria | Não | Sim (só a própria) | **Não** — só o dia a dia, sem acesso a chaves/credenciais |

Granularidade abaixo do papel (ex.: um `OPERADOR` que só vê Dashboard e Cadastro, sem Contratos) fica pra uma segunda fase, como você mesmo sugeriu — o MVP é só os 3 papéis acima. Se quiser adiantar o desenho: a extensão natural é uma tabela `UsuarioPermissao (usuarioId, recurso)` com overrides que, quando presente, restringe o que o papel já permitiria; sem linha nenhuma, vale o padrão do papel. Não faz parte desta rodada.

### 1.3 `franquiaId` em todo model de negócio existente

Adicionar `franquiaId String @map("franquia_id")` (com FK pra `Franquia`, índice) em:

- `Associado`
- `CadastroEnviado`
- `ModeloContrato`
- `CobrancaIgnorada`
- `SyncLog`
- `ApiKey` (nullable — ver nota abaixo)

`Cobranca` e `HistoricoStatusAssociado` **não** precisam do campo diretamente — já herdam o isolamento via `associado.franquiaId` (join), evita duplicar a coluna sem necessidade.

`Configuracao` (tabela chave→valor genérica: `asaas_api_key`, `drive_pasta_raiz_id`, `n8n_webhook_cadastro_url`, `inadimplencia_palavras_excluidas`, `inadimplencia_dias_tolerancia`, e a nova `google_service_account_json` — ver seção 3) muda a chave primária de `chave` sozinha pra composta `(chave, franquia_id)` — cada franquia tem sua própria linha por chave de configuração.

`ApiKey`: `franquiaId` fica **nullable** de propósito. Hoje uma API key autentica qualquer integração (n8n) sem saber de qual franquia é. Até a frente do n8n ser tratada (fora de escopo aqui, item 2.4 do seu pedido), chaves continuam podendo ser globais (`franquiaId = null` → enxerga tudo, comportamento atual preservado). Quando o n8n for parametrizado por franquia, aí sim cada chave nova passa a ter uma `franquiaId` fixa, e o middleware de auth já vai saber usar isso pra escopar as chamadas — a coluna já nasce pronta pra isso sem precisar de outra migração depois.

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

Desenho: `src/config/prismaComEscopo.js` exporta uma função `prismaParaRequisicao(req)` que retorna um Prisma Client (via `prisma.$extends(...)`) com um middleware de query que, para os models da lista de "tenant-scoped" (`associado`, `cadastroEnviado`, `modeloContrato`, `cobrancaIgnorada`, `syncLog`, e via relação `cobranca`/`historicoStatusAssociado`), injeta automaticamente `franquiaId: req.auth.franquiaId` em todo `where` de `findMany`/`findFirst`/`findUnique`/`update`/`updateMany`/`delete`/`deleteMany`, e em todo `create`/`createMany` garante que o `data.franquiaId` bate com a franquia da sessão (recusa com erro se alguém tentar forçar outro valor no corpo da requisição).

Para `SUPER_ADMIN` (`req.auth.papel === 'SUPER_ADMIN'`): a extension **não** injeta filtro nenhum por padrão (vê tudo), mas os controllers que precisam de uma visão por franquia específica (ex.: relatório filtrado) aceitam um parâmetro explícito (`?franquia_id=...`) que a extension então respeita — nunca automático/implícito pra esse papel, sempre um parâmetro visível na chamada.

Cada controller passa a receber `req.prisma` (montado por um middleware Express logo depois do `auth`, usando `req.auth`) em vez de importar `../config/prisma` direto — troca mecânica em todos os controllers listados no início deste documento (`associados`, `cadastros`, `contratos`, `inadimplencia`, `sync`, `config`), mas de baixo risco individual (é sempre a mesma troca: `const prisma = require(...)` vira `const prisma = req.prisma`). Isso é o motivo de eu preferir revisar o desenho antes de sair reescrevendo os ~7 controllers de uma vez.

Teste dedicado a escrever pra essa extension especificamente (antes de qualquer controller usar): criar 2 franquias + 2 usuários (um de cada) + dados de ambas, confirmar que uma consulta pelo usuário A nunca retorna nada da franquia B, em cada operação (`findMany`, `findUnique` por id que pertence à outra franquia — deve dar "não encontrado", não vazar o registro —, `update`/`delete` em id de outra franquia, `create` tentando forçar `franquiaId` de outra franquia no corpo). Esse teste é o que dá confiança real de que a extension está fechada, mais importante que testar controller por controller de novo.

---

## 5. Migração dos dados existentes

Passo a passo (migração hand-written em SQL, mesmo padrão já usado neste projeto):

1. `CREATE TABLE franquias` + `CREATE TABLE usuarios`.
2. `INSERT INTO franquias (nome) VALUES ('Via Permuta')` (nome ajustável — me diga se prefere outro) → guarda o id gerado.
3. Adiciona `franquia_id` **nullable** em `associados`, `cadastros_enviados`, `modelos_contrato`, `cobrancas_ignoradas`, `sync_log`, `api_keys` (essa última fica nullable pra sempre, ver seção 1.3).
4. `UPDATE` em massa: preenche `franquia_id` = id da franquia criada no passo 2, em todas as tabelas do passo 3 (exceto `api_keys`, que fica `null` — chaves existentes continuam globais).
5. Torna `franquia_id` `NOT NULL` (com `FOREIGN KEY`) em todas exceto `api_keys`.
6. `configuracoes`: adiciona `franquia_id`, migra as linhas existentes pra apontar pra franquia do passo 2, troca a chave primária pra `(chave, franquia_id)`.
7. Migração de aplicação (roda no primeiro boot, idempotente, não em SQL puro): semeia o `SUPER_ADMIN` a partir de `ADMIN_USER`/`ADMIN_PASSWORD` (seção 2); copia `GOOGLE_SERVICE_ACCOUNT_JSON` do ambiente pra `configuracoes` da franquia do passo 2, se estiver setada (seção 3).

Tudo reversível/auditável — nenhum dado é apagado, só rotulado com a franquia que já era implicitamente a única existente.

---

## 6. Nova aba "Controle Geral" (só `SUPER_ADMIN`)

- **Franquias**: listar, criar (nome), ativar/desativar. Desativar uma franquia — comportamento a definir: bloquear login de todos os usuários dela (recomendo isso) ou só ocultar da navegação? Fica como pergunta aberta pro momento de implementar essa tela.
- **Usuários** (com filtro por franquia): listar, criar (nome, email, senha inicial, papel, franquia — exceto pra `SUPER_ADMIN`, que não tem franquia), editar papel, ativar/desativar (`ativo=false` → login recusado + refresh futuro recusado, ver seção 2).
- Granularidade por recurso (2.3, "quais recursos o usuário pode acessar") — fica pra segunda fase, como combinado.

Novos endpoints (rascunho, ajusto no detalhamento): `GET/POST/PATCH /api/franquias`, `GET/POST/PATCH /api/usuarios` (todos exigindo `papel === 'SUPER_ADMIN'` num middleware novo, `exigirSuperAdmin`).

---

## 7. Ordem de implementação sugerida

Cada etapa é testável e "shippable" isoladamente (não precisa esperar tudo pronto pra ter valor):

1. **Schema + migração de dados** (seções 1, 5) — sem nenhuma mudança de comportamento ainda, só a base de dados pronta.
2. **Autenticação** (seção 2) — login passa a usar `Usuario`/`bcrypt`, token ganha `franquiaId`/`papel`. Sistema continua funcionando exatamente como hoje pra quem já usa (o admin migrado é `SUPER_ADMIN`, vê tudo, nada muda na prática ainda porque só existe 1 franquia).
3. **Isolamento** (seção 4) — extension + troca dos controllers. Testado a fundo (seção 4) antes de qualquer tela nova.
4. **Configurações por franquia** (seção 3).
5. **Tela Controle Geral** (seção 6) — só agora dá pra criar a 2ª franquia de verdade e ver o isolamento valendo em produção.

## Perguntas em aberto (além das já respondidas)

- Nome da primeira franquia (migração, seção 5) — "Via Permuta" está certo, ou prefere outro nome?
- Desativar uma **franquia inteira** (não um usuário): bloqueia login de todo mundo dela imediatamente, ou só remove do painel do `SUPER_ADMIN` sem afetar quem já está logado?
- `SUPER_ADMIN` "vendo tudo" — telas como Dashboard/Cadastro fazem sentido pra ele sem selecionar uma franquia primeiro, ou é melhor forçar a escolha de uma franquia (com opção "todas" só em relatórios agregados, se algum existir)?
