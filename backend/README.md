# Gestor de Inadimplência — Backend

API de controle de cobrança da **Via Permuta**. Node.js + Express + PostgreSQL (Prisma ORM), pronta para rodar em Docker e ser hospedada no EasyPanel.

## Stack

- Node.js 20 + Express
- PostgreSQL 16
- Prisma ORM (migrações versionadas em `prisma/migrations`)
- JWT (`jsonwebtoken`) para o login do painel
- Docker + docker-compose

## Modelo de dados

- **associados**: `id`, `cpf_cnpj` (único, indexado), `nome`, `telefone`, `email`, `em_negociacao`, `observacao`, `observacao_atualizada_em` (data/hora da última mudança de valor de `observacao`, só via `PATCH .../negociacao` — ver seção de endpoints), `bloqueado`, `em_juridico`, `ciclo_resetado_em` (marco usado pelo contador de bloqueios), `criado_em`, `atualizado_em`
- **cobrancas**: `id`, `associado_id` (FK), `id_externo` (opcional, único, indexado — ID gerado pelo Asaas para a cobrança, ex.: `pay_xxxxxxxxxxxxx`), `valor`, `vencimento`, `dias_diferenca`, `link_pagamento`, `descricao`, `status` (`pending` | `overdue` | `paid` | `quitada` — este último só é gravado pelo próprio backend, nunca vem de payload externo, ver seção de reconciliação em `POST /api/sync`), `sincronizado_em`, `quitada_em` (preenchido só quando reconciliada como `"quitada"`)
- **historico_status_associado**: `id`, `associado_id` (FK), `campo` (`"em_negociacao"` | `"bloqueado"` | `"em_juridico"`), `status_anterior`, `status_novo`, `alterado_em` — histórico único das três mudanças de status booleano do associado (substitui as antigas `historico_negociacao` e `historico_bloqueio`, consolidadas nesta tabela pela migração `consolidar_historico_status`; `em_juridico` não tinha histórico dedicado antes disso)
- **configuracoes**: `chave` (PK, ex.: `"api_key"` — legado, ver seção "Múltiplas API keys" abaixo —, `"n8n_webhook_cadastro_url"`, `"asaas_api_key"`, `"inadimplencia_palavras_excluidas"` — array JSON serializado em string), `valor`, `atualizado_em` — tabela genérica de configurações persistidas em runtime
- **api_keys**: `id`, `nome` (rótulo livre, ex.: `"n8n - Sync Cobrança"`), `hash` (SHA-256 da chave, único — a chave em texto puro nunca é persistida), `tamanho`, `ultimos_caracteres` (usados só pra mascarar na listagem), `criada_em`, `ultimo_uso_em` (nullable, atualizado best-effort a cada autenticação bem-sucedida), `revogada_em` (nullable — `null` = ativa; a linha nunca é deletada, pra manter histórico) — substitui a antiga chave única de `configuracoes`, ver seção própria abaixo
- **sync_log**: `id`, `executado_em`, `total_associados_processados`, `sucesso` — uma linha por chamada a `POST /api/sync`
- **cadastros_enviados**: `id`, `payload` (json — corpo completo enviado pelo formulário), `status` (`enviado` | `erro`), `resposta_n8n` (texto, nullable — motivo do erro quando o repasse ao n8n falha ou reporta `sucesso: false`), `link_pagamento`/`cliente_asaas_id`/`pedido_bling_id` (texto, nullable — só preenchidos em caso de sucesso, vindos da resposta do n8n), `criado_em` — uma linha por chamada a `POST /api/cadastros` (fluxo de Cadastro/Faturamento, substitui o gatilho do Kommo)
- **cobrancas_ignoradas**: `id`, `asaas_payment_id` (único, indexado), `motivo` (texto, nullable), `criado_em` — lista manual de cobranças do Asaas a excluir do cálculo de Taxa de Inadimplência (ver seção própria abaixo)

## Autenticação

Todas as rotas em `/api/*` exigem o header `Authorization: Bearer <token>`, **exceto** `POST /api/login`. O token pode ser:

1. **Qualquer API key ativa** cadastrada em `api_keys` — para integrações externas (ex.: n8n em `POST /api/sync` e `POST /api/cadastros`).
2. Um **JWT** obtido via `POST /api/login` — para uso do painel administrativo.

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
| POST | `/api/login` | Login fixo (`ADMIN_USER`/`ADMIN_PASSWORD`), retorna JWT. Única rota pública. |
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
| GET | `/api/inadimplencia/resumo` | Números da tela de "Taxa de Inadimplência", calculados em tempo real a partir da API do Asaas. Query params `venc_de`, `venc_ate` (`YYYY-MM-DD`, opcionais — padrão: últimos 12 meses), `renegociacao`, `em_juridico` e `bloqueado` (`todos`\|`sim`\|`nao`, padrão `todos` nos três), `visao_faixas` (`aberto`\|`historico`, padrão `aberto`) e `forcar` (`true`, opcional — ignora o cache dessa chamada, mas ainda atualiza o cache com o resultado novo). Cobranças excluídas (manualmente ou por palavra-chave — ver seção própria) nunca entram no cálculo; o quanto foi excluído vem em `excluidos`. Cacheado em memória por 4 minutos por combinação de filtros. Ver seções "Classificação histórica" e "Taxa de Inadimplência" abaixo. |
| GET | `/api/inadimplencia/evolucao-mensal` | Mesmos números de `valor_total_faturado`/`valor_inadimplente`/`taxa_inadimplencia_percentual` do `/resumo`, mas agrupados por mês, mais `taxa_adimplencia_percentual` (calculado de forma independente, não mais complementar — ver seção "Classificação histórica"). Mesmos query params de filtro do `/resumo` (`venc_de`, `venc_ate`, `renegociacao`, `em_juridico`, `bloqueado`, `forcar` — **não** aceita `visao_faixas`, que só afeta `faixas`/`criticos_90_dias`, campos que esse endpoint não tem). Ver seção própria abaixo. |
| GET | `/api/inadimplencia/exclusoes` | Lista as cobranças do Asaas excluídas manualmente (por `asaas_payment_id`) do cálculo de Taxa de Inadimplência, mais recentes primeiro. |
| POST | `/api/inadimplencia/exclusoes` | Body `{ "asaas_payment_id": "pay_...", "motivo"?: "..." }`. Adiciona uma exclusão manual. `409` se o `asaas_payment_id` já estiver na lista. |
| DELETE | `/api/inadimplencia/exclusoes/:id` | Remove uma exclusão manual pelo `id` (uuid da tabela `cobrancas_ignoradas`, não o `asaas_payment_id`). `404` se não existir. |
| GET | `/api/config/palavras-excluidas` | Retorna a lista de palavras-chave usadas para excluir cobranças automaticamente do cálculo de Taxa de Inadimplência pela descrição (`{ "palavras": [...] }`, array vazio se nunca configurada). |
| PATCH | `/api/config/palavras-excluidas` | Body `{ "palavras": ["palavra1", "palavra2"] }`. Substitui a lista inteira (não faz merge). |
| GET | `/api/config/tolerancia-dias` | Retorna o período de tolerância vigente para a classificação de inadimplência (`{ "dias": number }`, `0` se nunca configurado). Ver seção "Período de tolerância" abaixo. |
| PATCH | `/api/config/tolerancia-dias` | Body `{ "dias": number }`. Valida que é um inteiro entre 0 e 30 (`400` caso contrário), salva e limpa o cache de `/resumo`/`/evolucao-mensal`. |

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

### Classificação histórica de inadimplência (data de pagamento, não status atual)

**O problema que essa seção resolve:** consultar o `status` atual de uma cobrança no Asaas para decidir se ela foi "inadimplente" é errado para relatórios de período fechado. Uma cobrança vencida em janeiro e paga só em março aparece como `RECEIVED` quando você consulta hoje — e, se a classificação dependesse do status atual, ela simplesmente desapareceria da inadimplência de janeiro, sub-representando o histórico. O retrato de um mês fechado não pode mudar dependendo de quando você consulta.

**Campo usado**: `paymentDate` do Asaas ("Payment date on Asaas" — [documentação oficial](https://docs.asaas.com/reference/list-payments.md)), populado quando o pagamento é efetivamente recebido/confirmado, `null` enquanto não pago. **Não** confundir com `clientPaymentDate` ("Date on which the customer paid the bank slip" — específico de boleto, não usado aqui): `paymentDate` é o campo correto porque existe para qualquer forma de pagamento (PIX, cartão, boleto), não só boleto.

**Regra de classificação** (`classificarPagamento`, em `src/controllers/inadimplencia.controller.js`), aplicada a qualquer cobrança com vencimento dentro do período filtrado (`dataLimiteEfetiva` é explicada na seção "Período de tolerância" logo abaixo — com a tolerância no padrão `0`, `dataLimiteEfetiva` é sempre idêntica a `dueDate`, e as regras abaixo se reduzem exatamente ao comportamento original):

- **ADIMPLENTE**: possui `paymentDate` **e** `paymentDate <= dataLimiteEfetiva`.
- **INADIMPLENTE**: possui `paymentDate` **e** `paymentDate > dataLimiteEfetiva` (paga além da tolerância) **ou** não possui `paymentDate` **e** `dataLimiteEfetiva <= hoje` (ainda não paga, e a tolerância já esgotou) — **mesmo que o `status` atual já seja `RECEIVED`/`CONFIRMED`**.
- **A_VENCER** (exceção): não possui `paymentDate` **e** `dataLimiteEfetiva > hoje`. Não conta nem como adimplente nem como inadimplente — só entra em `valor_total_faturado`, nunca nos numeradores de `valor_inadimplente` ou de adimplência. Cobre tanto o caso original (vencimento futuro) quanto, com tolerância configurada, uma cobrança já vencida pela data crua mas ainda dentro da janela de tolerância — nos dois casos ela ainda não pode ser julgada "em dia" nem "atrasada".

Essa classificação (não mais o `status` bruto do Asaas) é a base de `valor_inadimplente`/`valor_adimplente`/`taxa_inadimplencia_percentual`/`taxa_adimplencia_percentual` (em `/resumo` e `/evolucao-mensal`) — por isso o "retrato" de qualquer mês passado fica **fixo**, independente de quando a consulta é feita (a única coisa que pode mudar esse retrato depois é alterar a tolerância configurada, o que é uma decisão deliberada do operador, não um efeito colateral do tempo passar).

> **Decisão de design**: `associados_inadimplentes` e `top_devedores` **continuam** baseados no snapshot de hoje (`status: "OVERDUE"`), sem usar essa nova classificação nem a tolerância — são métricas operacionais ("quem eu ligo hoje"), diferentes da taxa histórica do período. O pedido original só nomeou explicitamente `valor_inadimplente`, `taxa_inadimplencia_percentual` e `taxa_adimplencia_percentual` como alvo da mudança.

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

**Fórmula**: `dataLimiteEfetiva = dueDate + diasTolerancia` (dias corridos). Toda comparação que hoje usa `dueDate` para decidir ADIMPLENTE x INADIMPLENTE — seja contra `paymentDate` (cobrança já paga) ou contra "hoje" (cobrança ainda não paga) — passa a usar `dataLimiteEfetiva` em vez do vencimento cru. Isso vale tanto para a classificação histórica (`valor_inadimplente`/`valor_adimplente`/as duas taxas, em `/resumo` e `/evolucao-mensal`) quanto para os dias de atraso usados para escolher a faixa em `faixas`/`criticos_90_dias`, nos dois modos de `visao_faixas`:

- **Modo `historico`**: os dias de atraso usados para bucketizar passam a ser `paymentDate - dataLimiteEfetiva` (se já paga) ou `hoje - dataLimiteEfetiva` (se não paga) — uma cobrança paga com 2 dias de atraso e tolerância de 2 dias nem entra no conjunto (é ADIMPLENTE, não aparece em nenhuma faixa); uma paga com 25 dias de atraso e tolerância de 2 dias entra na faixa correspondente a 23 dias efetivos, não 25.
- **Modo `aberto`**: mesma lógica, com `hoje - dataLimiteEfetiva` para cobranças ainda não pagas. Uma cobrança cujo `hoje - dueDate` ainda esteja dentro da tolerância (ou seja, `hoje - dataLimiteEfetiva` seria negativo) **não aparece em nenhuma faixa** — mesmo que o Asaas já marque `status: "OVERDUE"` para ela (o Asaas não tem conceito de tolerância; quem decide isso é o Gestor).

**Exemplo numérico** (tolerância 0 x tolerância 2, mesma cobrança): vencimento em `2026-05-10`, paga em `2026-05-12` (2 dias de atraso).

| Tolerância | `dataLimiteEfetiva` | Comparação | Classificação | Aparece em `faixas`? |
|---|---|---|---|---|
| `0` dias | `2026-05-10` (= vencimento) | `2026-05-12 > 2026-05-10` | **INADIMPLENTE** | Sim — faixa `0_20`, com 2 dias de atraso |
| `2` dias | `2026-05-12` | `2026-05-12 <= 2026-05-12` | **ADIMPLENTE** | Não — não é inadimplente, não entra em nenhuma faixa |

Com tolerância `0`, os 2 dias de atraso contam integralmente contra o associado. Com tolerância `2`, o mesmo pagamento — sem nenhuma outra mudança — passa a ser tratado como pago em dia.

**Invalidação de cache**: alterar a tolerância via `PATCH` limpa o cache de `/resumo` e `/evolucao-mensal` (mesmo `cache.clear()` já usado por `/config/palavras-excluidas` e pelas exclusões manuais) — a mudança vale já na próxima consulta, sem esperar o TTL de 4 minutos expirar.

### Regras de cálculo do `/resumo`

Todos os valores em R$, calculados sobre o conjunto de pagamentos com vencimento no período `[venc_de, venc_ate]` (já sem os excluídos — ver seção "Exclusão de cobranças" — e já filtrado por `renegociacao`/`em_juridico`/`bloqueado`, quando ativos):

| Campo | Cálculo |
|---|---|
| `valor_total_faturado` | Soma do `value` de **todos** os pagamentos do período, qualquer status (inclusive os "a vencer"). |
| `valor_inadimplente` | Soma do `value` dos pagamentos classificados **INADIMPLENTE** pela regra histórica acima (data de pagamento vs **data limite efetiva**, já com a tolerância aplicada) — não mais pelo `status` atual, nem pelo vencimento cru. |
| `taxa_inadimplencia_percentual` | `valor_inadimplente / valor_total_faturado * 100`, arredondado a 2 casas — `0` se não houver faturamento no período. |
| `valor_adimplente` | Soma do `value` dos pagamentos classificados **ADIMPLENTE** pela mesma regra histórica (possui `paymentDate` **e** `paymentDate <= dataLimiteEfetiva`). Calculado diretamente aqui no backend — **não** derive esse valor no frontend por subtração (`valor_total_faturado - valor_inadimplente`): o resultado ficaria errado sempre que houver cobranças "a vencer" no período, que não entram em nenhum dos dois numeradores (ver seção "Classificação histórica" acima). |
| `taxa_adimplencia_percentual` | `valor_adimplente / valor_total_faturado * 100`, arredondado a 2 casas — `0` se não houver faturamento no período. Mesma lógica de `taxa_adimplencia_percentual` de `/evolucao-mensal`: não é o complementar de `taxa_inadimplencia_percentual` (as duas só somam 100% quando não há nenhuma cobrança "a vencer" no período). |
| `associados_inadimplentes` | Contagem de clientes **distintos** (por `cpfCnpj` resolvido, ou pelo ID do Asaas quando não foi possível resolver) com pelo menos um pagamento `status: "OVERDUE"` **hoje** (snapshot operacional, não a classificação histórica — ver decisão de design acima). |
| `renegociacoes_abertas` | **Não** usa mais `associados.em_negociacao`. Conta e soma, entre os pagamentos com `status` ainda em aberto (`PENDING` ou `OVERDUE` — não os já pagos), aqueles cuja `description` (do próprio Asaas) contém a palavra "Renegociação", case-insensitive, como substring. `quantidade` = número de **pagamentos** nessa condição; `valor` = soma desses pagamentos. Ver nota de nomenclatura abaixo. |
| `criticos_90_dias` | Soma do `value` dos pagamentos com 90 dias de atraso ou mais, seguindo o mesmo modo (`aberto`/`historico`) de `faixas` — ver seção "Faixas de atraso: modo aberto x histórico". Métrica independente das faixas — um pagamento pode entrar tanto em `criticos_90_dias` quanto na faixa `50_100` (ex.: 90-99 dias caem na faixa `50_100` **e** em `criticos_90_dias`). |
| `faixas` | Soma do `value` (não contagem), agrupada em 6 faixas de dias de atraso **efetivos** (já descontada a tolerância — ver "Período de tolerância" acima) não sobrepostas: `0_20` (0-19d), `20_30` (20-29d), `30_40` (30-39d), `40_50` (40-49d), `50_100` (50-99d), `100_180` (**100d ou mais** — sem teto). O **conjunto de pagamentos** e o **cálculo dos dias de atraso** dependem do parâmetro `visao_faixas` — ver seção própria abaixo. |
| `top_devedores` | Os 10 clientes com maior soma de pagamentos `status: "OVERDUE"` **hoje** no período (mesmo snapshot operacional de `associados_inadimplentes`), ordenados decrescente. `nome` vem do nosso cadastro local quando existe associado correspondente; senão, do nome do cliente no Asaas; `cpf_cnpj` vem do cpfCnpj resolvido (ou o ID do cliente no Asaas, como último recurso). |
| `excluidos` | `{ "quantidade": number, "valor": number }` — quantas cobranças e qual valor foram **removidos do cálculo inteiro** (não entram em nenhum dos campos acima) pelos dois mecanismos de exclusão (manual por ID + palavra-chave na descrição). Ver seção "Exclusão de cobranças do cálculo" abaixo. |

> **Nota de nomenclatura**: `renegociacoes_abertas` (campo da resposta, baseado na descrição das cobranças no Asaas) e o filtro de query `renegociacao` (`todos`\|`sim`\|`nao`, baseado em `associados.em_negociacao` na nossa base) são **dois conceitos diferentes** que só coincidem no nome por acaso — um veio de uma decisão de produto anterior (marcar o associado como "em negociação" no nosso cadastro), o outro é a forma nova, mais direta, de contar renegociações formalizadas como cobrança no próprio Asaas. Não confundir: filtrar `renegociacao=sim` **não** restringe o cálculo de `renegociacoes_abertas` a nada especial — os dois convivem de forma independente na mesma resposta.

### Faixas de atraso: modo `aberto` x `historico` (`visao_faixas`)

O parâmetro `visao_faixas` (`aberto`\|`historico`, padrão `aberto`) controla **quais pagamentos entram** em `faixas`/`criticos_90_dias` e **como os dias de atraso são calculados** para bucketá-los:

| Modo | Conjunto de pagamentos | Dias de atraso efetivos |
|---|---|---|
| `aberto` (padrão, comportamento original) | Só os **ainda não pagos hoje** (`status: "OVERDUE"`) com vencimento no período. | `hoje - dataLimiteEfetiva`. |
| `historico` | Os classificados **INADIMPLENTE** pela regra histórica (sem `paymentDate`, ou pago além da tolerância) com vencimento no período — inclui cobranças já pagas (com atraso) que hoje têm `status: "RECEIVED"`/`CONFIRMED`, mas que não estão mais em `aberto`. | Se já foi paga: `paymentDate - dataLimiteEfetiva`. Se ainda não foi paga: `hoje - dataLimiteEfetiva` (mesma regra do modo `aberto`). |

`dataLimiteEfetiva = dueDate + diasTolerancia` (ver seção "Período de tolerância" acima). Em qualquer um dos dois modos, se o resultado de "dias de atraso efetivos" for **negativo** (a cobrança ainda está dentro da janela de tolerância), ela **não aparece em nenhuma faixa nem em `criticos_90_dias`** — mesmo que o Asaas já marque `status: "OVERDUE"` (isso só pode acontecer no modo `aberto`; no `historico` o próprio conjunto de INADIMPLENTES já exclui essas cobranças antes de chegar aqui).

**A diferença na prática**: o modo `aberto` é um **retrato do dia de hoje** — "quanto está em aberto agora, e há quanto tempo" — útil para o time de cobrança decidir quem ligar. O modo `historico` é o **retrato do período filtrado**, fixo: uma cobrança vencida em maio e paga com atraso em julho aparece na faixa correspondente ao atraso efetivo do pagamento (`paymentDate - dataLimiteEfetiva`) mesmo que hoje, em agosto, ela já não apareça mais em nenhuma lista de "em aberto". `valor_inadimplente`/`taxa_inadimplencia_percentual` (que já usam a classificação histórica, ver seção acima) **não mudam** entre os dois modos — só `faixas` e `criticos_90_dias` mudam, porque só eles dependem de "quais pagamentos" e "atraso calculado como".

### Filtros `renegociacao`, `em_juridico` e `bloqueado`

Cruzam o `cpfCnpj` de cada pagamento do Asaas com `associados.em_negociacao`, `associados.em_juridico` e `associados.bloqueado`, respectivamente, com **exatamente a mesma regra para os três**. Pagamentos de clientes sem `cpfCnpj` resolvido, ou sem associado correspondente na nossa base, contam como **"não"** nos três campos. Quando algum dos três é `sim` ou `nao` (diferente do padrão `todos`), o filtro se aplica a **todo** o conjunto de pagamentos usado no cálculo — inclusive `valor_total_faturado`, não só os que estão em aberto hoje. Os três filtros se combinam com **E** quando ativos ao mesmo tempo (ex.: `renegociacao=sim&em_juridico=nao&bloqueado=sim` retorna só quem está em negociação, **não** está no jurídico e **está** bloqueado). Por isso, com `renegociacao=nao`, `renegociacoes_abertas` continua funcionando normalmente (ver nota de nomenclatura acima — os dois conceitos são independentes, não há mais o efeito colateral que existia antes dessa mudança).

### Exclusão de cobranças do cálculo

Duas formas de excluir cobranças específicas do cálculo de Taxa de Inadimplência (aplicadas **antes** de qualquer outro cálculo — inclusive antes de `renegociacao`/`em_juridico` — e nunca contam em nenhum campo da resposta além de `excluidos`):

1. **Lista manual por `asaas_payment_id`** (tabela `cobrancas_ignoradas`, endpoints `GET`/`POST`/`DELETE /api/inadimplencia/exclusoes`) — para excluir cobranças pontuais (ex.: um lançamento duplicado ou de teste feito direto no Asaas).
2. **Lista de palavras-chave** (tabela `configuracoes`, chave `inadimplencia_palavras_excluidas`, endpoints `GET`/`PATCH /api/config/palavras-excluidas`) — para excluir automaticamente qualquer cobrança cuja **descrição** (campo `description` do Asaas) contenha, como substring e **case-insensitive**, alguma das palavras configuradas. Útil para padronizar exclusões recorrentes (ex.: toda cobrança com "teste" ou "cortesia" na descrição) sem precisar cadastrar cada `asaas_payment_id` manualmente.

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

Mesma base de cálculo do `/resumo` — mesma exclusão combinada e os mesmos filtros `renegociacao`/`em_juridico`/`bloqueado` — mas devolvida **por mês**, para alimentar um gráfico de evolução. Aceita os mesmos query params de filtro (`venc_de`, `venc_ate`, `renegociacao`, `em_juridico`, `bloqueado`), com o mesmo padrão de período (últimos 12 meses quando `venc_de`/`venc_ate` não são informados). Não aceita `visao_faixas` (esse endpoint não devolve `faixas`/`criticos_90_dias`).

`valor_inadimplente` e `taxa_inadimplencia_percentual` usam a **classificação histórica por data de pagamento** (ver seção "Classificação histórica de inadimplência" acima) — o mês de vencimento de uma cobrança paga com atraso continua mostrando ela como inadimplente, mesmo que o `status` atual já seja `RECEIVED`.

Todo mês dentro do intervalo pedido aparece no array de resposta, **mesmo sem nenhuma cobrança naquele mês** (todos os campos zerados).

**Importante — `taxa_adimplencia_percentual` NÃO é mais `100 - taxa_inadimplencia_percentual`.** Cada taxa tem seu próprio numerador (`valorInadimplente`/`valorAdimplente`), calculado independentemente sobre `valor_total_faturado`:

```
taxa_inadimplencia_percentual = valor_inadimplente / valor_total_faturado * 100
taxa_adimplencia_percentual   = valor_adimplente   / valor_total_faturado * 100
```

Isso é proposital, não um bug: cobranças "a vencer" (vencimento futuro, ainda não pagas) entram em `valor_total_faturado` mas **não contam em nenhum dos dois numeradores** (ver exceção A_VENCER na seção "Classificação histórica"). Um mês com bastante cobrança futura em aberto vai legitimamente ter `taxa_inadimplencia_percentual + taxa_adimplencia_percentual < 100` — a diferença é exatamente a fatia "a vencer" daquele mês, que ainda não pode ser julgada nem como em dia nem como atrasada.

```bash
curl "https://api.exemplo.com/api/inadimplencia/evolucao-mensal?venc_de=2026-01-01&venc_ate=2026-06-30" \
  -H "Authorization: Bearer <token>"
# [
#   { "mes": "2026-01", "valor_total_faturado": 18500.00, "valor_inadimplente": 2200.00, "taxa_inadimplencia_percentual": 11.89, "taxa_adimplencia_percentual": 88.11 },
#   { "mes": "2026-02", "valor_total_faturado": 19200.00, "valor_inadimplente": 1900.00, "taxa_inadimplencia_percentual": 9.90, "taxa_adimplencia_percentual": 90.10 },
#   ...
# ]
```

**Cache** (`src/services/cache.service.js`) — assim como o `/resumo`, o resultado completo é cacheado em memória por **4 minutos**, num namespace de cache separado, com a chave sendo a combinação exata `(venc_de, venc_ate, renegociacao, em_juridico, bloqueado)`.

**Cache do `/resumo`** — mesma lógica, mesma janela de 4 minutos, mesma chave `(venc_de, venc_ate, renegociacao, em_juridico, bloqueado, visao_faixas)`. Chamadas repetidas com os mesmos filtros dentro da janela não fazem nenhuma requisição nova ao Asaas. É um cache só do processo (não distribuído, não sobrevive a restart) — adequado para uma tela consultada por poucos usuários do painel; se a API rodar em múltiplas instâncias atrás de um load balancer, cada instância mantém seu próprio cache.

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
#   "faixas": { "0_20": 9000.00, "20_30": 4500.00, "30_40": 3200.00, "40_50": 2100.00, "50_100": 3150.50, "100_180": 2200.00 },
#   "top_devedores": [ { "nome": "Empresa X", "cpf_cnpj": "12.345.678/0001-90", "valor": 4800.00 }, ... ],
#   "excluidos": { "quantidade": 2, "valor": 950.00 }
# }
# (note que 24150.50 + 150200.00 = 174350.50 < 182300.00 nesse exemplo — a
# diferença, 7949.50, é o valor "a vencer" do período, que não entra em
# nenhum dos dois numeradores.)
```

### Como testar a tela de Inadimplência com dados fictícios

A tela "Taxa de Inadimplência" do painel depende de uma chave de API real do Asaas para funcionar. Para testar a tela manualmente no navegador **sem precisar de uma conta/chave real do Asaas**, este repositório traz um mock standalone da API do Asaas em `scripts/mock-asaas-server.js`.

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
   - `JWT_EXPIRES_IN` → opcional, padrão `8h`
   - `PORT` → `3000` (ou o que o EasyPanel exigir)
3. Configure a porta exposta do serviço como `3000` (a mesma do `EXPOSE` do Dockerfile).
4. No deploy, o `docker-entrypoint.sh` roda `prisma migrate deploy` automaticamente antes de iniciar a API — não é necessário rodar migrações manualmente, mas o serviço de banco precisa estar acessível no boot.
5. Recomenda-se **não** montar volume para `.env` em produção — defina as variáveis diretamente no painel do EasyPanel, como descrito no passo 2.

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
- Suíte dedicada a esta correção: **24/24 asserções passaram**.
