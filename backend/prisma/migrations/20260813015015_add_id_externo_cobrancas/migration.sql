-- AlterTable
ALTER TABLE "cobrancas" ADD COLUMN     "id_externo" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "cobrancas_id_externo_key" ON "cobrancas"("id_externo");

-- CreateIndex
CREATE INDEX "cobrancas_id_externo_idx" ON "cobrancas"("id_externo");

