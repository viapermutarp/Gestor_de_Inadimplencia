# Gestor de Inadimplência — Frontend

Painel web da **Via Permuta** para controle de cobrança. Next.js (App Router) + Tailwind CSS v4, hospedado no Vercel, consumindo a API backend (Node/Express) via `NEXT_PUBLIC_API_URL`.

## Stack

- Next.js 16 (App Router, React 19)
- Tailwind CSS v4
- Tema visual **Sinal** (skill frontend-design) — ver seção própria abaixo
- Autenticação via JWT armazenado em `localStorage`

## Direção visual — tema "Sinal"

Painel interno de uso diário da equipe de cobrança (não é voltado a cliente final), pensado para uma tarefa específica: escanear rapidamente uma tabela densa de associados e identificar quem precisa de atenção. A direção visual segue esse objetivo.

**Paleta** — fundo quase preto (não roxo), com uma única cor de marca elétrica e saturada aplicada de forma consistente em botões primários, estados ativos, foco e ícones:

| Token | Hex | Uso |
|---|---|---|
| `--background` (Tinta) | `#0A0A0D` | Fundo da aplicação |
| `--surface` (Carvão) | `#131318` | Cards, painéis, tabela |
| `--surface-elevated` | `#1E2029` | Inputs, modais, hover |
| `--primary` (Sinal) | `#3D5AFE` | Cor de marca — botões primários, estados ativos, foco, ícones |
| `--accent` (Sinal Claro) | `#7C8BFF` | Variação clara do sinal — eyebrows, detalhes |
| `--foreground` (Osso) | `#F2F3F7` | Texto principal |

As quatro cores de status de atraso (`--status-green` `#22C55E`, `--status-yellow` `#F5B301`, `--status-orange` `#FB7A24`, `--status-red` `#F2454B`) ficam **fora** dessa paleta de marca — são um código de cor semântico fixo, reservado exclusivamente para a faixa de atraso de cada associado, e nunca usado como cor de botão/ícone genérico. Essa separação é deliberada: evita que a cor da marca seja confundida com um indicador de risco.

**Tipografia** — três famílias, cada uma com um papel bem definido:
- **Space Grotesk** (`font-display`) — títulos e os números grandes de destaque (cards de resumo, contador de bloqueios). Usada com moderação.
- **IBM Plex Sans** (`font-sans`, padrão do corpo) — rótulos, textos, navegação, formulários.
- **IBM Plex Mono** (`font-mono`) — todo dado codificado/numérico: CPF/CNPJ, telefone, valores monetários, datas e timestamps, chave de API. É a decisão tipográfica central do redesenho: numa tabela densa de dados financeiros, o alinhamento tabular do monoespaçado ajuda a equipe a escanear e comparar números/códigos muito mais rápido do que uma fonte proporcional — e distingue visualmente "dado" de "texto corrido" (nome, rótulos) sem precisar de nenhuma cor ou ícone extra.

**Sistema de severidade na tabela** — a intensidade visual de cada linha cresce com a gravidade do atraso: "Em dia" fica neutro (não precisa de atenção), e as faixas Atenção/Alerta/Crítico ganham uma barra de destaque na borda esquerda e um leve tingimento de fundo cada vez mais forte — o vermelho (Crítico) é a linha mais "pesada" visualmente da tabela. Esse é o elemento-assinatura do redesenho: em vez de um badge decorativo, a própria hierarquia de urgência (o motivo de existir dessa tela) é o que dá a personalidade visual à interface.

**Ícones** — conjunto próprio em `components/icons.js` (SVG inline, sem dependência externa), todos com o mesmo traço. Usados dentro de chips circulares preenchidos com a cor de marca (cards de resumo, cabeçalho, chave de API, log de sincronizações) — nunca com as cores semânticas de atraso, para não diluir esse código de cor.

**Cantos e espaçamento** — escala de raio generosa e consistente: `rounded-xl` (12px) em botões/inputs/badges, `rounded-2xl` (16px) em cards/painéis/tabela, `rounded-3xl` (24px) em modais. Espaçamento interno dos cards e da tabela ampliado em relação à versão anterior para dar mais respiração.

## Variáveis de ambiente

Crie um `.env.local` a partir do `.env.example`:

```bash
cp .env.example .env.local
```

| Variável | Descrição |
|---|---|
| `NEXT_PUBLIC_API_URL` | URL base da API backend (ex.: `https://api.viapermuta.com`, sem `/` no final). Exposta ao client pois as chamadas são feitas no navegador. |

## Rodando localmente

```bash
npm install
npm run dev
```

Acesse `http://localhost:3000`. Você será redirecionado para `/login`; após autenticar, o token é salvo no `localStorage` e as rotas de `/dashboard` ficam liberadas.

Build de produção local:

```bash
npm run build
npm run start
```

## Telas

- **`/login`** — usuário/senha (`POST /api/login`), salva o JWT retornado.
- **`/dashboard`** — protegida (redireciona para `/login` se não houver token válido). A partir da versão com paginação do backend, a tabela busca **uma página por vez** em `GET /api/associados` (`page`, `limit=100`), combinando filtro/busca/página numa única chamada:
  - **Cards de resumo** (topo): associados com cobrança em aberto, valor total em aberto, em negociação, bloqueados e no jurídico — sempre refletem a **carteira inteira** (não só a página/filtro ativos na tabela). Vêm de uma **única chamada** a `GET /api/associados/resumo` (números já agregados no banco pelo backend) — não busca mais os associados um por um nem pagina por baixo dos panos para montar esses números, o que reduz bastante as chamadas feitas ao carregar o dashboard (antes crescia com o tamanho da carteira; agora é sempre 1 chamada, independente de ter 50 ou 5.000 associados).
  - **Atalhos de filtro**: Todos, Em Negociação, Bloqueados, Jurídico — enviados como query params (`em_negociacao`/`bloqueado`/`em_juridico`) para o backend, não filtrados no cliente.
  - **Busca**: um único campo de texto (nome, CPF/CNPJ **ou telefone**) enviado como `?busca=` — a pesquisa por telefone acontece no backend, não no cliente. Tem debounce de ~350ms para não disparar uma chamada a cada tecla digitada.
  - **Paginação**: trocar de filtro ou digitar uma busca nova sempre volta a tabela para a página 1. Controles de "Anterior"/"Próxima", indicador "Página X de Y" e total de registros ficam abaixo da tabela (`components/PaginacaoControles.js`).
  - **Ordenação pelo atraso mais crítico primeiro**: o backend agora ordena pelo `dias_diferenca` mais crítico **antes** de paginar (ver README do backend), então a página 1 sempre traz o associado mais crítico do sistema inteiro, e a ordem se mantém correta navegando entre páginas. O frontend **não reordena mais nada no cliente** — a tabela renderiza `associados` exatamente na ordem que a API devolve; a antiga ordenação client-side (`sortByAtrasoDesc`, que só conseguia ordenar dentro da página já carregada) foi removida.
  - **Indicador "sem contato recente"**: um ponto amarelo sutil ao lado do nome (tooltip "Sem contato há Xd") para associados **em negociação** cuja `observacao_atualizada_em` seja nula ou tenha mais de 5 dias — ver `lib/contato.js`. Não aparece para quem não está em negociação.
  - Toggles direto na linha para "Em negociação" (`PATCH .../negociacao`), "Bloqueado" (`PATCH .../bloqueio`) e "Jurídico" (`PATCH .../juridico`) — atualização otimista local: tanto a linha da tabela quanto o contador correspondente nos cards de resumo (+1/-1) são ajustados na hora, sem esperar resposta do servidor nem refazer a chamada de resumo inteira; em caso de erro, os dois voltam ao valor anterior. Como consequência, se um associado deixar de bater com o filtro ativo (ex.: desmarcar "Em negociação" enquanto o atalho "Em Negociação" está selecionado), ele só some da lista na próxima navegação de página/filtro/busca, não instantaneamente.
  - **Botão "Atualizar"** (ao lado dos atalhos de filtro): re-busca a página atual da tabela e os cards de resumo juntos (`Promise.all`), sem precisar dar F5 na tela inteira — mesmo padrão visual do botão equivalente em `/inadimplencia` (ícone vira spinner enquanto carrega, mensagem "Atualizado agora" por alguns segundos depois).
- **Modal de detalhe** (abre ao clicar na linha) — dados cadastrais (incluindo e-mail, quando o associado tiver um vindo do `POST /api/sync`), badges de Bloqueado/Jurídico, cobranças em aberto com link de pagamento, seção **Controle de bloqueios** (contador do ciclo via `GET .../bloqueios/contador`, badge de risco de perda de cashback a partir de 4 bloqueios, botão de reset com confirmação via `POST .../bloqueios/resetar`), seção **Histórico** e campo de observação editável — logo abaixo do campo, mostra "Última observação: há Xd" (ou "hoje"/"há 1 dia") com a data completa entre parênteses, calculado a partir de `observacao_atualizada_em`, e o mesmo indicador amarelo de "sem contato recente" da tabela quando aplicável.
  - **Histórico** consome o campo único `historico` de `GET /api/associados/:cpf_cnpj` (ver README do backend — tabela `historico_status_associado`) e mostra, mais recente primeiro, toda mudança de "Negociação", "Bloqueio" **ou** "Jurídico" do associado — cada linha identifica qual dos três campos mudou, o valor anterior, o valor novo e a data/hora. Antes, essa seção só existia para negociação e nem sequer registrava mudanças de status jurídico.
- **`/inadimplencia`** — protegida, acessível pelo link "Taxa de Inadimplência %" no cabeçalho (entre Dashboard e Cadastro). Consome `GET /api/inadimplencia/resumo`, que calcula os números **em tempo real** a partir da API do Asaas (pode demorar alguns segundos — ver indicador de carregamento abaixo).
  - **Cards de resumo**: Valor Total Faturado, Valor Inadimplente, Associados Inadimplentes, Renegociações Abertas (quantidade + valor) e Críticos 90+ dias, mais um card "hero" para a **Taxa de Inadimplência (%)** — fonte bem maior que os outros números (`text-5xl` vs `text-xl`) e cor que muda com a gravidade (verde `<5%`, amarelo `5-15%`, laranja `15-30%`, vermelho `≥30%` — faixas de corte são uma decisão de design do frontend, o backend só manda o número).
  - **Filtros**: "Vencimento de"/"Vencimento até" (`components/DatePicker.js`, mesmo calendário usado em `/cadastro`), "Faixa de atraso" (dropdown) e "Renegociação" (Todos/Em negociação/Não em negociação), com botões **Aplicar** e **Limpar**. Só "Vencimento de/até" e "Renegociação" disparam uma nova chamada à API (por isso ficam "represados" até clicar em Aplicar — cada chamada pode ser lenta, então não faz sentido buscar a cada mudança); "Faixa de atraso" é aplicada **na hora**, sem nova chamada, porque `GET /api/inadimplencia/resumo` já devolve as 6 faixas do período inteiro de uma vez — o filtro só destaca a faixa escolhida no gráfico (ver abaixo), não teria o que re-buscar.
  - **Gráfico de faixas** (`components/FaixasChart.js`): barras verticais com o valor em atraso (R$) de cada uma das 6 faixas (`0_20` a `100_180` dias). Cores em rampa de calor, **interpoladas entre as 4 cores semânticas de atraso já existentes no app** (verde → amarelo → laranja → vermelho — ver `lib/atraso.js`/seção de faixas de cor abaixo), então a paleta de marca continua com uma cor só e nenhuma cor nova é introduzida. Clicar numa barra (ou escolher no dropdown "Faixa de atraso") destaca essa faixa e esmaece as demais.
  - **Top 10 devedores** (`components/TopDevedores.js`): lista com barra horizontal proporcional ao valor de cada devedor, nome + CPF/CNPJ, ordenados do maior para o menor — direto do array `top_devedores` da resposta.
  - **Chave do Asaas não configurada**: se `GET /api/inadimplencia/resumo` responder `400` com uma mensagem citando `"asaas-key"` (é como o backend sinaliza esse caso — ver README do backend), a tela troca todo o conteúdo por um aviso claro com um botão "Ir para Configurações" (`Link` para `/configuracoes`), em vez de mostrar cards/gráficos vazios ou um erro genérico.
  - **Indicador de carregamento**: enquanto a chamada ao Asaas está em andamento, os cards mostram skeletons pulsantes (mesmo padrão do dashboard) e aparece um aviso de texto com spinner ("Consultando a API do Asaas — isso pode levar alguns segundos") logo abaixo dos filtros, já que essa chamada é sensivelmente mais lenta que as demais do app (depende de uma API externa, não só do nosso banco).
- **`/cadastro`** — protegida, acessível pelo link "Cadastro" no cabeçalho. Formulário de Cadastro/Faturamento que substitui o gatilho do Kommo, organizado em 4 seções:
  - **Identificação**: Tipo de Pessoa (toggle PF/PJ), Razão Social, Nome Fantasia, CNPJ/CPF (máscara dinâmica conforme o tipo selecionado — `000.000.000-00` para PF, `00.000.000/0000-00` para PJ).
  - **Endereço**: CEP (máscara `00000-000`), Endereço, Número, Complemento (opcional), Bairro, Cidade, UF (dropdown com as 27 siglas de estado).
  - **Contato**: Contato, Celular (máscara `(00) 00000-0000`/`(00) 0000-0000` conforme a quantidade de dígitos), E-mail (validado por formato antes do envio).
  - **Faturamento**: Descrição do Serviço (dropdown travado nas 4 opções exatas exigidas pelo backend), Valor da Entrada (opcional, campo monetário R$), Número de Parcelas (dropdown 1x–12x), Valor Total, Data Vencimento (calendário customizado com navegação por mês, `components/DatePicker.js`), Observações (textarea) e Desconto Parcela (opcional, campo monetário).

  Os campos monetários (`Valor da Entrada`, `Valor Total`, `Desconto Parcela`) usam uma máscara "de digitação": o estado guarda o valor em centavos e a exibição é formatada como moeda BRL a cada tecla (`lib/mascaras.js`); no envio, são convertidos para string decimal (`"1500.00"`), igual ao formato usado nos testes do backend.

  Validação client-side antes do `POST /api/cadastros`, espelhando exatamente as regras do backend: `CNPJ/CPF` obrigatório, `Razão Social` **ou** `Contato` obrigatório, `Descrição do Serviço` obrigatório, `Valor Total` obrigatório, e `E-mail` (quando preenchido) precisa ter formato válido — erros aparecem num banner listando cada mensagem, sem chegar a enviar a requisição. O payload é montado com as chaves **exatamente** como o backend espera (em português, com acento/espaço: `"Tipo de Pessoa"`, `"Razão Social"`, `"CNPJ/CPF"`, `"Descrição do Serviço"` etc. — ver `criarCadastro` em `lib/api.js`). Após um envio bem-sucedido, um banner verde de confirmação aparece e o formulário inteiro é limpo para o próximo cadastro; erros de rede/API (ex.: 400 de validação vindo do backend) aparecem no `ErrorBanner` padrão do app.
- **`/configuracoes`** — também protegida, acessível pelo link "Configurações" no cabeçalho. Mostra a API key mascarada (`GET /api/config/api-key`), botão para regenerá-la com confirmação (`POST /api/config/api-key/regenerar`) que revela a chave completa uma única vez num modal com botão de copiar e aviso para atualizar integrações (ex.: n8n), uma seção para a **chave de API do Asaas** (campo mascarado + input + botão "Salvar", mesmo padrão visual da chave interna — mas sem o fluxo de regeneração aleatória, já que essa chave é colada manualmente pelo usuário, vinda do painel do Asaas; usa `GET`/`PATCH /api/config/asaas-key`, com link direto para a tela `/inadimplencia`), e uma tabela com o log das últimas 20 sincronizações (`GET /api/config/sync-log`).

### Faixas de cor por atraso (cores fixas, fora da paleta do tema)

Calculadas a partir da cobrança em aberto (`pending`/`overdue`) mais atrasada de cada associado. **Convenção do `dias_diferenca` (vem do backend): negativo = dias em atraso; zero ou positivo = dias até o vencimento** (ou já vencendo hoje, no caso do zero).

| Faixa | Cor | Critério |
|---|---|---|
| Em dia | Verde | sem cobrança em aberto, ou `dias_diferenca >= 0` |
| Atenção | Amarelo | `dias_diferenca` entre -1 e -9 |
| Alerta | Laranja | `dias_diferenca` entre -10 e -19 |
| Crítico | Vermelho | `dias_diferenca <= -20` |

> Havia um bug nessa lógica em uma versão anterior, com o sinal invertido (tratando positivo como atraso). Foi corrigido em `lib/atraso.js` — a função que encontra a cobrança mais crítica também passou a usar o menor valor de `dias_diferenca` (mais negativo), não mais o maior.
>
> As faixas numéricas também já mudaram uma vez desde então: os limites originais (amarelo até -15, laranja até -30, vermelho a partir de -31) foram substituídos pelos atuais (amarelo até -9, laranja até -19, vermelho a partir de -20) — ver "Testes realizados" para a validação das fronteiras.

## Deploy no Vercel

1. Importe o repositório (ou a pasta `frontend`, se for um monorepo) no [Vercel](https://vercel.com/new).
2. Framework Preset: **Next.js** (detectado automaticamente).
3. Em *Environment Variables*, defina:
   - `NEXT_PUBLIC_API_URL` → URL pública da API backend em produção.
4. Deploy. Builds seguintes acontecem automaticamente a cada push.

> Como a API já roda em outro servidor, garanta que ela aceite requisições vindas do domínio do Vercel (CORS liberado) — o backend deste projeto já habilita CORS por padrão.

## Estrutura

```
app/
  page.js                  # redireciona para /login ou /dashboard conforme sessão
  login/page.js            # tela de login
  dashboard/layout.js      # guarda de autenticação + cabeçalho (via RequireAuth/AppHeader)
  dashboard/page.js        # tabela de associados
  inadimplencia/layout.js  # guarda de autenticação + cabeçalho
  inadimplencia/page.js    # Taxa de Inadimplência: filtros, cards, gráfico de faixas, top devedores
  cadastro/layout.js       # guarda de autenticação + cabeçalho
  cadastro/page.js         # formulário de Cadastro/Faturamento (POST /api/cadastros)
  configuracoes/layout.js  # guarda de autenticação + cabeçalho
  configuracoes/page.js    # API key mascarada/regeneração, chave do Asaas, log de sincronizações
  globals.css              # tema Sinal + cores semânticas de atraso
components/
  AppHeader.js              # cabeçalho com navegação (Dashboard / Taxa de Inadimplência % / Cadastro / Configurações) + Sair
  RequireAuth.js            # wrapper de proteção de rota, usado pelos layouts
  ResumoCards.js            # cards de resumo do dashboard (consome GET /api/associados/resumo direto)
  ResumoInadimplenciaCards.js # cards de /inadimplencia, com a Taxa (%) em destaque visual maior
  FaixasChart.js             # gráfico de barras das 6 faixas de atraso, rampa de cor quente
  TopDevedores.js            # lista/barras dos 10 maiores devedores
  PaginacaoControles.js     # anterior/próxima, "Página X de Y", total de registros
  SemContatoIndicador.js    # ponto amarelo com tooltip, indicador de "sem contato recente"
  DatePicker.js              # calendário customizado com navegação por mês (usado em /cadastro e /inadimplencia)
  icons.js                  # conjunto de ícones SVG inline (traço único, sem dependência externa)
  AssociadoDetalheModal.js
  NegociacaoToggle.js        # toggle genérico (negociação, bloqueio, jurídico)
  StatusAtrasoBadge.js
  ErrorBanner.js / Spinner.js
lib/
  api.js       # client HTTP (fetch) com Authorization: Bearer <token>; getAssociados aceita { emNegociacao, bloqueado, emJuridico, busca, page, limit }; getResumo aceita { busca }; criarCadastro(payload) faz POST /api/cadastros; getResumoInadimplencia({ vencDe, vencAte, renegociacao }) faz GET /api/inadimplencia/resumo; getAsaasKeyMascarada/atualizarAsaasKey(chave) fazem GET/PATCH /api/config/asaas-key
  auth.js      # leitura/gravação do token em localStorage
  atraso.js    # cálculo da cobrança mais crítica, soma em aberto, faixas de cor (a ordenação em si é feita pelo backend, não mais aqui)
  contato.js   # indicador "sem contato recente" e formatação de "Última observação: há Xd"
  format.js    # formatação de moeda e datas para EXIBIÇÃO (pt-BR) — ex. tabelas
  mascaras.js  # máscaras "de digitação" (CPF/CNPJ, CEP, celular, moeda), validação de e-mail, e as listas de UFs/descrições de serviço/parcelas usadas em /cadastro
```

## Testes realizados

- `next build` — build de produção completo, todas as rotas (`/`, `/login`, `/dashboard`, `/configuracoes`) prerenderizadas sem erros de SSR.
- `eslint` — sem erros.
- Lógica de faixas de atraso, cobrança mais crítica, soma de valores em aberto e ordenação (`lib/atraso.js`) validada com os valores pedidos e casos de borda **nas faixas atuais** (amarelo -1 a -9, laranja -10 a -19, vermelho a partir de -20): `12` → verde "Vence em 12d", `0` → verde "Vence hoje", `-1` → amarelo "1d de atraso", `-9` → amarelo "9d de atraso" (fronteira exata), `-10` → laranja "10d de atraso" (fronteira exata), `-19` → laranja "19d de atraso" (fronteira exata), `-20` → vermelho "20d de atraso" (fronteira exata), `-35` → vermelho "35d de atraso", `null` (sem cobrança aberta) → verde "Em dia", e cobranças `paid` corretamente excluídas do cálculo. Ordenação conferida: mais atrasado primeiro, associados sem débito em aberto por último.
- **Múltiplas cobranças por associado**: testado com um associado com 4 cobranças (2 `overdue`, 1 `pending`, 1 `paid`) — confirmado que a coluna Atraso usa a mais crítica (`-30`, não `-5`), a coluna Valor em aberto soma só as três em aberto (430,50, ignorando a paga), e o modal lista as três abertas individualmente, cada uma com seu próprio valor/vencimento/link.
- **Cards de resumo e atalhos de filtro**: testado com 4 associados variados (combinações de negociação/bloqueio/jurídico/cobranças) contra um servidor mock — confirmado que `GET /api/associados` é chamado **sem** query params (a lista completa é buscada uma vez só) e que os 5 números dos cards e os 4 filtros (Todos/Em Negociação/Bloqueados/Jurídico) batem exatamente com o esperado.
- Fluxo completo de `lib/api.js`/`lib/auth.js` — incluindo as funções novas (`patchBloqueio`, `patchJuridico`, `getBloqueiosContador`, `resetarBloqueios`, `getApiKeyMascarada`, `regenerarApiKey`, `getSyncLog`) — validado contra um servidor mock que replica o contrato da API: login, listagem, detalhe, PATCH de negociação/bloqueio/jurídico, contador zerando após reset, mascaramento e regeneração de API key, e leitura do log de sincronizações.
- `next start` + checagem HTTP de todas as rotas (200, sem erros no log do servidor).

Não havia uma instância real da API backend disponível neste ambiente para um teste ponta a ponta com dados reais — antes de ir para produção, valide o fluxo completo (login → dashboard → toggles → modal → configurações) apontando `NEXT_PUBLIC_API_URL` para a API real.

### Paginação, busca unificada e indicador "sem contato recente" (validado após a adaptação ao novo contrato de `GET /api/associados`)

- `next build` e `eslint` — sem erros, com os arquivos novos (`lib/contato.js`, `components/PaginacaoControles.js`, `components/SemContatoIndicador.js`).
- `next start` + checagem HTTP de `/`, `/login`, `/dashboard` e `/configuracoes` (200, sem erros no log do servidor) contra um servidor mock com o novo contrato paginado.
- **`lib/api.js` (`getAssociados`)** validado contra um servidor mock que replica `{ dados, paginacao }`, com 12 associados fake:
  - `page=1&limit=5` / `page=2&limit=5` / `page=3&limit=5`: 5, 5 e 2 registros respectivamente, `paginacao.total_paginas: 3` e `total_registros: 12` consistentes em todas as páginas.
  - Filtro (`emNegociacao: true`) combinado com paginação: retorna só os 4 associados em negociação, com `total_registros` já refletindo o filtro (não o total da carteira).
  - Busca unificada (`busca`) por nome completo, CPF/CNPJ parcial e telefone completo: cada uma retornando exatamente o associado esperado — confirma que o campo de busca da UI agora cobre telefone também, via backend.
- **`lib/contato.js`** validado com 6 combinações de `em_negociacao` × `observacao_atualizada_em`: associado em negociação com observação nunca registrada (indicador aparece), 2 dias desde a última observação (não aparece), exatamente 5 dias (não aparece — o critério é "mais de 5 dias"), 6 dias (aparece), e dois associados fora de negociação com `observacao_atualizada_em` nulo/antigo (indicador nunca aparece, independentemente da data). `formatUltimaObservacao` conferido para `null`, "2 dias atrás" e "6 dias atrás".
- Reset de página para 1 ao trocar filtro ou busca, e atualização otimista dos cards de resumo e da tabela nos toggles — verificados por leitura de código e pelos testes unitários acima; não há ainda um teste automatizado de interação de UI (clique/digitação) neste ambiente, já que os testes desta seção rodam contra `lib/*.js` diretamente, sem montar componentes React. Antes de produção, vale um teste manual do fluxo completo (trocar filtro, buscar, navegar entre páginas, dar toggle) contra a API real.

### Cards de resumo via `GET /api/associados/resumo` e remoção da ordenação client-side

- `next build` e `eslint` — sem erros após a troca de `ResumoCards.js` (agora consome `{ com_cobranca_aberto, valor_total_aberto, em_negociacao, bloqueados, em_juridico }` direto, sem calcular nada a partir de um array de associados) e a remoção de `sortByAtrasoDesc` (`lib/atraso.js`) e do seu uso em `dashboard/page.js`. Confirmado via busca no código-fonte que não sobrou nenhuma referência a `sortByAtrasoDesc` em `app/`, `components/` ou `lib/`.
- **Redução de chamadas no carregamento do dashboard**: testado contra um servidor mock com 250 associados fake — simulando exatamente a sequência de chamadas feita ao montar o dashboard (`GET /api/associados?page=1&limit=100` + `GET /api/associados/resumo`), confirmado que só **2 chamadas** são feitas no total. Pela abordagem antiga (buscar a carteira inteira paginando por baixo dos panos só para montar os cards), o mesmo cenário de 250 registros exigiria `1 (tabela) + 3 (ceil(250/100) páginas do loop de resumo) = 4` chamadas — e esse número cresceria junto com o tamanho da carteira; com `/resumo`, é sempre 1 chamada de resumo, não importa quantos associados existam.
- **Formato do `/resumo`** validado: os 5 campos retornados (`com_cobranca_aberto`, `valor_total_aberto`, `em_negociacao`, `bloqueados`, `em_juridico`) chegam como `number`, prontos para exibição direta nos cards sem nenhum cálculo no cliente.
- **Ordenação preservada, sem reordenação no cliente**: o mock foi configurado para entregar os associados já pré-ordenados pelo `dias_diferenca` mais crítico (mesmo comportamento do backend real, que ordena no banco antes de paginar) — confirmado que a página 1 recebida por `getAssociados()` vem em ordem monotonicamente crescente de criticidade, e que essa ordem bate exatamente com uma reordenação feita localmente a partir dos mesmos critérios (ou seja, a API já entrega a ordem certa; não há necessidade nem presença de nenhum sort adicional no caminho `lib/api.js` → `dashboard/page.js` → render da tabela).
- `next start` + checagem HTTP de `/`, `/login`, `/dashboard` e `/configuracoes` (200, sem erros no log do servidor) contra o mock de 250 registros.

### Nova direção visual — tema "Sinal" (skill frontend-design)

- `next build` e `eslint` — sem erros em todos os arquivos tocados (`app/layout.js`, `app/globals.css`, `app/login/page.js`, `app/configuracoes/page.js`, `components/AppHeader.js`, `components/ResumoCards.js`, `components/PaginacaoControles.js`, `components/StatusAtrasoBadge.js`, `components/ErrorBanner.js`, `components/AssociadoDetalheModal.js`, `components/icons.js` (novo), `lib/atraso.js`) — validado tanto numa cópia de teste quanto, por último, direto na pasta real do projeto, para garantir que o que ficou salvo é exatamente o que builda limpo.
- `next start` + checagem HTTP de `/`, `/login`, `/dashboard` e `/configuracoes` (200, sem erros no log do servidor).
- Busca no código-fonte confirmando que não sobrou nenhuma referência ao tema anterior ("Midnight Galaxy", lavanda, fonte Arimo).
- **Nenhuma mudança de lógica**: todo o trabalho desta rodada foi só em `className` (Tailwind), tokens de cor/fonte (`globals.css`) e um componente novo puramente decorativo (`icons.js`) — nenhum arquivo de `lib/` teve função renomeada, removida ou com comportamento alterado (a única mudança em `lib/atraso.js` foi a estrutura de classes CSS dentro de `STATUS_COLOR_CLASSES`, usada só para estilo).
- **Limitação conhecida**: o ambiente usado para este trabalho não tem acesso de root/sudo para instalar as dependências de sistema do Chromium headless (tentado via Playwright), então não foi possível capturar screenshots reais das telas renderizadas para revisão visual automatizada. A validação nesta rodada ficou restrita a build/lint limpos, checagem HTTP das rotas e revisão manual de cada `className` alterado. Recomendamos abrir o app localmente (`npm run dev`) e navegar pelas 4 telas antes do deploy, para confirmar visualmente a nova direção.

### Nova tela `/cadastro` (formulário de Cadastro/Faturamento)

- `next build` e `eslint` — sem erros, incluindo a rota nova (`○ /cadastro` aparece na saída do build junto das demais).
- `next start` + `curl` em `/cadastro` — HTTP 200, HTML válido (título e fontes carregando corretamente). O conteúdo do formulário em si não aparece no HTML gerado no servidor porque `RequireAuth` decide no cliente (via `localStorage`) se redireciona para `/login` — mesmo comportamento de `/dashboard` e `/configuracoes`, não é uma particularidade desta tela.
- **`lib/mascaras.js`** validado isoladamente (script Node separado, importando o arquivo real do projeto): `maskCpf`/`maskCnpj`/`maskCpfCnpj` formatando corretamente em cada estágio de digitação e truncando no limite de dígitos (11/14); `maskCep` e `maskCelular` (testado tanto o caso de 10 dígitos — fixo, `(11) 3333-4444` — quanto 11 — celular, `(11) 99999-9999`); `isValidEmail` aceitando/rejeitando os casos esperados; `digitosParaCentavos`/`formatCentavosInput`/`centavosParaDecimalString` (incluindo o caso de valor vazio → `null` → `"0.00"` no envio); `UFS` com exatamente 27 siglas; `DESCRICOES_SERVICO` com as 4 strings exigidas pelo backend (incluindo a mais longa, "Recorrência Cartão de Crédito (Anuidade)"); `OPCOES_PARCELAS` de 1 a 12.
- **Contrato do payload de `POST /api/cadastros`** validado contra um servidor mock que replica o comportamento do backend real (responde 201 com `{ id, payload, status, resposta_n8n, criado_em }`): reproduzida a mesma lógica de montagem do payload usada em `app/cadastro/page.js` (chaves + conversão de centavos para string decimal) e confirmado que as 20 chaves batem **exatamente** (sem faltar nem sobrar nenhuma) com a lista exigida pelo backend, incluindo acentos e espaços (`"Tipo de Pessoa"`, `"Razão Social"`, `"CNPJ/CPF"`, `"Descrição do Serviço"` etc.), e que campos monetários vazios (opcionais) são enviados como `"0.00"`, não como string vazia ou `null`.
- **Não testado neste ambiente** (mesma limitação de Chromium headless já documentada acima): interação real de UI no navegador — clique no toggle PF/PJ, digitação nos campos mascarados, abrir/fechar o `DatePicker` e navegar entre meses, seleção nos `<select>`, disparo do banner de erro de validação antes do envio, e o banner de sucesso + limpeza do formulário após um `POST` real. A lógica por trás de cada um desses comportamentos foi revisada manualmente e os blocos que não dependem de DOM (máscaras, validação, montagem do payload) foram cobertos pelos testes acima. Recomendamos um teste manual do fluxo completo (`npm run dev`, preencher e enviar o formulário) apontando para a API real antes do deploy.

### Nova tela `/inadimplencia` (Taxa de Inadimplência) e seção "Chave de API do Asaas" em Configurações

- `next build` e `eslint` — sem erros, com a rota nova (`○ /inadimplencia`) aparecendo no build junto das demais.
- `next start` + `curl` em `/`, `/login`, `/dashboard`, `/inadimplencia`, `/cadastro` e `/configuracoes` — todas `200`, sem erros no log do servidor (mesma ressalva de sempre: `RequireAuth` decide client-side se redireciona para `/login`, então o HTML gerado no servidor não traz o conteúdo da tela em si — não é uma particularidade desta rota).
- **`lib/api.js`** (`getResumoInadimplencia`, `getAsaasKeyMascarada`, `atualizarAsaasKey`) validado contra um servidor mock que replica o contrato do backend:
  - `getResumoInadimplencia()` sem filtros retorna o objeto completo (`taxa_inadimplencia_percentual`, `faixas`, `top_devedores` como array etc.) — confirmado que a chamada sem parâmetros não envia nenhuma query string (deixa o backend cair no padrão de 12 meses).
  - `getResumoInadimplencia({ vencDe, vencAte, renegociacao })` monta a query com os nomes exatos que o backend espera (`venc_de`, `venc_ate`, `renegociacao`) — confirmado indiretamente pelo teste do cenário de erro abaixo, que só dispara porque o mock reconhece o parâmetro `venc_de` pelo nome certo.
  - `getAsaasKeyMascarada()` retorna a chave mascarada tal como o backend manda, sem nenhum processamento client-side.
  - `atualizarAsaasKey(chave)` envia `{ "chave": "..." }` no corpo do PATCH (nome exato exigido pelo backend) e retorna a versão mascarada da resposta.
  - **Erro "chave não configurada"**: mock configurado para responder `400` com a mesma mensagem do backend real (citando `"asaas-key"`) — confirmado que `getResumoInadimplencia` lança `ApiError` com `status: 400` e `message` batendo no regex `/asaas-key/i` usado por `app/inadimplencia/page.js` para decidir mostrar o aviso de "chave não configurada" em vez do `ErrorBanner` genérico.
- **Não testado neste ambiente** (mesma limitação de Chromium headless): interação real de UI — abrir os `DatePicker` de "Vencimento de/até", trocar os dropdowns de "Faixa de atraso"/"Renegociação", clicar em "Aplicar"/"Limpar", clicar numa barra do gráfico de faixas para destacá-la, e o fluxo de salvar a chave do Asaas em Configurações (incluindo a mensagem "Salvo com sucesso."). A lógica de cada uma dessas interações foi revisada manualmente; os pontos que não dependem de DOM (construção da query, tratamento do erro 400 específico, payload do PATCH) foram cobertos pelos testes acima. Recomendamos um teste manual (`npm run dev`) contra a API real antes do deploy, incluindo o caso de configurar a chave do Asaas pela primeira vez e ver a tela `/inadimplencia` sair do estado de aviso para os dados reais.
