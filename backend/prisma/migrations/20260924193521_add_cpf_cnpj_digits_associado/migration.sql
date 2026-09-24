-- Correção pós-AJUSTE 19 — "cpf_cnpj" nunca era normalizado na hora de
-- comparar/buscar nos 3 caminhos que escrevem em Associado (POST /api/sync,
-- POST /api/cadastros, importação de CSV): uma formatação diferente do
-- MESMO CPF/CNPJ (com ou sem pontuação — ex.: "123.456.789-00" vs.
-- "12345678900") era tratada como uma pessoa/empresa nova, arriscando
-- duplicata em vez de reconhecer o conflito.
--
-- Campo novo "cpf_cnpj_digits" (só dígitos) passa a ser a chave de fato
-- usada em toda busca/comparação (ver executarUpsertEscopado em
-- src/config/prismaComEscopo.js e src/lib/cpfCnpj.js) — mantido em
-- sincronia SÓ PELA APLICAÇÃO a cada escrita, nunca por trigger/generated
-- column do banco. "cpf_cnpj" continua guardando o valor original,
-- verbatim, exatamente como sempre guardou, só pra exibição.
--
-- Padrão de sempre pra coluna NOT NULL nova numa tabela já com dados:
-- nullable -> backfill -> NOT NULL (ver migração "20260901130000_add_multi_franquia").
--
-- ATENÇÃO — se este passo falhar com "duplicate key value violates unique
-- constraint" na CREATE UNIQUE INDEX abaixo, significa que já existem hoje
-- (antes mesmo deste ajuste) 2+ associados com o MESMO CPF/CNPJ gravados em
-- formatos diferentes — precisa ser resolvido manualmente (decidir qual
-- registro é o "certo" e mesclar/remover o outro) antes de rodar esta
-- migração de novo. Rode a query abaixo pra checar isso ANTES de aplicar:
--
--   SELECT regexp_replace(cpf_cnpj, '\D', '', 'g') AS digitos, count(*), array_agg(id)
--   FROM associados
--   GROUP BY 1
--   HAVING count(*) > 1;

ALTER TABLE "associados" ADD COLUMN "cpf_cnpj_digits" TEXT;

UPDATE "associados" SET "cpf_cnpj_digits" = regexp_replace("cpf_cnpj", '\D', '', 'g');

ALTER TABLE "associados" ALTER COLUMN "cpf_cnpj_digits" SET NOT NULL;

CREATE UNIQUE INDEX "associados_cpf_cnpj_digits_key" ON "associados"("cpf_cnpj_digits");
