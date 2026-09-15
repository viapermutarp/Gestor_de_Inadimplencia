-- =============================================================================
-- Diagnóstico: associados sumindo do filtro "Jurídico" em Taxa de Inadimplência
-- =============================================================================
-- Investigação pedida: com o filtro "Jurídico" ativo (período 01/01–31/08/2026),
-- só aparecem 4 dos 8 associados com card real no quadro Jurídico. Os que
-- somem (Fernanda, Nadia, Malu, Joyce) têm valor relevante no CARD deles
-- (ex.: Fernanda R$ 42.455,77), que não aparece em lugar nenhum nos totais
-- da tela.
--
-- Achado de leitura de código (antes de rodar isto): o valor mostrado no
-- CARD do Jurídico ("valor_em_aberto", ver juridico.controller.js) vem da
-- tabela "cobrancas" (associado -> cobrancas, sync antigo via n8n/POST
-- /api/sync). Os totais da tela "Taxa de Inadimplência" (/resumo) vêm de
-- uma tabela DIFERENTE, "pagamentos_asaas" (sync novo via webhook/backfill
-- do Asaas, AJUSTE 14) — as duas nunca se tocam por FK, só por cpf_cnpj
-- (string, cruzado em tempo de consulta). Duas causas prováveis, na ordem
-- mais provável primeiro:
--   (a) o associado não tem NENHUMA linha em pagamentos_asaas ainda (nunca
--       passou pelo backfill/webhook novo, só está em "cobrancas" via
--       n8n) — nesse caso o valor existe de verdade, mas nunca chegou na
--       fonte de dados que a tela nova usa, com ou sem filtro Jurídico;
--   (b) o associado TEM linhas em pagamentos_asaas, mas o cpf_cnpj gravado
--       lá não bate, caractere por caractere, com o cpf_cnpj gravado em
--       "associados" (ex.: "123.456.789-00" vs "12345678900" — o /api/sync,
--       que alimenta "associados", grava o cpf_cnpj como vier no payload,
--       SEM normalizar; o backfill/webhook do Asaas, que alimenta
--       pagamentos_asaas, também grava como a API do Asaas devolve —
--       tipicamente só dígitos). Isso quebraria não só o filtro Jurídico
--       novo (AJUSTE 17, buscarCpfCnpjComCardJuridico), mas TAMBÉM o
--       cruzamento antigo por em_juridico/nome/bloqueado/em_negociacao
--       (resolverAssociadosPorCpfCnpj já faz o mesmo "where cpf_cnpj in
--       (...)" exato) — ou seja, se for isso, o problema é mais amplo do
--       que só o card "Jurídico".
--   (c) dueDate das cobranças reais desses associados cai fora de
--       01/01–31/08/2026 (comportamento esperado, item 1 do pedido).
--
-- Como rodar: com o Postgres da aplicação acessível (ex.:
-- `docker compose exec db psql -U postgres -d gestor_inadimplencia -f
-- backend/scripts/diagnostico-juridico-sumindo.sql`, ou colando cada bloco
-- num cliente tipo pgAdmin/DBeaver/psql apontando pro banco real). Ajuste a
-- lista de nomes no array abaixo se precisar (adicionei variações de
-- acento pra "Nadia"/"Nádia").
-- =============================================================================

\pset pager off

-- ---------------------------------------------------------------------------
-- 0. Franquias existentes — contexto, pra confirmar se é ambiente
--    single-tenant ou se há mais de uma franquia (mismatch de franquia é
--    outra causa possível de "card existe, mas some do /resumo").
-- ---------------------------------------------------------------------------
SELECT id, nome FROM franquias ORDER BY nome;

-- ---------------------------------------------------------------------------
-- 1. Associados candidatos (ajuste os nomes se necessário)
-- ---------------------------------------------------------------------------
SELECT id, franquia_id, nome, cpf_cnpj, length(cpf_cnpj) AS tamanho_cpf_cnpj, em_juridico
FROM associados
WHERE nome ILIKE ANY (ARRAY['%fernanda%', '%nadia%', '%nádia%', '%malu%', '%joyce%'])
ORDER BY nome;

-- ---------------------------------------------------------------------------
-- 2. Cards reais no Jurídico desses associados — confirma que o card
--    existe e mostra em qual franquia/etapa ele está.
-- ---------------------------------------------------------------------------
SELECT
  a.nome,
  a.cpf_cnpj        AS cpf_associado,
  a.franquia_id     AS franquia_associado,
  cj.id             AS card_id,
  cj.franquia_id    AS franquia_card,
  ej.nome           AS etapa,
  cj.criado_em
FROM cards_juridico cj
JOIN associados a ON a.id = cj.associado_id
LEFT JOIN etapas_juridico ej ON ej.id = cj.etapa_id
WHERE a.nome ILIKE ANY (ARRAY['%fernanda%', '%nadia%', '%nádia%', '%malu%', '%joyce%'])
ORDER BY a.nome;

-- ---------------------------------------------------------------------------
-- 3. Cobranças (tabela "cobrancas", sync n8n) — é daqui que vem o valor
--    mostrado no CARD do Jurídico (soma de status pending/overdue). Serve
--    pra confirmar os R$ 42.455,77 da Fernanda e ver o vencimento real
--    dessas cobranças.
-- ---------------------------------------------------------------------------
SELECT
  a.nome,
  c.status,
  c.valor,
  c.vencimento,
  c.quitada_em,
  c.sincronizado_em
FROM cobrancas c
JOIN associados a ON a.id = c.associado_id
WHERE a.nome ILIKE ANY (ARRAY['%fernanda%', '%nadia%', '%nádia%', '%malu%', '%joyce%'])
ORDER BY a.nome, c.vencimento;

-- Resumo por associado (equivalente ao "valor_em_aberto" do card):
SELECT
  a.nome,
  COUNT(*) FILTER (WHERE c.status IN ('pending', 'overdue')) AS qtd_em_aberto,
  COALESCE(SUM(c.valor) FILTER (WHERE c.status IN ('pending', 'overdue')), 0) AS valor_em_aberto_card,
  MIN(c.vencimento) FILTER (WHERE c.status IN ('pending', 'overdue')) AS vencimento_mais_antigo,
  MAX(c.vencimento) FILTER (WHERE c.status IN ('pending', 'overdue')) AS vencimento_mais_recente
FROM associados a
LEFT JOIN cobrancas c ON c.associado_id = a.id
WHERE a.nome ILIKE ANY (ARRAY['%fernanda%', '%nadia%', '%nádia%', '%malu%', '%joyce%'])
GROUP BY a.id, a.nome
ORDER BY a.nome;

-- ---------------------------------------------------------------------------
-- 4. pagamentos_asaas — QUALQUER registro desses associados, em QUALQUER
--    período (não só 01/01-31/08) — pra ver de cara se é "zero linha nunca
--    chegou" (causa a) ou "tem linha, mas não bate" (causa b).
-- ---------------------------------------------------------------------------
SELECT
  a.nome,
  COUNT(pa.id)              AS total_pagamentos_asaas_match_exato,
  MIN(pa.due_date)          AS due_date_min,
  MAX(pa.due_date)          AS due_date_max,
  COUNT(pa.id) FILTER (WHERE pa.due_date BETWEEN '2026-01-01' AND '2026-08-31') AS total_dentro_do_periodo
FROM associados a
LEFT JOIN pagamentos_asaas pa ON pa.cpf_cnpj = a.cpf_cnpj
WHERE a.nome ILIKE ANY (ARRAY['%fernanda%', '%nadia%', '%nádia%', '%malu%', '%joyce%'])
GROUP BY a.id, a.nome
ORDER BY a.nome;

-- ---------------------------------------------------------------------------
-- 5. Mesma pergunta, mas com o cpf_cnpj NORMALIZADO (só dígitos) dos dois
--    lados — se essa contagem for MAIOR que a da consulta 4 acima, achamos
--    a causa (b): formatação de cpf_cnpj divergente entre "associados" e
--    "pagamentos_asaas" (o app hoje faz match EXATO, então essa diferença
--    de formatação já explicaria o sumiço sozinha).
-- ---------------------------------------------------------------------------
SELECT
  a.nome,
  a.cpf_cnpj                                    AS cpf_associado_bruto,
  regexp_replace(a.cpf_cnpj, '\D', '', 'g')     AS cpf_associado_normalizado,
  COUNT(pa.id)                                   AS total_pagamentos_asaas_match_normalizado,
  MIN(pa.due_date)                               AS due_date_min,
  MAX(pa.due_date)                               AS due_date_max,
  COUNT(pa.id) FILTER (WHERE pa.due_date BETWEEN '2026-01-01' AND '2026-08-31') AS total_dentro_do_periodo
FROM associados a
LEFT JOIN pagamentos_asaas pa
  ON regexp_replace(pa.cpf_cnpj, '\D', '', 'g') = regexp_replace(a.cpf_cnpj, '\D', '', 'g')
WHERE a.nome ILIKE ANY (ARRAY['%fernanda%', '%nadia%', '%nádia%', '%malu%', '%joyce%'])
GROUP BY a.id, a.nome, a.cpf_cnpj
ORDER BY a.nome;

-- ---------------------------------------------------------------------------
-- 6. Detalhe linha a linha de pagamentos_asaas por match normalizado (só
--    roda de fato útil se a consulta 5 mostrou mais linhas que a 4) —
--    mostra o cpf_cnpj bruto gravado nos dois lados, lado a lado, pra
--    confirmar visualmente a diferença de formatação (pontuação, espaços,
--    etc.) e a franquia de cada linha.
-- ---------------------------------------------------------------------------
SELECT
  a.nome,
  a.cpf_cnpj      AS cpf_associado_bruto,
  a.franquia_id   AS franquia_associado,
  pa.id           AS pagamento_id,
  pa.cpf_cnpj     AS cpf_pagamento_bruto,
  pa.franquia_id  AS franquia_pagamento,
  pa.due_date,
  pa.value,
  pa.status
FROM associados a
JOIN pagamentos_asaas pa
  ON regexp_replace(pa.cpf_cnpj, '\D', '', 'g') = regexp_replace(a.cpf_cnpj, '\D', '', 'g')
WHERE a.nome ILIKE ANY (ARRAY['%fernanda%', '%nadia%', '%nádia%', '%malu%', '%joyce%'])
ORDER BY a.nome, pa.due_date;

-- ---------------------------------------------------------------------------
-- 7. Controle: mesmas consultas 4/5, mas para os 4 associados do Jurídico
--    que CONTINUAM aparecendo no filtro (pra comparação lado a lado —
--    preencha os nomes deles abaixo). Se os 4 "que funcionam" mostrarem
--    match exato = match normalizado, e os 4 "que somem" mostrarem match
--    normalizado > match exato (ou zero nos dois), fecha a causa (b) ou
--    (a) respectivamente, por comparação direta.
-- ---------------------------------------------------------------------------
-- SELECT a.nome, a.cpf_cnpj,
--        COUNT(pa_exato.id) AS match_exato,
--        COUNT(pa_norm.id) AS match_normalizado
-- FROM associados a
-- LEFT JOIN pagamentos_asaas pa_exato ON pa_exato.cpf_cnpj = a.cpf_cnpj
-- LEFT JOIN pagamentos_asaas pa_norm
--   ON regexp_replace(pa_norm.cpf_cnpj, '\D', '', 'g') = regexp_replace(a.cpf_cnpj, '\D', '', 'g')
-- WHERE a.nome ILIKE ANY (ARRAY['%nome-que-funciona-1%', '%nome-que-funciona-2%'])
-- GROUP BY a.id, a.nome, a.cpf_cnpj;
