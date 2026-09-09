-- AJUSTE 11 — Documentos anexados ao associado, visíveis no card Jurídico
-- (ver brief "Documentos anexados ao associado, visíveis no card Jurídico"
-- e README para detalhes do fluxo completo).
--
-- Vinculado por "cpf_cnpj" (do Associado), de propósito NÃO por
-- "card_id": os documentos precisam sobreviver à exclusão do card
-- (AJUSTE 10 passou a excluir de verdade — hard delete — o card quando
-- "em_juridico" é desmarcado no Dashboard) e reaparecer automaticamente se
-- um novo card for criado depois para o mesmo associado. Por isso não há
-- foreign key para "cards_juridico" nem para "associados" aqui.
--
-- CreateTable
CREATE TABLE "documentos_juridico" (
    "id" TEXT NOT NULL,
    "franquia_id" TEXT NOT NULL,
    "cpf_cnpj" TEXT NOT NULL,
    "nome_original" TEXT NOT NULL,
    "caminho_arquivo" TEXT NOT NULL,
    "tipo_mime" TEXT NOT NULL,
    "tamanho_bytes" INTEGER NOT NULL,
    "enviado_por" TEXT,
    "descricao" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentos_juridico_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "documentos_juridico_franquia_id_idx" ON "documentos_juridico"("franquia_id");

-- CreateIndex
CREATE INDEX "documentos_juridico_cpf_cnpj_idx" ON "documentos_juridico"("cpf_cnpj");

-- AddForeignKey
ALTER TABLE "documentos_juridico" ADD CONSTRAINT "documentos_juridico_franquia_id_fkey" FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
