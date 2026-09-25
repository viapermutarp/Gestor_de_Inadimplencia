-- Adiciona "client_payment_date" e "confirmed_date" à tabela pagamentos_asaas.
--
-- AJUSTE 22 (revisão pré-commit, item "quitadaEm para CONFIRMED") — pra
-- cartão de crédito (status CONFIRMED no Asaas), "payment_date" costuma vir
-- nulo até o repasse pro lojista terminar de processar, mesmo com o
-- pagamento já confirmado. "confirmed_date" (quando o Asaas confirmou) e
-- "client_payment_date" (quando o cliente efetivamente pagou) costumam vir
-- preenchidos nesse meio tempo — usados como fallback em "aplicarQuitacao"
-- (src/services/cobrancasPresas.service.js) pra "quitada_em" refletir a data
-- real em vez de cair em "agora" só por causa do repasse ainda pendente.
--
-- Mesma convenção de string "YYYY-MM-DD" (sem parsing) de
-- due_date/payment_date/date_created, já usada nesta tabela.
ALTER TABLE "pagamentos_asaas" ADD COLUMN "client_payment_date" TEXT;
ALTER TABLE "pagamentos_asaas" ADD COLUMN "confirmed_date" TEXT;
