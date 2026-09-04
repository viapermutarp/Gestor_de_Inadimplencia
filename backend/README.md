# Gestor de Inadimplência — Backend

API de controle de cobrança da **Via Permuta**. Node.js + Express + PostgreSQL (Prisma ORM), pronta para rodar em Docker e ser hospedada no EasyPanel.

## Stack

- Node.js 20 + Express
- PostgreSQL 16
- Prisma ORM (migrações versionadas em `prisma/migrations`)
- JWT (`jsonwebtoken`) para o login do painel
- Docker + docker-compose

## Modelo de dados

> **Multi-franquia (ver `docs/plano-multi-franquia.md`)**: `franquias` e `usuarios` já existem no schema, e todo model de negócio abaixo já tem `franquia_id` (`NOT NULL`, backfillado pra uma única franquia semente na migração `20260901130000_add_multi_franquia`). Fase 2 (autenticação) completa: `POST /api/login`/`/refresh`/`/logout` resolvem `Usuario` de verdade (bcrypt, claims `franquiaId`/`papel` no access token) — ver seção "Autenticação" mais abaixo. Fase 3 (isolamento) completa: `src/config/prismaComEscopo.js` (Prisma Client Extension) + `src/middleware/escopoFranquia.js` montam `req.prisma`, já escopado pela franquia da sessão (JWT) ou da API key usada, logo depois de `auth` em toda rota — os 6 controllers de negócio (`associados`, `sync`, `cadastros`, `contratos`, `inadimplencia`, `config`) usam `req.prisma` em vez do client global pros 8 models tenant-scoped, com isolamento automático em toda operação (`findMany`/`findUnique`/`create`/`update`/`delete`/`upsert`/`updateMany`/`createMany`). `src/services/franquiaPadrao.service.js` deixou de ser a ponte universal — hoje só resta como fallback explícito pro `SUPER_ADMIN` (sem seletor de franquia na tela ainda) em `configuracoes` (que não está na extension — ver "Testes realizados") e na criação de API key. Pendente: tela "Controle Geral" (seção 6 do plano) e o teste de isolamento com uma 2ª franquia real em produção (hoje só existe 1).
>
> - **franquias**: `id`, `nome` (editável), `ativo` (`false` bloqueia login de todos os usuários dela), `criado_em`, `recursos_permitidos` (array de string — restrição de telas por franquia, ver `src/config/recursos.js` e "Restrição de telas por franquia" abaixo; `SUPER_ADMIN` nunca é afetado)
> - **usuarios**: `id`, `nome`, `email` (único), `senha_hash`, `papel` (`"SUPER_ADMIN"` | `"FRANQUIA"`), `franquia_id` (nullable — só `SUPER_ADMIN` não tem; `@@unique([franquia_id])` trava 1 usuário por franquia no banco, NULL não conta pra unicidade), `ativo`, `criado_em`, `ultimo_login_em`

- **associados**: `id`, `franquia_id` (FK), `cpf_cnpj` (único, indexado), `nome`, `telefone`, `email`, `em_negociacao`, `observacao`, `observacao_atualizada_em` (data/hora da última mudança de valor de `observacao`, só via `PATCH .../negociacao` — ver seção de endpoints), `bloqueado`, `em_juridico`, `ciclo_resetado_em` (marco usado pelo contador de bloqueios), `criado_em`, `atualizado_em`
- **cobrancas**: `id`, `associado_id` (FK), `id_externo` (opcional, único, indexado — ID gerado pelo Asaas para a cobrança, ex.: `pay_xxxxxxxxxxxxx`), `valor`, `vencimento`, `dias_diferenca`, `link_pagamento`, `descricao`, `status` (`pending` | `overdue` | `paid` | `quitada` — este último só é gravado pelo próprio backend, nunca vem de payload externo, ver seção de reconciliação em `POST /api/sync`), `sincronizado_em`, `quitada_em` (preenchido só quando reconciliada como `"quitada"`)
- **historico_status_associado**: `id`, `associado_id` (FK), `campo` (`"em_negociacao"` | `"bloqueado"` | `"em_juridico"`), `status_anterior`, `status_novo`, `alterado_em` — histórico único das três mudanças de status booleano do associado (substitui as antigas `historico_negociacao` e `historico_bloqueio`, consolidadas nesta tabela pela migração `consolidar_historico_status`; `em_juridico` não tinha histórico dedicado antes disso)
- **configuracoes**: `chave` + `franquia_id` (PK composta — cada franquia tem sua própria linha por chave, ex.: `"api_key"` — legado, ver seção "Múltiplas API keys" abaixo —, `"n8n_webhook_cadastro_url"`, `"asaas_api_key"`, `"inadimplencia_palavras_excluidas"` — array JSON serializado em string), `valor`, `atualizado_em` — tabela genérica de configurações persistidas em runtime
- **api_keys**: `id`, `franquia_id` (FK, `NOT NULL` — chave usada pelo n8n pra autenticar `POST /api/sync`/`/api/cadastros`, precisa saber a franquia pra gravar os registros corretos), `nome` (rótulo livre, ex.: `"n8n - Sync Cobrança"`), `hash` (SHA-256 da chave, único — a chave em texto puro nunca é persistida), `tamanho`, `ultimos_caracteres` (usados só pra mascarar na listagem), `criada_em`, `ultimo_uso_em` (nullable, atualizado best-effort a cada autenticação bem-sucedida), `revogada_em` (nullable — `null` = ativa; a linha nunca é deletada, pra manter histórico) — substitui a antiga chave única de `configuracoes`, ver seção própria abaixo
- **sync_log**: `id`, `franquia_id` (FK), `executado_em`, `total_associados_processados`, `sucesso` — uma linha por chamada a `POST /api/sync`
- **cadastros_enviados**: `id`, `franquia_id` (FK), `payload` (json — corpo completo enviado pelo formulário), `status` (`enviado` | `erro`), `resposta_n8n` (texto, nullable — motivo do erro quando o repasse ao n8n falha ou reporta `sucesso: false`), `link_pagamento`/`cliente_asaas_id`/`pedido_bling_id` (texto, nullable — só preenchidos em caso de sucesso, vindos da resposta do n8n), `nome_pasta` (texto, nullable — campo "Nome da pasta" do formulário), `modelos_contrato_ids` (array de texto — ids de `modelos_contrato` selecionados em "Contratos a gerar"), `pasta_drive_id`/`arquivos_gerados` (nullable, preenchidos de forma assíncrona depois que a geração de contratos termina — ver seção "Geração automática de contratos" abaixo), `criado_em` — uma linha por chamada a `POST /api/cadastros` (fluxo de Cadastro/Faturamento, substitui o gatilho do Kommo)
- **cobrancas_ignoradas**: `id`, `franquia_id` (FK), `asaas_payment_id` (único, indexado), `motivo` (texto, nullable), `criado_em` — lista manual de cobranças do Asaas a excluir do cálculo de Taxa de Inadimplência (ver seção própria abaixo)
- **modelos_contrato**: `id`, `franquia_id` (FK), `nome`, `tipo` (`"TERMO"` | `"ADITIVO"`, só organizacional), `conteudo` (HTML do editor rich text, com placeholders `{{...}}`), `ativo` (soft-delete — `false` quando "removido" via `DELETE /api/contratos/:id`, nunca é hard-deletado), `criado_em`, `atualizado_em` — ver seção "Geração automática de contratos" abaixo
- **refresh_tokens**: `id` (uuid, usado como `jti` no access token da sessão), `token_hash` (SHA-256, único — o valor em texto puro nunca é persistido), `usuario`, `criado_em`, `expira_em`, `revogado_em` (nullable — `null` = sessão ativa), `ultimo_uso_em` — sessões do painel, ver "Autenticação do painel: access token curto + refresh token" abaixo
- **etapas_juridico**: `id`, `franquia_id` (FK), `nome`, `ordem` (inteiro, 0-based — colunas do Kanban "Jurídico"), `criado_em`
- **cards_juridico**: `id`, `franquia_id` (FK), `etapa_id` (FK, `ON DELETE CASCADE`), `ordem` (inteiro, posição dentro da etapa), `associado_id` (FK opcional, `ON DELETE CASCADE` — card "vinculado"; `titulo`/`descricao` ficam `null` quando preenchido), `titulo`/`descricao` (card "livre" — só quando `associado_id` é `null`), `responsavel`/`prazo` (opcionais, válidos nos dois casos), `etapa_alterada_em` (preenchido só quando o card muda de etapa via `PATCH .../mover`), `criado_em`, `atualizado_em` — ver "Kanban Jurídico" abaixo

## Autenticação

Todas as rotas em `/api/*` exigem o header `Authorization: Bearer <token>`, **exceto** `POST /api/login`. O token pode ser:

1. **Qualquer API key ativa** cadastrada em `api_keys` — para integrações externas (ex.: n8n em `POST /api/sync` e `POST /api/cadastros`).
2. Um **JWT (access token)** obtido via `POST /api/login` — para uso do painel administrativo. Ver seção seguinte.

### Autenticação do painel: access token curto + refresh token

**Diagnóstico do bug relatado** ("sessão expira, peço login de novo, mas o token continua sendo o mesmo depois de logar de novo"): não era cache do frontend nem o formulário deixando de submeter — era a própria assinatura do JWT. `jwt.sign` (HS256) é **determinístico**: mesmo header + mesmo payload + mesmo segredo sempre produzem a mesma assinatura, byte a byte. O login antigo assinava só `{ sub: usuario }`, e a única coisa que varia de um login pro outro é o claim automático `iat` (issued-at, resolução de **1 segundo**) — então dois logins com as mesmas credenciais dentro do mesmo segundo geravam o token **idêntico**. Confirmado lendo o código e reproduzido empiricamente (`jwt.sign` chamado duas vezes seguidas no mesmo processo gera o mesmo valor) e também com o teste de ponta a ponta descrito na seção de testes abaixo (dois `POST /api/login` disparados em paralelo, mesmas credenciais — sem o fix, geravam o mesmo access token). Isso por si só já é uma falha de segurança (duas sessões deveriam sempre ser distinguíveis), e também explica por raiz por que só aumentar o tempo de expiração não resolveria nada.

**Fix**: o login deixou de emitir um único JWT de vida longa e passou a emitir dois tokens:

- **Access token** (`token` na resposta) — um JWT continua sendo isso, mas agora **curto** (`JWT_EXPIRES_IN`, padrão `15m`) e carrega um claim `jti` = id de um `RefreshToken` novo, único por sessão (uuid). Isso garante que **duas sessões nunca produzem o mesmo access token**, mesmo com login simultâneo e mesmas credenciais — o `jti` sempre difere, então o payload assinado sempre difere. Verificado no middleware (`src/middleware/auth.js`) do jeito de sempre (`jwt.verify`, stateless, sem tocar o banco a cada requisição).
- **Refresh token** (`refresh_token` na resposta) — uma string aleatória (32 bytes), guardada no banco só como hash SHA-256 (`refresh_tokens.token_hash`, mesmo padrão de `api_keys` — o valor em texto puro nunca é persistido), com validade de `REFRESH_TOKEN_TTL_DIAS` dias (padrão 30). É o refresh token que sustenta a sessão de fato: quando o access token expira (a cada 15min, por design — isso é esperado, não é bug), o frontend chama `POST /api/refresh` em segundo plano pra trocar por um par novo, sem pedir a senha de novo. Um refresh token só pode ser usado **uma vez** (rotação: cada troca revoga o antigo e cria outro) — reusar um já trocado, ou um revogado, ou um expirado, responde 401 e força login de verdade.

**Revogação — o motivo de existir isso tudo.** `POST /api/logout` revoga o refresh token da sessão atual imediatamente (idempotente). Mais importante pro que vem a seguir (item da expansão multi-franquia): `revogarTodasDoUsuario` em `src/services/refreshTokens.service.js` já existe pronta (ainda sem endpoint, porque hoje só existe um usuário/admin) — é exatamente o que "bloquear o acesso de um usuário imediatamente" vai chamar quando o modelo `Usuario` existir: revogar todos os refresh tokens dele barra login de novo na hora; o access token que ele já tinha em mãos continua valendo só até expirar sozinho (no máximo `JWT_EXPIRES_IN`, minutos — não mais dias como antes). Se "imediatamente" precisar ser mais estrito que isso (revogar em segundos, não em até 15min), a opção é o middleware passar a checar o `jti` contra o banco a cada requisição — um trade-off deliberado entre performance (JWT stateless) e revogação instantânea, pra decidir junto com o desenho do multi-usuário.

**Endpoints:**

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/login` | Body `{ usuario, senha }`. Retorna `{ token, refresh_token, tipo: "Bearer", expira_em }`. Única rota pública que exige credenciais. |
| POST | `/api/refresh` | Body `{ refresh_token }`. Troca por um par novo (rotação). 401 se o token não existir, já tiver sido usado, estiver revogado ou expirado — resposta igual à de um access token inválido, pra manter o frontend simples. |
| POST | `/api/logout` | Body `{ refresh_token }`. Revoga só essa sessão; as demais (outros logins/dispositivos) continuam ativas. Sempre 204, mesmo chamado de novo ou com token já revogado/inexistente. |

**Variáveis de ambiente novas/alteradas:**

- `JWT_EXPIRES_IN` — mudou o **padrão** de `8h` pra `15m` (o valor antigo fazia sentido quando o JWT era a sessão inteira; agora é só o access token, renovado sozinho pelo refresh). Se você tinha essa variável setada explicitamente no `.env`/EasyPanel esperando 8h de sessão sem reforço, pode remover — o refresh token (30 dias) é quem sustenta a sessão agora.
- `REFRESH_TOKEN_TTL_DIAS` — novo, padrão `30`. Quantos dias um refresh token vale sem uso.

### Múltiplas API keys

Desde esta versão, a autenticação por API key suporta **N chaves simultâneas** (tabela `api_keys`), cada uma com nome/rótulo próprio (ex.: `"n8n - Sync Cobrança"`, `"n8n - Cadastro/Faturamento"`) e revogável individualmente sem afetar as demais — antes havia só uma chave global, e regenerá-la derrubava toda integração ativa de uma vez.

O middleware de autenticação (`src/middleware/auth.js`) valida o token recebido contra `src/services/apiKeys.service.js` (`validarChave`): calcula o SHA-256 do token e busca por esse hash entre as chaves não revogadas. A chave em texto puro **nunca é persistida** — só o hash (pra validar) e os últimos 6 caracteres (pra mascarar na listagem). A cada autenticação bem-sucedida, `ultimo_uso_em` é atualizado em segundo plano (best-effort, não bloqueia a resposta).

Gerenciamento via `GET`/`POST /api/config/api-keys` e `POST /api/config/api-keys/:id/revogar` (ver tabela de endpoints abaixo) — sem UI de curl necessária, a tela de Configurações do painel já cobre isso.

**Migração automática da chave legada.** A antiga chave única (variável `API_KEY` / tabela `configuracoes`, chave `"api_key"`) é importada automaticamente para `api_keys` (com o nome `"Chave padrão (migrada)"`) na primeira vez que qualquer requisição autenticada por API key ou qualquer chamada a `GET /api/config/api-keys` acontecer depois desta atualização — não é necessário nenhum passo manual, e integrações já configuradas com a chave antiga continuam funcionando sem interrupção. Depois da migração, ela aparece na lista como uma chave normal, revogável como qualquer outra.

### Geração automática da API key e do segredo JWT (fallback do `.env`)

Se `API_KEY` ou `JWT_SECRET` estiverem vazios no `.env`, a aplicação gera valores fortes aleatoriamente **na primeira inicialização** e os grava de volta no arquivo `.env` (o `docker-compose.yml` monta `./.env` dentro do container justamente para isso persistir). Verifique o arquivo `.env` após o primeiro `docker-compose up` para pegar a chave gerada — ela aparece também nos logs do container `api`. Essa variável só serve como semente pra migração automática descrita acima (usada apenas se `api_keys` ainda estiver vazia); depois da primeira migração, ela deixa de ter qualquer efeito e o gerenciamento passa a ser todo pela tabela `api_keys`.

Em produção (EasyPanel), prefira **definir `API_KEY` e `JWT_SECRET` manualmente** nas variáveis de ambiente do serviço, já que o sistema de arquivos do container pode não ser persistente entre deploys — e use `POST /api/config/api-keys` (autenticado) pra gerar chaves nomeadas por integração depois de já estar no ar.

## ⚠️ Breaking change — `GET /api/associados` agora é paginado

A partir desta versão, `GET /api/associados` **não retorna mais um array na raiz da resposta**. Qualquer cliente que já integra com esse endpoint (painel, scripts, automações) **precisa ser atualizado** para ler `body.dados` em vez de `body` diretamente.

**Antes:**

```json
[
  { "cpf_cnpj": "123.456.789-00", "nome": "Fulano de Tal", "...": "..." },
  { "cpf_cnpj": "987.654.321-00", "nome": "Ciclana Silva", "...": "..." }
]
```

**Agora:**

```json
{
  "dados": [
    { "cpf_cnpj": "123.456.789-00", "nome": "Fulano de Tal", "...": "..." },
    { "cpf_cnpj": "987.654.321-00", "nome": "Ciclana Silva", "...": "..." }
  ],
  "paginacao": {
    "pagina_atual": 1,
    "total_paginas": 3,
    "total_registros": 245,
    "por_pagina": 100
  }
}
```

Isso vale inclusive para chamadas **sem nenhum filtro** — antes, `GET /api/associados` sem query params devolvia a base inteira de uma vez; agora devolve a primeira página (100 registros por padrão), como qualquer outra chamada ao endpoint. Para obter a base inteira, pagine (`?page=1`, `?page=2`, ...) usando `paginacao.total_paginas` como referência de parada.

## Endpoints

| Método | Rota | Descrição |
|---|---|---|
| POST | `/api/login` | Login fixo (`ADMIN_USER`/`ADMIN_PASSWORD`). Retorna `{ token, refresh_token, tipo, expira_em }` — ver "Autenticação do painel" acima. |
| POST | `/api/refresh` | Body `{ refresh_token }`. Troca por um access token + refresh token novos (rotação). 401 se inválido/revogado/expirado. |
| POST | `/api/logout` | Body `{ refresh_token }`. Revoga a sessão. Sempre 204. |
| POST | `/api/sync` | Recebe array de associados (com `cobrancas` aninhadas) e faz upsert. Cada associado aceita `cpf_cnpj`, `nome`, `telefone` (obrigatórios) e `email` (opcional). Registra uma linha em `sync_log` a cada chamada. |
| POST | `/api/sync/atualizar` | Sem corpo. Dispara sob demanda o webhook do n8n (`N8N_SYNC_WEBHOOK_URL`) que sincroniza com o Asaas e chama `POST /api/sync` internamente — usado pelo botão "Atualizar" do Dashboard. Timeout de 30s. Ver seção própria abaixo. |
| GET | `/api/associados` | **Paginada** (`page`, `limit` — padrão 1/100, máximo 100). Filtros `em_negociacao`, `em_juridico`, `bloqueado` (`true`\|`false`, combináveis via AND) e `busca` (nome, cpf_cnpj ou telefone, contains case-insensitive). Sem filtro/busca: cada associado vem com todas as cobranças; com algum filtro/busca ativo: só com as em aberto (`pending`/`overdue`). **Sem nenhum dos três toggles de status (aba "Todos" — `busca` sozinho não conta)**: só retorna associados com pelo menos 1 cobrança `pending`/`overdue`, mesmo critério do card de resumo — assim que qualquer toggle é informado, essa exigência some (ver seção própria abaixo). Ordenada pelo `dias_diferenca` mais crítico (mais negativo) em aberto, calculado e aplicado **no banco antes da paginação** (ver seção própria abaixo). Resposta: `{ dados, paginacao }` — ver aviso de breaking change acima. |
| GET | `/api/associados/resumo` | Números agregados (`com_cobranca_aberto`, `valor_total_aberto`, `em_negociacao`, `bloqueados`, `em_juridico`), calculados direto no banco — nunca traz os registros individuais pra aplicação. Aceita só `busca` (mesmo comportamento do parâmetro acima); não aceita paginação nem os filtros booleanos. |
| GET | `/api/associados/:cpf_cnpj` | Detalhe de um associado, com todas as cobranças e `historico` — as mudanças de `em_negociacao`, `bloqueado` e `em_juridico` juntas num só array (`{ id, associado_id, campo, status_anterior, status_novo, alterado_em }`), mais recente primeiro. Ver "Histórico unificado de status" abaixo. |
| PATCH | `/api/associados/:cpf_cnpj/negociacao` | Body `{ "em_negociacao": bool, "observacao"?: string }`. Atualiza o status e grava uma linha em `historico_status_associado` (`campo: "em_negociacao"`). Se o valor de `observacao` realmente mudar, também atualiza `observacao_atualizada_em` — nenhum outro endpoint (incluindo `POST /api/sync`) toca nesse campo. |
| PATCH | `/api/associados/:cpf_cnpj/bloqueio` | Body `{ "bloqueado": bool }`. Atualiza o status e grava uma linha em `historico_status_associado` (`campo: "bloqueado"`). |
| PATCH | `/api/associados/:cpf_cnpj/juridico` | Body `{ "em_juridico": bool }`. Atualiza o campo e grava uma linha em `historico_status_associado` (`campo: "em_juridico"`) — diferente de versões anteriores deste endpoint, que não gravavam histórico nenhum. |
| GET | `/api/associados/:cpf_cnpj/bloqueios/contador` | Conta quantas vezes o associado foi marcado como bloqueado (`historico_status_associado` com `campo: "bloqueado"` e `status_novo: true`) desde o último reset (ou desde sempre, se nunca resetado). |
| POST | `/api/associados/:cpf_cnpj/bloqueios/resetar` | Marca `ciclo_resetado_em = agora`. Não apaga o histórico; só move o ponto de corte do contador. |
| GET | `/api/config/api-keys` | Lista todas as API keys (ativas e revogadas), mais recentes primeiro, sempre mascaradas: `[{ id, nome, chave_mascarada, criada_em, ultimo_uso_em, ativa }]`. Dispara a migração automática da chave legada se `api_keys` ainda estiver vazia (ver seção "Múltiplas API keys" acima). |
| POST | `/api/config/api-keys` | Body `{ "nome": "..." }`. Gera uma nova API key com esse nome/rótulo. Retorna a chave completa — única vez que ela aparece por inteiro. |
| POST | `/api/config/api-keys/:id/revogar` | Revoga só a chave indicada (idempotente; não deleta, só marca `revogada_em`). 404 se o id não existir. |
| GET | `/api/config/webhook-cadastro` | Retorna a URL vigente do webhook do n8n usada por `POST /api/cadastros` (`{ "n8n_webhook_cadastro_url": ... }`, `null` se ainda não configurada). |
| PATCH | `/api/config/webhook-cadastro` | Body `{ "n8n_webhook_cadastro_url": "https://..." }`. Atualiza (cria ou substitui) a URL na tabela `configuracoes`. |
| GET | `/api/config/sync-log` | Retorna as últimas 20 execuções de `POST /api/sync`, mais recentes primeiro. |
| POST | `/api/cadastros` | Recebe o payload do formulário de Cadastro/Faturamento (fluxo que substitui o gatilho do Kommo), salva em `cadastros_enviados` e repassa ao webhook do n8n. Ver seção própria abaixo. |
| GET | `/api/cadastros` | **Paginada** (`page`, `limit` — padrão 1/100, máximo 100, mesmo padrão de `GET /api/associados`). Lista os cadastros enviados, mais recentes primeiro. Resposta: `{ dados, paginacao }`. |
| GET | `/api/config/asaas-key` | Retorna a chave de API do Asaas vigente mascarada (só os últimos 6 caracteres visíveis), `null` se ainda não configurada. |
| PATCH | `/api/config/asaas-key` | Body `{ "chave": "$aact_..." }`. Salva (cria ou substitui) a chave na tabela `configuracoes`. Nunca ecoa o valor completo de volta — só a versão mascarada, mesmo em caso de sucesso. |
| GET | `/api/inadimplencia/resumo` | Números da tela de "Taxa de Inadimplência", calculados em tempo real a partir da API do Asaas. Query params `venc_de`, `venc_ate` (`YYYY-MM-DD`, opcionais — padrão: últimos 12 meses), `renegociacao`, `em_juridico` e `bloqueado` (`todos`\|`sim`\|`nao`, padrão `todos` nos três), `tipo_pendencia` (`todos`\|`vencidas`\|`confirmadas`, padrão `todos` — AJUSTE 4, só tem efeito com `visao=aberto`), `visao` (`aberto`\|`historico`, padrão `aberto` — renomeado de `visao_faixas` no AJUSTE 6: agora controla também `valor_inadimplente`/`valor_adimplente`/as duas taxas, não só `faixas`/`criticos_90_dias`) e `forcar` (`true`, opcional — ignora o cache dessa chamada, mas ainda atualiza o cache com o resultado novo). Cobranças excluídas (manualmente, por palavra-chave na descrição, ou por CPF/CNPJ/nome do associado — AJUSTE 7 — ver seção própria) nunca entram no cálculo; o quanto foi excluído vem em `excluidos`. Cacheado em memória por 4 minutos por combinação de filtros. Ver seções "Status atual x classificação histórica" e "Taxa de Inadimplência" abaixo. |
| GET | `/api/contratos` | Lista todos os modelos de contrato (ativos e inativos), mais recentes primeiro. Aceita `?ativo=true`\|`false` opcional pra filtrar. |
| GET | `/api/contratos/:id` | Detalhe de um modelo (inclui o HTML completo em `conteudo`). |
| POST | `/api/contratos` | Body `{ "nome", "tipo": "TERMO"\|"ADITIVO", "conteudo" }`. Cria um modelo novo (nasce `ativo: true`). |
| PATCH | `/api/contratos/:id` | Body: qualquer subconjunto de `{ nome, tipo, conteudo, ativo }`. Também usado pra reativar (`ativo: true`). |
| DELETE | `/api/contratos/:id` | **Soft-delete** — só marca `ativo: false`, nunca apaga a linha (cadastros antigos referenciam o id em `modelos_contrato_ids` e continuam funcionando). Idempotente. |
| GET | `/api/config/drive-pasta-raiz` | Retorna o id vigente da pasta raiz do Google Drive (`{ "drive_pasta_raiz_id": ... }`, `null` se não configurada). |
| PATCH | `/api/config/drive-pasta-raiz` | Body `{ "drive_pasta_raiz_id": "..." }`. Aceita tanto o id puro quanto o link completo da pasta (extrai o id automaticamente). |
| GET | `/api/config/google-service-account` | Retorna só metadados da credencial da conta de serviço do Google vigente **da própria franquia** (`{ "configurado": boolean, "client_email"?, "project_id"? }`) — nunca a chave privada. |
| PATCH | `/api/config/google-service-account` | Body `{ "credencial": "..." }` — JSON cru ou base64 da conta de serviço (mesmo formato aceito antes por `GOOGLE_SERVICE_ACCOUNT_JSON`). Valida que é um JSON de conta de serviço válido com `client_email` (`400` caso contrário), salva **na franquia de quem está autenticado** (ou na franquia selecionada, pro `SUPER_ADMIN`) e invalida o cliente Drive em cache dessa franquia — a troca vale já na próxima geração de contrato, sem reiniciar o processo. |
| GET | `/api/inadimplencia/evolucao-mensal` | Mesmos números de `valor_total_faturado`/`valor_inadimplente`/`taxa_inadimplencia_percentual` do `/resumo`, mas agrupados por mês, mais `taxa_adimplencia_percentual` (calculado de forma independente, não mais complementar — ver seção "Status atual x classificação histórica"). Mesmos query params de filtro do `/resumo` (`venc_de`, `venc_ate`, `renegociacao`, `em_juridico`, `bloqueado`, `tipo_pendencia`, `forcar` — **não** aceita `visao`: o AJUSTE 6 unificou o toggle "aberto"/"historico" só nos 3 cards do `/resumo`; este endpoint continua exclusivamente por status atual, sempre, e também não devolve `faixas`/`criticos_90_dias`). Ver seção própria abaixo. |
| GET | `/api/inadimplencia/exclusoes` | Lista as cobranças do Asaas excluídas manualmente (por `asaas_payment_id`) do cálculo de Taxa de Inadimplência, mais recentes primeiro. |
| POST | `/api/inadimplencia/exclusoes` | Body `{ "asaas_payment_id": "pay_...", "motivo"?: "..." }`. Adiciona uma exclusão manual. `409` se o `asaas_payment_id` já estiver na lista. |
| DELETE | `/api/inadimplencia/exclusoes/:id` | Remove uma exclusão manual pelo `id` (uuid da tabela `cobrancas_ignoradas`, não o `asaas_payment_id`). `404` se não existir. |
| GET | `/api/config/palavras-excluidas` | Retorna a lista de palavras-chave usadas para excluir cobranças automaticamente do cálculo de Taxa de Inadimplência pela descrição, CPF/CNPJ ou nome/razão social do associado (AJUSTE 7 — `{ "palavras": [...] }`, array vazio se nunca configurada). |
| PATCH | `/api/config/palavras-excluidas` | Body `{ "palavras": ["palavra1", "palavra2"] }`. Substitui a lista inteira (não faz merge). |
| GET | `/api/config/tolerancia-dias` | Retorna o período de tolerância vigente para a classificação de inadimplência (`{ "dias": number }`, `0` se nunca configurado). Ver seção "Período de tolerância" abaixo. |
| PATCH | `/api/config/tolerancia-dias` | Body `{ "dias": number }`. Valida que é um inteiro entre 0 e 30 (`400` caso contrário), salva e limpa o cache de `/resumo`/`/evolucao-mensal`. |
| GET | `/api/franquias` | **Só SUPER_ADMIN** (403 caso contrário — ver `middleware/exigirSuperAdmin.js`). Lista todas as franquias (ativas e inativas), mais antigas primeiro, cada uma já com **todos** os usuários dela embutidos (mais antigo primeiro): `[{ id, nome, ativo, criado_em, usuarios: [{ id, nome, email, ativo, ultimo_login_em, recursos_permitidos }] }]`. Desde o ajuste "múltiplos usuários por franquia" (ver "Testes realizados" abaixo), `recursos_permitidos` é por **usuário**, não mais por franquia. `usuarios: []` só acontece pra franquias que nunca passaram por `POST /api/franquias` nem `POST /api/franquias/:id/usuarios` (hoje, na prática, só a franquia semeada pela migração da Fase 1). |
| POST | `/api/franquias` | **Só SUPER_ADMIN.** Body `{ "nome", "usuario": { "nome", "email", "senha" }, "recursos_permitidos"? }`. Cria a franquia E o usuário titular dela (papel `FRANQUIA`) numa única transação — não existe franquia "vazia" sem usuário neste desenho; se o usuário falhar ao criar (ex.: e-mail já em uso — `409`), a franquia também não é criada. `senha` precisa ter pelo menos 8 caracteres. `recursos_permitidos` (array de chaves de `src/config/recursos.js`) é opcional — sem ele, o usuário titular nasce com **todos** os recursos liberados; se informado, precisa ser só chaves válidas sem repetir (`400` caso contrário). Pra adicionar usuários **extras** a uma franquia já existente, ver `POST /api/franquias/:id/usuarios` logo abaixo. |
| POST | `/api/franquias/:id/usuarios` | **Só SUPER_ADMIN.** Body `{ "nome", "email", "senha", "recursos_permitidos"? }`. Multi-franquia: adiciona mais um login a uma franquia **já existente** (distinto de `POST /api/franquias`, que cria franquia + titular juntos) — o novo usuário compartilha as integrações da franquia (Asaas/webhook/Drive, todas já por-franquia) mas tem `recursos_permitidos` (telas liberadas) **próprios**, independentes dos outros usuários dela. `404` se a franquia não existir. Mesma validação de e-mail único **globalmente** (não por franquia) que já vale pro titular — `409` se colidir. |
| PATCH | `/api/franquias/:id` | **Só SUPER_ADMIN.** Body: qualquer subconjunto de `{ "nome", "ativo" }` — `recursos_permitidos` **não** é mais aceito aqui (movido pra `PATCH /api/usuarios/:id`, logo abaixo — cada usuário tem o próprio desde o ajuste "múltiplos usuários por franquia"). `ativo: false` bloqueia o login de **todos** os usuários da franquia **imediatamente** — `POST /api/login`/`POST /api/refresh` já checam `usuario.franquia.ativo` a cada tentativa, e esta rota também revoga na hora toda sessão já aberta de **cada** usuário dela (não espera o próximo refresh, e não é só o titular). Reversível a qualquer momento (`ativo: true`). |
| DELETE | `/api/franquias/:id/excluir-permanente` | **Só SUPER_ADMIN. ALTO RISCO — exclusão definitiva, distinta de `PATCH /api/franquias/:id` com `ativo: false` (essa continua reversível).** Body `{ "confirmar_nome" }`, precisa bater **exatamente** com o nome atual da franquia (mesmo padrão do GitHub pra apagar um repositório) — `400` se não bater, `404` se a franquia não existir; nos dois casos nada é tocado. Em caso de sucesso (`200`): apaga a franquia e **todos** os dados dela dentro do Gestor numa única transação Prisma (tudo ou nada), cobrindo as 11 relações diretas de `Franquia` no `schema.prisma` (`usuarios`, `associados`, `cadastrosEnviados`, `modelosContrato`, `cobrancasIgnoradas`, `syncLogs`, `apiKeys`, `configuracoes`, `etapasJuridico`, `cardsJuridico`, `historicosCardJuridico`) mais as 2 tabelas `ESCOPO_RELACAO` sem `franquia_id` próprio (`Cobranca`/`HistoricoStatusAssociado`, apagadas via relação `{ associado: { franquiaId } }` dentro da mesma transação) — 13 tabelas ao todo. Resposta: `{ excluido: true, registros_apagados: {...contagem por tabela...}, aviso }` — o `aviso` deixa explícito que contas externas (Asaas, Bling, Google Drive) **não** são apagadas, só os dados dentro do Gestor. |
| PATCH | `/api/usuarios/:id` | **Só SUPER_ADMIN.** Body: qualquer subconjunto de `{ "ativo": boolean, "recursos_permitidos": [...] }`. Bloqueia/desbloqueia o acesso de um usuário individual (distinto de desativar a franquia inteira — ver acima, que agora afeta **todos** os usuários dela de uma vez; os dois controles ficam separados no banco/API de propósito) e/ou troca as telas liberadas dele (`recursos_permitidos` substitui a lista inteira, não faz merge; `400` se alguma chave for inválida). Revoga na hora as sessões já abertas do usuário quando `ativo: false`. `400` se o SUPER_ADMIN tentar bloquear a si mesmo por aqui (use `PATCH /api/perfil`). |
| POST | `/api/usuarios/:id/resetar-senha` | **Só SUPER_ADMIN.** Body `{ "senha" }` (mín. 8 caracteres). Define uma senha nova pro usuário indicado sem precisar saber a antiga, e revoga na hora todas as sessões já abertas dele (a senha só vale de verdade se ele precisar logar de novo com ela). Retorna só `{ "ok": true }`. |
| GET | `/api/perfil` | Dados do **próprio** usuário autenticado (`{ id, nome, email, papel, franquia_id, ativo, ultimo_login_em }`) — qualquer sessão de painel, não só SUPER_ADMIN (sessão por API key toma 403). |
| PATCH | `/api/perfil` | Troca as **próprias** credenciais. Body `{ "nome"?, "email"?, "senha_atual", "senha_nova"? }` — `senha_atual` é **sempre obrigatória e verificada**, mesmo pra trocar só o nome (`401` se não bater). `email` duplicado → `409`. Trocar `senha_nova` revoga as OUTRAS sessões abertas desse usuário (a sessão atual continua valendo até o access token expirar sozinho). Hoje só usado pelo SUPER_ADMIN (tela "Controle Geral"), mas a rota em si não exige esse papel. |
| GET | `/api/juridico/etapas` | Exige recurso `juridico` (ver abaixo). O board inteiro do Kanban: etapas ordenadas (`ordem` asc), cada uma já com os próprios cards (também ordenados). Cards vinculados a associado vêm com os dados dele **ao vivo** — `associado: { id, nome, cpf_cnpj, telefone, valor_em_aberto }`, recalculado a cada chamada, nunca copiado estaticamente. |
| POST | `/api/juridico/etapas` | Body `{ "nome" }`. Cria uma etapa nova como última coluna (`ordem` = máximo atual + 1). |
| PATCH | `/api/juridico/etapas/:id` | Body `{ "nome" }`. Renomeia (edição simples, não mexe em `ordem`). `404` se não existir nesta franquia. |
| POST | `/api/juridico/etapas/reordenar` | Body `{ "ids": [...] }` — a nova ordem completa das colunas (drag and drop). Reindexa `ordem` = posição no array pra todas as etapas informadas, numa transação só. `400` se algum id não existir nesta franquia. |
| DELETE | `/api/juridico/etapas/:id` | Sem `?confirmar=true`: se a etapa tiver algum card, recusa com `409 { total_cards }`. Com `?confirmar=true`: remove a etapa — os cards dela são removidos junto pelo `ON DELETE CASCADE` do banco. |
| GET | `/api/juridico/associados-busca` | `?busca=termo` — busca por nome/CPF-CNPJ/telefone (mesmo padrão de `GET /api/associados`), usada só na hora de vincular um card a um associado existente. Resposta enxuta, top 20, já com `valor_em_aberto` calculado. |
| POST | `/api/juridico/cards` | Body `{ "etapa_id", "associado_id"?, "titulo"?, "descricao"?, "observacoes"?, "responsavel"?, "prazo"? }`. Exatamente uma origem: `associado_id` (vinculado) OU `titulo` (livre) — nunca os dois, nunca nenhum (`400`). `descricao`/`observacoes` funcionam nos **dois** modos desde o ajuste "Observações também em card vinculado" (ver "Kanban Jurídico" abaixo) — só `titulo` continua exclusivo de card livre (`400` se enviado junto com `associado_id`). Nasce como último card da etapa. Registra um evento `"criacao"` no histórico do card (ver "Histórico dos cards do Jurídico" abaixo). |
| PATCH | `/api/juridico/cards/:id` | Qualquer subconjunto de `{ "titulo", "descricao", "observacoes", "responsavel", "prazo" }`. Nunca muda `associado_id`/`etapa_id` (pra mover entre colunas, ver rota `.../mover`). Card vinculado a associado rejeita só `titulo` (`400`) — `descricao`/`observacoes` são aceitos e atualizados normalmente nos dois modos desde o mesmo ajuste. Registra um evento no histórico do card pra cada campo que mudou **de verdade** (compara valor anterior x novo — não loga se o valor enviado for igual ao que já estava salvo; ver "Histórico dos cards do Jurídico" abaixo). |
| PATCH | `/api/juridico/cards/:id/mover` | Body `{ "etapa_id", "indice" }`. Move o card (drag and drop) pra `etapa_id` na posição `indice` (0-based) da lista de destino — pode ser a mesma etapa, só reordenando. Reindexa `ordem` de todos os cards afetados (destino e, se mudou de etapa, também a origem). `etapa_alterada_em` só é preenchido quando a etapa muda de verdade — e, nesse mesmo caso (não numa simples reordenação dentro da coluna), um evento `"etapa"` também é registrado no histórico do card (ver "Histórico dos cards do Jurídico" abaixo). |
| DELETE | `/api/juridico/cards/:id` | Remove o card e reindexa `ordem` dos demais cards da etapa (fecha o buraco deixado). Registra o evento final `"exclusao"` no histórico do card **antes** do delete de verdade (ver "Histórico dos cards do Jurídico" abaixo) — o registro não tem FK pro card, então continua consultável depois. |
| GET | `/api/juridico/cards/:id/historico` | Mesma cadeia de middleware das outras rotas de card (`auth, juridico, escopoFranquia`) — isolamento por franquia automático via a Prisma Client Extension. Lista os eventos do card em `historico_card_juridico`, mais recente primeiro (`criadoEm: 'desc'`): `[{ id, campo_alterado, valor_anterior, valor_novo, usuario_id, usuario_nome, criado_em }]` — `usuario_nome` resolvido à parte via `usuario.findMany` (a tabela não tem FK pro usuário, de propósito). `404` se o card não existir (inclusive card de outra franquia, ou já excluído) — o histórico em si sobrevive no banco depois do card ser apagado (evento `"exclusao"` incluso), mas o endpoint exige o card ainda existir pra autorizar/escopar a consulta. |

### Restrição de telas por franquia

Cada usuário passa a ter uma lista configurável (`usuarios.recursos_permitidos`, array de string) de quais telas ele pode acessar — `dashboard`, `inadimplencia`, `cadastro`, `contratos`, `juridico`, `configuracoes` (chaves canônicas em `src/config/recursos.js`, reaproveitadas por `franquias.controller.js`/`usuarios.controller.js` na validação e por `middleware/exigirRecurso.js` na aplicação). **"Controle Geral" nunca entra nessa lista** — não é um recurso restringível, continua sendo SUPER_ADMIN only sem exceção, e não depende de usuário/franquia nenhuma.

> **Atualização (ajuste "múltiplos usuários por franquia"):** `recursos_permitidos` migrou de `Franquia` pra `Usuario` — o resto desta seção segue valendo conceitualmente (mesmas 6 chaves, mesmo middleware, mesma checagem em tempo real contra o banco), só que a lista agora é por **login**, não mais compartilhada por todos os usuários da mesma franquia. Ver "Múltiplos usuários por franquia" logo depois de "Kanban Jurídico" abaixo.

`middleware/exigirRecurso(chave)` (mesmo padrão de `exigirSuperAdmin.js` — fábrica de middleware, uso: `exigirRecurso('dashboard')`) protege cada grupo de rotas, sempre logo depois de `auth`:

- **Duas isenções totais**, nunca bloqueadas: autenticação por **API key** (integrações externas, ex.: n8n em `POST /api/sync` — não é uma "tela", não faz sentido restringir) e papel **SUPER_ADMIN** (sempre tem acesso a tudo, em qualquer franquia que tiver selecionada).
- Pra qualquer outra sessão (usuário de franquia comum), busca `recursosPermitidos` **direto no banco a cada requisição** — nunca confia num claim do JWT, que ficaria desatualizado até o token expirar. Se a chave não estiver na lista, `403`. Isso significa que uma mudança feita pelo SUPER_ADMIN em Controle Geral vale **na próxima requisição**, sem exigir novo login da franquia afetada.

Mapeamento de rotas → recurso: `associados.routes.js` (Dashboard, inclui o toggle `em_juridico` do próprio associado — não confundir com a aba "Jurídico"/Kanban) → `dashboard`; `inadimplencia.routes.js` → `inadimplencia`; `cadastros.routes.js` → `cadastro`; `contratos.routes.js` → `contratos`; `config.routes.js` (toda a tela Configurações) → `configuracoes`; `juridico.routes.js` → `juridico`; `sync.routes.js`: só `POST /api/sync/atualizar` (botão "Atualizar" do Dashboard, sessão JWT) exige `dashboard` — `POST /api/sync` em si roda por API key, sempre isento.

**Migração** (`20260902141630_add_juridico_kanban_e_recursos_franquia`): toda franquia **existente** até esse deploy recebeu a lista completa de recursos (backfill via `UPDATE`, ninguém perdeu acesso ao que já tinha). Franquias criadas **depois** desse deploy recebem a lista que o SUPER_ADMIN escolher em `POST /api/franquias` — sem informar nada, o controller já usa a lista completa como default (mesmo espírito: "mais fácil desmarcar o que não quer do que esquecer de marcar o que precisa").

### Kanban Jurídico (`/api/juridico/*`)

Aba nova — quadro Kanban por franquia, com etapas (colunas) e cards configuráveis. `EtapaJuridico`/`CardJuridico` são `ESCOPO_DIRETO` na Prisma Client Extension de isolamento (`src/config/prismaComEscopo.js`) — `franquia_id` direto na própria tabela, mais simples que o desenho por relação usado em `Cobranca`/`HistoricoStatusAssociado` (a etapa não "pertence" a nenhum outro tenant-model, ela mesma é o tenant-model).

- **Etapas**: criar, renomear, reordenar (`ordem` reindexado por inteiro a cada mudança, nunca esparso), excluir — com confirmação obrigatória (`409` + `total_cards`, repete a chamada com `?confirmar=true`) se a etapa tiver algum card; os cards são removidos junto pelo `ON DELETE CASCADE` do banco.
- **Cards — duas origens, mutuamente exclusivas** (validado no controller): **vinculado** a um `Associado` já cadastrado (busca por nome/CPF-CNPJ/telefone, mesmo padrão do Dashboard — `GET /api/juridico/associados-busca`) — nome, CPF/CNPJ, telefone e valor em aberto são exibidos **sempre ao vivo** a partir da relação, recalculados a cada `GET /api/juridico/etapas`, nunca copiados estaticamente pro card; ou **livre** — título + descrição próprios, sem nenhum associado. `responsavel`/`prazo` são opcionais nos dois casos. O vínculo com `Associado` é validado manualmente no controller (confirma que o `associado_id` pertence à mesma franquia antes de aceitar) — a extension só valida esse tipo de relação automaticamente pros models `ESCOPO_RELACAO`.
- **Mover entre etapas** (`PATCH .../mover`): reindexa `ordem` de todos os cards afetados na etapa de destino e, se mudou de etapa, também na etapa de origem (fecha o buraco deixado). `etapa_alterada_em` é preenchido só quando a etapa muda de verdade — registro simples de "quando mudou de etapa pela última vez", complementar ao log completo em `historico_card_juridico` (ver abaixo).
- **Observações**: campo livre extra (`observacoes`), adicionado depois do MVP inicial. **Atualização (ajuste "Observações também em card vinculado"):** `descricao`/`observacoes` deixaram de ser exclusivos de card **livre** — hoje funcionam nos dois modos, tanto em `POST` quanto em `PATCH`. Só `titulo` continua exclusivo de card livre (`400` se enviado junto com `associado_id`) — pra card vinculado, o título segue sempre derivado do nome do associado (nunca um valor próprio, editável).

### Histórico dos cards do Jurídico (`historico_card_juridico`)

Toda alteração de um card do Jurídico gera um registro nesta tabela — nunca sobrescreve o card, só acrescenta um evento: criação (`campo_alterado: "criacao"`), edição de um campo (`"titulo"`/`"descricao"`/`"observacoes"`/`"responsavel"`/`"prazo"`, com `valor_anterior`/`valor_novo` preenchidos — só quando o valor mudou **de verdade**, comparado antes/depois; reenviar o mesmo valor já salvo não gera evento novo), mudança de etapa (`"etapa"`, com o id da etapa origem/destino — só quando a etapa muda de verdade, **não** numa reordenação dentro da mesma coluna) e exclusão (`"exclusao"`, registrado **antes** do delete de verdade).

- **Sem FK pro card nem pro usuário, de propósito** (mesmo raciocínio já usado em `RefreshToken.usuario`) — precisa sobreviver tanto à exclusão do card (o evento `"exclusao"` só faz sentido se continuar consultável depois que o card já não existe mais) quanto a qualquer mudança futura em como usuários são removidos/arquivados. `usuario_id` fica `null` quando a ação vem de uma sessão de API key (não deveria acontecer na prática — o Jurídico não é usado por integração externa nenhuma — mas o campo aceita esse caso sem quebrar).
- **Isolamento por franquia**: `historico_card_juridico` está no `ESCOPO_DIRETO` da Prisma Client Extension de isolamento (mesma extension da seção "Isolamento de dados" — `franquia_id` na própria tabela, mesmo padrão de `EtapaJuridico`/`CardJuridico`).
- **Atualização (ajuste "histórico do card na UI"):** ganhou endpoint de leitura, `GET /api/juridico/cards/:id/historico` (ver tabela de Endpoints acima) — antes só existia a gravação, sem jeito de consultar pelo painel. No frontend, o modal do card ganhou um seletor "Dados"/"Histórico" (só aparece editando um card já existente — card novo ainda não tem histórico), listando cada evento com rótulo amigável do campo alterado, valor anterior → valor novo, quem fez a mudança (ou "Sistema (API)" quando `usuario_id` é `null`) e quando.

### Múltiplos usuários por franquia

Uma franquia deixa de estar limitada a 1 usuário — o SUPER_ADMIN pode adicionar usuários extras a uma franquia já existente (`POST /api/franquias/:id/usuarios`), cada um com login próprio e `recursos_permitidos` independentes, todos compartilhando os mesmos dados e integrações da franquia (Asaas/webhook/Drive, sempre por-franquia, nunca por-usuário).

- `@@unique([franquiaId])` removido de `Usuario` (migração `20260902150000_juridico_observacoes_historico_e_usuarios_multiplos`) — nada mais impede 2+ usuários com a mesma `franquia_id`.
- `recursosPermitidos` migrou de `Franquia` pra `Usuario`, com backfill: cada usuário único que já existia recebeu exatamente o `recursos_permitidos` que a franquia dele tinha antes da migração — ninguém perdeu acesso. `Franquia.recursosPermitidos` fica como campo **legado** (documentado no schema, sem `DROP COLUMN`), sem ser lido por nenhum código a partir daqui.
- `middleware/exigirRecurso.js` passou a consultar `Usuario.recursosPermitidos` (por usuário) em vez de `Franquia.recursosPermitidos` (por franquia) — ver "Restrição de telas por franquia" acima.
- Desativar uma franquia (`PATCH /api/franquias/:id`, `ativo: false`) bloqueia login/refresh de **todos** os usuários dela de uma vez (revoga a sessão de cada um), não só do titular — mesma checagem de `usuario.franquia.ativo` em `POST /api/login`/`POST /api/refresh` que já existia, agora valendo pra N usuários por franquia.
- Frontend: "Controle Geral" ganhou "+ Adicionar usuário" por franquia, e cada usuário passou a ter o próprio bloco de "Telas liberadas" (editável individualmente, não mais um bloco só por franquia).

### Cadastro/Faturamento (`POST /api/cadastros`) — substitui o gatilho do Kommo

Endpoint usado pela própria equipe interna via painel (autenticado com o JWT do login, embora aceite o mesmo `Bearer <token>` de qualquer outra rota — não há um middleware específico "só JWT", é o mesmo `auth` usado no resto da API). Recebe o payload **exatamente com as chaves em português, acentos e espaços incluídos**, porque é o formato que o n8n já espera:

```json
{
  "Tipo de Pessoa": "PF",
  "Razão Social": "",
  "Nome Fantasia": "",
  "CNPJ/CPF": "123.456.789-00",
  "CEP": "01000-000",
  "Endereço": "Rua Exemplo",
  "Número": "100",
  "Complemento": "",
  "Bairro": "Centro",
  "Cidade": "São Paulo",
  "UF": "SP",
  "Contato": "Fulano de Tal",
  "Celular": "11999999999",
  "E-mail": "fulano@email.com",
  "Descrição do Serviço": "Anuidade (PIX)",
  "Valor da Entrada": "0",
  "Número de Parcelas": "1",
  "Valor Total": "1500.00",
  "Data Vencimento": "2026-09-01",
  "Observações": "",
  "Desconto Parcela": "0"
}
```

**Validação** (400 se faltar): `"CNPJ/CPF"` é obrigatório; é preciso informar `"Razão Social"` **ou** `"Contato"` (pelo menos um); `"Descrição do Serviço"` é obrigatório e precisa ser uma das quatro opções (`Anuidade (PIX)`, `Anuidade (Boleto)`, `Anuidade (Cartão de Crédito)`, `Recorrência Cartão de Crédito (Anuidade)`); `"Valor Total"` é obrigatório. Se `"Tipo de Pessoa"` vier preenchido, precisa ser `"PF"` ou `"PJ"`.

**Fluxo, passo a passo:**
1. Salva uma linha em `cadastros_enviados` com `status: "enviado"` e o payload completo.
2. Faz `POST` do mesmo payload (JSON) para a URL configurada em `n8n_webhook_cadastro_url` e **aguarda a resposta dele** (timeout de 60s — o fluxo lá encadeia criação de cliente e pedido no Bling, depois cliente e cobrança no Asaas, cada chamada com retry de até 3 tentativas e 5s entre elas; o caminho feliz já passa de 30-40s, um retry pode passar de 1 minuto). Configurável via `CADASTRO_WEBHOOK_TIMEOUT_MS` (útil só pra testes automatizados não esperarem 60s de verdade).
3. **Captura a resposta do n8n** (JSON esperado):
   ```json
   { "sucesso": true, "linkPagamento": "https://...", "clienteAsaasId": "cus_...", "pedidoBlingId": "..." }
   { "sucesso": false, "erro": "CPF inválido" }
   ```
   Um HTTP `2xx` **não** garante sucesso — o n8n pode responder `200` mesmo quando a etapa de negócio falhou (CPF inválido, cliente já existe no Bling etc.); quem manda é o campo `"sucesso"` do corpo. Se a integração ainda não mandar esse campo, é tratado como sucesso (graceful degradation), só que sem os IDs/link (ficam `null`).
4. Se o `POST` falhar por qualquer motivo — rede indisponível, timeout, HTTP de erro do n8n, `"sucesso": false` no corpo, ou a URL simplesmente não estar configurada — atualiza o registro para `status: "erro"` com o motivo em `resposta_n8n`. Se der certo, grava `link_pagamento`, `cliente_asaas_id` e `pedido_bling_id` vindos da resposta.
5. **A resposta HTTP para quem preencheu o formulário é sempre de sucesso (`201`)**, com o registro salvo (já refletindo `status: "enviado"` ou `"erro"`, e os campos acima) — uma falha ao chamar/processar no n8n nunca trava o cadastro em si, que já está garantido no banco. Quem decide se deu certo pro usuário é o campo `"status"` do corpo, não o status HTTP — ver `app/cadastro/page.js` no frontend pra como isso é exibido (link de pagamento clicável em caso de sucesso, mensagem de erro real em caso de falha).

```bash
curl -X POST https://api.exemplo.com/api/cadastros \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{ "CNPJ/CPF": "123.456.789-00", "Contato": "Fulano", "Descrição do Serviço": "Anuidade (PIX)", "Valor Total": "1500.00" }'
# 201 — sucesso:
# { "id": "...", "payload": {...}, "status": "enviado", "resposta_n8n": null,
#   "link_pagamento": "https://sandbox.asaas.com/i/abc123", "cliente_asaas_id": "cus_000001",
#   "pedido_bling_id": "bling_555", "criado_em": "..." }
# 201 — falha (de negócio, transporte, ou timeout — mesmo formato pros três):
# { "id": "...", "payload": {...}, "status": "erro", "resposta_n8n": "CPF inválido",
#   "link_pagamento": null, "cliente_asaas_id": null, "pedido_bling_id": null, "criado_em": "..." }

curl "https://api.exemplo.com/api/cadastros?page=1&limit=20" -H "Authorization: Bearer <token>"
```

### Taxa de Inadimplência (`GET /api/inadimplencia/resumo`) — integração direta com a API do Asaas

Tela nova que consulta a API do Asaas **em tempo real** (não depende de `POST /api/sync` nem de nenhuma tabela local de cobranças) para calcular a taxa de inadimplência da carteira, cruzando com `associados.em_negociacao` da nossa própria base.

**Configuração da chave** (feita uma vez, via painel ou `curl`):

```bash
curl -X PATCH https://api.exemplo.com/api/config/asaas-key \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"chave": "$aact_prod_..."}'
# {"asaas_api_key":"••••••••••••••••••••••••••••••••••••••••3f89b2"}

curl https://api.exemplo.com/api/config/asaas-key -H "Authorization: Bearer <token>"
# {"asaas_api_key":"••••••••••••••••••••••••••••••••••••••••3f89b2"}
```

Se `GET /api/inadimplencia/resumo` for chamado **antes** de configurar a chave, retorna `400`:

```json
{ "error": "Chave da API do Asaas não configurada. Configure em PATCH /api/config/asaas-key." }
```

**Como a consulta ao Asaas funciona** (`src/services/asaas.service.js`):

- Base URL: `https://www.asaas.com/api/v3` (fixa em produção; só é sobrescrita pela variável de ambiente `ASAAS_API_BASE_URL` para apontar a um mock nos testes — ver seção de testes).
- Autenticação: header `access_token: <chave>` (a API do Asaas **não** usa `Authorization: Bearer`).
- `GET /v3/payments?dueDate[ge]=...&dueDate[le]=...&limit=100&offset=N`, paginando com o mesmo esquema offset/limit da API do Asaas até `hasMore: false` — busca **todos** os pagamentos (qualquer status) com vencimento no período, não só os em atraso.
- **Importante**: o objeto de pagamento do Asaas só traz o **ID do cliente** (`customer`, ex.: `"cus_000005219478"`), não o `cpfCnpj` diretamente. Por isso, para cruzar com `associados.em_negociacao`, o serviço faz uma chamada extra `GET /v3/customers/{id}` (com concorrência limitada a 5 em paralelo) para cada cliente único referenciado — só quando necessário, ver regra de "renegociacao" abaixo. Uma falha isolada ao resolver um cliente não derruba o cálculo inteiro: esse pagamento é tratado como "sem associado correspondente" (conta como "não em negociação").

### AJUSTE CRÍTICO 3 — `valor_inadimplente`/`valor_adimplente` por status atual do Asaas

**Decisão de negócio (confirmada explicitamente, reverte o AJUSTE CRÍTICO 1 abaixo):** a Taxa de Inadimplência deve refletir **o que está em aberto agora**, não o histórico de atraso de algo já quitado. Por isso, desde este ajuste, `valor_inadimplente`/`valor_adimplente`/`taxa_inadimplencia_percentual`/`taxa_adimplencia_percentual` usam o **status atual de cada cobrança no Asaas**, não mais a classificação histórica por data de pagamento da seção seguinte — isso vale para `/evolucao-mensal` sempre, e para `/resumo` quando `visao=aberto` (o padrão). Desde o **AJUSTE 6** (ver seção própria mais abaixo), no `/resumo` com `visao=historico` esses mesmos campos passam a usar a classificação histórica por data, e não mais o status atual:

| Grupo | Status Asaas | Observação |
|---|---|---|
| **INADIMPLENTE** | `OVERDUE` (vencida, não paga) ou `CONFIRMED` (confirmada — ex.: cartão aprovado, dinheiro ainda não caiu na conta) | Qual dos dois entra depende do filtro `tipo_pendencia` — ver AJUSTE 4 abaixo. |
| **ADIMPLENTE** | `RECEIVED` ou `RECEIVED_IN_CASH` (baixa manual "recebido em dinheiro") | Nunca afetado por `tipo_pendencia`. |
| *(nem um nem outro)* | Qualquer outro status — o mais comum é `PENDING` (ainda não venceu) | Não entra em nenhum dos dois somatórios. É **esperado e correto** que `valor_total_faturado !== valor_inadimplente + valor_adimplente` sempre que houver cobranças desse terceiro grupo no período. |

Consequência direta: uma cobrança vencida em janeiro e paga com atraso em março passa a contar como **adimplente** assim que a consulta é feita depois de março (status `RECEIVED`) — o oposto exato do que o AJUSTE CRÍTICO 1 original buscava evitar. Essa reversão foi deliberada e confirmada com o operador antes de implementar.

**AJUSTE 4 — filtro `tipo_pendencia`** (`todos`\|`vencidas`\|`confirmadas`, padrão `todos`) separa, dentro de `valor_inadimplente`, as cobranças vencidas (`OVERDUE`) das confirmadas/crédito futuro (`CONFIRMED`) — antes não havia como isolar uma da outra, as duas sempre apareciam somadas:

```bash
curl "https://api.exemplo.com/api/inadimplencia/resumo?tipo_pendencia=vencidas" -H "Authorization: Bearer <token>"
# valor_inadimplente = só cobranças OVERDUE

curl "https://api.exemplo.com/api/inadimplencia/resumo?tipo_pendencia=confirmadas" -H "Authorization: Bearer <token>"
# valor_inadimplente = só cobranças CONFIRMED
```

Afeta **só** `valor_inadimplente` e `taxa_inadimplencia_percentual`. **Não** afeta `valor_adimplente`/`taxa_adimplencia_percentual` (sempre `RECEIVED`/`RECEIVED_IN_CASH`), nem `valor_total_faturado` (sempre o período inteiro, qualquer status), nem `top_devedores`/`associados_inadimplentes`/`criticos_90_dias`/`renegociacoes_abertas`/`faixas` (nenhum destes muda com este filtro).

**Desde o AJUSTE 6**: este filtro só tem efeito quando `visao=aberto` (o padrão). Com `visao=historico`, `tipo_pendencia` é lido e validado normalmente (valores inválidos ainda retornam 400), mas **não afeta o resultado** — `valor_inadimplente` no modo histórico já é definido pela classificação por data (ver seção "AJUSTE 6" abaixo), sem distinção entre "vencidas"/"confirmadas". O frontend desabilita visualmente o campo "Tipo de pendência" quando o modo "Histórico do período" está ativo, para não sugerir um efeito que não existe.

> **AJUSTE 6 — unificação `aberto`/`historico` nos 3 cards do `/resumo`**: a classificação histórica por data de pagamento (`classificarPagamento`, seção seguinte) continua existindo sem nenhuma mudança de comportamento na função em si — o que mudou é **quem a consome**. Até o AJUSTE 5, ela alimentava só `faixas`/`criticos_90_dias` no modo `historico`. **Desde o AJUSTE 6**, ela também alimenta `valor_inadimplente`/`valor_adimplente`/`taxa_inadimplencia_percentual`/`taxa_adimplencia_percentual` no `/resumo`, sempre que `visao=historico` — usando a mesma função `computarValorInadimplenteAdimplenteHistorico`, que soma o `value` de quem a classificação por data marca `INADIMPLENTE` (não pago dentro da tolerância) ou `ADIMPLENTE` (pago dentro da tolerância), agregando os mesmos dois grupos que já alimentam as 7 faixas em 2 números só. O parâmetro que controla o modo — antes `visao_faixas`, só para `faixas`/`criticos_90_dias` — foi **renomeado para `visao`** neste ajuste, já que agora controla mais do que só as faixas (ver seção "AJUSTE 6" própria mais abaixo para o comportamento completo e o motivo do rename). Com `visao=aberto` (padrão), nada muda: os 3 cards continuam por status atual, exatamente como neste AJUSTE CRÍTICO 3.

### Classificação histórica de inadimplência (data de pagamento) — usada só em `faixas`/`criticos_90_dias`

**O problema que essa seção resolve:** consultar o `status` atual de uma cobrança no Asaas para decidir se ela foi "inadimplente" é errado para relatórios de período fechado. Uma cobrança vencida em janeiro e paga só em março aparece como `RECEIVED` quando você consulta hoje — e, se a classificação dependesse do status atual, ela simplesmente desapareceria da inadimplência de janeiro, sub-representando o histórico. O retrato de um mês fechado não pode mudar dependendo de quando você consulta.

**Campo usado**: `paymentDate` do Asaas ("Payment date on Asaas" — [documentação oficial](https://docs.asaas.com/reference/list-payments.md)), populado quando o pagamento é efetivamente recebido/confirmado, `null` enquanto não pago. **Não** confundir com `clientPaymentDate` ("Date on which the customer paid the bank slip" — específico de boleto, não usado aqui): `paymentDate` é o campo correto porque existe para qualquer forma de pagamento (PIX, cartão, boleto), não só boleto.

**Regra de classificação** (`classificarPagamento`, em `src/controllers/inadimplencia.controller.js`), aplicada a qualquer cobrança com vencimento dentro do período filtrado (`dataLimiteEfetiva` é explicada na seção "Período de tolerância" logo abaixo — com a tolerância no padrão `0`, `dataLimiteEfetiva` é sempre idêntica a `dueDate`, e as regras abaixo se reduzem exatamente ao comportamento original):

- **ADIMPLENTE**: possui `paymentDate` **e** `paymentDate <= dataLimiteEfetiva`.
- **INADIMPLENTE**: possui `paymentDate` **e** `paymentDate > dataLimiteEfetiva` (paga além da tolerância) **ou** não possui `paymentDate` **e** `dataLimiteEfetiva <= hoje` (ainda não paga, e a tolerância já esgotou) — **mesmo que o `status` atual já seja `RECEIVED`/`CONFIRMED`**.
- **A_VENCER** (exceção): não possui `paymentDate` **e** `dataLimiteEfetiva > hoje`. Não conta nem como adimplente nem como inadimplente **nesta classificação por data** — cobre tanto o caso original (vencimento futuro) quanto, com tolerância configurada, uma cobrança já vencida pela data crua mas ainda dentro da janela de tolerância. Desde o AJUSTE CRÍTICO 3, esse rótulo importa pra decidir se a cobrança entra em `faixas`/`criticos_90_dias` no modo `historico` (não entra) e, desde o **AJUSTE 6**, também pra `valor_inadimplente`/`valor_adimplente` no `/resumo` quando `visao=historico` (mesma exclusão) — só não tem relação com `valor_inadimplente`/`valor_adimplente` quando `visao=aberto` (padrão) ou em `/evolucao-mensal`, que são por status atual (ver seção acima).

Desde o AJUSTE CRÍTICO 3 (seção acima), essa classificação deixou de alimentar `valor_inadimplente`/`valor_adimplente`/as duas taxas em `/evolucao-mensal` e no `/resumo` com `visao=aberto` (padrão) — nesses casos o status atual do Asaas manda. Ela é usada para bucketizar `faixas`/`criticos_90_dias` nos dois modos de `visao` (ver AJUSTE CRÍTICO 2 e AJUSTE 5 mais abaixo) e, **desde o AJUSTE 6**, também para `valor_inadimplente`/`valor_adimplente`/as duas taxas no `/resumo` quando `visao=historico` (ver seção "AJUSTE 6" acima). Por isso o "retrato" do `/resumo` no modo `historico`, pra qualquer mês passado, continua **fixo**, independente de quando a consulta é feita (a única coisa que pode mudar esse retrato depois é alterar a tolerância configurada, o que é uma decisão deliberada do operador, não um efeito colateral do tempo passar).

> **Decisão de design**: `associados_inadimplentes` e `top_devedores` **continuam** baseados no snapshot de hoje (`status: "OVERDUE"`), sem usar essa nova classificação nem a tolerância — são métricas operacionais ("quem eu ligo hoje"), diferentes da taxa histórica do período. O pedido original só nomeou explicitamente `valor_inadimplente`, `taxa_inadimplencia_percentual` e `taxa_adimplencia_percentual` como alvo da mudança.

### AJUSTE 6 — `visao` unifica os 3 cards do `/resumo` com o modo de `faixas` (rename de `visao_faixas`)

Até este ajuste, o parâmetro `visao_faixas` (`aberto`\|`historico`) só controlava `faixas`/`criticos_90_dias` — os 3 cards do topo (`valor_inadimplente`, `valor_adimplente`, `taxa_inadimplencia_percentual`) ficavam sempre travados no critério de status atual do AJUSTE CRÍTICO 3, ignorando o toggle da tela. Desde este ajuste, o mesmo parâmetro — **renomeado de `visao_faixas` para `visao`**, porque agora afeta mais do que só as faixas — controla os dois ao mesmo tempo, na mesma requisição a `/resumo`:

| Modo (`visao`) | `faixas`/`criticos_90_dias` | `valor_inadimplente`/`valor_adimplente`/as 2 taxas |
|---|---|---|
| `aberto` (padrão) | Comportamento inalterado — ver seção "Faixas de atraso" abaixo. | Status atual do Asaas — comportamento do AJUSTE CRÍTICO 3, sem nenhuma mudança. |
| `historico` | Comportamento inalterado — ver seção "Faixas de atraso" abaixo. | Classificação histórica por data (`classificarPagamento`) sobre o mesmo conjunto de pagamentos que já alimenta as faixas nesse modo (excluídos só os `A_VENCER`) — `valor_inadimplente` = soma de quem foi classificado `INADIMPLENTE`, `valor_adimplente` = soma de quem foi classificado `ADIMPLENTE`. As duas taxas são calculadas sobre esses valores, como sempre (`.../ valor_total_faturado * 100`). |

**Por que renomear `visao_faixas` para `visao`**: o nome antigo já não descrevia o parâmetro corretamente, já que ele deixou de afetar só `faixas`. Avaliado o impacto: o parâmetro é interno a este app full-stack (backend e frontend do Gestor de Inadimplência são desenvolvidos e implantados juntos, sem consumidores externos da API), então o rename foi seguro de fazer direto, sem período de transição/alias. Frontend atualizado no mesmo commit (`lib/api.js`, `app/inadimplencia/page.js`, `components/FaixasChart.js`).

**`tipo_pendencia` fica sem efeito em `visao=historico`** (decisão confirmada): o filtro é lido e validado normalmente nesse modo, mas não influencia o resultado — `valor_inadimplente` histórico já vem de uma classificação por data, sem a distinção "vencida"/"confirmada" que só existe no status atual do Asaas. O frontend desabilita visualmente o campo "Tipo de pendência" (`<select>` com `disabled`) quando "Histórico do período" está selecionado, para deixar claro que ele não se aplica nesse modo, em vez de deixá-lo clicável sem efeito.

**`/evolucao-mensal` não faz parte desta unificação** — continua sem aceitar `visao`, e continua usando a classificação histórica por data para `valor_inadimplente`/`taxa_inadimplencia_percentual` incondicionalmente (comportamento anterior ao AJUSTE CRÍTICO 3 para esse endpoint específico, nunca alterado — ver seção "Evolução mensal" abaixo). Só o `/resumo` tinha o problema de estar travado no status atual independente do toggle; o `/evolucao-mensal` nunca teve esse toggle nem esse problema.

> **CORREÇÃO relacionada (mesmo ajuste)**: implementar a unificação acima expôs um bug pré-existente em `faixas`/`criticos_90_dias` no modo `historico` — a faixa `ate_vencimento` aparecia sempre zerada em produção, mesmo havendo cobranças pagas em dia no período. Causa raiz: o filtro que selecionava o conjunto de pagamentos para `historico` excluía tudo que não fosse `INADIMPLENTE`, então cobranças `ADIMPLENTE` (pagas dentro da tolerância) nunca chegavam à função de bucketização — e são justamente elas que deveriam cair em `ate_vencimento` (atraso efetivo `<= 0`). Corrigido trocando o filtro para excluir só `A_VENCER` (em vez de manter só `INADIMPLENTE`), deixando passar tanto `INADIMPLENTE` quanto `ADIMPLENTE` — o mesmo conjunto que agora alimenta `computarValorInadimplenteAdimplenteHistorico` acima. Caso de teste dedicado adicionado em `backend/test-status-ajustes.js` (cobrança `RECEIVED` paga antes do vencimento, deve aparecer em `ate_vencimento` no modo `historico`) — os casos existentes cobriam vários pagamentos com atraso, mas nenhum pagamento em dia nesse modo, o que explica como o bug passou despercebido.

### Período de tolerância (`GET`/`PATCH /api/config/tolerancia-dias`)

Absorve atrasos operacionais irrelevantes (o exemplo clássico: float bancário de fim de semana — uma cobrança vence sexta, o banco só processa e confirma o recebimento na segunda) sem tratá-los como inadimplência real. Configurável em dias corridos, inteiro entre `0` (padrão — nenhuma tolerância, comportamento idêntico ao que existia antes desta configuração) e `30`.

```bash
curl https://api.exemplo.com/api/config/tolerancia-dias -H "Authorization: Bearer <token>"
# {"dias":0}

curl -X PATCH https://api.exemplo.com/api/config/tolerancia-dias \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"dias": 2}'
# {"dias":2}

curl -X PATCH https://api.exemplo.com/api/config/tolerancia-dias \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"dias": 31}'
# 400 — {"error":"\"dias\" deve ser um número inteiro entre 0 e 30."}
```

**Fórmula**: `dataLimiteEfetiva = dueDate + diasTolerancia` (dias corridos). Toda comparação que usa `dueDate` para decidir ADIMPLENTE x INADIMPLENTE na classificação histórica — seja contra `paymentDate` (cobrança já paga) ou contra "hoje" (cobrança ainda não paga) — passa a usar `dataLimiteEfetiva` em vez do vencimento cru. **Desde o AJUSTE CRÍTICO 3, isso vale** para os dias de atraso usados para escolher a faixa em `faixas`/`criticos_90_dias`, nos dois modos de `visao` — e, **desde o AJUSTE 6**, também para `valor_inadimplente`/`valor_adimplente`/as duas taxas no `/resumo` quando `visao=historico` (mesma classificação por data, agregada em 2 números em vez de 7 faixas). Só **não** vale para `valor_inadimplente`/`valor_adimplente`/as duas taxas quando `visao=aberto` (padrão) ou em `/evolucao-mensal`, que são por status atual do Asaas, sem nenhuma comparação de data:

- **Modo `historico`**: os dias de atraso usados para bucketizar passam a ser `paymentDate - dataLimiteEfetiva` (se já paga) ou `hoje - dataLimiteEfetiva` (se não paga) — uma cobrança paga com 2 dias de atraso e tolerância de 2 dias nem entra no conjunto (é ADIMPLENTE, não aparece em nenhuma faixa); uma paga com 25 dias de atraso e tolerância de 2 dias entra na faixa correspondente a 23 dias efetivos, não 25.
- **Modo `aberto`**: mesma lógica, com `hoje - dataLimiteEfetiva` para cobranças ainda não pagas. Uma cobrança cujo `hoje - dueDate` ainda esteja dentro da tolerância (ou seja, `hoje - dataLimiteEfetiva` seria negativo) **não aparece em nenhuma faixa** — mesmo que o Asaas já marque `status: "OVERDUE"` para ela (o Asaas não tem conceito de tolerância; quem decide isso é o Gestor).

**Exemplo numérico** (tolerância 0 x tolerância 2, mesma cobrança): vencimento em `2026-05-10`, paga em `2026-05-12` (2 dias de atraso).

| Tolerância | `dataLimiteEfetiva` | Comparação | Classificação | Aparece em `faixas`? |
|---|---|---|---|---|
| `0` dias | `2026-05-10` (= vencimento) | `2026-05-12 > 2026-05-10` | **INADIMPLENTE** | Sim — faixa `1_20`, com 2 dias de atraso |
| `2` dias | `2026-05-12` | `2026-05-12 <= 2026-05-12` | **ADIMPLENTE** | Não — não é inadimplente, não entra em nenhuma faixa |

Com tolerância `0`, os 2 dias de atraso contam integralmente contra o associado. Com tolerância `2`, o mesmo pagamento — sem nenhuma outra mudança — passa a ser tratado como pago em dia.

**Invalidação de cache**: alterar a tolerância via `PATCH` limpa o cache de `/resumo` e `/evolucao-mensal` (mesmo `cache.clear()` já usado por `/config/palavras-excluidas` e pelas exclusões manuais) — a mudança vale já na próxima consulta, sem esperar o TTL de 4 minutos expirar.

### Regras de cálculo do `/resumo`

Todos os valores em R$, calculados sobre o conjunto de pagamentos com vencimento no período `[venc_de, venc_ate]` (já sem os excluídos — ver seção "Exclusão de cobranças" — e já filtrado por `renegociacao`/`em_juridico`/`bloqueado`, quando ativos):

| Campo | Cálculo |
|---|---|
| `valor_total_faturado` | Soma do `value` de **todos** os pagamentos do período, qualquer status (inclusive os "a vencer"). |
| `valor_inadimplente` | Depende de `visao` (**AJUSTE 6**). Com `visao=aberto` (padrão): **AJUSTE CRÍTICO 3** — soma do `value` dos pagamentos com status `OVERDUE` e/ou `CONFIRMED` no Asaas (qual dos dois depende do filtro `tipo_pendencia` — AJUSTE 4, padrão `todos` = os dois). Com `visao=historico`: soma do `value` dos pagamentos classificados `INADIMPLENTE` pela classificação histórica por data (`classificarPagamento`) — `tipo_pendencia` não tem efeito nesse modo. |
| `taxa_inadimplencia_percentual` | `valor_inadimplente / valor_total_faturado * 100`, arredondado a 2 casas — `0` se não houver faturamento no período. |
| `valor_adimplente` | Depende de `visao` (**AJUSTE 6**). Com `visao=aberto` (padrão): **AJUSTE CRÍTICO 3** — soma do `value` dos pagamentos com status `RECEIVED` ou `RECEIVED_IN_CASH` no Asaas. Com `visao=historico`: soma do `value` dos pagamentos classificados `ADIMPLENTE` pela classificação histórica por data. Nunca afetado por `tipo_pendencia`, em nenhum dos dois modos. Calculado diretamente aqui no backend — **não** derive esse valor no frontend por subtração (`valor_total_faturado - valor_inadimplente`): o resultado fica errado sempre que houver cobranças de outro status/classificação no período (ex.: `PENDING`/`A_VENCER`, ainda não vencida), que não entram em nenhum dos dois somatórios — ver seções "AJUSTE CRÍTICO 3" e "AJUSTE 6" acima. |
| `taxa_adimplencia_percentual` | `valor_adimplente / valor_total_faturado * 100`, arredondado a 2 casas — `0` se não houver faturamento no período. Não é o complementar de `taxa_inadimplencia_percentual` (as duas só somam 100% quando não há nenhuma cobrança de outro status, tipicamente `PENDING`, no período). |
| `associados_inadimplentes` | Contagem de clientes **distintos** (por `cpfCnpj` resolvido, ou pelo ID do Asaas quando não foi possível resolver) com pelo menos um pagamento `status: "OVERDUE"` **hoje** (snapshot operacional, não a classificação histórica — ver decisão de design acima). |
| `renegociacoes_abertas` | **Não** usa mais `associados.em_negociacao`. Conta e soma, entre os pagamentos com `status` ainda em aberto (`PENDING` ou `OVERDUE` — não os já pagos), aqueles cuja `description` (do próprio Asaas) contém a palavra "Renegociação", case-insensitive, como substring. `quantidade` = número de **pagamentos** nessa condição; `valor` = soma desses pagamentos. Ver nota de nomenclatura abaixo. |
| `criticos_90_dias` | Soma do `value` dos pagamentos com 90 dias de atraso ou mais, seguindo o mesmo modo (`aberto`/`historico`) de `faixas` — ver seção "Faixas de atraso: modo aberto x histórico". Métrica independente das faixas — um pagamento pode entrar tanto em `criticos_90_dias` quanto na faixa `51_100` (ex.: 90-99 dias caem na faixa `51_100` **e** em `criticos_90_dias`). |
| `faixas` | Soma do `value` (não contagem), agrupada em **7 faixas** de dias de atraso **efetivos** (já descontada a tolerância — ver "Período de tolerância" acima) não sobrepostas — **AJUSTE 5**: `ate_vencimento` (atraso `<= 0`d — cobranças ainda dentro do vencimento ou da tolerância, antes descartadas sem aparecer em nenhuma faixa), `1_20` (1-20d), `21_30` (21-30d), `31_40` (31-40d), `41_50` (41-50d), `51_100` (51-100d), `acima_100` (**mais de 100d** — sem teto; renomeada de `100_180`, mesmo comportamento sem teto de sempre, só nome corrigido). O **conjunto de pagamentos** e o **cálculo dos dias de atraso** dependem do parâmetro `visao` (renomeado de `visao_faixas` no **AJUSTE 6**) — ver seção própria abaixo, e continuam usando a classificação histórica por data (não o status atual do AJUSTE CRÍTICO 3). |
| `top_devedores` | Os 10 clientes com maior soma de pagamentos `status: "OVERDUE"` **hoje** no período (mesmo snapshot operacional de `associados_inadimplentes`), ordenados decrescente. `nome` vem do nosso cadastro local quando existe associado correspondente; senão, do nome do cliente no Asaas; `cpf_cnpj` vem do cpfCnpj resolvido (ou o ID do cliente no Asaas, como último recurso). |
| `excluidos` | `{ "quantidade": number, "valor": number }` — quantas cobranças e qual valor foram **removidos do cálculo inteiro** (não entram em nenhum dos campos acima) pelos dois mecanismos de exclusão (manual por ID + palavra-chave na descrição). Ver seção "Exclusão de cobranças do cálculo" abaixo. |

> **Nota de nomenclatura**: `renegociacoes_abertas` (campo da resposta, baseado na descrição das cobranças no Asaas) e o filtro de query `renegociacao` (`todos`\|`sim`\|`nao`, baseado em `associados.em_negociacao` na nossa base) são **dois conceitos diferentes** que só coincidem no nome por acaso — um veio de uma decisão de produto anterior (marcar o associado como "em negociação" no nosso cadastro), o outro é a forma nova, mais direta, de contar renegociações formalizadas como cobrança no próprio Asaas. Não confundir: filtrar `renegociacao=sim` **não** restringe o cálculo de `renegociacoes_abertas` a nada especial — os dois convivem de forma independente na mesma resposta.

### Faixas de atraso: modo `aberto` x `historico` (`visao`)

O parâmetro `visao` (`aberto`\|`historico`, padrão `aberto`; renomeado de `visao_faixas` no **AJUSTE 6**, que passou a usar o mesmo parâmetro também para os 3 cards de topo do `/resumo` — ver seção "AJUSTE 6" acima) controla **quais pagamentos entram** em `faixas`/`criticos_90_dias` e **como os dias de atraso são calculados** para bucketá-los:

| Modo | Conjunto de pagamentos | Dias de atraso efetivos |
|---|---|---|
| `aberto` (padrão, comportamento original) | Só os **ainda não pagos hoje** (`status: "OVERDUE"`) com vencimento no período. | `hoje - dataLimiteEfetiva`. |
| `historico` | Os classificados **INADIMPLENTE** pela regra histórica (sem `paymentDate`, ou pago além da tolerância) com vencimento no período — inclui cobranças já pagas (com atraso) que hoje têm `status: "RECEIVED"`/`CONFIRMED`, mas que não estão mais em `aberto`. | Se já foi paga: `paymentDate - dataLimiteEfetiva`. Se ainda não foi paga: `hoje - dataLimiteEfetiva` (mesma regra do modo `aberto`). |

`dataLimiteEfetiva = dueDate + diasTolerancia` (ver seção "Período de tolerância" acima). Em qualquer um dos dois modos, se o resultado de "dias de atraso efetivos" for **negativo** (a cobrança ainda está dentro da janela de tolerância), ela **não aparece em nenhuma faixa nem em `criticos_90_dias`** — mesmo que o Asaas já marque `status: "OVERDUE"` (isso só pode acontecer no modo `aberto`; no `historico` o próprio conjunto de INADIMPLENTES já exclui essas cobranças antes de chegar aqui).

**A diferença na prática**: o modo `aberto` é um **retrato do dia de hoje** — "quanto está em aberto agora, e há quanto tempo" — útil para o time de cobrança decidir quem ligar. O modo `historico` é o **retrato do período filtrado**, fixo: uma cobrança vencida em maio e paga com atraso em julho aparece na faixa correspondente ao atraso efetivo do pagamento (`paymentDate - dataLimiteEfetiva`) mesmo que hoje, em agosto, ela já não apareça mais em nenhuma lista de "em aberto". **Desde o AJUSTE 6**, `valor_inadimplente`/`valor_adimplente`/as duas taxas no `/resumo` **também mudam** entre os dois modos, pela mesma razão — em `aberto` usam o status atual do Asaas (AJUSTE CRÍTICO 3), em `historico` usam a mesma classificação por data que alimenta as faixas (ver seção "AJUSTE 6" acima). Em `/evolucao-mensal`, que não aceita `visao`, `valor_inadimplente`/`taxa_inadimplencia_percentual` continuam fixos na classificação histórica por data, sempre — ver seção "Evolução mensal" abaixo.

### Filtros `renegociacao`, `em_juridico` e `bloqueado`

Cruzam o `cpfCnpj` de cada pagamento do Asaas com `associados.em_negociacao`, `associados.em_juridico` e `associados.bloqueado`, respectivamente, com **exatamente a mesma regra para os três**. Pagamentos de clientes sem `cpfCnpj` resolvido, ou sem associado correspondente na nossa base, contam como **"não"** nos três campos. Quando algum dos três é `sim` ou `nao` (diferente do padrão `todos`), o filtro se aplica a **todo** o conjunto de pagamentos usado no cálculo — inclusive `valor_total_faturado`, não só os que estão em aberto hoje. Os três filtros se combinam com **E** quando ativos ao mesmo tempo (ex.: `renegociacao=sim&em_juridico=nao&bloqueado=sim` retorna só quem está em negociação, **não** está no jurídico e **está** bloqueado). Por isso, com `renegociacao=nao`, `renegociacoes_abertas` continua funcionando normalmente (ver nota de nomenclatura acima — os dois conceitos são independentes, não há mais o efeito colateral que existia antes dessa mudança).

### Exclusão de cobranças do cálculo

Duas formas de excluir cobranças específicas do cálculo de Taxa de Inadimplência (aplicadas **antes** de qualquer outro cálculo — inclusive antes de `renegociacao`/`em_juridico` — e nunca contam em nenhum campo da resposta além de `excluidos`):

1. **Lista manual por `asaas_payment_id`** (tabela `cobrancas_ignoradas`, endpoints `GET`/`POST`/`DELETE /api/inadimplencia/exclusoes`) — para excluir cobranças pontuais (ex.: um lançamento duplicado ou de teste feito direto no Asaas).
2. **Lista de palavras-chave** (tabela `configuracoes`, chave `inadimplencia_palavras_excluidas`, endpoints `GET`/`PATCH /api/config/palavras-excluidas`) — para excluir automaticamente qualquer cobrança que bata, como substring e **case-insensitive**, com alguma das palavras configuradas, em **qualquer um** de 3 campos (**AJUSTE 7**, antes só o primeiro): a **descrição** da cobrança (campo `description` do Asaas), o **CPF/CNPJ do associado** (comparado sem pontuação — `normalizarDocumento` remove tudo que não é dígito de ambos os lados da comparação, então funciona configurar tanto `"12.345.678/0001-90"` quanto `"12345678000190"`), ou o **nome/razão social do associado**. Útil para padronizar exclusões recorrentes (ex.: toda cobrança com "teste" ou "cortesia" na descrição, ou todas as cobranças de um cliente específico pelo CPF/CNPJ ou nome) sem precisar cadastrar cada `asaas_payment_id` manualmente. Continua sendo um único campo de lista, mesma UI, mesmo comportamento de case-insensitive — só o critério de match que passa a checar os 3 campos.

**Uma cobrança é excluída se qualquer um dos dois mecanismos bater (OU, não E).** Uma cobrança pega pelos dois ao mesmo tempo (ex.: está na lista manual **e** a descrição também contém uma palavra configurada) é contada **uma única vez** em `excluidos` — os dois mecanismos filtram o mesmo array de pagamentos numa única passada, não há como um pagamento ser removido duas vezes.

```bash
# Lista manual
curl -X POST https://api.exemplo.com/api/inadimplencia/exclusoes \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"asaas_payment_id": "pay_123456", "motivo": "cobrança de teste feita direto no Asaas"}'
# 201 — {"id":"...","asaas_payment_id":"pay_123456","motivo":"cobrança de teste feita direto no Asaas","criado_em":"..."}

curl https://api.exemplo.com/api/inadimplencia/exclusoes -H "Authorization: Bearer <token>"

curl -X DELETE https://api.exemplo.com/api/inadimplencia/exclusoes/<id> -H "Authorization: Bearer <token>"
# 204

# Palavras-chave
curl -X PATCH https://api.exemplo.com/api/config/palavras-excluidas \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"palavras": ["teste", "cortesia", "não contabilizar"]}'

curl https://api.exemplo.com/api/config/palavras-excluidas -H "Authorization: Bearer <token>"
# {"palavras": ["teste", "cortesia", "não contabilizar"]}
```

Alterar qualquer uma das duas listas (criar/remover exclusão manual, ou substituir as palavras-chave) **limpa o cache** de `/api/inadimplencia/resumo` e `/evolucao-mensal` inteiro — a mudança vale já na próxima consulta, sem esperar os 4 minutos de TTL expirarem.

### Evolução mensal (`GET /api/inadimplencia/evolucao-mensal`)

Mesma base de cálculo do `/resumo` — mesma exclusão combinada e os mesmos filtros `renegociacao`/`em_juridico`/`bloqueado` — mas devolvida **por mês**, para alimentar um gráfico de evolução. Aceita os mesmos query params de filtro (`venc_de`, `venc_ate`, `renegociacao`, `em_juridico`, `bloqueado`), com o mesmo padrão de período (últimos 12 meses quando `venc_de`/`venc_ate` não são informados). Não aceita `visao` (esse endpoint não devolve `faixas`/`criticos_90_dias`) — ver seção "AJUSTE 6" acima para o motivo desse endpoint ficar de fora da unificação.

`valor_inadimplente` e `taxa_inadimplencia_percentual` usam a **classificação histórica por data de pagamento** (ver seção "Classificação histórica de inadimplência" acima) — o mês de vencimento de uma cobrança paga com atraso continua mostrando ela como inadimplente, mesmo que o `status` atual já seja `RECEIVED`.

Todo mês dentro do intervalo pedido aparece no array de resposta, **mesmo sem nenhuma cobrança naquele mês** (todos os campos zerados).

**Importante — `taxa_adimplencia_percentual` NÃO é mais `100 - taxa_inadimplencia_percentual`.** Cada taxa tem seu próprio numerador (`valorInadimplente`/`valorAdimplente`), calculado independentemente sobre `valor_total_faturado`:

```
taxa_inadimplencia_percentual = valor_inadimplente / valor_total_faturado * 100
taxa_adimplencia_percentual   = valor_adimplente   / valor_total_faturado * 100
```

Isso é proposital, não um bug: cobranças com status que não é nem `OVERDUE`/`CONFIRMED` nem `RECEIVED`/`RECEIVED_IN_CASH` — o caso mais comum é `PENDING` (vencimento futuro, ainda não paga) — entram em `valor_total_faturado` mas **não contam em nenhum dos dois numeradores** (ver AJUSTE CRÍTICO 3 acima). Um mês com bastante cobrança futura em aberto vai legitimamente ter `taxa_inadimplencia_percentual + taxa_adimplencia_percentual < 100` — a diferença é exatamente a fatia nesse "terceiro grupo" daquele mês.

```bash
curl "https://api.exemplo.com/api/inadimplencia/evolucao-mensal?venc_de=2026-01-01&venc_ate=2026-06-30" \
  -H "Authorization: Bearer <token>"
# [
#   { "mes": "2026-01", "valor_total_faturado": 18500.00, "valor_inadimplente": 2200.00, "taxa_inadimplencia_percentual": 11.89, "taxa_adimplencia_percentual": 88.11 },
#   { "mes": "2026-02", "valor_total_faturado": 19200.00, "valor_inadimplente": 1900.00, "taxa_inadimplencia_percentual": 9.90, "taxa_adimplencia_percentual": 90.10 },
#   ...
# ]
```

**Cache** (`src/services/cache.service.js`) — assim como o `/resumo`, o resultado completo é cacheado em memória por **4 minutos**, num namespace de cache separado, com a chave sendo a combinação exata `(venc_de, venc_ate, renegociacao, em_juridico, bloqueado, tipo_pendencia)`.

**Cache do `/resumo`** — mesma lógica, mesma janela de 4 minutos, mesma chave `(venc_de, venc_ate, renegociacao, em_juridico, bloqueado, tipo_pendencia, visao)` (AJUSTE 4: `tipo_pendencia` entrou na chave; AJUSTE 6: `visao_faixas` da chave renomeado para `visao`, mesmo campo). Chamadas repetidas com os mesmos filtros dentro da janela não fazem nenhuma requisição nova ao Asaas. É um cache só do processo (não distribuído, não sobrevive a restart) — adequado para uma tela consultada por poucos usuários do painel; se a API rodar em múltiplas instâncias atrás de um load balancer, cada instância mantém seu próprio cache.

**Atualização forçada (`forcar=true`)** — tanto `/resumo` quanto `/evolucao-mensal` aceitam `?forcar=true` (qualquer outro valor, incluindo ausente, é tratado como `false`). Com `forcar=true`, a chamada **ignora a leitura do cache** — sempre consulta a API do Asaas de novo, mesmo que já exista uma entrada válida (dentro do TTL) para aquela combinação exata de filtros — mas o resultado novo **ainda é gravado no cache** ao final, com o TTL normal de 4 minutos. Ou seja: `forcar=true` força só *aquela* chamada a buscar dados frescos; não desliga o cache para as chamadas seguintes (sem `forcar=`), que voltam a se beneficiar do resultado recém-gravado normalmente. Pensado para um botão de "Atualizar agora" na tela — sem precisar esperar o TTL expirar nem invalidar o cache pra todo mundo.

```bash
# Padrão: últimos 12 meses, sem filtros de status
curl https://api.exemplo.com/api/inadimplencia/resumo -H "Authorization: Bearer <token>"

# Período customizado, só quem está em negociação
curl "https://api.exemplo.com/api/inadimplencia/resumo?venc_de=2026-01-01&venc_ate=2026-06-30&renegociacao=sim" \
  -H "Authorization: Bearer <token>"

# Filtro combinado: em negociação E no jurídico ao mesmo tempo
curl "https://api.exemplo.com/api/inadimplencia/resumo?renegociacao=sim&em_juridico=sim" \
  -H "Authorization: Bearer <token>"

# Ignora o cache desta chamada (mas ainda grava o resultado novo pras próximas)
curl "https://api.exemplo.com/api/inadimplencia/resumo?forcar=true" -H "Authorization: Bearer <token>"

# Resposta (exemplo)
# {
#   "valor_total_faturado": 182300.00,
#   "valor_inadimplente": 24150.50,
#   "taxa_inadimplencia_percentual": 13.25,
#   "valor_adimplente": 150200.00,
#   "taxa_adimplencia_percentual": 82.39,
#   "associados_inadimplentes": 18,
#   "renegociacoes_abertas": { "quantidade": 6, "valor": 7800.00 },
#   "criticos_90_dias": 5200.00,
#   "faixas": { "ate_vencimento": 1800.00, "1_20": 9000.00, "21_30": 4500.00, "31_40": 3200.00, "41_50": 2100.00, "51_100": 3150.50, "acima_100": 2200.00 },
#   "top_devedores": [ { "nome": "Empresa X", "cpf_cnpj": "12.345.678/0001-90", "valor": 4800.00 }, ... ],
#   "excluidos": { "quantidade": 2, "valor": 950.00 }
# }
# (note que 24150.50 + 150200.00 = 174350.50 < 182300.00 nesse exemplo — a
# diferença, 7949.50, é o valor de cobranças com outro status — tipicamente
# "PENDING", ainda não vencidas — que não entram em nenhum dos dois
# numeradores desde o AJUSTE CRÍTICO 3, ver seção acima.)
```

### Como testar a tela de Inadimplência com dados fictícios

A tela "Taxa de Inadimplência" do painel depende de uma chave de API real do Asaas para funcionar. Para testar a tela manualmente no navegador **sem precisar de uma conta/chave real do Asaas**, este repositório traz um mock standalone da API do Asaas em `scripts/mock-asaas-server.js`.

> **Nota (AJUSTE CRÍTICO 3 / AJUSTE 5 / AJUSTE 6 / AJUSTE 7)**: o dataset fixo de `scripts/mock-asaas-server.js` e os logs de validação abaixo (rodadas anteriores a estes ajustes) usam as chaves antigas das faixas (`0_20`...`100_180`), descrevem `valor_inadimplente`/`valor_adimplente` pela classificação histórica por data em todos os casos (não só em `visao=historico`), usam o nome antigo `visao_faixas`, e não cobrem a exclusão por CPF/CNPJ/nome — várias coisas mudaram (ver seções "AJUSTE CRÍTICO 3", "AJUSTE 5", "AJUSTE 6" e a seção de exclusão acima). Os números específicos desses logs ficam como registro histórico do que foi validado em cada rodada; para o comportamento **atual**, veja `backend/test-status-ajustes.js` (suíte dedicada a estes ajustes, 74/74 validado com Postgres real).

**1. Rode o mock** (num terminal separado, deixe rodando):

```bash
npm run mock:asaas
# ou: node scripts/mock-asaas-server.js
```

Ele sobe um servidor HTTP na porta `4001` simulando `GET /v3/payments` (com paginação offset/limit igual à API real) e `GET /v3/customers/:id`, pré-populado com **29 pagamentos fictícios**:

- 13 ainda em atraso hoje (`status: "OVERDUE"`, sem `paymentDate`), cobrindo **as 6 faixas** da tela (0-20, 20-30, 30-40, 40-50, 50-100 e 100-180 dias — incluindo um caso com mais de 180 dias de atraso, para confirmar que a tela não "esconde" dívidas muito antigas).
- 3 "a vencer" (`status: "PENDING"`, `dueDate` futuro, sem `paymentDate`) — para testar a exceção A_VENCER da classificação histórica.
- 3 pagas **em dia** (`paymentDate <= dueDate`, `status: "RECEIVED"`/`CONFIRMED"`) — devem contar como ADIMPLENTE.
- 2 pagas **com atraso** mas com `status` atual já `RECEIVED` (`paymentDate > dueDate`) — devem continuar contando como INADIMPLENTE mesmo com status "pago". Uma delas (`pay_mock_021`) simula especificamente o cenário "vence num mês, só é paga ~2 meses depois", o caso central que motivou a mudança de classificação por data de pagamento.
- 3 com a palavra **"Renegociação"** na descrição: 2 ainda em aberto (`pay_mock_022` `OVERDUE`, `pay_mock_023` `PENDING`) — devem contar em `renegociacoes_abertas` — e 1 já paga (`pay_mock_024`, `RECEIVED`) — **não** deve contar, para testar que o filtro de status (`PENDING`/`OVERDUE` apenas) funciona.
- 5 casos de **período de tolerância** (`GET`/`PATCH /api/config/tolerancia-dias`): `pay_mock_028` (1 dia em atraso, ainda não paga), `pay_mock_025` (21 dias em atraso, ainda não paga — cruza de faixa `20_30` para `0_20` com tolerância 2), `pay_mock_026` (paga com 1 dia de atraso), `pay_mock_027` (paga com exatamente 2 dias de atraso) e `pay_mock_029` (91 dias em atraso, ainda não paga — sai de `criticos_90_dias` com tolerância 2, sem trocar de faixa) — todos desenhados para migrar de classificação (ou de faixa, ou de `criticos_90_dias`) só quando a tolerância configurada é grande o suficiente para absorver o atraso.

As datas de vencimento/pagamento são calculadas em relação ao dia em que você rodar o script, então o dataset sempre cai nas faixas/classificações certas, não importa quando você testar.

Ele também tenta (best-effort, usando a `DATABASE_URL` do seu `.env`) criar/atualizar 4 associados fictícios na sua tabela local `associados` — cobrindo combinações de `em_negociacao`/`em_juridico`/`bloqueado` — com os mesmos CPF/CNPJ de 4 dos clientes fictícios do mock, para os filtros **"Renegociação"**, **"Jurídico"** e **"Bloqueado"** da tela também terem o que mostrar. Se o Postgres não estiver acessível nesse momento, o script avisa no console e continua rodando normalmente (só esse cruzamento com a base local fica de fora).

Duas das cobranças fictícias (`pay_mock_003` e `pay_mock_008`) já vêm com a frase **"não contabilizar"** na descrição (em caixas diferentes), prontas para testar a exclusão automática por palavra-chave — basta configurar essa palavra em `PATCH /api/config/palavras-excluidas`. `pay_mock_005` e `pay_mock_008` também servem para testar a exclusão manual por ID via `POST /api/inadimplencia/exclusoes` (`pay_mock_008` cai nos dois mecanismos ao mesmo tempo, útil para confirmar que a exclusão combinada não conta ele em dobro em `excluidos`).

Ao subir, o script imprime exatamente o que fazer nos dois próximos passos.

**2. Aponte o backend para o mock.** Adicione ao `.env` do backend:

```
ASAAS_API_BASE_URL=http://localhost:4001/v3
```

E **reinicie o backend** (`npm run dev` ou `npm start`) para a variável de ambiente ser lida — ela só é aplicada na inicialização do processo (ver `src/services/asaas.service.js`).

**3. Configure a chave fictícia no painel.** Abra a tela de Configurações do Gestor e cole no campo "Chave de API do Asaas":

```
asaas-mock-chave-de-teste-123456
```

(essa é a única chave que o mock aceita — qualquer outro valor recebe `401`, igual seria com uma chave real errada). Depois de salvar, abra a tela "Taxa de Inadimplência" — os cards, o gráfico de faixas e o top de devedores devem vir populados com os dados fictícios acima.

Quando terminar de testar, `Ctrl+C` no terminal do mock encerra o servidor. Não esqueça de trocar `ASAAS_API_BASE_URL`/a chave de volta pelos valores reais antes de ir para produção (ou simplesmente remover a variável do `.env` — sem ela, o serviço volta a usar a URL real do Asaas por padrão).

### Exemplo — paginação, filtros e busca combinados em `GET /api/associados`

```bash
# Página 1 (padrão: page=1, limit=100), sem filtro
curl https://api.exemplo.com/api/associados -H "Authorization: Bearer <token>"

# Página 2, 50 por página
curl "https://api.exemplo.com/api/associados?page=2&limit=50" -H "Authorization: Bearer <token>"

# limit acima de 100 é reduzido para 100 (não dá erro)
curl "https://api.exemplo.com/api/associados?limit=500" -H "Authorization: Bearer <token>"

# Só quem está em negociação
curl "https://api.exemplo.com/api/associados?em_negociacao=true" -H "Authorization: Bearer <token>"

# Só quem está bloqueado
curl "https://api.exemplo.com/api/associados?bloqueado=true" -H "Authorization: Bearer <token>"

# Busca unificada por nome, CPF/CNPJ ou telefone (contains, case-insensitive)
curl "https://api.exemplo.com/api/associados?busca=11999999999" -H "Authorization: Bearer <token>"
curl "https://api.exemplo.com/api/associados?busca=fulano" -H "Authorization: Bearer <token>"

# Filtros combinados (AND): quem NÃO está em negociação E NÃO está no jurídico —
# a lista segura para régua de cobrança automática (evita mandar mensagem de
# cobrança pra quem já negociou ou já foi parar no jurídico)
curl "https://api.exemplo.com/api/associados?em_negociacao=false&em_juridico=false" \
  -H "Authorization: Bearer <token>"

# Filtro + busca + paginação, tudo junto
curl "https://api.exemplo.com/api/associados?bloqueado=false&busca=Silva&page=1&limit=20" \
  -H "Authorization: Bearer <token>"
```

`em_negociacao`, `em_juridico`, `bloqueado` e `busca` podem ser usados sozinhos ou combinados — quando mais de um é informado, o filtro é a interseção (AND) de todos, nunca OR. Qualquer valor inválido em `em_negociacao`/`em_juridico`/`bloqueado` (diferente de `true`/`false`) é ignorado, como se aquele filtro não tivesse sido informado. Sempre que pelo menos um filtro ou `busca` está ativo, a resposta traz cada associado só com as cobranças em aberto (`pending`/`overdue`); sem nenhum filtro/busca, vem com todas as cobranças, de qualquer status — mas ainda paginado (ver breaking change acima).

`page` e `limit` inválidos ou ausentes caem no padrão (`page=1`, `limit=100`); `limit` maior que 100 é reduzido para 100 silenciosamente, nunca gera erro 400.

### Ordenação por criticidade — calculada no banco, antes da paginação

`GET /api/associados` ordena os resultados pelo `dias_diferenca` mais negativo entre as cobranças em aberto (`pending`/`overdue`) de cada associado — quanto mais negativo, mais atrasado, mais crítico. Associados sem nenhuma cobrança em aberto vão sempre por último; empates são desempatados por nome (A-Z).

O ponto importante: essa ordenação é calculada **dentro da consulta SQL, antes de aplicar `LIMIT`/`OFFSET`** — não é "ordena a página depois de já ter paginado". Isso garante que o associado mais crítico **do sistema inteiro** sempre apareça na primeira posição da página 1, não importa quantas páginas existam. Internamente, a consulta:

1. Calcula `MIN(dias_diferenca)` entre as cobranças em aberto de cada associado (subquery correlacionada) já dentro do `WHERE`/`ORDER BY`.
2. Aplica `ORDER BY <esse valor> ASC NULLS LAST, nome ASC` e só então `LIMIT`/`OFFSET`, trazendo só os IDs da página pedida.
3. Busca os registros completos (com cobranças) desses IDs e reordena em memória seguindo a mesma ordem — necessário porque `WHERE id IN (...)` não garante preservar a ordem da lista de IDs.

### Exemplo — `GET /api/associados/resumo`

```bash
curl https://api.exemplo.com/api/associados/resumo -H "Authorization: Bearer <token>"
# {"com_cobranca_aberto":133,"valor_total_aberto":13236.50,"em_negociacao":5,"bloqueados":4,"em_juridico":3}

curl -G https://api.exemplo.com/api/associados/resumo --data-urlencode "busca=fulano" \
  -H "Authorization: Bearer <token>"
# {"com_cobranca_aberto":1,"valor_total_aberto":150.50,"em_negociacao":0,"bloqueados":0,"em_juridico":0}
```

Pensado pros cards de resumo do painel: como o `GET /api/associados` normal agora é paginado, não dá mais pra montar esses números somando só a página carregada — esse endpoint resolve isso calculando tudo agregado no Postgres (`COUNT`/`SUM` com `FILTER`), sem trazer nenhum associado individual pra aplicação. Só aceita `busca` (não os filtros `em_negociacao`/`em_juridico`/`bloqueado`) e não tem paginação, já que a resposta é sempre um objeto só de números.

### Exemplo — `POST /api/sync`

```json
[
  {
    "cpf_cnpj": "123.456.789-00",
    "nome": "Fulano de Tal",
    "telefone": "11999999999",
    "email": "fulano@email.com",
    "cobrancas": [
      {
        "id_externo": "pay_xxxxxxxxxxxxx",
        "valor": 150.50,
        "vencimento": "2026-08-10",
        "dias_diferenca": -2,
        "link_pagamento": "https://pay.exemplo.com/1",
        "descricao": "Mensalidade agosto/2026",
        "status": "overdue"
      }
    ]
  }
]
```

`cobrancas[].id_externo` é **opcional** — string com o ID único que o Asaas gera para a cobrança (ex.: `"pay_xxxxxxxxxxxxx"`). Quando enviado, é o campo usado para casar a cobrança no upsert (ver nota abaixo). Integrações que ainda não enviam esse campo continuam funcionando normalmente.

**Forma alternativa do corpo (recomendada — habilita a reconciliação global, ver abaixo):** em vez do array na raiz, um objeto com `associados` (mesmo formato de sempre) e `janela`:

```json
{
  "janela": { "inicio": "2026-07-03", "fim": "2026-08-30" },
  "associados": [ /* mesmo formato do array acima */ ]
}
```

`janela.inicio`/`janela.fim` descrevem o intervalo de vencimento usado pela consulta ao Asaas que gerou este payload (datas `YYYY-MM-DD`). Ver a seção de reconciliação abaixo para o efeito disso.

Resposta:

```json
{
  "associados_criados": 1,
  "associados_atualizados": 0,
  "cobrancas_criadas": 1,
  "cobrancas_atualizadas": 0,
  "cobrancas_quitadas": 0,
  "reconciliacao": "global",
  "erros": []
}
```

`reconciliacao` diz qual modo rodou nesta chamada: `"global"` (corpo trouxe uma `janela` válida) ou `"por_associado"` (sem `janela`, ou `janela` malformada — cai no modo antigo sem quebrar a chamada).

> **Nota sobre o upsert de cobranças:** o casamento de cada cobrança no upsert segue esta ordem de prioridade:
> 1. **`id_externo`**, quando presente no payload — é o identificador mais confiável (ex.: o ID da cobrança gerado pelo Asaas), então tem prioridade máxima e é único/indexado na tabela `cobrancas`.
> 2. **Fallback** (compatibilidade retroativa), quando `id_externo` não vem no payload — casamento pela combinação `(associado_id, vencimento, descricao)`, como antes. Esse fallback só considera cobranças que também não têm `id_externo` gravado, para não sobrescrever por engano um registro já vinculado a um ID do Asaas.

> **Reconciliação (quitação automática — corrige o bug de cobranças "presas"):** o payload do n8n traz, para cada associado, a lista das cobranças **atualmente** pending/overdue no Asaas. Antes, quando uma cobrança era paga, o Asaas simplesmente parava de devolvê-la nas próximas consultas — e como `POST /api/sync` só fazia upsert (nunca removia nada), essa cobrança ficava presa no banco para sempre no último status sincronizado, contando indevidamente como "em aberto" no Dashboard. Não é hard delete em nenhum dos dois modos abaixo — o registro continua no banco (histórico financeiro preservado), só sai do conjunto "em aberto". `"quitada"` nunca é um valor aceito vindo de payload externo (só `pending`/`overdue`/`paid`, ver `STATUS_VALIDOS`) — é um status que só o próprio backend grava, durante a reconciliação. Se uma cobrança marcada `"quitada"` **voltar** a aparecer num sync seguinte (ex.: reversão de pagamento no Asaas), a quitação é desfeita automaticamente (`quitada_em` volta a `null`) — o upsert normal já cuida disso, nos dois modos.
>
> **Modo global (`"janela"` no corpo — recomendado):** ao final do processamento de todos os associados do payload, roda **uma reconciliação só, pra base inteira**: toda cobrança `pending`/`overdue` no banco cujo `vencimento` caia dentro de `janela.inicio`–`janela.fim` e que **não foi tocada por nenhum associado deste payload** é marcada `"quitada"` — mesmo que o associado dela não tenha aparecido em `"associados"` de jeito nenhum. Isso cobre a lacuna do modo por-associado (abaixo): quando **todas** as cobranças de um associado são pagas, o agrupamento do n8n para de gerar uma entrada pra ele — o associado inteiro some do payload, não só a cobrança paga. Cobranças com vencimento **fora** da janela nunca são tocadas, mesmo que o associado delas também tenha sumido do payload — o Asaas nem foi consultado sobre esse intervalo nesta chamada, então não há informação nova pra agir sobre elas.
>
> **Modo por-associado (sem `"janela"` — compatibilidade):** para cada associado cujo registro traga `"cobrancas"` como array (mesmo vazio), toda cobrança já existente no banco **para esse associado** com status pending/overdue que não foi criada/atualizada por esta chamada é marcada `"quitada"`. Associados cujo registro não trouxer `"cobrancas"` como array (chave ausente, ou não é array) não sofrem reconciliação nenhuma nesse modo — preserva o comportamento de syncs "só cadastrais". **Limitação que motivou o modo global**: se um associado inteiro sumir do payload (todas as cobranças dele pagas), o loop nunca chega a examiná-lo, então as cobranças presas dele nunca são reconciliadas neste modo — é exatamente o que acontecia antes de existir `"janela"`.
>
> `GET /api/associados`, `GET /api/associados/resumo` e a seção "Cobranças em aberto" do frontend já **excluíam** qualquer status fora de `pending`/`overdue` (ver `COBRANCAS_ABERTAS` em `associados.controller.js` e `STATUS_ABERTOS` no frontend) — então cobranças `"quitada"` somem do Dashboard automaticamente, sem precisar de nenhuma mudança nesses endpoints. `GET /api/associados/:cpf_cnpj` (detalhe do associado) continua trazendo **todas** as cobranças, de qualquer status, incluindo as quitadas — é onde o histórico financeiro completo fica visível.

### Aba "Todos" do Dashboard só mostra quem tem cobrança em aberto

Efeito colateral do fix de reconciliação acima: um associado que fica sem **nenhuma** cobrança `pending`/`overdue` (quitou tudo) continuava aparecendo na aba "Todos" da tabela do Dashboard, com "R$ 0,00"/"Em dia" — inconsistente com o card de resumo (`com_cobranca_aberto`), que já não contava esse associado.

Corrigido em `GET /api/associados`: quando **nenhum** dos três toggles de status (`em_negociacao`, `em_juridico`, `bloqueado`) é informado na query — é o caso da aba "Todos", com ou sem `busca` — só entram associados com pelo menos uma cobrança `pending`/`overdue` (`EXISTS` contra `cobrancas`, mesma condição usada pelo card de resumo). Assim que **qualquer** um dos três toggles é informado (`true` OU `false`), essa exigência desaparece — as abas "Em Negociação"/"Bloqueados"/"Jurídico" continuam mostrando todo mundo marcado com o respectivo toggle, tenha ou não cobrança em aberto (ex.: associado em negociação que já quitou tudo, mas ainda está em acompanhamento). `GET /api/associados/resumo` não foi tocado — já contava certo antes e depois.

Validado com Postgres real: associado sem nenhuma cobrança aberta e nenhum toggle marcado não aparece na aba "Todos" (nem buscando por ele diretamente); ao marcar `em_negociacao: true` nele, volta a aparecer em `?em_negociacao=true`, mas continua fora da aba "Todos". Testado também para `bloqueado` e `em_juridico` (associados quitados marcados com cada um desses toggles continuam aparecendo na aba correspondente). Um associado com cobrança ainda aberta continua normal na aba "Todos" (não é uma regressão que esconde todo mundo). Contagem de paginação (`total_registros`) da aba "Todos" bate com `com_cobranca_aberto` do resumo. **16/16 asserções passaram.**

⚠️ Essa mudança também tornou obsoleta uma asserção de rodadas anteriores (nos testes de reconciliação): um associado totalmente quitado, buscado sem nenhum toggle ativo, agora retorna `dados: []` em vez de aparecer na lista com `cobrancas: []` — os testes de reconciliação foram atualizados de acordo (mesmo comportamento novo, sem regressão real).

### Corrigindo cobranças já presas antes deste fix (`scripts/reconciliar-cobrancas-presas.js`)

Se você já tinha o bug de cobranças "presas" descrito acima **antes** desta versão, a correção em `POST /api/sync` sozinha não conserta os registros que já ficaram travados no passado — ela só evita que aconteça de novo dali em diante.

**Você não precisa rodar nada manualmente na maioria dos casos**: a próxima execução normal de `POST /api/sync` (agendamento do n8n, ou clicando em "Atualizar" no Dashboard) já reconcilia automaticamente qualquer cobrança presa — **desde que o n8n já esteja enviando `"janela"`** (ver seção acima). Sem `"janela"`, o sync continua rodando no modo por-associado, que **não** reconcilia associados que sumiram inteiros do payload (ex.: todas as cobranças dele foram pagas) — esse era exatamente o caso da Deni e de outros ~17 associados relatados.

Este script (`reconciliar-cobrancas-presas.js`), por outro lado, **nunca dependeu do payload de nenhum sync** — ele varre a tabela `cobrancas` direto, comparando `sincronizado_em`, então já cobre esse caso mesmo antes do n8n mandar `"janela"`.

Se preferir corrigir imediatamente, sem esperar/disparar um sync completo, existe `scripts/reconciliar-cobrancas-presas.js`: varre `cobrancas` procurando pending/overdue com `sincronizado_em` visivelmente mais antigo que o resto da base (mesmo sintoma do bug: alguns associados travados numa data antiga enquanto o resto já está atualizado) e marca como `"quitada"`.

```bash
# dentro do container/ambiente com DATABASE_URL certo:
node scripts/reconciliar-cobrancas-presas.js                    # dry run — só lista, não muda nada
node scripts/reconciliar-cobrancas-presas.js --confirm          # aplica de verdade
node scripts/reconciliar-cobrancas-presas.js --cutoff=2026-08-21 --confirm   # cutoff manual
```

Roda em modo **dry run por padrão** (lista os candidatos, não altera o banco — confira a lista contra o que você já validou manualmente no Asaas antes de confirmar). Sem `--cutoff` explícito, calcula automaticamente a data do `sincronizado_em` mais recente da base inteira e trata qualquer cobrança sincronizada num dia anterior como candidata. Tem um guardrail de segurança: recusa aplicar (`--confirm`) se o número de candidatos passar muito do esperado (> 60), a não ser que você passe `--force` também — evita quitar em massa por engano se o cutoff calculado pegar mais coisa do que devia. Não é hard delete, mesmo comportamento do fix em `POST /api/sync`.

Validado com Postgres real simulando o cenário do relato original: 17 associados só com cobrança presa, 3 associados "saudáveis" com cobrança recente, e um caso "Fernanda" (associado com uma cobrança recente **e** uma presa ao mesmo tempo) — confirmando que o script quita só a presa da Fernanda sem tocar na recente. Também testado: guardrail de segurança recusando aplicar com candidatos em excesso sem `--force`, e idempotência (rodar de novo depois não encontra mais nada) — **14/14 asserções passaram**.

### Sincronização sob demanda (`POST /api/sync/atualizar`)

Endpoint sem corpo de requisição, usado pelo botão **"Atualizar"** do Dashboard no frontend, para permitir buscar dados novos do Asaas sem esperar a próxima execução agendada de `POST /api/sync`. Não substitui o `POST /api/sync` — só o **dispara indiretamente**, chamando um webhook do n8n (`N8N_SYNC_WEBHOOK_URL`, variável de ambiente) que:

1. Busca os dados atualizados na API do Asaas (paginando, o que pode levar alguns segundos).
2. Agrupa os dados por associado.
3. Chama `POST /api/sync` internamente, com o payload já pronto.

Ou seja: quando `POST /api/sync/atualizar` retorna com sucesso, o banco **já está atualizado** — o frontend só precisa re-buscar (`GET /api/associados`/`GET /api/associados/resumo`) depois, sem se preocupar em orquestrar o sync em si.

```bash
curl -X POST https://api.exemplo.com/api/sync/atualizar \
  -H "Authorization: Bearer <token>"
# {"status":"ok","synced_at":"2026-08-19T12:00:00.000Z","total_associados":42}
```

- **`N8N_SYNC_WEBHOOK_URL`** (variável de ambiente, ver `.env.example`) — URL do webhook do n8n. Fica só em variável de ambiente (não é um valor configurável em runtime como `n8n_webhook_cadastro_url`) porque tende a mudar entre ambientes (dev/staging/produção) e não precisa de UI própria. Se não estiver definida, o endpoint responde `502` explicando isso, sem tentar nenhuma chamada.
- **Timeout de 30s** (`SYNC_WEBHOOK_TIMEOUT_MS`, também variável de ambiente — só existe pra permitir reduzir em testes automatizados sem esperar 30s de verdade; em produção deixe sem definir, o padrão já é 30000). Generoso de propósito: o webhook pagina no Asaas antes de responder, então pode legitimamente demorar bem mais que uma chamada comum da nossa API.
- **Qualquer falha vira `502`** (nunca `500` genérico) — URL não configurada, timeout, erro de rede, ou o próprio webhook respondendo com status HTTP de erro (nesse último caso, o corpo da resposta do webhook vem em `detalhe`, truncado a 500 caracteres). A mensagem em `error` sempre deixa claro que o problema foi no webhook/Asaas, não na nossa API.
- **Resposta de sucesso** repassa o corpo do webhook (que devolve `{ status, syncedAt, totalAssociados }`) convertido pra `snake_case` (`{ status, synced_at, total_associados }`), consistente com o resto da API. Se o webhook responder `200` mas com um corpo que não é JSON válido, o endpoint **não trata isso como erro** — degrada graciosamente, devolvendo `status: "ok"` e os outros dois campos como `null` (afinal o `200` já indica que o n8n processou a chamada; só não conseguimos extrair os detalhes do corpo).
- Este endpoint **não grava nada em `sync_log`** diretamente — quem grava é o próprio `POST /api/sync` acionado pelo webhook (do jeito que sempre gravou), então uma sincronização feita pelo botão "Atualizar" aparece no log de sincronizações normalmente, sem duplicar contagem.

### Exemplo — bloqueio e contador

```bash
curl -X PATCH https://api.exemplo.com/api/associados/123.456.789-00/bloqueio \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"bloqueado": true}'

curl https://api.exemplo.com/api/associados/123.456.789-00/bloqueios/contador \
  -H "Authorization: Bearer <token>"
# {"cpf_cnpj":"123.456.789-00","contador":1,"ciclo_resetado_em":null}

curl -X POST https://api.exemplo.com/api/associados/123.456.789-00/bloqueios/resetar \
  -H "Authorization: Bearer <token>"
# {"cpf_cnpj":"123.456.789-00","ciclo_resetado_em":"2026-08-13T15:00:00.000Z"}
```

Depois do reset, o contador volta a zero e só passa a contar bloqueios (`status_novo = true`, `campo = "bloqueado"`) registrados **após** `ciclo_resetado_em`. Os registros antigos continuam em `historico_status_associado` — nada é apagado, só o ponto de corte do contador muda.

### Histórico unificado de status (`historico_status_associado`)

`GET /api/associados/:cpf_cnpj` traz um único array `historico` reunindo **todas** as mudanças de `em_negociacao`, `bloqueado` e `em_juridico` do associado, ordenado do mais recente para o mais antigo — cada item identifica qual campo mudou:

```json
{
  "historico": [
    { "id": "...", "associado_id": "...", "campo": "em_juridico", "status_anterior": false, "status_novo": true, "alterado_em": "2026-08-19T18:40:00.000Z" },
    { "id": "...", "associado_id": "...", "campo": "bloqueado", "status_anterior": false, "status_novo": true, "alterado_em": "2026-08-19T18:35:00.000Z" },
    { "id": "...", "associado_id": "...", "campo": "em_negociacao", "status_anterior": false, "status_novo": true, "alterado_em": "2026-08-10T09:00:00.000Z" }
  ]
}
```

Antes desta versão, o histórico vinha em dois campos separados (`historico_negociacao` e `historico_bloqueio`) e `em_juridico` não tinha histórico nenhum — `PATCH .../juridico` só atualizava o campo, sem deixar rastro de quando/quem mudou. A migração `20260819160000_consolidar_historico_status` resolve os dois problemas de uma vez: cria `historico_status_associado` (coluna `campo` discrimina o tipo de mudança), **migra os dados existentes** das duas tabelas antigas para a nova (com o `campo` certo em cada linha, preservando `id`/`status_anterior`/`status_novo`/`alterado_em` originais) e só então derruba `historico_negociacao`/`historico_bloqueio`. `PATCH .../juridico` passou a gravar uma linha nessa tabela a partir de agora — mudanças de `em_juridico` anteriores a este deploy não têm registro histórico (não havia como reconstituir o que nunca foi salvo).

### Exemplo — múltiplas API keys

```bash
curl https://api.exemplo.com/api/config/api-keys -H "Authorization: Bearer <token>"
# [
#   {"id":"...","nome":"n8n - Sync Cobrança","chave_mascarada":"••••••••••••••••••••••••••••••••••••••••••••••••••••••••b1c4d3","criada_em":"...","ultimo_uso_em":"...","ativa":true},
#   {"id":"...","nome":"n8n - Cadastro/Faturamento","chave_mascarada":"••••••••••••••••••••••••••••••••••••••••••••••••••••••••7a91fe","criada_em":"...","ultimo_uso_em":null,"ativa":true}
# ]

curl -X POST https://api.exemplo.com/api/config/api-keys \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"nome":"n8n - Cadastro/Faturamento"}'
# {"id":"...","nome":"n8n - Cadastro/Faturamento","chave":"<chave completa, 64 caracteres hex>","criada_em":"...","aviso":"Guarde esta chave agora..."}

curl -X POST https://api.exemplo.com/api/config/api-keys/<id>/revogar -H "Authorization: Bearer <token>"
# {"id":"...","nome":"n8n - Cadastro/Faturamento","ativa":false}
```

Revogar uma chave só afeta ela — as demais chaves ativas (e o JWT do painel) continuam funcionando normalmente.

### Exemplo — log de sincronizações

```bash
curl https://api.exemplo.com/api/config/sync-log -H "Authorization: Bearer <token>"
# [
#   {"id":"...","executado_em":"2026-08-13T15:10:00.000Z","total_associados_processados":42,"sucesso":true},
#   {"id":"...","executado_em":"2026-08-13T14:00:00.000Z","total_associados_processados":0,"sucesso":false}
# ]
```

## Rodando localmente com Docker

### Pré-requisitos

- Docker e Docker Compose instalados

### Passos

```bash
# 1. Copie o arquivo de exemplo e ajuste o que quiser (ADMIN_USER, ADMIN_PASSWORD, etc.)
cp .env.example .env

# 2. Suba os containers (build da imagem + Postgres)
docker-compose up --build
```

Na primeira subida:

- O container `db` sobe o PostgreSQL.
- O container `api` aguarda o banco, roda `prisma migrate deploy` (cria as tabelas) e inicia o Express na porta `3000`.
- Se `API_KEY`/`JWT_SECRET` estiverem vazios no `.env`, eles são gerados e gravados automaticamente.

Teste rápido:

```bash
curl http://localhost:3000/health
# {"status":"ok"}

curl -X POST http://localhost:3000/api/login \
  -H "Content-Type: application/json" \
  -d '{"usuario":"admin","senha":"troque-esta-senha"}'
# {"token":"...", "refresh_token":"...", "tipo":"Bearer", "expira_em":"15m"}
```

Para rodar em background: `docker-compose up -d --build`. Para derrubar: `docker-compose down` (use `docker-compose down -v` para também apagar o volume do Postgres).

### Rodando sem Docker (desenvolvimento)

```bash
npm install
cp .env.example .env   # ajuste DATABASE_URL para um Postgres local
npx prisma migrate deploy
npm run dev
```

## Deploy no EasyPanel

1. Crie um novo serviço do tipo **App** apontando para este repositório/pasta (ele detecta o `Dockerfile` automaticamente) e um serviço **PostgreSQL** (pode usar o template de banco do próprio EasyPanel).
2. No serviço da API, configure as variáveis de ambiente (aba *Environment*):
   - `DATABASE_URL` → string de conexão do serviço Postgres criado no EasyPanel (formato `postgresql://usuario:senha@host:5432/banco?schema=public`)
   - `API_KEY` → gere uma chave forte você mesmo (ex.: `openssl rand -hex 32`) e defina fixa aqui; ela só é usada como semente da migração automática pra `api_keys` na primeira inicialização (ver seção "Múltiplas API keys" acima) — depois disso, gerencie chaves por `POST /api/config/api-keys`
   - `JWT_SECRET` → idem, gere com `openssl rand -hex 48`
   - `ADMIN_USER` / `ADMIN_PASSWORD` → credenciais do painel
   - `JWT_EXPIRES_IN` → opcional, padrão `15m` (duração do access token — não precisa aumentar pra "a sessão durar mais"; quem sustenta a sessão é o refresh token, ver "Autenticação do painel" acima)
   - `REFRESH_TOKEN_TTL_DIAS` → opcional, padrão `30` (duração da sessão de fato)
   - `PORT` → `3000` (ou o que o EasyPanel exigir)
3. Configure a porta exposta do serviço como `3000` (a mesma do `EXPOSE` do Dockerfile).
4. No deploy, o `docker-entrypoint.sh` roda `prisma migrate deploy` automaticamente antes de iniciar a API — não é necessário rodar migrações manualmente, mas o serviço de banco precisa estar acessível no boot.
5. Recomenda-se **não** montar volume para `.env` em produção — defina as variáveis diretamente no painel do EasyPanel, como descrito no passo 2.

## Geração automática de contratos

Ao salvar um Cadastro com pelo menos um modelo em "Contratos a gerar", o backend gera um `.docx` por modelo selecionado (a partir do HTML cadastrado em `/contratos`, com os placeholders `{{...}}` resolvidos) e sobe cada um numa subpasta do Google Drive nomeada pelo campo "Nome da pasta". Isso acontece **depois** de `POST /api/cadastros` já ter respondido (nunca trava nem atrasa o envio do formulário) — consulte `GET /api/cadastros` depois pra ver `pasta_drive_id`/`arquivos_gerados` preenchidos.

### Por que `html-to-docx` em vez de LibreOffice headless

Testado com um HTML representativo (título, negrito, duas listas numeradas separadas): `html-to-docx` gera numeração automática nativa do Word (`numbering.xml` com `numFmt="decimal"`, não texto "1. " digitado), preserva negrito e mapeia títulos pra `Heading 1`/`Heading 2` reais. Como o Dockerfile deste projeto é baseado em `node:20-alpine`, e LibreOffice em Alpine é historicamente problemático (musl libc, pacote pesado, builds mais lentos), optamos por `html-to-docx` — sem dependência externa nenhuma, roda direto no Node. Se algum contrato real tiver uma formatação que ele não segure bem (ex.: tabelas complexas), vale reavaliar caso a caso.

### Três bugs reais do `html-to-docx` 1.8.0 (e o fix aplicado)

A barra de ferramentas da tela de Contratos ganhou itálico, sublinhado, lista com marcadores, alinhamento de texto e, mais recentemente, fonte (font-family) e tamanho (font-size). Testando a exportação pra `.docx` desses formatos (gerando `.docx` reais e inspecionando o XML gerado — não é suposição), três bugs reais foram encontrados na lib `html-to-docx` 1.8.0, lendo o código-fonte dela pra confirmar a causa:

1. **`<em>` sozinho perde toda a formatação.** A lib reconhece `<i>` como itálico, mas o trecho de código que decide qual atributo aplicar por tag (dentro de `buildRun`) não tem nenhum `case` pra `<em>` — só pra `<i>`. Como o Tiptap exporta itálico como `<em>` (padrão HTML), um `<em>` isolado virava texto normal no `.docx`, sem itálico nenhum.
2. **Combinações de formatação aninhada perdem a formatação das tags externas.** Mais sério: qualquer tag de formatação (`<strong>`/`<b>`/`<i>`/`<u>`/`<ins>`) que tenha como **único filho** outra tag de formatação perde a própria formatação no `.docx` final — só a tag mais interna da cadeia sobrevive. Isso acontece porque o código da lib só "persiste" a formatação de um nível quando esse nível tem mais de 1 filho; com exatamente 1 filho (o aninhamento limpo que o Tiptap gera pra uma seleção com múltiplas marcas — ex.: negrito+itálico+sublinhado vira `<strong><em><u>texto</u></em></strong>`, sem nenhum irmão) a formatação da tag mais externa é descartada. Ex.: sem o fix, `<strong><em>texto</em></strong>` virava só itálico no Word, perdendo o negrito. Isso vale também quando essa cadeia vem dentro de um `<span style="...">` (caso de fonte/tamanho combinados com negrito/itálico, ver abaixo) — o `<span>` tem seu próprio caminho de código na lib (`buildRunOrRuns`), mas ele delega pra esse mesmo trecho problemático pra processar a cadeia de formatação interna, então o mesmo bug (e o mesmo fix) se aplica; confirmado lendo o código-fonte de `buildRunOrRuns`/`buildRun` e validado empiricamente (ver `test-docx-fonte-tamanho.js`).
3. **Nomes de fonte com espaço saem quebrados.** A lib não decodifica entidades HTML (ex.: `&quot;`) dentro do valor do atributo `style` antes de interpretar `font-family`. Nomes de fonte com mais de uma palavra (ex.: "Courier New", "Times New Roman") são naturalmente serializados pelo Tiptap/DOM como `style="font-family: &quot;Courier New&quot;"` (aspas reais viram entidade ao virar string HTML — isso é serialização HTML padrão, não peculiaridade do Tiptap). A lib usa esse valor cru sem decodificar a entidade, então o nome da fonte sai truncado/quebrado no `.docx`. Fontes de uma palavra só (Arial, Calibri) não têm esse problema.

**Fix**: `src/lib/htmlParaDocxFix.js`, chamado por `gerarDocxBuffer` (`docx.service.js`) antes de repassar o HTML pra `html-to-docx`. Usa `cheerio` pra: (a) normalizar `<em>` → `<i>`; (b) pra cada tag de formatação com exatamente 1 filho que também é uma tag de formatação, injetar um espaço de largura zero (`U+200B`, invisível, não imprime, não afeta o texto nem os placeholders — que já foram resolvidos antes dessa etapa) como filho irmão extra, tirando o código da lib do caminho com bug (roda em loop até estabilizar, pra cobrir cadeias de 3+ níveis); (c) remover aspas (simples ou duplas) de cada nome dentro de `font-family` em qualquer atributo `style` — como o cheerio já decodifica a entidade ao ler o atributo, a remoção acontece nos caracteres reais, e o valor final (sem aspas) sai sem precisar de entidade nenhuma ao serializar de volta pra HTML, contornando o bug 3 por completo (nomes com espaço continuam funcionando sem aspas — confirmado no teste).

### Fonte e tamanho no editor de Contratos

A barra de ferramentas do editor de Contratos ganhou dois seletores novos: fonte (font-family — Courier New, Arial, Times New Roman, Calibri) e tamanho (font-size — 8 a 14pt, incluindo 9pt e 12pt). Implementado com `@tiptap/extension-text-style` (pacote oficial do Tiptap, inclui `TextStyle`, `FontFamily` e `FontSize` prontos — não foi preciso extensão de terceiros nem atributo customizado; o Tiptap ainda não tem uma extensão oficial separada só de `font-size`, mas ela já vem embutida nesse mesmo pacote). Os dois atributos ficam na mesma mark `textStyle` e saem como um único `<span style="font-family: ...; font-size: ...">` no HTML (não dois `<span>` aninhados).

Validado com `.docx` reais gerados a partir do HTML exato que o Tiptap produz (via `@tiptap/html/server`), isolado e combinado com negrito/itálico/sublinhado (o cenário mais arriscado, dado o bug 2 acima) — ver `test-docx-fonte-tamanho.js` na seção de testes.

### Configuração necessária

1. **Conta de serviço do Google** com a Drive API habilitada:
   - No [Google Cloud Console](https://console.cloud.google.com/), crie (ou reaproveite) um projeto e habilite a **Google Drive API**.
   - Em "Credenciais" → "Criar credenciais" → "Conta de serviço", crie uma conta de serviço qualquer (ex.: `gestor-contratos@<projeto>.iam.gserviceaccount.com`).
   - Gere uma chave JSON pra essa conta de serviço (aba "Chaves" → "Adicionar chave" → JSON) — isso baixa um arquivo `.json`.
   - Cole o **conteúdo desse arquivo** em `PATCH /api/config/google-service-account` (ou pela tela de Configurações do painel) — **por franquia**, desde o Passo 4 da migração multi-franquia (ver seção "Testes realizados"). Aceita tanto o JSON cru colado direto quanto o JSON inteiro em base64 (`base64 -w0 arquivo.json`) — mais seguro em plataformas onde colar um valor multi-linha é incômodo (ex.: EasyPanel). O backend tenta os dois formatos automaticamente. A variável de ambiente `GOOGLE_SERVICE_ACCOUNT_JSON` (formato antigo, global) continua funcionando como **semente**: se estiver setada, seu valor é copiado automaticamente na primeira subida do servidor pra dentro de `configuracoes` da franquia padrão (idempotente — só copia se essa franquia ainda não tiver credencial salva) — depois disso a variável de ambiente nunca mais é lida.
   - **Compartilhe a pasta raiz do Drive com o e-mail da conta de serviço** (campo `client_email` do JSON), com permissão de Editor — sem isso, a criação de subpastas/upload falha com erro de permissão, mesmo com a credencial correta.
2. **Pasta raiz do Drive**: configure via `PATCH /api/config/drive-pasta-raiz` (ou pela tela de Configurações do painel) — aceita tanto o id da pasta quanto o link completo (`https://drive.google.com/drive/folders/<id>`). Também por franquia.

Sem a credencial da conta de serviço configurada **para aquela franquia**, ou sem a pasta raiz definida, a geração é **pulada de forma silenciosa** (só loga um aviso no console) — o Cadastro em si continua sendo salvo normalmente, só fica sem `pasta_drive_id`/`arquivos_gerados`.

### Pasta raiz dentro de um Drive Compartilhado (Shared Drive)

Se a pasta raiz configurada (`drive_pasta_raiz_id`) vive dentro de um **Drive Compartilhado** (não do "Meu Drive" comum), toda chamada da API do Drive que toca nela precisa do parâmetro `supportsAllDrives: true` — sem isso, a API trata o conteúdo do Shared Drive como inexistente e as chamadas falham com `File not found: <id da pasta>`, mesmo com a pasta corretamente compartilhada com a conta de serviço (permissão de Editor/Administrador de conteúdo). `criarPasta` e `uploadDocx` em `src/services/drive.service.js` já enviam `supportsAllDrives: true` em toda chamada `files.create` — não tem efeito quando a pasta é do "Meu Drive" normal, então fica sempre ligado por padrão, sem precisar saber de antemão qual tipo de Drive será usado.

### Nome do arquivo .docx gerado

Cada `.docx` gerado (um por modelo selecionado em "Contratos a gerar") é salvo no Drive com o nome `"{Tipo} - {Razão Social}.docx"`, montado por `nomeArquivoContrato` (`src/services/contratosGeracao.service.js`):

- **`{Tipo}`**: rótulo do campo "Tipo" do `ModeloContrato` usado — `TERMO` → "Termo de Associação", `ADITIVO` → "Aditivo Contratual" (`TIPO_MODELO_LABEL`, mesmo texto exibido na tela `/contratos` do frontend; mantido em sincronia manualmente, já que o banco guarda só o código). **Não** é o campo "Nome" do modelo, que pode ter texto extra (ex.: "Termo de Associação (Pessoa Jurídica)") — usar o "Nome" bagunçaria o nome do arquivo. Um tipo sem rótulo mapeado (nenhum hoje, mas por segurança) cai pro próprio código em vez de travar a geração.
- **`{Razão Social}`**: sempre `payload['Razão Social']` do Cadastro, PF ou PJ — esse campo é sempre preenchido na prática, independente do tipo de pessoa.
- Cada contrato gerado pro mesmo Cadastro tem seu próprio nome — se "Contratos a gerar" tiver Termo + Aditivo, saem dois arquivos com nomes diferentes, não um nome só pra pasta inteira.
- **Sanitização** (`sanitizarNomeArquivo`): caracteres inválidos/problemáticos em nome de arquivo (`\ / : * ? " < > |` e caracteres de controle) são substituídos por espaço — nunca removidos "colados" (evita grudar duas palavras) — com espaços múltiplos colapsados e aparados no fim. Cobre o caso de alguém colar um CNPJ formatado junto da Razão Social por engano (ex.: `"ACME LTDA 12.345.678/0001-90"` → `"ACME LTDA 12.345.678 0001-90"`), sem quebrar a geração.

Exemplos: `"Termo de Associação - 45.493.621 ERICA DA COSTA ROSA.docx"`, `"Aditivo Contratual - 45.493.621 ERICA DA COSTA ROSA.docx"`.

### Dicionário de variáveis (`{{...}}`)

Os placeholders usados no HTML de um `ModeloContrato` são resolvidos contra este dicionário (ver `src/services/contratosGeracao.service.js`):

Direto do payload do Cadastro: `Razão Social`, `Nome Fantasia`, `CNPJ/CPF`, `Endereço`, `Número`, `Complemento`, `Bairro`, `Cidade`, `UF`, `CEP`, `E-mail`, `Celular`, `Contato`, `Tipo de Pessoa`.

Calculados: `Nome do Associado` (Razão Social pra PJ, Contato pra PF — com fallback cruzado se um dos dois estiver vazio), `Qualificação`, `Créditos VP$ Quantidade`/`Créditos VP$ Valor` e `Cláusula de Pagamento` (bloco pronto, frase inteira já montada) — usando as funções em `src/lib/contratoVariaveis.js` (copiadas verbatim do texto fornecido, validadas contra os 2 exemplos de aceitação fornecidos, que batem caractere por caractere — ver `test-contrato-variaveis.js`).

**Tokens soltos** (mesmos dados que já alimentam `Cláusula de Pagamento`, expostos individualmente pra quem quiser montar a própria redação em vez de usar o bloco pronto — as duas formas coexistem, usar uma não impede usar a outra):

- `Número de Parcelas` — valor cru do campo do formulário (ex.: `"11"`).
- `Número de Parcelas Por Extenso` — via `numeroPorExtensoFeminino` (ex.: `"onze"`).
- `Valor Total` / `Valor Total Por Extenso`.
- `Valor da Entrada` / `Valor da Entrada Por Extenso`.
- `Data da Entrada` — ver campo novo abaixo.
- `Valor da Parcela` / `Valor da Parcela Por Extenso` — `(Valor Total - Valor da Entrada) / Número de Parcelas`, mesmo cálculo usado internamente por `Cláusula de Pagamento`.
- `Data Vencimento` — valor bruto do campo "Data Vencimento" do formulário (data da primeira/única parcela), formatado `dd/mm/aaaa`. Não é a lista de vencimentos de cada parcela (isso só existe hoje dentro do texto montado por `Cláusula de Pagamento`) — só a data única do campo, solta.

A substituição é feita direto na string HTML (`content.replace(/\{\{([^}]+)\}\}/g, ...)`), sem tentar interpretar o HTML como árvore — por isso, **nunca formate uma placeholder pela metade** (ex.: deixar só `{{Razão` em negrito e `Social}}` sem) na tela de Contratos, ou a substituição não vai encontrar a chave inteira. Placeholders sem correspondência no dicionário (typo no nome da variável) são deixados como estão no documento final, em vez de travar a geração inteira — revise o `.docx` gerado se um trecho aparecer literalmente como `{{...}}`.

### Campo "Data da Entrada"

Novo campo no formulário de Cadastro (mesmo componente de calendário de "Data Vencimento"), opcional — relevante quando há "Valor da Entrada" > 0, mas não bloqueia o envio se ficar vazio. Persistido dentro do JSON `cadastros_enviados.payload` (não precisou de coluna nova).

Usado como `dataEntrada` nas três funções de cláusula (à vista/parcelado/recorrente) e no token solto `{{Data da Entrada}}`. Se vier vazio **e** houver "Valor da Entrada" > 0, cai no fallback antigo (a data em que o Cadastro foi enviado, `criado_em`, assumindo que a entrada foi paga "no ato da assinatura") — ver `resolverDataEntrada` em `contratosGeracao.service.js`. O fallback é só uma rede de segurança pra cadastros antigos (anteriores a este campo) ou pra quem não preencher; nunca trava a geração.

### Valor da parcela também por extenso

`clausulaPagamentoParcelado` e `clausulaPagamentoRecorrente` passaram a incluir o valor de cada parcela por extenso, no mesmo padrão dos demais valores da cláusula: antes "... de R$ 420,00, por meio de ...", agora "... de R$ 420,00 (quatrocentos e vinte reais), por meio de ...". Único ponto onde as funções verbatim originais foram alteradas (ver comentário no topo de `src/lib/contratoVariaveis.js`) — os 2 testes de aceitação foram atualizados junto, continuam batendo caractere por caractere.

### Premissas assumidas (campos que não existiam no formulário)

O formulário de Cadastro/Faturamento, antes desta feature, não tinha campos suficientes pra montar a "Cláusula de Pagamento" e os "Créditos VP$" com 100% de certeza. As premissas abaixo foram assumidas para fechar essas lacunas — **revise-as e avise se algo estiver errado**, é só ajustar a lógica em `contratosGeracao.service.js`, nada disso está espalhado pelo código:

- **Roteamento da cláusula**: `Descrição do Serviço === "Recorrência Cartão de Crédito (Anuidade)"` → sempre `clausulaPagamentoRecorrente`; caso contrário, `Número de Parcelas <= 1` → `clausulaPagamentoAvista`, `> 1` → `clausulaPagamentoParcelado` (independente de PIX/Boleto/Cartão, já que qualquer um pode ser parcelado em mais de 1x no formulário atual).
- **Forma de pagamento** (texto usado nas cláusulas à vista/parcelado): `"Anuidade (PIX)"` → "PIX", `"Anuidade (Boleto)"` → "boleto bancário", `"Anuidade (Cartão de Crédito)"` → "cartão de crédito".
- ~~**Data da entrada**: não existe campo próprio no formulário...~~ — **resolvida**: "Data da Entrada" agora é um campo de verdade no formulário (ver seção acima); o que era premissa virou só um fallback de segurança.
- **Vencimento de cada parcela**: computado somando 1 mês por parcela a partir de "Data Vencimento" (ex.: parcela 1 = "Data Vencimento", parcela 2 = +1 mês, ...), com ajuste automático pro último dia do mês quando o dia de origem não existir no mês de destino (ex.: 31/01 + 1 mês → 28/02 ou 29/02).
- **Valor de cada parcela**: `(Valor Total - Valor da Entrada) / Número de Parcelas`, dividido igualmente (arredondado a 2 casas decimais).
- **Créditos VP$**: a função `creditosVps` só aceita 8.000, 2.000 ou 0 — como não havia nenhum campo existente de onde derivar esse valor, foi adicionado um **3º campo novo ao formulário de Cadastro** (dropdown "Créditos VP$": 8.000 / 2.000 / Nenhum), além dos 2 campos pedidos ("Nome da pasta" e "Contratos a gerar") — ver README do frontend.

## Testes realizados

O ambiente de execução usado para gerar este projeto não tinha Docker disponível, então a validação completa (`docker-compose up`) não pôde ser executada literalmente aqui. Em vez disso, a aplicação foi validada de ponta a ponta com um PostgreSQL real (mesmo motor de banco, mesmas migrações do Prisma geradas em `prisma/migrations`), cobrindo:

- Subida do servidor Express e `GET /health`
- `POST /api/login` com credenciais corretas e incorretas
- `POST /api/sync` criando e depois atualizando (upsert) associados e cobranças, sem duplicar
- `GET /api/associados` com e sem filtro `em_negociacao`, confirmando que cobranças `paid` são excluídas da listagem filtrada
- `GET /api/associados/:cpf_cnpj` com histórico de negociação
- `PATCH /api/associados/:cpf_cnpj/negociacao` gravando corretamente `status_anterior`/`status_novo` em `historico_negociacao`
- Autenticação: acesso negado (401) sem token e com token inválido; aceito tanto com `API_KEY` quanto com JWT do login
- Casos de erro: 404 para CPF/CNPJ inexistente, 400 para corpo inválido no PATCH

**Upsert de cobrança por `id_externo`** (validado após a adição do campo):

- Migração `add_id_externo_cobrancas` aplicada com sucesso via `prisma migrate deploy`, coluna `id_externo` criada como `TEXT NULL` com índice único.
- Sync enviando `id_externo` pela primeira vez: cria a cobrança normalmente.
- Sync reenviando o **mesmo `id_externo`** com valor/vencimento/descrição diferentes: atualiza o registro existente (`cobrancas_atualizadas: 1`) sem criar duplicata.
- Sync **sem `id_externo`** (integração legada): continua casando por `(associado_id, vencimento, descricao)` — criação e depois atualização do mesmo título, sem duplicar.
- Caso extra testado: reenviar o mesmo `id_externo` associado a um CPF/CNPJ diferente do original — como `id_externo` é único globalmente, o upsert corretamente move o vínculo da cobrança para o novo associado (sem duplicar a linha), o que é o comportamento esperado para correções de vínculo vindas do Asaas.

**Bloqueio, jurídico, contador e reset** (validado após a adição desses endpoints):

- Migração `add_bloqueio_juridico_config_synclog` aplicada com sucesso via `prisma migrate deploy` (colunas novas em `associados` + tabelas `historico_bloqueio`, `configuracoes`, `sync_log`).
- `PATCH .../bloqueio` alternando `true`/`false` várias vezes: cada chamada grava uma linha em `historico_bloqueio` com `status_anterior`/`status_novo` corretos.
- `GET .../bloqueios/contador`: contou corretamente 2 marcações como bloqueado antes do reset.
- `POST .../bloqueios/resetar`: grava `ciclo_resetado_em`; o contador cai para 0 logo em seguida.
- Novo bloqueio após o reset: contador passa a 1, considerando só bloqueios após `ciclo_resetado_em` — confirmado que os 4 registros antigos de `historico_bloqueio` continuam intactos (nada é apagado, só o ponto de corte muda).
- `PATCH .../juridico`: atualiza o campo sem gravar histórico, como esperado.
- Validação: 400 para `bloqueado`/`em_juridico` não booleano; 404 nos 4 endpoints novos para CPF/CNPJ inexistente.
- `GET /api/associados/:cpf_cnpj` retornando `bloqueado`, `em_juridico`, `ciclo_resetado_em` e `historico_bloqueio` no payload.

**Configurações (`sync-log`)**:

- `GET /api/config/sync-log`: vazio antes de qualquer sync; após 2 syncs bem-sucedidos e 1 com corpo inválido, retorna as 3 linhas, mais recente primeiro, com `total_associados_processados`/`sucesso` corretos em cada uma (incluindo `sucesso: false` para a chamada inválida).

**Múltiplas API keys (`api_keys`, substitui a chave única)** — testado com Postgres real (`test-multiplas-api-keys.js`, 29/29):

- Subindo a aplicação com `API_KEY` (legada, via env) definida e nenhuma linha em `api_keys`: a primeira requisição autenticada com essa chave continua funcionando normalmente (200) — confirma a migração lazy.
- `GET /api/config/api-keys` logo em seguida: lista exatamente 1 chave, nome `"Chave padrão (migrada)"`, ativa, mascarada (não expõe o valor completo).
- `POST /api/config/api-keys` sem `"nome"` → 400; com `"nome"` → 201, retorna a chave completa (64 caracteres hex) só nessa resposta.
- A chave nova funciona como Bearer em endpoint protegido, **independente e simultaneamente** com a chave legada migrada.
- `ultimo_uso_em` começa e permanece `null` até a chave ser usada pela primeira vez; depois de usada, é preenchido (atualização em segundo plano, confirmado com uma pequena espera).
- `POST /api/config/api-keys/:id/revogar`: revoga só aquela chave — passa a dar 401 em endpoint protegido — enquanto a chave legada (não revogada) continua aceita normalmente (200), confirmando que revogar uma não afeta as outras.
- Chave revogada continua aparecendo em `GET /api/config/api-keys` (histórico preservado, `ativa: false`), não é deletada.
- Revogar a mesma chave de novo: ainda 200 (idempotente). Revogar um id inexistente: 404.
- Rotas antigas de chave única (`GET /api/config/api-key`, `POST /api/config/api-key/regenerar`) confirmadas removidas (404).
- Regressão: `test-sync-atualizar.js` (16/16), `test-reconciliacao-janela.js` e `test-tolerancia.js` completos passando após a troca do middleware de auth, confirmando que endpoints que dependem de `API_KEY`/autenticação continuam funcionando normalmente com o novo esquema.

**Filtro combinado `em_negociacao` + `em_juridico` em `GET /api/associados`** (validado com 4 associados cobrindo as 4 combinações possíveis dos dois booleanos):

- Sem filtro: retorna os 4, com todas as cobranças (qualquer status).
- Só `em_negociacao=true`: retorna só quem está em negociação, independente do jurídico.
- Só `em_juridico=true`: retorna só quem está no jurídico, independente da negociação.
- `em_negociacao=false&em_juridico=false`: retorna **apenas** o associado que não está em nenhum dos dois — confirma o AND (não OR) entre os filtros, e é exatamente o cenário da "lista segura para régua de cobrança automática" citado no enunciado.
- `em_negociacao=true&em_juridico=true`: retorna só quem está nos dois ao mesmo tempo.
- `em_negociacao=false&em_juridico=true`: retorna só quem está no jurídico mas não em negociação.
- Valor inválido em um dos parâmetros (ex.: `em_juridico=talvez`): esse filtro é ignorado, mantendo só o outro válido — confirmado que não quebra nem é tratado como `false`.

**Paginação, busca unificada e `observacao_atualizada_em`** (validado com um cenário de ~150 associados fake e migração `add_observacao_atualizada_em`):

- Migração `add_observacao_atualizada_em` aplicada com sucesso via `prisma migrate deploy`, coluna `observacao_atualizada_em` criada como `TIMESTAMP(3) NULL`.
- `POST /api/sync` criando 150 associados de uma vez (`associados_criados: 150`, sem erros).
- Paginação padrão (sem `page`/`limit`): primeira página com 100 registros, `paginacao.pagina_atual: 1`, `total_paginas: 2`, `total_registros: 150`, `por_pagina: 100`.
- `page=2`: os 50 registros restantes.
- `page=3` (além do fim): `dados: []`, mas `pagina_atual: 3` e `total_paginas: 2` preservados corretamente na resposta (não gera erro, não "clampa" a página).
- `limit=500`: reduzido silenciosamente para 100, sem erro 400.
- `limit=25`: `total_paginas: 6` (150/25), confirmando o cálculo do total de páginas com um `limit` customizado.
- Busca unificada (`busca`) por telefone completo: 1 resultado correto.
- Busca por nome com espaço (ex.: `"fake associado 001"`, URL-encoded): 1 resultado, `contains` case-insensitive funcionando.
- Busca por CPF/CNPJ parcial: 1 resultado correto.
- `observacao_atualizada_em`: `null` no estado inicial de um associado recém-criado via sync.
- `PATCH .../negociacao` com `observacao` nova (`"abc"`): `observacao_atualizada_em` passa a ter timestamp.
- Reenviar a **mesma** `observacao` (`"abc"` de novo): `observacao_atualizada_em` **não muda** (timestamp idêntico ao anterior).
- `PATCH .../negociacao` **sem** enviar `observacao` no body (só alternando `em_negociacao`): `observacao_atualizada_em` **não muda**.
- `PATCH .../negociacao` com `observacao` **diferente** (`"xyz"`): `observacao_atualizada_em` atualiza para um timestamp novo e maior que o anterior.
- `PATCH .../bloqueio`: `observacao_atualizada_em` **não muda**.
- `PATCH .../juridico`: `observacao_atualizada_em` **não muda**.
- `POST /api/sync` atualizando o mesmo associado (nome/telefone): `observacao` e `observacao_atualizada_em` **não mudam** — confirmado que o sync nunca toca nesses campos.
- `GET /api/associados` e `GET /api/associados/:cpf_cnpj` retornando `observacao_atualizada_em` corretamente em ambos.

**`GET /api/associados/resumo` e ordenação por criticidade no banco** (validado com um cenário de 150 associados fake, combinando três grupos):

- Cenário: 128 associados cada um com uma cobrança `pending` com `dias_diferenca` único e sequencial de -1 a -128 (Grupo A); 10 associados sem nenhuma cobrança em aberto — só paga ou nenhuma (Grupo B); 12 associados variados usados especificamente para o teste de `busca` no resumo, com nomes prefixados `Criteriotest` (Grupo C). `POST /api/sync` criando os 150 associados e 141 cobranças de uma vez, sem erros.
- `GET /api/associados/resumo?busca=criteriotest` batendo exatamente com os números calculados manualmente a partir da composição conhecida do Grupo C: `com_cobranca_aberto: 5`, `valor_total_aberto: 436.50`, `em_negociacao: 4`, `bloqueados: 3`, `em_juridico: 2`.
- `GET /api/associados/resumo` sem filtro (carteira inteira, 150 registros) batendo com os números calculados somando os três grupos: `com_cobranca_aberto: 133`, `valor_total_aberto: 13236.50`, `em_negociacao: 5`, `bloqueados: 4`, `em_juridico: 3`.
- Ordenação cruzando páginas: buscadas todas as 8 páginas de `GET /api/associados` (`limit=20`, 150 registros), concatenando os resultados — confirmado que: (1) os 150 registros aparecem uma única vez cada, sem duplicatas nem perdas entre páginas; (2) o **primeiro registro da página 1** é o associado com o `dias_diferenca` mais negativo do sistema inteiro (-128, do Grupo A), confirmando que a ordenação é global e não só "dentro da página"; (3) a sequência de "pior `dias_diferenca`" de todos os 150 registros concatenados é monotonicamente crescente (do mais crítico para o menos crítico); (4) os 10 associados do Grupo B (sem cobrança em aberto, `pior_dias_diferenca` nulo) aparecem todos exatamente nas últimas posições, confirmando o `NULLS LAST`.

**Cadastro/Faturamento (`POST /api/cadastros`, `GET /api/cadastros`, `GET`/`PATCH /api/config/webhook-cadastro`)** — validado com Postgres real e um mock HTTP simulando o n8n (respostas de sucesso, HTTP 500 e porta fechada/inalcançável):

- Migração `add_cadastros_enviados` aplicada com sucesso via `prisma migrate deploy`, tabela criada com `payload` como `JSONB`.
- `POST /api/cadastros` sem token: `401`.
- `POST /api/cadastros` com payload incompleto (faltando `CNPJ/CPF`, `Razão Social`/`Contato`, `Descrição do Serviço` e `Valor Total`): `400`, com uma mensagem por campo faltante.
- `PATCH /api/config/webhook-cadastro` salvando uma URL e `GET` confirmando que persistiu.
- **Caminho feliz**: `n8n_webhook_cadastro_url` apontando para um endpoint que responde 200 — `POST /api/cadastros` retorna `201` com `status: "enviado"` e `resposta_n8n: null`; confirmado que o mock recebeu o payload com todas as 20 chaves em português (acentos e espaços preservados, ex.: `"Razão Social"`, `"Descrição do Serviço"`).
- **Falha de rede (porta fechada/inalcançável)**: `POST /api/cadastros` continua retornando `201` (sucesso para quem preencheu o formulário) — mas o registro salvo vem com `status: "erro"` e `resposta_n8n` com o motivo (`"fetch failed"`), confirmando que a falha ao chamar o n8n não trava o cadastro.
- **n8n responde HTTP 500**: mesmo comportamento — `201` para o formulário, registro com `status: "erro"` e `resposta_n8n` citando o código `500` e o corpo da resposta do n8n.
- **Paginação de `GET /api/cadastros`**: criados 12 cadastros em sequência; `page=1&limit=5` traz os 5 mais recentes primeiro (ordem decrescente por `criado_em`), `page=2&limit=5` os 5 seguintes, `page=3&limit=5` os 2 restantes, e `page=4&limit=5` (além do fim) retorna `dados: []` com `pagina_atual: 4` e `total_paginas: 3` preservados — mesmo comportamento de paginação já usado em `GET /api/associados`.

**Taxa de Inadimplência (`GET /api/inadimplencia/resumo`, `GET`/`PATCH /api/config/asaas-key`)** — validado com Postgres real e um mock HTTP simulando a API do Asaas (paginação offset/limit real, `GET /v3/customers/:id`, autenticação por `access_token`):

- `GET /api/inadimplencia/resumo` **antes** de configurar a chave: `400`, mensagem orientando `PATCH /api/config/asaas-key`.
- `PATCH /api/config/asaas-key`: `200`, resposta mascarada (últimos 6 caracteres) que **não contém** a chave completa enviada. `GET /api/config/asaas-key` em seguida retorna a mesma máscara.
- **Cenário de cálculo** (11 pagamentos, 4 clientes no Asaas — 3 deles com associado correspondente na nossa base, 1 sem registro local — cobrindo as 6 faixas de atraso, incluindo um pagamento com exatamente 90 dias de atraso e outro com mais de 300 dias):
  - `valor_total_faturado` e `valor_inadimplente` batendo exatamente com a soma manual do dataset (18.200,00 e 17.000,00).
  - `taxa_inadimplencia_percentual` batendo com `valor_inadimplente / valor_total_faturado * 100` arredondado.
  - `associados_inadimplentes` = 4 (um por cliente com pagamento `OVERDUE`).
  - Cada uma das 6 faixas (`0_20` a `100_180`) batendo com o pagamento esperado — incluindo confirmar que o pagamento com mais de 300 dias de atraso **não desaparece** do relatório (cai em `100_180`, sem teto).
  - `criticos_90_dias` somando corretamente os pagamentos com 90+ dias, incluindo o caso de fronteira exata (90 dias) — e confirmando que esse mesmo pagamento também aparece contado na faixa `50_100` (métricas independentes, não mutuamente exclusivas).
  - `renegociacoes_abertas` (`quantidade` e `valor`) batendo com os pagamentos `OVERDUE` de clientes com `em_negociacao: true` na nossa base.
  - `top_devedores` ordenado corretamente por valor decrescente, com `nome` vindo do cadastro local (não do nome cadastrado no Asaas) quando o associado existe na nossa base.
- **Filtro `renegociacao=sim`/`nao`**: confirmado que filtra **todo** o conjunto (inclusive `valor_total_faturado`, não só os `OVERDUE`) — testado com os números recalculados manualmente para cada filtro; `renegociacao=nao` incluindo corretamente o cliente **sem registro local** (tratado como "não em negociação", regra explícita do pedido); `renegociacoes_abertas` corretamente zerado quando `renegociacao=nao` (o próprio filtro já exclui quem está em negociação).
- **Cache**: chamada repetida com os mesmos `venc_de`/`venc_ate`/`renegociacao` **não gera nenhuma nova requisição** ao mock do Asaas (contador de chamadas ao mock inalterado na 2ª chamada).
- **Paginação real**: cenário dedicado com 150 pagamentos no período (excede o `limit=100` por página) — confirmado que o serviço faz exatamente 2 chamadas ao Asaas (`offset=0` e `offset=100`) e que a soma dos 150 registros bate no resultado final, validando que a paginação por `hasMore`/`offset` percorre todas as páginas sem perder nem duplicar registros.
- **Validações**: `venc_de` malformado (`400`); só `venc_de` sem `venc_ate` (`400`, exige os dois juntos ou nenhum); `renegociacao` com valor fora de `todos`/`sim`/`nao` (`400`); requisição sem token (`401`).

**`scripts/mock-asaas-server.js`** (mock standalone para teste manual, ver seção "Como testar a tela de Inadimplência com dados fictícios") — validado de ponta a ponta com Postgres real e o backend de verdade rodando (não só chamado diretamente):

- `GET /v3/payments` sem `access_token`: `401`; com token errado: `401`; com o token fictício certo: `200`.
- Período amplo (2 anos atrás até hoje+30 dias): `totalCount: 20`, `hasMore: false`, os 4 status esperados presentes (`OVERDUE`, `PENDING`, `RECEIVED`, `CONFIRMED`), 13 pagamentos `OVERDUE`.
- Paginação (`limit=5`): página 1 e página 2 trazem os IDs esperados na ordem certa, `hasMore: true` em ambas (20 registros / 5 por página).
- `GET /v3/customers/cus_mock_alfa`: `200` com `name`/`cpfCnpj` corretos; `GET /v3/customers/<id inexistente>`: `404`.
- Seed dos 4 associados fictícios na tabela local `associados`: confirmado via query direta ao Postgres que os 4 registros foram criados com o `em_negociacao` esperado (3× `true`, 1× `false`).
- **Fechando o ciclo completo**: subiu o backend real (`npm start`) apontando `ASAAS_API_BASE_URL` para o mock, configurada a chave fictícia via `PATCH /api/config/asaas-key`, e chamado `GET /api/inadimplencia/resumo` de verdade — confirmado que **as 6 faixas vêm todas com valor maior que zero** (`0_20: 2050`, `20_30: 2530.50`, `30_40: 2255`, `40_50: 1230`, `50_100: 2290`, `100_180: 8590` — essa última já inclui o pagamento de mais de 180 dias, sem sumir do relatório), `top_devedores` traz o nome vindo do cadastro local para os 4 associados seedados e o nome do Asaas para os demais, e `renegociacao=sim` restringe corretamente para os 3 associados marcados `em_negociacao: true` (`associados_inadimplentes: 3`, `renegociacoes_abertas.quantidade: 6` — as 2 cobranças `OVERDUE` de cada um dos 3).

**Exclusão de cobranças, filtro `em_juridico` e evolução mensal (`GET/POST/DELETE /api/inadimplencia/exclusoes`, `GET/PATCH /api/config/palavras-excluidas`, `em_juridico` em `/resumo`, `GET /api/inadimplencia/evolucao-mensal`)** — validado com Postgres real (7ª migração, `add_cobrancas_ignoradas`, aplicada com sucesso) e o mock do Asaas estendido (`scripts/mock-asaas-server.js`, agora com `description` em todos os 20 pagamentos fictícios e 4 associados cobrindo as combinações de `em_negociacao`/`em_juridico`):

- `GET /api/config/palavras-excluidas` antes de qualquer configuração: `{"palavras": []}`. `PATCH` com `"palavras"` não-array: `400`. `PATCH` válido persiste e é lido de volta corretamente (testado com acento, `"não contabilizar"`).
- `GET /api/inadimplencia/exclusoes` vazio inicialmente. `POST` sem `asaas_payment_id`: `400`. `POST` válido: `201` com o registro completo. `POST` com `asaas_payment_id` repetido: `409` (violação da constraint única tratada explicitamente, não vaza como 500).
- **Exclusão combinada, sem duplicar contagem**: configurada a palavra `"não contabilizar"` (batendo em `pay_mock_003` e `pay_mock_008`) e adicionados manualmente `pay_mock_005` e `pay_mock_008` (esse último pego pelos **dois** mecanismos ao mesmo tempo) — `excluidos.quantidade` veio `3` (não `4`) e `excluidos.valor` bateu exatamente com a soma dos 3 pagamentos únicos, confirmando que a exclusão combinada não conta duas vezes quem cai nos dois critérios. `valor_total_faturado`/`valor_inadimplente` do `/resumo` vieram exatamente iguais ao total do período **menos** o valor excluído.
- **Invalidação de cache ao mudar as exclusões**: `DELETE` de uma exclusão manual (`204`; `404` ao tentar de novo no mesmo id) fez `excluidos.quantidade`/`valor` do `/resumo` **mudarem já na chamada seguinte**, sem esperar os 4 minutos de TTL — confirmando que `POST`/`DELETE /api/inadimplencia/exclusoes` e `PATCH /api/config/palavras-excluidas` limpam o cache.
- **Filtro `em_juridico`**: valor inválido (`?em_juridico=talvez`): `400`. `em_juridico=sim` restringindo corretamente **todo** o conjunto (não só os `OVERDUE`) aos dois associados fictícios marcados `em_juridico: true` — `valor_total_faturado`, `valor_inadimplente`, `associados_inadimplentes`, `criticos_90_dias`, `faixas` e `renegociacoes_abertas` todos batendo com o cálculo manual a partir do dataset conhecido do mock; `em_juridico=nao` batendo com o complementar exato do total do período. `excluidos` permaneceu idêntico entre `em_juridico=todos`/`sim`/`nao` — confirmado que a exclusão é anterior (e independente) aos filtros de cross-reference.
- **`GET /api/inadimplencia/evolucao-mensal`**: período explícito de 10 meses (dez/2025 a set/2026) retornou os 10 meses no array, incluindo dois meses **sem nenhuma cobrança no dataset** (zerados, `taxa_inadimplencia_percentual: 0`, `taxa_adimplencia_percentual: 100`). Conferidos manualmente, mês a mês, contra o dataset do mock (levando em conta as 3 cobranças excluídas): dezembro/2025 (100% inadimplência, um único pagamento antigo), junho, julho e agosto/2026, e um mês só com pagamento `PENDING` (0% inadimplência, 100% adimplência) — todos batendo exatamente. `taxa_adimplencia_percentual = 100 - taxa_inadimplencia_percentual` confirmado em cada mês. Chamada com filtros (`renegociacao=sim&em_juridico=nao`) não quebrou. Chamada repetida com os mesmos parâmetros voltou idêntica, byte a byte, sem gerar nova requisição ao mock (cache funcionando, mesmo namespace/TTL do `/resumo`).
- Suíte automatizada rodou de ponta a ponta contra um Postgres descartável (`embedded-postgres`) e o mock real do Asaas: **63/63 asserções passaram**.

**Classificação histórica por data de pagamento, `visao_faixas`, renegociação por descrição e filtro `bloqueado`** — validado com Postgres real (nenhuma migração nova; `bloqueado` já existia em `associados`) e o mock do Asaas estendido para 24 pagamentos (`paymentDate` em todos, incluindo pagos em dia, pagos com atraso mesmo já `RECEIVED`, a vencer, e 2 com "Renegociação" na descrição — ver seção do mock acima):

- **Cenário central da classificação histórica**: `pay_mock_021` vence em maio/2026 e só é paga (`paymentDate`) em agosto/2026 (~65 dias de atraso), com `status` atual `RECEIVED`. Consultando `/resumo` e `/evolucao-mensal` com o período restrito a maio/2026 (isolando o mês de vencimento): as 3 cobranças que venceram naquele mês (`pay_mock_010`, ainda não paga; `pay_mock_018`, paga com ~40 dias de atraso; `pay_mock_021`, paga com ~65 dias de atraso) somam `valor_total_faturado: 4140`, `valor_inadimplente: 4140`, `taxa_inadimplencia_percentual: 100` — confirmando que nenhuma delas "sumiu" da inadimplência de maio mesmo com 2 das 3 já mostrando `status: "RECEIVED"` hoje.
- **`visao_faixas=aberto` x `historico`**, mesmo período de maio/2026: no modo `aberto`, só `pay_mock_010` (ainda `OVERDUE` hoje) aparece nas faixas — soma `540`, no bucket `50_100`. No modo `historico`, as 3 cobranças aparecem, bucketadas por `paymentDate - dueDate` quando já pagas (`pay_mock_018` cai em `40_50` com `2300`) ou `hoje - dueDate` quando não (`pay_mock_010` + `pay_mock_021`, `1840` em `50_100`) — soma total `4140`, batendo com `valor_inadimplente`. Parâmetro inválido (`visao_faixas=abertooo`): `400`.
- **`renegociacoes_abertas` via descrição**: `pay_mock_022` (`OVERDUE`) e `pay_mock_023` (`PENDING`), ambas com "Renegociação" na descrição, somaram `quantidade: 2`, `valor: 1450.00`; `pay_mock_024` (mesma palavra na descrição, mas `status: "RECEIVED"`) **não** entrou na contagem, confirmando o filtro por status em aberto.
- **Filtro `bloqueado`**: valor inválido (`?bloqueado=talvez`): `400`. `bloqueado=sim` restringindo corretamente ao associado Delta (`bloqueado: true`) no período testado — `valor_total_faturado: 3600`, `valor_inadimplente: 2100` (a cobrança "a vencer" da Delta não conta no numerador), batendo com o cálculo manual. Invariante `todos = sim + nao` (soma de `valor_total_faturado`) confirmada tanto em `/resumo` quanto somando os meses de `/evolucao-mensal`. Combinação tripla `renegociacao=sim&em_juridico=sim&bloqueado=nao` (só bate com a Beta) trazendo exatamente as 2 cobranças esperadas, `taxa_inadimplencia_percentual: 100`.
- Suíte automatizada dedicada a esta rodada rodou de ponta a ponta contra um Postgres descartável (`embedded-postgres`) e o mock estendido do Asaas: **44/44 asserções passaram**.

**Período de tolerância (`GET`/`PATCH /api/config/tolerancia-dias`)** — validado com Postgres real (nenhuma migração nova; reaproveita a tabela genérica `configuracoes`) e o mock do Asaas estendido para 29 pagamentos (`pay_mock_025` a `pay_mock_029`, ver seção do mock acima):

- `GET /api/config/tolerancia-dias` antes de qualquer configuração: `{"dias": 0}`.
- **Validação de `PATCH`**: `400` para corpo sem `"dias"`, `dias` negativo, `dias` acima de `30`, `dias` não-inteiro (`2.5`), `dias` como string (`"2"`) e `dias: null`; `200` nos limites `dias: 0` e `dias: 30`, ecoando o valor salvo.
- **Regressão em tolerância 0**: período de 25 dias isolando 10 pagamentos conhecidos do dataset — `valor_inadimplente: 4930.50`, `valor_adimplente: 1475.00`, `taxa_inadimplencia_percentual: 76.97`, `taxa_adimplencia_percentual: 23.03`, faixas `0_20: 3050` e `20_30: 1130.5` — todos idênticos ao comportamento anterior à tolerância, confirmando que `dias=0` não muda nada.
- **Migração de classificação com tolerância 2, mesmo período**: `pay_mock_026`/`pay_mock_027` (pagos com 1-2 dias de atraso) migram de INADIMPLENTE para ADIMPLENTE (`valor_inadimplente` cai para `3980.50`, `valor_adimplente` sobe para `2225.00`); `pay_mock_028` (1 dia em aberto) vira "a vencer" e some do numerador (as duas taxas somam menos de 100%); `pay_mock_025` (21 dias em aberto) desloca de faixa `20_30` para `0_20` (`0_20: 3550`, `20_30: 430.5`) tanto no modo `aberto` quanto no `historico`, com a soma das faixas batendo exatamente com `valor_inadimplente`.
- **Migração fina 1 dia x 2 dias de atraso**: em período isolado (`pay_mock_002`/`016`/`022`/`026`/`027`), tolerância 2 deixa `026` e `027` ambos ADIMPLENTE; tolerância 1 só cobre `026` (1 dia), `027` (2 dias) volta a ser INADIMPLENTE; tolerância 0 devolve os dois a INADIMPLENTE — confirmando o limite exato dia a dia, e que cada mudança de tolerância se refletiu na consulta seguinte **sem `forcar=true`** (prova de que o `PATCH` invalida o cache).
- **`criticos_90_dias` sensível à tolerância, sem mudar de faixa**: `pay_mock_029` (91 dias em aberto) conta em `criticos_90_dias` (`900`) e na faixa `50_100` (`900`) com tolerância 0; com tolerância 2 (atraso efetivo de 89 dias) sai de `criticos_90_dias` (`0`) mas **permanece** na faixa `50_100` (`900`) — isolando o efeito da tolerância sobre o corte de 90 dias do efeito sobre a escolha de faixa, também sem `forcar=true`.
- Suíte automatizada dedicada a esta rodada rodou de ponta a ponta contra um Postgres descartável (`embedded-postgres`) e o mock estendido do Asaas: **47/47 asserções passaram**.

**Histórico unificado de status (`historico_status_associado`) e confirmação de `email` em `POST /api/sync`** — validado com Postgres real, num teste desenhado especificamente para provar que a migração `20260819160000_consolidar_historico_status` preserva dados reais existentes (não só que funciona num banco vazio):

- Aplicadas as 6 primeiras migrações isoladamente (a de consolidação foi temporariamente retirada de `prisma/migrations`), depois inseridas à mão 3 linhas "à moda antiga" — 1 em `historico_negociacao`, 2 em `historico_bloqueio`, associadas a um mesmo associado fictício — simulando dados reais de produção antes do deploy.
- Restaurada a migração de consolidação e reaplicada via `prisma migrate deploy`: as 3 linhas apareceram em `historico_status_associado` com o **mesmo `id` original**, `status_anterior`/`status_novo`/`alterado_em` preservados e `campo` corretamente atribuído (`em_negociacao` para a primeira, `bloqueado` para as outras duas) — confirmado direto no banco, sem passar pela aplicação. `historico_negociacao` e `historico_bloqueio` deixaram de existir (`relation ... does not exist` ao consultar).
- Com o app real rodando sobre esse banco já migrado: `POST /api/sync` enviando `email` tanto para o associado legado (upsert) quanto para um associado novo (create) — `GET /api/associados/:cpf_cnpj` de ambos retornou o `email` salvo corretamente nos dois casos.
- `GET /api/associados/:cpf_cnpj` do associado legado trouxe os 3 registros migrados dentro de `historico` (não mais `historico_negociacao`/`historico_bloqueio` separados), ordenados do mais recente pro mais antigo.
- `PATCH .../negociacao`, `.../bloqueio` e `.../juridico` em sequência: cada um gravou exatamente uma linha nova em `historico_status_associado` com o `campo` certo — a de `.../juridico` é o caso novo (antes desta rodada esse endpoint não gravava histórico nenhum), confirmado com `status_anterior: false`/`status_novo: true` corretos. `GET` seguinte trouxe as 6 linhas (3 legadas + 3 novas) na ordem certa, misturando dado migrado com dado novo sem problema.
- `GET .../bloqueios/contador` (ainda sem reset) contou `2` — as duas marcações como bloqueado do associado (1 migrada + 1 nova), ignorando corretamente a marcação de desbloqueio migrada (`status_novo: false`) — confirmando que o contador migrou de `historico_bloqueio` para a tabela única sem quebrar a lógica de contagem.
- Suíte automatizada dedicada a esta rodada rodou de ponta a ponta contra um Postgres descartável (`embedded-postgres`): **35/35 asserções passaram**.

Antes do primeiro deploy real, recomendamos rodar `docker-compose up --build` localmente para confirmar o build da imagem Docker em si.

⚠️ **Atenção ao aplicar esta versão em produção**: a migração `20260819160000_consolidar_historico_status` **derruba as tabelas `historico_negociacao` e `historico_bloqueio`** depois de copiar os dados para `historico_status_associado` — o teste acima confirma que a cópia preserva tudo, mas, como em qualquer migração que remove tabelas, vale fazer um backup do banco antes do `prisma migrate deploy` em produção, por precaução.

**Sincronização sob demanda (`POST /api/sync/atualizar`)** — validado com Postgres real e um mock HTTP simples fazendo o papel do webhook do n8n (comportamento trocado em tempo de execução: sucesso, erro HTTP, "trava" pra forçar timeout, corpo de resposta que não é JSON):

- `N8N_SYNC_WEBHOOK_URL` não configurada (instância própria do app, sem essa variável): `502`, mensagem citando `"N8N_SYNC_WEBHOOK_URL"` — nenhuma chamada de rede chega a ser tentada.
- Webhook respondendo `200` com `{ status: "ok", syncedAt, totalAssociados }`: `200`, os três campos repassados corretamente convertidos pra `snake_case` (`status`, `synced_at`, `total_associados`).
- Webhook respondendo `500`: `502` (não `500` genérico — deixa claro que o problema foi no upstream), com o corpo da resposta de erro do webhook presente em `detalhe`.
- Webhook "travado" (nunca responde): usando `SYNC_WEBHOOK_TIMEOUT_MS=800` (só pra este teste não precisar esperar os 30s reais), a chamada voltou `502` com mensagem citando "Tempo esgotado" depois de ~858ms — confirmando que o timeout realmente é respeitado (nem retorna instantâneo, nem trava além do configurado).
- Webhook respondendo `200` mas com corpo que não é JSON válido: ainda assim `200` (o `200` já indica que o n8n processou), com `status: "ok"` e os outros dois campos em `null` — confirmando que corpo inesperado degrada graciosamente em vez de virar erro.
- Suíte automatizada dedicada a esta rodada rodou de ponta a ponta contra um Postgres descartável (`embedded-postgres`) e o mock do webhook: **16/16 asserções passaram**.

**Reconciliação de cobranças quitadas (correção de bug — `POST /api/sync`)** — validado com Postgres real, num teste desenhado para reproduzir exatamente o cenário relatado (cobrança paga no Asaas sumindo do payload e ficando "presa" como em aberto no banco):

- Sync 1 cria um associado A com 2 cobranças em aberto (`pay_A1` overdue, `pay_A2` pending) e outros dois associados (B, C) com 1 cobrança cada — `cobrancas_quitadas: 0` (nada a reconciliar na primeira aparição).
- Sync 2 manda A só com `pay_A1` (simulando `pay_A2` paga e removida da consulta do Asaas), manda B **sem a chave `"cobrancas"`** (payload só cadastral) e manda C com `"cobrancas": []` (array vazio explícito) — resposta trouxe `cobrancas_quitadas: 2` (`pay_A2` de A + a única cobrança de C).
- `GET /api/associados?busca=<cpf de A>` depois do sync 2: volta só 1 cobrança em aberto (`pay_A1`) — `pay_A2` sumiu da lista, confirmando a correção do bug.
- `GET /api/associados/<cpf de A>` (detalhe, sem filtro de status): continua trazendo as 2 cobranças — `pay_A2` aparece com `status: "quitada"` e `sincronizado_em` preservado do sync original, confirmando que é reconciliação (não hard delete) e que o histórico financeiro não se perde.
- B (sync sem a chave `"cobrancas"`): sua cobrança **não** foi tocada — continua `overdue` — confirmando que syncs só-cadastrais não quitam nada por omissão.
- C (`"cobrancas": []` explícito): ficou com 0 cobranças em aberto — confirmando que um array vazio é tratado como "nada pendente agora", diferente de omitir a chave.
- `GET /api/associados/resumo` depois do sync 2: `valor_total_aberto` e `com_cobranca_aberto` já refletem só as cobranças que continuam abertas (A e B), sem exigir nenhuma mudança nesse endpoint — o filtro `status IN ('pending','overdue')` que já existia excluiu `"quitada"` automaticamente.
- Sync 3: `pay_A2` volta a aparecer no payload de A (simulando reversão de pagamento) — a reconciliação anterior é desfeita automaticamente (`status` volta a `overdue`, `quitada_em` volta a `null`), sem sync duplicado nem `cobrancas_quitadas` incorreto.
- Suíte dedicada a esta correção: **24/24 asserções passaram**. Suíte completa de regressão também rodada nesta rodada: `historico_status_associado` (**35/35**) e tolerância de dias (**47/47**) continuam passando integralmente — ambas tocam associados/cobranças de perto e não quebraram com a mudança. As suítes de Taxa de Inadimplência (`AJUSTE CRÍTICO`, `valor adimplente/forcar`) apresentaram falhas **pré-existentes e não relacionadas a esta correção**: são testes com datas de vencimento fixas cujo resultado depende de "hoje" (classificação PENDING/OVERDUE/pago-com-atraso muda conforme o calendário avança) — não tocam a tabela `cobrancas` nem o `POST /api/sync` de forma alguma, então não são afetadas por esta mudança. Ficam com data desatualizada há alguns dias e precisam de uma recalibração própria, fora do escopo deste fix.

**Reconciliação global via `"janela"` (correção da lacuna "associado sumiu inteiro do payload")** — validado com Postgres real, reproduzindo exatamente o caso relatado com a Deni: um associado cuja única cobrança em aberto foi paga simplesmente não aparece mais em `"associados"` (o agrupamento do n8n só cria uma entrada quando existe pelo menos uma cobrança pendente/vencida), então o modo por-associado nunca chegava a examinar as cobranças presas dele:

- Sync 1 (sem `"janela"`, modo `por_associado`) cria três associados: Deni (1 cobrança, vencimento dentro da janela que o sync 2 vai usar), Eduarda (1 cobrança, idem) e Fábio (1 cobrança, vencimento **fora** da janela que o sync 2 vai usar).
- Sync 2 manda `{ "janela": { "inicio": "2026-08-01", "fim": "2026-08-31" }, "associados": [Eduarda] }` — **Deni e Fábio não aparecem no payload de jeito nenhum**. Resposta: `"reconciliacao": "global"`, `"cobrancas_quitadas": 1`.
- `GET /api/associados?busca=<cpf da Deni>`: 0 cobranças em aberto — a cobrança dela foi quitada mesmo sem ela ter aparecido no payload, confirmando que a lacuna foi fechada.
- `GET /api/associados/<cpf da Deni>` (detalhe): a cobrança continua lá, agora com `status: "quitada"` — histórico preservado, mesmo comportamento do modo por-associado.
- Fábio (cobrança com vencimento **fora** da janela, também sumiu do payload): continua com a cobrança `overdue`, intocada — confirma que "fora da janela" nunca é quitado só porque o associado sumiu, já que o Asaas nem foi consultado sobre esse intervalo nesta chamada.
- Eduarda (voltou no payload): continua com sua cobrança aberta normalmente.
- Sync 3, com `"janela"` malformada (`inicio: "not-a-date"`): responde `200` normalmente e `"reconciliacao": "por_associado"` — confirma que uma janela inválida não quebra a chamada, só faz cair de volta pro modo antigo.
- Suíte dedicada a este ajuste: **16/16 asserções passaram**. Reconciliação por-associado (sem `"janela"`, suíte da rodada anterior) rodada de novo pra garantir que o modo de compatibilidade não regrediu: **24/24**. `historico_status_associado` também revalidado: **35/35**.

**Cadastro/Faturamento — captura da resposta do n8n (link de pagamento + IDs)** — validado com Postgres real e um mock HTTP simples fazendo o papel do webhook do n8n (comportamento trocado em tempo de execução: sucesso com campos completos, falha de negócio via `"sucesso": false`, corpo sem os campos esperados, "trava" pra forçar timeout, erro HTTP 500):

- Payload inválido (sem os campos obrigatórios): `400`, nem chega a tentar o webhook.
- Webhook responde `200` com `{ sucesso: true, linkPagamento, clienteAsaasId, pedidoBlingId }`: `201`, `status: "enviado"`, os três campos repassados corretamente e também persistidos no banco (confirmado via `GET /api/cadastros`).
- Webhook responde `200` mas com `{ sucesso: false, erro: "CPF inválido" }`: `201` (registro salvo normalmente), mas `status: "erro"` e `resposta_n8n: "CPF inválido"` — confirma que um HTTP `200` não é tratado como sucesso automático, o campo `"sucesso"` do corpo é quem manda.
- Webhook responde `200` com corpo vazio (`{}`, integração ainda sem os campos novos): `status: "enviado"` (sem `"sucesso": false` explícito, trata como sucesso), mas `link_pagamento`/`cliente_asaas_id`/`pedido_bling_id` ficam `null` — degrada graciosamente.
- Webhook "travado" (nunca responde): usando `CADASTRO_WEBHOOK_TIMEOUT_MS=800` (só pra este teste não precisar esperar os 60s reais), voltou `status: "erro"` com `resposta_n8n` citando "Tempo esgotado" depois de ~852ms.
- Webhook responde `500`: `status: "erro"` com `resposta_n8n` citando o status HTTP retornado.

**Geração automática de contratos (modelos, dicionário de variáveis, .docx e Drive)**:

- **CRUD `/api/contratos`** (`test-crud-contratos.js`, 34/34): validação de campos obrigatórios e `tipo` (só `TERMO`/`ADITIVO`) no `POST`; `GET` lista e detalhe (404 pra id inexistente); `PATCH` edita subconjunto de campos e valida os mesmos campos do `POST` quando presentes; `DELETE` é soft-delete (`ativo: false`, idempotente, nunca some da listagem nem do detalhe); filtro `?ativo=true`\|`false`; reativação via `PATCH { ativo: true }`; confirmado que um `CadastroEnviado` referenciando um `ModeloContrato` já desativado continua funcionando normalmente (soft-delete não quebra histórico).
- **Funções de variáveis** (`src/lib/contratoVariaveis.js`, `test-contrato-variaveis.js`, 2/2): os 2 exemplos de aceitação fornecidos (`clausulaPagamentoParcelado` com 2 parcelas + entrada + desconto, `clausulaPagamentoRecorrente` com 11 parcelas) batem **caractere por caractere** com o texto esperado.
- **Dicionário de variáveis e roteamento de cláusula** (`src/services/contratosGeracao.service.js`, `test-contratos-geracao.js`, 22/22): `formatarDataBr`/`somarMeses` (incluindo virada de ano e ajuste pro último dia de fevereiro, bissexto e não-bissexto); roteamento correto (PIX + 1 parcela → à vista, Cartão + 3 parcelas → parcelado, Recorrência → sempre recorrente mesmo com várias parcelas); todos os campos diretos e calculados do dicionário (incluindo `Nome do Associado` com fallback cruzado PF/PJ, `Qualificação`, `Créditos VP$`); um cenário ponta a ponta com os mesmos valores do exemplo de aceitação reproduz exatamente a mesma string esperada, confirmando que as premissas assumidas (data da entrada = data do cadastro, parcelas +1 mês) batem com o exemplo real fornecido.
- **`resolverPlaceholders`**: substitui múltiplas ocorrências da mesma variável, substitui uma variável no meio de uma tag `<strong>` sem quebrá-la, e preserva intacta (sem travar) uma placeholder sem correspondência no dicionário.
- **Geração de `.docx`** (`src/services/docx.service.js`, `test-docx-service.js`, 9/9): fluxo completo modelo HTML → dicionário resolvido → HTML final → `.docx`, com o arquivo gerado inspecionado por dentro (unzip + XML): título vira `Heading1`, negrito preservado, lista numerada gera `numbering.xml` com numeração automática decimal (não texto digitado) — tudo isso **depois** da substituição de placeholders, confirmando que a integração entre as duas etapas não quebra formatação.
- **Integração com Google Drive** (`src/services/drive.service.js` + `gerarContratosParaCadastro`, `test-geracao-contratos-fluxo.js`, 20/20 — rodado em processo, com um cliente Drive fake injetado via `_definirClienteParaTeste`, já que não há credencial real neste ambiente): sem `GOOGLE_SERVICE_ACCOUNT_JSON` configurada, pula a geração sem lançar erro nem alterar o cadastro; com cliente mas sem pasta raiz configurada, idem; fluxo completo de sucesso cria a pasta com o nome de "Nome da pasta" dentro da pasta raiz configurada, sobe o `.docx` com o nome `"<nome do modelo>.docx"` e salva `pasta_drive_id`/`arquivos_gerados` corretamente; falha parcial (1 de 2 modelos falha ao subir) não derruba o outro — resultado parcial é salvo, não é tudo ou nada; cadastro sem nenhum modelo selecionado nem tenta chamar o Drive.
- **Wiring em `POST /api/cadastros`** (`test-cadastro-campos-contrato.js`, 15/15, com Postgres real + mock do webhook n8n): `nomePasta`/`modelosContratoIds` no corpo da requisição são persistidos e devolvidos como `nome_pasta`/`modelos_contrato_ids`; confirmado que **nenhum dos dois vaza pro payload repassado ao n8n** (só os campos em português do formulário original chegam lá); compatibilidade retroativa confirmada (`POST` sem esses 2 campos continua funcionando, `nome_pasta: null`, `modelos_contrato_ids: []`); `pasta_drive_id`/`arquivos_gerados` continuam `null` logo após a resposta (a geração roda em segundo plano); `GET /api/cadastros` traz os campos novos na listagem.
- **Migração do schema** (`20260827090000_add_contratos`) validada rodando `prisma migrate deploy` do zero contra um Postgres real, junto com todas as migrações anteriores, sem erros.
- Suíte dedicada a esta correção: **24/24 asserções passaram**.

**Geração de contratos — "Data da Entrada" como campo real, parcela por extenso e tokens soltos** (`test-contrato-variaveis.js`, 7/7; mais um teste de integração dedicado com Postgres real + cliente Drive fake, 4/4):

- Os 2 exemplos de aceitação originais (`clausulaPagamentoParcelado` e `clausulaPagamentoRecorrente`) foram **atualizados** para incluir o valor da parcela por extenso e continuam batendo **caractere por caractere** com o novo texto esperado (ex.: "...de R$ 1.660,00 (mil e seiscentos e sessenta reais), por meio de..." e "...de R$ 420,00 (quatrocentos e vinte reais), por meio de...").
- `resolverClausulaPagamento` usa `payload["Data da Entrada"]` quando preenchida (confirmado que o texto gerado usa exatamente essa data) e cai no fallback `criado_em` quando o campo vem vazio (confirmado com um payload sem o campo).
- O exemplo de aceitação de tokens soltos pedido explicitamente — colar `{{Número de Parcelas}} ({{Número de Parcelas Por Extenso}})` num modelo e resolver contra o cenário de 11 parcelas — resolve exatamente pra `"11 (onze)"`.
- Os demais tokens soltos (`Valor Total`/`Valor da Entrada`/`Valor da Parcela`, cada um com e sem "Por Extenso", e `Data da Entrada`) validados contra os valores esperados do mesmo cenário (4.980,00 total, 360,00 de entrada, 420,00 por parcela).
- `{{Cláusula de Pagamento}}` (bloco pronto) confirmado que continua resolvendo normalmente lado a lado com os tokens soltos — nenhuma regressão no comportamento existente.
- **Teste de integração** (Postgres real, `gerarContratosParaCadastro` chamada de ponta a ponta com um `ModeloContrato` usando `{{Data da Entrada}}` + todos os tokens soltos + o bloco pronto no mesmo HTML, cliente Drive fake capturando o `.docx` gerado): pasta e arquivo criados corretamente, `.docx` resultante é um ZIP válido (assinatura `PK`) — confirma que a mudança no dicionário não quebrou a integração com `docx.service.js`/`drive.service.js`.
- Nenhuma migração de schema nesta rodada — "Data da Entrada" vai dentro do JSON `cadastros_enviados.payload`, que já existia.

**Correção: geração falhando com "File not found: `<id da pasta raiz>`" quando a pasta raiz é um Drive Compartilhado** (`test-shared-drive.js`, 5/5, Postgres real + cliente Drive fake):

- Causa confirmada: `criarPasta`/`uploadDocx` em `src/services/drive.service.js` não enviavam `supportsAllDrives: true` nas chamadas `files.create` — a API do Drive trata conteúdo de Shared Drives como inexistente sem esse parâmetro, mesmo com a pasta corretamente compartilhada (Editor/Administrador de conteúdo) com a conta de serviço.
- Corrigido adicionando `supportsAllDrives: true` às duas chamadas `files.create` (criação da subpasta do associado e upload de cada `.docx`).
- Teste de regressão dedicado usa um cliente Drive fake que **reproduz fielmente o bug real**: lança `Error("File not found: <id do parent>")` se `supportsAllDrives` não vier `true` em qualquer chamada `files.create` — exatamente o comportamento reportado pelo usuário, com o mesmo id de pasta raiz do relato (`1q1Yld0RpdF0z3eEg7dK2Gc-Q2G5IkGC8`). Confirmado que, com a correção, tanto a criação da pasta quanto o upload do `.docx` completam com sucesso e o registro do Cadastro é atualizado com `pastaDriveId`/`arquivosGerados` normalmente.
- `supportsAllDrives: true` não tem efeito quando a pasta raiz é do "Meu Drive" comum (não-Shared Drive), então a mudança é segura por padrão — não é preciso saber de antemão qual tipo de pasta o cliente vai configurar.

**Token solto `{{Data Vencimento}}`** (`test-token-data-vencimento.js`, 2/2): resolve pro valor bruto do campo "Data Vencimento" do formulário de Cadastro (data da primeira/única parcela), formatado `dd/mm/aaaa` — não é a lista de vencimentos de cada parcela (isso só existe dentro do texto montado por `Cláusula de Pagamento`), só a data única do campo, solta. Sem "Data Vencimento" no payload, resolve pra string vazia em vez de travar a geração.

**Novos formatos no editor de Contratos (itálico, sublinhado, lista com marcadores, alinhamento) + fix de dois bugs reais do `html-to-docx`** (`test-docx-formatacao-combinada.js`, 18/18, gerando `.docx` reais e inspecionando o XML):

- Formatos isolados: itálico (`<em>`, convertido internamente pra `<i>`) e sublinhado (`<u>`) exportam corretamente (`<w:i/>`, `<w:u w:val="single"/>`); os 4 alinhamentos (`style="text-align: ..."` — é assim que `@tiptap/extension-text-align` serializa) viram `<w:jc w:val="center"/>`/`"right"`/`"both"` (nome Word pra "justify") corretamente; lista com marcadores gera `numFmt="bullet"` em `numbering.xml`, com `abstractNum` **separado** da lista numerada (`numFmt="decimal"`) — as duas listas não se misturam.
- Combinações de marcas — o motivo real de precisar do fix em `htmlParaDocxFix.js` — validadas com o HTML exato que o Tiptap gera pra uma seleção com múltiplas marcas (confirmado gerando esse HTML de verdade via `@tiptap/html/server` com a mesma configuração de extensões do editor, não um HTML inventado à mão): negrito+itálico+sublinhado juntos (`<strong><em><u>texto</u></em></strong>`), negrito+sublinhado, negrito+itálico, e o caso "com irmão" (`<strong>texto <em>outro</em></strong>`, que por acaso já funcionava mesmo sem o fix) — todos os 4 cenários preservam **todas** as marcas aplicadas no `.docx` final.
- Regressão: título (`Heading2`), negrito isolado (sem combinação) e numeração automática decimal — já validados em rodadas anteriores — continuam funcionando normalmente depois do fix.
- `npm install` (backend): `cheerio` `^1.2.0` adicionado como dependência nova (usada só em `htmlParaDocxFix.js`).

**Fonte e tamanho no editor de Contratos (font-family/font-size) + fix do 3º bug real do `html-to-docx`** (`test-docx-fonte-tamanho.js`, 20/20, gerando `.docx` reais e inspecionando o XML — mesma técnica das suítes anteriores, HTML gerado via `@tiptap/html/server` com `TextStyle`/`FontFamily`/`FontSize` reais, não inventado à mão):

- Fonte e tamanho isolados (`<span style="font-family: Times New Roman; font-size: 12pt;">`) exportam corretamente: `<w:rFonts w:ascii="...">` com o nome completo da fonte e `<w:sz w:val="...">` no valor certo em meio-ponto do Word (12pt → `24`, 9pt → `18`, 14pt → `28`, 8pt → `16` — conferido contra `pointToHIP` da própria lib, que é `Math.round(2 * pontos)`).
- **Cenário crítico pedido pelo usuário** — fonte+tamanho+negrito+itálico juntos (`<span style="font-family: Arial; font-size: 9pt;"><strong><em>texto</em></strong></span>`, a serialização real do Tiptap pra essa combinação): todos os 4 atributos saem corretos no mesmo `<w:r>` (`w:rFonts`, `w:sz`, `w:b`, `w:i`). Pior caso testado (5 marcas juntas: fonte+tamanho+negrito+itálico+sublinhado) também passa.
- **3º bug real encontrado nessa validação**: nomes de fonte com espaço (Courier New, Times New Roman — 2 das 4 fontes pedidas) saíam quebrados, porque a lib não decodifica `&quot;` no atributo `style` antes de ler `font-family` (ver seção acima). Sem o fix, `w:rFonts` saía como `w:ascii="&amp;quot"` (lixo) em vez do nome da fonte. Corrigido removendo aspas de `font-family` em `htmlParaDocxFix.js` antes de repassar pro `html-to-docx` — evita o problema por completo, já que fontes com espaço funcionam normalmente sem aspas.
- Regressão: fonte isolada sem negrito não ganha `w:b` indevido; só tamanho sem fonte (e vice-versa) funciona; `style` com cor mas sem `font-family` (`color: rgb(...)`) não é tocado pelo fix novo, cor continua aplicada normalmente.

**Nome do arquivo .docx gerado (`"{Tipo} - {Razão Social}.docx"`)** (`test-nome-arquivo.js`, 16/16 — 10 testes unitários de `sanitizarNomeArquivo`/`nomeArquivoContrato` + 6 de integração com Postgres real e cliente Drive fake):

- `nomeArquivoContrato` usa o rótulo do campo "Tipo" (`TERMO` → "Termo de Associação", `ADITIVO` → "Aditivo Contratual"), não o campo "Nome" do modelo (testado com um modelo cujo "Nome" tem texto extra — `"Termo de Associação (Pessoa Jurídica)"` — confirmando que o texto extra não vaza pro nome do arquivo).
- `sanitizarNomeArquivo` substitui por espaço cada um de `\ / : * ? " < > |` e caracteres de controle, colapsa espaços múltiplos e apara as pontas — testado isoladamente e no cenário real pedido (Razão Social com um CNPJ colado junto, contendo "/").
- **Teste de integração de ponta a ponta**: Postgres real (`embedded-postgres`, migrações aplicadas), 2 `ModeloContrato` (`TERMO`/`ADITIVO`) e 1 `CadastroEnviado` selecionando os dois, cliente Drive fake (`_definirClienteParaTeste`, mesma técnica de `test-shared-drive.js`) capturando o `requestBody.name` de cada `files.create`. Confirmado: (a) saem 2 arquivos com nomes diferentes pro mesmo Cadastro; (b) o nome de cada um bate com a regra; (c) o nome efetivamente enviado ao Drive (`requestBody.name`) é idêntico ao persistido em `cadastros_enviados.arquivos_gerados` — sem essa checagem, um bug em `uploadDocx` poderia fazer os dois divergirem sem nenhum teste pegar; (d) um segundo Cadastro com Razão Social suja (`"ACME LTDA 12.345.678/0001-90"`) gera o arquivo já sanitizado, sem lançar erro.

**Autenticação do painel: access token curto + refresh token** (`test-auth-refresh.js`, 22/22, servidor Express real — não mocks de rede — com `JWT_EXPIRES_IN=2s` pra testar expiração de verdade em segundos em vez de esperar minutos):

- Reproduz e confirma a causa raiz do bug relatado: dois `POST /api/login` disparados **em paralelo** (mesmas credenciais, `Promise.all`) geram `token` e `refresh_token` **diferentes** em cada resposta — antes do fix (payload do JWT sem `jti`), esse mesmo cenário gerava o access token idêntico, porque `jwt.sign` é determinístico e o único campo que varia (`iat`) só muda a cada segundo.
- Fluxo completo validado: login → chamada autenticada funciona → access token expira sozinho (2s) → mesma chamada com o token vencido responde 401 com a mensagem exata reportada pelo usuário ("Token de autenticação inválido ou expirado.") → `POST /api/refresh` com o refresh token troca por um par **novo** (access E refresh diferentes dos anteriores) → chamada autenticada volta a funcionar com o access token novo.
- Rotação: reusar o refresh token antigo (já trocado por um novo via `/refresh`) falha com 401 — cada refresh token só serve uma vez.
- Revogação: `POST /api/logout` revoga a sessão; depois disso, nem `/refresh` nem nada derivado dela funciona. Idempotente (chamar de novo com o mesmo token já revogado continua 204). Revogar uma sessão **não** afeta outra sessão independente (mesmo usuário, login simultâneo diferente) — pré-requisito confirmado pro "bloquear usuário imediatamente" do item de expansão multi-franquia.
- Validações básicas: `/refresh` sem `refresh_token` no body → 400; `/refresh` com um valor que nunca existiu → 401 (não 500); `/login` com senha errada → 401 (comportamento antigo preservado).
- `npm install` (backend): nenhuma dependência nova (usa só `jsonwebtoken`, `crypto`, já presentes).

**Multi-franquia — Fase 1: schema + migração de dados** (`20260901130000_add_multi_franquia`, Postgres real, cenário de migração "a quente" — banco populado com o schema **antigo**, migração aplicada por cima, sem `prisma migrate reset`):

- Banco semeado com o schema anterior (migrações até `20260901120000_add_refresh_tokens`) e dados de exemplo em `associados`, `configuracoes`, `api_keys`, `cadastros_enviados`, `modelos_contrato`, `cobrancas_ignoradas` e `sync_log` — simulando produção antes da migração.
- Migração aplicada por cima com `prisma migrate deploy`: sem erros, sem perda de linha nenhuma.
- Confirmado que a franquia semente `"Via Permuta Ribeirão Preto"` foi criada (nome pedido explicitamente, evitando o genérico "Via Permuta") e que **todas** as linhas pré-existentes nas 7 tabelas acima foram backfilladas com o `id` dela — nenhuma ficou com `franquia_id` nulo.
- Confirmado no `information_schema` que `franquia_id` virou `NOT NULL` nas 7 tabelas depois do backfill (inclusive `api_keys` — a correção da primeira versão do plano, que evita quebrar `sync.controller.js`/`cadastros.controller.js` quando `Associado.franquiaId` também for obrigatório).
- **Trava de 1 usuário por franquia** (`@@unique([franquiaId])`): 2 `SUPER_ADMIN` com `franquiaId: null` criados sem problema (Postgres não considera `NULL` pra unicidade); 1º usuário de uma franquia criado normalmente; 2ª tentativa de criar usuário pra **mesma** franquia falha com `P2002` (constraint do banco, não validação de aplicação) — confirma que a trava vale mesmo batendo direto na camada de dados, não só pela tela de Controle Geral (ainda não implementada).
- **`configuracoes` com PK composta** `(chave, franquia_id)`: a mesma chave (`asaas_api_key`) cadastrada em 2 franquias diferentes funciona (2 linhas distintas); tentar cadastrar a mesma chave 2x na **mesma** franquia falha com `P2002`.
- `npm install` (scratch de teste, não no projeto): `embedded-postgres` como dependência de teste — mesmo padrão dos testes anteriores desta suíte de auth.

**Correção de regressão pós-deploy da Fase 1 (configuracoes "sumindo" + creates novos quebrados)** — reportada pelo usuário depois do deploy real em produção (webhook de Cadastro e pasta do Drive apareceram como "Ainda não configurada" na tela, apesar de já estarem salvos):

- **Causa raiz confirmada** (reproduzida com Postgres real: banco no formato antigo e populado → migração da Fase 1 aplicada por cima → código real, ainda não corrigido, rodando em cima): a Fase 1 trocou a chave primária de `configuracoes` de `chave` sozinha pra composta `(chave, franquia_id)`, mas `config.service.js` continuava usando `prisma.configuracao.findUnique/upsert({ where: { chave } })` — seletor que deixou de ser válido. O Prisma lançava um erro de validação em toda leitura, capturado por um `catch` que devolvia `null` silenciosamente (por isso "Ainda não configurada", não um erro visível). **Os dados nunca saíram do banco** — confirmado lendo a tabela `configuracoes` direto, ignorando `config.service.js`: as 5 linhas de configuração seguiam lá, com `franquia_id` corretamente preenchido pelo backfill.
- **Escopo maior do que o relatado**: a mesma causa (coluna `franquia_id` obrigatória sem o código de escrita ter sido atualizado) também quebrava **todo `create`/`upsert` novo** — não só leituras — nas 6 tabelas com `franquia_id` direto: `POST /api/sync` falhava por inteiro (erro 500, lote inteiro rejeitado, não só o registro novo) sempre que um associado novo aparecia no payload; `POST /api/cadastros` (formulário de Cadastro/Faturamento) falhava em toda chamada; criar contrato, exclusão manual de cobrança ou API key novos também falhavam.
- **Correção**: `config.service.js` (leitura/escrita de `configuracoes`, incluindo `getApiKey`/`setApiKey`), `apiKeys.service.js` (as 2 chamadas de `create`), `sync.controller.js` (`syncLog.create` + `associado.upsert`), `cadastros.controller.js` (`cadastroEnviado.create`), `contratos.controller.js` (`modeloContrato.create`) e `inadimplencia.controller.js` (`cobrancaIgnorada.create`) — todos os 9 pontos de leitura/escrita afetados, localizados via busca exaustiva por `prisma.<model>.(create|upsert|findUnique)` nos 6 models tenant-scoped. Novo helper `src/services/franquiaPadrao.service.js` (`obterFranquiaIdPadrao()`, com cache em memória) resolve a única franquia existente hoje — documentado como ponte temporária, a ser substituída na Fase 3 por resolução real via sessão autenticada (`req.auth.franquiaId`).
- **Reteste completo** (Postgres real, reproduzindo o cenário de produção do zero — banco antigo populado → migração → **código corrigido**): todas as 5 leituras de configuração voltam a retornar o valor salvo; escrita de configuração (`setConfigValor`) funciona; `create`/`upsert` novo funciona nas 6 tabelas (associado novo via upsert, cadastro, modelo de contrato, exclusão manual, sync_log, API key nova via `criarChave`, incluindo a nova chave aparecendo na listagem). Complementado com um teste HTTP de ponta a ponta contra o servidor real (não só a camada de serviço): login → `POST /api/sync` com associado que não existia antes (`200`, associado realmente persistido e lido de volta) → `POST /api/cadastros` com payload válido (`201`, registro salvo mesmo com o envio ao n8n falhando — o comportamento de "cadastro nunca trava por causa do n8n" continua intacto) → `GET /api/config/webhook-cadastro` (`200`, valor salvo antes do "deploy" simulado ainda lá).
- **Regra adotada daqui pra frente** (ver `docs/plano-multi-franquia.md`, seção 5.1): nenhuma migração que muda a forma da chave única/primária de uma tabela pode ser considerada pronta sem, no mesmo passo, atualizar e testar (com dado pré-existente no formato antigo) todo ponto do código que lê ou escreve essa tabela — só *adicionar* uma coluna nova é seguro isolar em uma fase "só schema"; *mudar a forma* de uma chave existente não é.

**Multi-franquia — Fase 2, Passo 1: seed automático do SUPER_ADMIN** (`src/services/usuarios.service.js`, Postgres real, banco no formato pós-Fase-1 com `usuarios` vazia — mesmo cenário de produção hoje):

- Tabela `usuarios` vazia + `ADMIN_USER`/`ADMIN_PASSWORD` setados → `seedSuperAdminSeNecessario()` cria exatamente 1 `Usuario`: `papel: "SUPER_ADMIN"`, `franquiaId: null`, `ativo: true`, `senhaHash` validado com `bcrypt.compare` contra `ADMIN_PASSWORD` (bate; senha errada não bate). `email`: `ADMIN_USER` usado como está se já parece um e-mail válido, senão `"<ADMIN_USER>@local"` (testado com `ADMIN_USER=admin` → `admin@local`).
- Idempotência: rodar a função 3x seguidas (simula reiniciar o processo várias vezes) continua com exatamente 1 `Usuario`. Corrida: 5 chamadas disparadas em paralelo (`Promise.all`) numa tabela que já tinha 1 registro não duplicam nem lançam erro (a corrida cai no `catch` de `P2002` em "email", tratada como não-erro).
- Teste de subida real (spawna `node src/server.js` de verdade contra Postgres real, banco recém-migrado, `usuarios` vazia): log `"[usuarios] SUPER_ADMIN semeado automaticamente"` aparece na saída do processo; `POST /api/login` continua funcionando exatamente como antes (senha certa → 200 com token; senha errada → 401) — confirma que o Passo 1 não mudou nenhum comportamento visível, só preparou o terreno pro Passo 2.
- `npm install` (backend): `bcryptjs` `^2.4.3` adicionado como dependência nova — preferida a `bcrypt` (nativa) porque a imagem Docker do backend é `node:20-alpine` (musl), onde compilar módulos nativos é mais frágil; o custo de performance de uma implementação pura em JS é irrelevante aqui (hash de senha acontece só no login/seed, não em um caminho de alta frequência).

**Multi-franquia — Fase 2, Passo 2: login/refresh/logout via `Usuario` + claims JWT (`papel`/`franquiaId`)** — testado contra Postgres real reproduzindo exatamente o cenário de produção pedido: banco migrado até a Fase 1 → uma sessão real e legítima criada com o **código antigo** (`refresh_tokens.usuario = "admin"`, string crua, formato de antes do Passo 2) → deploy do Passo 2 por cima → código novo rodando:

- **Sessão antiga real → `/refresh` → 401 limpo**: chamando `POST /api/refresh` com o refresh token de uma sessão pré-existente (formato antigo) o servidor responde `401 { "error": "Sessão expirada ou revogada. Faça login novamente." }` — nenhum 500, nenhuma exceção não tratada. `rotacionar()` procura um `Usuario` com `id = "admin"`, não acha, trata como sessão inválida (mesmo caminho de "revogado/expirado" que já existia). Confirma a expectativa: toda sessão ativa antes do deploy pede 1 login novo, sem crash.
- **Login novo funcionando**: logo em seguida, `POST /api/login` com `ADMIN_USER`/`ADMIN_PASSWORD` responde `200` com `token`/`refresh_token` novos. Conferido direto no banco que o `refresh_tokens.usuario` dessa sessão nova é um `Usuario.id` de verdade (uuid), não mais a string crua — a mudança de conteúdo semântico do campo (sem migração de schema) funciona como desenhado.
- **Claims do access token**: `jwt.decode` no token novo confirma `sub` = uuid do Usuario, `papel: "SUPER_ADMIN"`, `franquiaId: null` (correto — SUPER_ADMIN sem franquia própria), `jti` presente.
- **Middleware aceitando o token novo**: uma chamada autenticada de verdade (`GET /api/config/sync-log`) com o access token novo passa pelo `middleware/auth.js` normalmente e responde `200`.
- **2º login (fluxo normal, não break-glass)**: com a tabela `usuarios` já populada (não mais vazia), um novo `POST /api/login` com as mesmas credenciais vai pelo caminho `buscarPorEmail` normal e continua funcionando (`200`).
- **Senha errada**: `401`, sem vazar se o usuário existe ou não.
- **Rotação de sessão nova**: `POST /api/refresh` com o refresh token de uma sessão criada já pelo código novo funciona normalmente (rotação, `200`, novo par de tokens).
- **Usuário desativado**: com `ativo: false`, tanto `POST /api/login` (`401 "Usuário desativado. Fale com o administrador."`) quanto `POST /api/refresh` de uma sessão já existente desse usuário (`401`) são bloqueados — confirma os dois pontos de checagem (`login` e `rotacionar`).
- **Break-glass explícito**: com a tabela `usuarios` truncada de propósito (cenário anômalo) e nenhum refresh token válido, `POST /api/login` com `ADMIN_USER`/`ADMIN_PASSWORD` semeia o `SUPER_ADMIN` na hora e loga com sucesso (`200`), sem exigir reiniciar o processo.
- Todos os 4 arquivos alterados (`usuarios.service.js`, `refreshTokens.service.js`, `auth.controller.js`, `middleware/auth.js`) passaram `node --check` antes deste teste funcional.
- **Design confirmado seguro**: `refresh_tokens.usuario` não teve o schema alterado (continua `String`, sem migração, sem backfill) — só o conteúdo que passou a ser semanticamente diferente (Usuario.id em vez de login cru). Isso elimina o padrão de risco do incidente da Fase 1 (mudança de forma de chave sem atualizar todo o código que lê/escreve) porque não há migração de forma nenhuma acontecendo aqui.

**Multi-franquia — Fase 3: Prisma Client Extension de isolamento por franquia + wiring dos 6 controllers** (`src/config/prismaComEscopo.js`, `src/middleware/escopoFranquia.js`) — testado em duas camadas contra Postgres real, com um cenário de **2 franquias reais, 2 usuários (um por franquia), dados de ambas** (associados, cobranças, modelos de contrato, exclusão manual, sync log, API keys):

- **Camada 1 — extension isolada** (sem HTTP, chamando `criarPrismaEscopado(franquiaId)` direto): `findMany` de um client escopado pra franquia A só retorna os registros de A, nunca os de B (e vice-versa). `findUnique` de A buscando pelo cpf/cnpj de um associado de B retorna `null` — tanto num model de escopo direto (`Associado`) quanto num de escopo por relação (`Cobranca`, buscando pelo `id_externo` de uma cobrança de B). `update`/`delete` de A tentando mexer num registro de B são **rejeitados** (erro com `code: "P2025"`, mesmo formato que o Prisma usa pra "não encontrado" — compatível com todo `catch` existente que já tratava esse código) — confirmado que o registro de B continua intacto depois da tentativa. `create` de A tentando forçar um `associadoId` de B (model de relação) é rejeitado (404, "Associado não encontrado nesta franquia"); `create` de A tentando forçar um `franquiaId` de B explícito (model de escopo direto) também é rejeitado (403). `upsert` de A usando o cpf/cnpj de um associado de B é rejeitado com conflito (409) — confirmado que o registro de B não foi sobrescrito. `createMany` com um lote misto (1 item de A, 1 de B) é rejeitado **por inteiro** — confirmado que zero linhas foram inseridas (tudo-ou-nada, não filtragem parcial). Cliente "irrestrito" (`franquiaId: null`, o caso do `SUPER_ADMIN` sem `?franquia_id=` explícito) vê os registros de **ambas** as franquias, como desenhado.
- **Camada 2 — round-trip HTTP real** (servidor real rodando, login de verdade): `GET /api/associados` com sessão do usuário de A retorna só o associado de A. `GET /api/associados/:cpf_cnpj` de A buscando o cpf de B responde `404` (não vaza a existência do registro). `PATCH /api/associados/:cpf_cnpj/bloqueio` de A tentando bloquear o associado de B responde `404`, e o associado de B continua desbloqueado depois da tentativa. `GET /api/config/sync-log` e `GET /api/contratos` de A não trazem nada de B.
- **O caso concreto que embasou todo o desenho** (seção 4 do plano) — a reconciliação global de `POST /api/sync` (`prisma.cobranca.updateMany` sem filtro de associado nenhum, modo "janela"): sincronizado com a **API key da franquia A**, numa janela que cobre o vencimento da cobrança de B, sem mencionar o associado de B no payload — antes do teste isso marcaria a cobrança de B como quitada por engano (o bug que a extension existe pra evitar). Com a extension: a cobrança de B **continua `"pending"`** depois do sync de A (confirmado direto no banco), enquanto a cobrança de A (também não mencionada nesse sync) **é corretamente marcada `"quitada"`** pela reconciliação — prova que o isolamento bloqueia só a franquia errada, sem quebrar o comportamento correto pra franquia certa.
- Também testado (via a mesma extension): autenticação por API key passa a resolver `req.auth.franquiaId` a partir da própria chave usada (`apiKeys.service.js:validarChave`, que agora retorna `{ franquiaId }` em vez de `true`/`false`) — é o que permite `sync.controller.js`/`cadastros.controller.js` (autenticados por API key, não JWT) terem `req.prisma` escopado corretamente.
- **Escopo desta etapa, deliberado**: a extension cobre os 8 models tenant-scoped listados no plano (`associado`, `cadastroEnviado`, `modeloContrato`, `cobrancaIgnorada`, `syncLog`, `apiKey` — escopo direto; `cobranca`, `historicoStatusAssociado` — escopo por relação). `configuracoes` (webhook, chave do Asaas, palavras excluídas, tolerância, pasta do Drive) **não** foi incluída nesta etapa — continua resolvendo a franquia via a ponte `franquiaPadrao.service.js` (agora só usada por ela e, como fallback explícito só pro `SUPER_ADMIN` sem seleção, pela criação de API key) — porque `Configuracao` não está na lista de models da extension no plano, e uma resolução completa exigiria a tela "Controle Geral"/seletor de franquia pro `SUPER_ADMIN` (seção 6 do plano), ainda não construída. `src/services/contratosGeracao.service.js` (job assíncrono disparado em segundo plano depois da resposta HTTP de `POST /api/cadastros`, ver `setImmediate`) também continua usando o client global — opera sempre sobre um `cadastroId` já resolvido e conhecido, fora do ciclo de vida da requisição, então não foi trocado por `req.prisma` nesta etapa e não foi testado por não ter isso.
- Também exigiu um pequeno refactor em `associados.controller.js`: as 3 chamadas a `prisma.$transaction([...])` (array) viraram `prisma.$transaction(async (tx) => ...)` (callback) — a extension faz checagens assíncronas extras antes de cada operação, o que quebra o contrato de "PrismaPromise batchável" exigido pela forma array; a forma callback é a documentada como compatível com extensions. E as 3 consultas de `listar`/`resumo` em `associados.controller.js` que usam `$queryRaw` (SQL cru) ganharam o filtro de franquia adicionado manualmente (`a.franquia_id = ...`) — Prisma Client Extensions não interceptam `$queryRaw`/`$queryRawUnsafe`, só chamadas via ORM.

**Multi-franquia — Passo 4: configurações por franquia** (fecha o gap deixado deliberadamente em aberto no fim da Fase 3 acima — `configuracoes` e `contratosGeracao.service.js` continuavam na ponte `franquiaPadrao.service.js`) — 4 itens, cada um testado contra Postgres real antes do próximo:

- **Item 1 — `configuracoes` e credencial do Google por franquia**: todos os getters/setters de `config.service.js` (`asaas_api_key`, `n8n_webhook_cadastro_url`, `drive_pasta_raiz_id`, `inadimplencia_dias_tolerancia`, `inadimplencia_palavras_excluidas` e a nova `google_service_account_json`) passaram a exigir `franquiaId` explícito — sem fallback interno silencioso —, e todo handler de `config.controller.js` passou a resolver esse `franquiaId` via um novo helper compartilhado, `resolverFranquiaIdOuPadrao(req)` (em `franquiaPadrao.service.js`): usa `req.franquiaId` quando existe, cai na franquia padrão só pro caso pragmático do `SUPER_ADMIN` irrestrito (sem `?franquia_id=`) — substitui a checagem local que antes vivia duplicada dentro de `config.controller.js`. `GOOGLE_SERVICE_ACCOUNT_JSON` saiu de variável de ambiente global e virou mais uma chave em `configuracoes`, por franquia, com endpoints novos (`GET`/`PATCH /api/config/google-service-account`) que nunca ecoam a chave privada — só `{ configurado, client_email, project_id }`, extraídos por um parser que aceita o mesmo formato de sempre (JSON cru ou base64). Migração automática no boot (`migrarGoogleServiceAccountJsonSeNecessario`, mesmo padrão idempotente de `seedSuperAdminSeNecessario`): se a variável de ambiente estiver setada, copia o valor pra dentro de `configuracoes` da franquia padrão **só se ela ainda não tiver esse valor salvo** — nunca sobrescreve uma edição feita depois pela tela.
  - **Testado** (Postgres real, 2 franquias de teste + a franquia padrão real pré-existente do ambiente — descoberta em runtime via `orderBy: criadoEm asc`, não assumida): as 6 configurações lidas/escritas por A e por B nunca vazam entre si (inclusive `google_service_account_json` — GET nunca retorna a chave privada de nenhuma franquia). PATCH com JSON de credencial inválido → `400`. Sem token → `401`. `SUPER_ADMIN` irrestrito lê/escreve corretamente a franquia padrão real (provado gravando um valor conhecido direto via Prisma nela e confirmando via GET autenticado como `SUPER_ADMIN`). 2 subidas reais do servidor confirmaram que a migração automática é idempotente: editar o valor via API e reiniciar o processo **não** reverte pro valor semeado do ambiente.
- **Itens 2+3 — validação de `modelosContratoIds` na entrada + defesa em profundidade em `contratosGeracao.service.js`**: `POST /api/cadastros` passou a validar, **em lote**, que todo id em `modelosContratoIds` existe em `req.prisma.modeloContrato` (ou seja, pertence à franquia de quem está enviando) antes de criar qualquer coisa — um único id estranho (de outra franquia, ou inexistente) rejeita a requisição inteira (`400`, tudo-ou-nada, mesma filosofia já usada em `createMany` na Fase 3). Como defesa em profundidade — não confiar só nesse único ponto de checagem —, a query `prisma.modeloContrato.findMany` dentro de `contratosGeracao.service.js` (que roda em background via `setImmediate`, fora do `req.prisma`) ganhou o filtro `franquiaId: cadastro.franquiaId`, usando o campo que já estava disponível em memória depois do load do cadastro.
  - **Testado** (Postgres real, HTTP real): id de outra franquia → `400`, nada persistido; mistura de id válido + inválido → `400`, nada persistido; id inexistente → `400`; id da própria franquia → `201` normal; sem `modelosContratoIds` → `201` normal (não quebrou o fluxo sem contrato). Defesa em profundidade provada à parte: um `CadastroEnviado` corrompido de propósito via Prisma direto (contornando a validação de entrada, simulando um bug futuro ou dado legado) com um id de outra franquia misturado — `gerarContratosParaCadastro` gerou **só** o arquivo do modelo da franquia certa, nunca o da errada.
  - **Regressão auto-detectada e corrigida antes de qualquer teste**: threadar `franquiaId` obrigatório em `getDrivePastaRaizId` (Item 1) quebrou silenciosamente `drive.service.js:criarPasta`, que ainda chamava a função sem argumento nenhum — identificado por leitura de código, não por um teste falhando, e corrigido junto (`criarPasta(nome, drive, franquiaId)`, com `contratosGeracao.service.js` passando `cadastro.franquiaId`) antes de rodar qualquer teste dos Itens 2+3.
- **Item 4 — credencial/pasta do Drive por franquia em `drive.service.js`**: o `clienteCache` de módulo único virou `clienteCachePorFranquia` (`Map<franquiaId, driveClient>`) — `obterClienteDrive(franquiaId)` agora é assíncrono, lê a credencial de `configuracoes` (via `getGoogleServiceAccountJson`, Item 1) em vez de `process.env.GOOGLE_SERVICE_ACCOUNT_JSON`, e cacheia por franquia. Novo `invalidarClienteCache(franquiaId)`, chamado por `config.controller.js:atualizarGoogleServiceAccount` logo depois de salvar uma credencial nova — sem isso, trocar a credencial pela tela só valeria depois de reiniciar o processo.
  - **Testado** (Postgres real, servidor real rodando **no mesmo processo do script de teste** de propósito — ver `item4-tests.js` — porque o cache de `drive.service.js` é um `Map` de módulo: só dá pra observar a identidade dos objetos cacheados chamando `obterClienteDrive` no mesmo processo Node que o servidor, não via uma segunda chamada HTTP): `PATCH /api/config/google-service-account` real de A e de B com credenciais diferentes → `obterClienteDrive(A)` chamado 2x retorna a **mesma instância** (cache funcionando); `obterClienteDrive(B)` retorna uma instância **diferente** da de A (isolamento por franquia, não é 1 cache global). Um novo `PATCH` real trocando a credencial de A → a próxima `obterClienteDrive(A)` retorna uma instância **nova** (prova que o `PATCH` de verdade, passando pelo controller de verdade, invalidou o cache que o `obterClienteDrive` de verdade usa — não um cache de teste isolado) — e `obterClienteDrive(B)` continua retornando a mesma instância de antes (invalidar A não mexeu no cache de B). `obterClienteDrive(undefined)` retorna `null` sem lançar. Fechado com um teste fim-a-fim real: `gerarContratosParaCadastro` (função real, não mockada) processando um cadastro real da franquia A, com só o client Drive final substituído por um fake (pra não bater na API do Google de verdade) — gerou o arquivo certo, usando a pasta raiz e o client resolvidos pela franquia certa.
- `node --check` rodado em todos os arquivos tocados nos 4 itens antes de cada rodada de teste (`config.service.js`, `franquiaPadrao.service.js`, `apiKeys.service.js`, `config.controller.js`, `config.routes.js`, `inadimplencia.controller.js`, `asaas.service.js`, `cadastros.controller.js`, `contratosGeracao.service.js`, `drive.service.js`). Frontend (`lib/api.js`, `app/configuracoes/page.js`, novo card "Credencial do Google (conta de serviço)" com `<textarea>`, nunca exibe a credencial salva) verificado por parse (`acorn`/`acorn-jsx`) — `next build`/`next lint` não puderam rodar neste sandbox (erro de permissão `EPERM` num arquivo de `.next/`, ambiente com um dev server ativo segurando lock; não é um problema introduzido por este passo).

**Multi-franquia — Etapa 5: tela "Controle Geral"** (`middleware/exigirSuperAdmin.js`, `controllers/franquias.controller.js`, `controllers/usuarios.controller.js`, `routes/franquias.routes.js`, `routes/usuarios.routes.js`, novos endpoints listados na tabela acima) — fecha o último item em aberto da Fase 3 (seção 6 do plano): até aqui só existia a franquia semeada pela migração; esta etapa é o que permite criar uma 2ª franquia de verdade em produção.

- **Visibilidade e proteção**: `middleware/exigirSuperAdmin.js` (403 se `req.auth.papel !== 'SUPER_ADMIN'`, mesmo autenticado) protege todas as rotas de `/api/franquias` e `PATCH /api/usuarios/:id`/`POST /api/usuarios/:id/resetar-senha` — a aba "Controle Geral" no frontend (`AppHeader.js`) só aparece no menu pra SUPER_ADMIN, mas isso é só UX (`components/RequireSuperAdmin.js` redireciona quem não é SUPER_ADMIN pro Dashboard antes de tentar chamar a API); a proteção que importa é a do backend — testado batendo direto nas 3 rotas como usuário de franquia comum, sempre `403`.
- **Franquias**: `POST /api/franquias` cria a franquia e o usuário titular (papel `FRANQUIA`) numa única transação Prisma — não existe franquia "vazia" neste desenho; se o e-mail do usuário colidir com outro já existente, a transação inteira faz rollback (`409`, nenhuma franquia órfã fica pra trás). `PATCH /api/franquias/:id` edita o nome a qualquer momento e ativa/desativa — desativar chama `refreshTokens.revogarTodasDoUsuario` além de contar com o check de `franquia.ativo` que `POST /api/login`/`POST /api/refresh` já faziam desde a Fase 2 (ver seção 2 do plano) — o efeito é bloqueio **imediato**, não só em logins futuros.
- **Usuários**: `PATCH /api/usuarios/:id` bloqueia/desbloqueia um usuário individual (mesmo mecanismo de revogação imediata, controle separado do de franquia no banco/API mesmo com efeito prático idêntico hoje). `POST /api/usuarios/:id/resetar-senha` deixa o SUPER_ADMIN definir uma senha nova sem saber a antiga, revogando as sessões abertas na hora. Um SUPER_ADMIN não consegue bloquear a própria conta por `PATCH /api/usuarios/:id` (`400` — usa `/api/perfil`, ver abaixo, com o objetivo de nunca se trancar fora sem querer).
- **Perfil do próprio SUPER_ADMIN**: `GET`/`PATCH /api/perfil` (rota genérica, não travada a SUPER_ADMIN, mas hoje só usada por ele) resolve o item 5 do escopo — "hoje isso só é possível via SQL direto no banco". Toda troca (mesmo só de nome) exige `senha_atual` correta (`401` caso contrário); trocar `senha_nova` revoga as demais sessões abertas.
- **Seletor de franquia (frontend)**: `SUPER_ADMIN` precisa escolher uma franquia (dropdown no topo, `components/FranquiaSelector.js`, franquia salva em `localStorage`) antes de ver Dashboard/Cadastro/Contratos/Configurações/Taxa de Inadimplência (`components/RequireFranquiaSelecionada.js` mostra um estado vazio orientando a escolher, em vez de tentar renderizar sem franquia) — mecanicamente, o frontend passa a anexar `?franquia_id=...` em toda chamada autenticada (`lib/api.js:comFranquiaSelecionada`), o mesmo parâmetro que a extension de isolamento já aceitava desde a Fase 3 (`resolverFranquiaIdDaRequisicao`). "Controle Geral" é a única tela que não passa por esse guard — é cross-franquia por natureza.
- **Testado** (Postgres real, servidor real rodando **no mesmo processo do script de teste**, cenário de produção — tabela `usuarios` vazia no boot, só a franquia padrão da migração da Fase 1 existindo): login inicial do SUPER_ADMIN semeado no boot; `GET /api/franquias` mostra só a franquia padrão com `usuario: null` (nunca teve um usuário `FRANQUIA` vinculado — o caso real de produção hoje); validação de entrada de `POST /api/franquias` (`usuario` ausente, e-mail inválido, senha curta, todos `400`); criação de 2 franquias reais (A e B) com usuários titulares; e-mail duplicado rejeita a transação inteira sem deixar franquia órfã (confirmado contando franquias antes/depois); os 2 usuários novos tomam `403` em toda rota de Controle Geral, mas `GET /api/perfil` funciona normalmente pros dois; isolamento real fim-a-fim (cada usuário cria um `ModeloContrato` via `POST /api/contratos`, cada um só vê o próprio em `GET /api/contratos` — zero registro da outra franquia aparecendo); SUPER_ADMIN alternando `?franquia_id=A`/`?franquia_id=B` vê só os dados de cada uma por vez, e o modo irrestrito (sem parâmetro) vê as duas — confirma que o filtro é real; editar nome da franquia; desativar franquia bloqueia login (`401 "Franquia desativada"`) E revoga na hora um refresh token emitido **antes** da desativação (`401` no `/refresh`, não só no próximo login); reativar restaura o login; bloquear/desbloquear usuário individual com o mesmo padrão de revogação imediata; resetar senha invalida a senha antiga e a nova já funciona; SUPER_ADMIN não consegue bloquear a si mesmo (`400`); `PATCH /api/perfil` exige `senha_atual` (`400` se ausente, `401` se errada) e, depois de trocar nome/e-mail/senha de verdade, o login antigo (`ADMIN_USER`/senha original) para de funcionar e só o e-mail/senha novos funcionam — prova que a troca afeta o fluxo de login real, não só a resposta da API. Conferência final: 3 franquias (padrão + A + B), nenhuma perdida/duplicada, cada uma com o usuário certo.
- Frontend: `next build` e `npm run lint` reais rodados com sucesso (rotas geradas incluindo `/controle-geral`; 0 erros/warnings de lint) — desta vez sem o bloqueio de sandbox visto no Passo 4, rodando numa cópia em `/tmp` com `npm install` completo (o `.next/` do diretório montado do Windows manteve o mesmo problema de permissão `EPERM` de sempre, contornado da mesma forma). Um erro real de lint foi pego e corrigido: `window.location.href` dentro de um handler de clique (troca de franquia — navegação "dura" deliberada, pra forçar remontagem de toda a tela com a franquia nova) disparava a regra nova do React Compiler (`react-hooks/immutability`) e a regra do Next (`no-location-assign-relative-destination`), ambas assumindo que toda navegação interna deveria ser `router.push` — corrigido com um `eslint-disable-next-line` comentado explicando a exceção deliberada.

**Kanban Jurídico + Restrição de telas por franquia** (`prisma/schema.prisma` — models `EtapaJuridico`/`CardJuridico` + `Franquia.recursosPermitidos`, migração `20260902141630_add_juridico_kanban_e_recursos_franquia`, `middleware/exigirRecurso.js`, `controllers/juridico.controller.js`, `routes/juridico.routes.js`, `franquias.controller.js` estendido, `refreshTokens.service.js` — claim `recursosPermitidos` no access token) — as duas frentes do pedido, testadas juntas por dependerem uma da outra (a franquia de teste do Kanban só existe com recurso `juridico` liberado).

- **Restrição de telas**: `middleware/exigirRecurso(chave)` aplicado em todas as 6 rotas de tela (`associados`, `inadimplencia`, `cadastros`, `contratos`, `config`, `juridico`) + `sync/atualizar`. SUPER_ADMIN e sessões por API key sempre isentos; franquia comum é checada contra o banco a cada requisição (nunca contra o JWT).
- **Testado** (Postgres real, servidor real no mesmo processo do script de teste, cenário de produção — franquia semeada pela Fase 1 + 2 franquias novas criadas de verdade via API): migração backfillou a franquia padrão com os 6 recursos completos (nenhum acesso perdido). Franquia A criada com `recursos_permitidos: ["dashboard", "juridico"]` só acessa essas duas telas — as outras 4 (`GET /api/contratos`, `/api/inadimplencia/resumo`, `/api/cadastros`, `/api/config/sync-log`) tomam `403`, testado direto na API (não só escondido no frontend). Franquia B criada **sem** informar `recursos_permitidos` nasceu com todos os 6 liberados (default do controller). `POST /api/franquias`/`PATCH /api/franquias/:id` com chave de recurso inventada → `400`. SUPER_ADMIN acessando `/api/contratos?franquia_id=<A>` (franquia que NÃO tem `contratos` liberado) → `200`, sempre irrestrito. `PATCH /api/franquias/:id` liberando `contratos` pra franquia A e, **sem novo login**, o mesmo access token da franquia A já acessa `/api/contratos` normalmente — prova que a checagem é em tempo real, não fica presa ao JWT (que, aliás, foi decodificado no teste e confirmado carregar o claim `recursosPermitidos` certo pra franquia comum e nenhum claim pro SUPER_ADMIN). Removendo `juridico` da franquia A depois de já ter usado a tela → `GET`/`POST /api/juridico/etapas` passam a `403` imediatamente. API key da franquia B (sem `dashboard` liberado) chamando `POST /api/sync` → cai direto na validação normal do payload (`400`), nunca no `403` de recurso — confirma a isenção de API key.
- **Kanban**: `POST /api/juridico/etapas` cria colunas com `ordem` sequencial; `POST /api/juridico/etapas/reordenar` reindexa corretamente (testado com uma reordenação real: `[C, A, B]`). Card vinculado a associado (`POST /api/juridico/cards` com `associado_id`) exibe nome/CPF-CNPJ/telefone/valor em aberto — confirmado que o valor em aberto é recalculado **ao vivo**: mudou o valor de uma cobrança direto no banco, sem tocar no card, e o próximo `GET /api/juridico/etapas` já refletiu o novo valor. Card livre com `titulo`/`descricao` funciona sem associado. Validações: nem `associado_id` nem `titulo` → `400`; os dois juntos → `400`; `associado_id` + `descricao` junto → `400` (card vinculado nunca tem descrição própria — mesma regra aplicada em criação e edição). `PATCH .../mover` moveu um card pra outra etapa, reindexou a etapa de origem (fechou o buraco) e a de destino, e preencheu `etapa_alterada_em`. `DELETE /api/juridico/etapas/:id` com card dentro → `409` com `total_cards`; com `?confirmar=true` → `200`, e o card confirmado removido em cascata via consulta direta ao banco. **Isolamento**: etapa criada pela franquia B nunca aparece no board da franquia A (e vice-versa); A tentando `PATCH` numa etapa da B pelo id direto → `404` (nunca vaza dado nem confirma existência de outra franquia).
- `node --check` em todos os arquivos backend tocados; frontend: `npm run lint` e `next build` reais (rotas geradas incluindo `/juridico`), 0 erros/warnings, rodados na mesma cópia `/tmp` de sempre.


**Observações + Histórico de alterações no Kanban Jurídico + Múltiplos usuários por franquia** (migração `20260902150000_juridico_observacoes_historico_e_usuarios_multiplos`, `juridico.controller.js`, `middleware/exigirRecurso.js`, `franquias.controller.js`/`usuarios.controller.js` estendidos, `refreshTokens.service.js`) — três ajustes testados juntos (a suíte de múltiplos usuários depende do Jurídico pra provar "mesmos dados, telas diferentes"), contra Postgres real, servidor real no mesmo processo do script de teste:

- **Migração preservando dado existente** (o cenário de maior risco deste ajuste, mesmo padrão do incidente da Fase 1 documentado na seção 5.1 do plano — mudar a forma de uma chave existente e migrar dado entre tabelas): banco semeado **antes** da migração (schema até `20260902141630_...`) com uma franquia real e 1 usuário, `recursos_permitidos` deliberadamente diferente do default (`["dashboard", "contratos"]`, não a lista completa — pra não confundir "preservou" com "sempre foi tudo liberado mesmo"). Migração aplicada por cima: `usuarios.recursos_permitidos` do usuário migrado bate **exatamente** com o que a franquia tinha antes (nem a mais, nem a menos, conferido depois da migração); índice único `usuarios_franquia_id_key` confirmado removido do banco (consultado no `pg_indexes`, não assumido).
- **Observações**: card livre criado com `observacoes` → persiste na criação e ao listar o board (`GET /api/juridico/etapas`); `PATCH` edita e depois limpa (`observacoes: null`) normalmente. Card vinculado a associado: `observacoes` junto no `POST` → `400`; card vinculado sempre serializa `observacoes: null`; `PATCH` tentando setar `observacoes` num card vinculado → `400`.
- **Histórico** (`historico_card_juridico`, consultado direto pelo Prisma no teste — não existe rota que exponha essa tabela ainda): evento `"criacao"` ao criar; evento por campo editado (`observacoes`, `titulo`, `responsavel` testados individualmente) com `valor_anterior`/`valor_novo` corretos; **enviar o mesmo valor já salvo não gera evento novo** (testado explicitamente — PATCH repetindo `observacoes: null` depois de já estar `null` não muda a contagem de eventos); evento `"etapa"` ao mover card pra outra coluna, com a etapa origem/destino certas; **reordenar dentro da mesma etapa não gera evento** (testado explicitamente — mover o card pra outro índice na mesma etapa mantém a contagem); evento `"exclusao"` registrado, e o registro **continua consultável depois do card já não existir** (histórico sem FK pro card, de propósito). **Isolamento por franquia**: usando `criarPrismaEscopado(franquiaId)` (a mesma extension da Fase 3, já que `historicoCardJuridico` está no `ESCOPO_DIRETO`) direto, sem passar por rota nenhuma — o escopo de uma franquia nunca retorna evento de outra, e o evento de criação do card da franquia 2 aparece só no escopo dela.
- **Múltiplos usuários por franquia**: franquia de teste criada já com o titular (`recursos_permitidos: ["juridico", "dashboard"]`); `POST /api/franquias/:id/usuarios` adiciona um 2º usuário com `recursos_permitidos` **próprios** (`["juridico", "configuracoes"]`, deliberadamente diferente do titular) — `GET /api/franquias` confirma que a franquia agora lista os 2. Os dois usuários logam e veem **exatamente as mesmas etapas jurídicas** (mesmos dados da franquia, nenhuma separação por usuário nos dados) mas com **telas diferentes**: o usuário extra acessa `/api/config/palavras-excluidas` (tem `configuracoes`) e toma `403` em `/api/associados/resumo` (não tem `dashboard`); o titular é o oposto — prova que `exigirRecurso` está checando o usuário autenticado, não mais a franquia. **Desativar a franquia bloqueia os dois de uma vez**: capturado o refresh token de cada um antes de desativar, depois da desativação tanto o login quanto o `/refresh` de **ambos** os usuários (titular e extra) voltam `401` — não só o titular, que era o único caso possível antes deste ajuste.
- 56/56 asserções passaram (script de teste, `test-juridico-multifranquia.js`, mesmo padrão dos scripts anteriores desta suíte — Postgres embarcado via `embedded-postgres`, servidor real, chamadas via `fetch`).
- `node --check` em todos os arquivos backend tocados (19 arquivos, incluindo os que só tiveram mudança de `mtime` por causa do resto do pacote, sem mudança de lógica); frontend: `npm run lint` e `next build` reais (cópia fresh em `/tmp` — o `node_modules` do diretório montado do Windows estava com uma dependência de lint quebrada, `hermes-parser` sem `dist/index.js`, e reinstalar direto ali não terminou a tempo por causa da lentidão do mount de rede; a validação seguiu pela cópia local de sempre, sem tocar nesse `node_modules`) — limpos, 0 erros/warnings, as 10 rotas (incluindo `/juridico` e `/controle-geral`) prerenderizando normalmente.


**4 ajustes: redirecionamento pós-login, excluir franquia permanentemente, observações no card vinculado, histórico do card na UI** (nenhuma migração nova pro Jurídico — reaproveita `historico_card_juridico`/`observacoes` já existentes; endpoint novo `DELETE /api/franquias/:id/excluir-permanente`; `lib/auth.js:rotaInicial()` no frontend) — quatro ajustes independentes testados juntos contra Postgres real, servidor real no mesmo processo do script de teste (`test-ajustes-brief.js`, mesmo padrão de sempre):

- **Observações/Descrição em card vinculado a associado** (antes só existiam em card livre): `POST`/`PATCH /api/juridico/cards` com `associado_id` + `descricao`/`observacoes` juntos passam a ser aceitos (`201`/`200`, valores persistidos e devolvidos); `titulo` continua exclusivo de card livre (`400` em ambas as rotas se enviado junto com `associado_id`); card livre (regressão) continua aceitando os três campos normalmente.
- **Histórico do card na UI** (endpoint novo `GET /api/juridico/cards/:id/historico`, já com o log gravado por `registrarHistoricoCard` desde o ajuste anterior — só faltava a rota + a tela): responde com os eventos do card em ordem cronológica reversa (mais recente primeiro — confirmado comparando a posição de um evento `"etapa"` feito por último contra o evento `"criacao"` feito primeiro), cada um com `campo_alterado`/`valor_anterior`/`valor_novo`/`usuario_id`/`usuario_nome` (resolvido à parte, já que a tabela não tem FK pro usuário, de propósito)/`criado_em`. Isolamento por franquia: usuário de outra franquia tentando ler o histórico de um card que não é dele toma `404` (mesmo padrão de "não vaza a existência do registro" já usado no resto da API). Card removido: o endpoint passa a responder `404` (o card em si já não existe mais — mesma regra de acesso das outras rotas de card), mas o histórico **continua no banco** (evento `"exclusao"` incluso, gravado antes do delete de verdade — confirmado consultando `historico_card_juridico` direto, ignorando a rota).
- **Excluir franquia permanentemente** (`DELETE /api/franquias/:id/excluir-permanente`, ALTO RISCO — hard delete, distinto de `PATCH .../ativo` que continua reversível) — a parte mais sensível deste ajuste: antes de implementar, foi levantada a lista **completa** de tabelas com `franquia_id` direto lendo o `schema.prisma` (11 relações no model `Franquia` — `usuarios`, `associados`, `cadastrosEnviados`, `modelosContrato`, `cobrancasIgnoradas`, `syncLogs`, `apiKeys`, `configuracoes`, `etapasJuridico`, `cardsJuridico`, `historicosCardJuridico`) mais as 2 tabelas ESCOPO_RELACAO que não têm `franquia_id` próprio (`Cobranca`/`HistoricoStatusAssociado`, vinculadas via `Associado`) — 13 tabelas ao todo, todas cobertas pela transação.
  - **Seed de teste com dado em cada uma das 13 tabelas** pra uma única franquia: 2 usuários (titular + extra, provando que "todos os usuários" some, não só o titular), 1 associado com 1 cobrança e 1 linha de histórico de status, 1 configuração (`asaas_api_key`), 1 API key, 1 log de sincronização, 1 cadastro enviado, 1 modelo de contrato, 1 cobrança ignorada, 1 etapa do Jurídico com 2 cards (1 livre + 1 vinculado ao associado, cobrindo os dois caminhos de cascade opcionais do schema) e o histórico gerado automaticamente por essas ações.
  - **Confirmação de duas etapas**: `confirmar_nome` no body precisa bater exatamente com o nome atual da franquia — nome errado → `400`, nada apagado (confirmado que a franquia e os 2 usuários continuam intactos depois da tentativa). Franquia inexistente → `404`. Usuário de franquia (não SUPER_ADMIN) tentando excluir → `403`.
  - **Exclusão de verdade**: `200`, resposta com `excluido: true`, a contagem exata de linhas apagadas por tabela (bate com o seed) e um `aviso` explícito de que Asaas/Bling/Google Drive **não** são apagados automaticamente.
  - **Zero linhas órfãs**: depois da exclusão, contagem em **cada uma das 13 tabelas** (mais a própria franquia) filtrada por essa franquia deu `0` — inclusive as duas tabelas sem `franquia_id` próprio (`cobrancas`/`historico_status_associado`, filtradas via `associado.franquia_id`), confirmando que o cascade automático do schema (`onDelete: Cascade` em `Cobranca`/`HistoricoStatusAssociado`/`CardJuridico`.associado) funcionou junto com os `deleteMany` explícitos da transação, sem depender só de um dos dois mecanismos.
  - Login com o e-mail do usuário titular apagado → `401` (usuário não existe mais). Outras franquias (criadas nos testes dos outros 3 ajustes, na mesma suíte) continuam intactas depois da exclusão — confirma que a transação ficou corretamente escopada só pra franquia alvo, sem vazar pra fora.
- **Redirecionamento pós-login pra tela acessível** (`lib/auth.js:rotaInicial()`, frontend — testado importando o módulo real como ESM contra tokens reais emitidos pelo backend, não uma reimplementação da lógica): usuário com só `juridico` liberado → `/juridico`; só `configuracoes` → `/configuracoes`; `contratos`+`dashboard` → `/dashboard` (prioridade); `contratos`+`cadastro` → `/cadastro` (cadastro vem antes de contratos na ordem de prioridade); nenhum recurso liberado → cai no fallback `/dashboard` (mesmo comportamento de antes do ajuste pra esse caso extremo — não existe rota nenhuma pra oferecer). SUPER_ADMIN sempre cai em `/dashboard`, mesmo sem claim de recursos no token.
- 100/100 asserções passaram (`test-ajustes-brief.js`, mesmo padrão de sempre — Postgres embarcado via `embedded-postgres`, servidor real, chamadas via `fetch`; o teste de `rotaInicial()` importa `lib/auth.js` como ESM dentro do mesmo processo, com um `localStorage` mínimo simulado via `global.window`).
- `node --check` em todos os arquivos backend tocados (`juridico.controller.js`, `juridico.routes.js`, `franquias.controller.js`, `franquias.routes.js`) e em todo `backend/src` (regressão completa); frontend: `npm run lint`/`next build` reais (cópia fresh em `/tmp`, mesmo contorno de sempre pro `node_modules` da pasta montada do Windows) — limpos, 0 erros/warnings, as 10 rotas (incluindo `/controle-geral` e `/juridico`) prerenderizando normalmente.
