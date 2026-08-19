-- Consolida "historico_negociacao" e "historico_bloqueio" numa única tabela
-- "historico_status_associado" (coluna "campo" discrimina qual status
-- mudou: 'em_negociacao' | 'bloqueado' | 'em_juridico' — este último nunca
-- teve tabela de histórico própria antes desta migração). Preserva todos os
-- registros existentes: primeiro cria a tabela nova, copia os dados das
-- duas antigas (com o "campo" certo em cada INSERT), só então derruba as
-- antigas. Em bancos novos (sem linhas em historico_negociacao/
-- historico_bloqueio ainda) os INSERT...SELECT simplesmente não copiam nada.

-- CreateTable
CREATE TABLE "historico_status_associado" (
    "id" TEXT NOT NULL,
    "associado_id" TEXT NOT NULL,
    "campo" TEXT NOT NULL,
    "status_anterior" BOOLEAN NOT NULL,
    "status_novo" BOOLEAN NOT NULL,
    "alterado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historico_status_associado_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "historico_status_associado_associado_id_idx" ON "historico_status_associado"("associado_id");

-- CreateIndex
CREATE INDEX "historico_status_associado_campo_idx" ON "historico_status_associado"("campo");

-- AddForeignKey
ALTER TABLE "historico_status_associado" ADD CONSTRAINT "historico_status_associado_associado_id_fkey" FOREIGN KEY ("associado_id") REFERENCES "associados"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MigrateData: historico_negociacao -> historico_status_associado (campo = 'em_negociacao')
INSERT INTO "historico_status_associado" ("id", "associado_id", "campo", "status_anterior", "status_novo", "alterado_em")
SELECT "id", "associado_id", 'em_negociacao', "status_anterior", "status_novo", "alterado_em"
FROM "historico_negociacao";

-- MigrateData: historico_bloqueio -> historico_status_associado (campo = 'bloqueado')
INSERT INTO "historico_status_associado" ("id", "associado_id", "campo", "status_anterior", "status_novo", "alterado_em")
SELECT "id", "associado_id", 'bloqueado', "status_anterior", "status_novo", "alterado_em"
FROM "historico_bloqueio";

-- DropTable
DROP TABLE "historico_negociacao";

-- DropTable
DROP TABLE "historico_bloqueio";
