-- AlterTable
ALTER TABLE "associados" ADD COLUMN     "bloqueado" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ciclo_resetado_em" TIMESTAMP(3),
ADD COLUMN     "em_juridico" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "historico_bloqueio" (
    "id" TEXT NOT NULL,
    "associado_id" TEXT NOT NULL,
    "status_anterior" BOOLEAN NOT NULL,
    "status_novo" BOOLEAN NOT NULL,
    "alterado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historico_bloqueio_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuracoes" (
    "chave" TEXT NOT NULL,
    "valor" TEXT NOT NULL,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "configuracoes_pkey" PRIMARY KEY ("chave")
);

-- CreateTable
CREATE TABLE "sync_log" (
    "id" TEXT NOT NULL,
    "executado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "total_associados_processados" INTEGER NOT NULL,
    "sucesso" BOOLEAN NOT NULL,

    CONSTRAINT "sync_log_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historico_bloqueio_associado_id_idx" ON "historico_bloqueio"("associado_id");

-- CreateIndex
CREATE INDEX "sync_log_executado_em_idx" ON "sync_log"("executado_em");

-- AddForeignKey
ALTER TABLE "historico_bloqueio" ADD CONSTRAINT "historico_bloqueio_associado_id_fkey" FOREIGN KEY ("associado_id") REFERENCES "associados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

