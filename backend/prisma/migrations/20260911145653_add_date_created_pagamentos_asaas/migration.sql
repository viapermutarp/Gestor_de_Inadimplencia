-- AlterTable
ALTER TABLE "pagamentos_asaas" ADD COLUMN     "date_created" TEXT;

-- CreateIndex
CREATE INDEX "pagamentos_asaas_franquia_id_date_created_idx" ON "pagamentos_asaas"("franquia_id", "date_created");

-- CreateIndex
CREATE INDEX "pagamentos_asaas_franquia_id_payment_date_idx" ON "pagamentos_asaas"("franquia_id", "payment_date");
