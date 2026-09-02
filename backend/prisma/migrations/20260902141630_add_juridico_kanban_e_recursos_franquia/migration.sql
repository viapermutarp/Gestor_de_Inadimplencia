-- AlterTable
ALTER TABLE "cadastros_enviados" ALTER COLUMN "modelos_contrato_ids" DROP DEFAULT;

-- AlterTable
-- Restrição de telas por franquia (ver docs/plano-multi-franquia.md e
-- src/config/recursos.js). NOT NULL DEFAULT '{}' ajustado manualmente
-- (Prisma gerou sem NOT NULL) para casar com "recursosPermitidos String[]"
-- (obrigatório) do schema e com o padrão já usado em
-- "cadastros_enviados.modelos_contrato_ids" (ver migração add_contratos).
ALTER TABLE "franquias" ADD COLUMN     "recursos_permitidos" TEXT[] NOT NULL DEFAULT '{}';

-- Backfill: toda franquia EXISTENTE até este deploy recebe todos os
-- recursos liberados por padrão — ninguém perde acesso ao que já tinha por
-- causa desta migração (ver escopo do pedido, item 2.1). Só franquias
-- criadas DAQUI PRA FRENTE (via POST /api/franquias, depois deste deploy)
-- passam a ter uma lista explícita definida pelo SUPER_ADMIN na criação
-- (ver franquias.controller.js:criar — default também é a lista completa,
-- mas fica editável antes de salvar).
UPDATE "franquias" SET "recursos_permitidos" = ARRAY['dashboard','inadimplencia','cadastro','contratos','juridico','configuracoes'];

-- CreateTable
CREATE TABLE "etapas_juridico" (
    "id" TEXT NOT NULL,
    "franquia_id" TEXT NOT NULL,
    "nome" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "etapas_juridico_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cards_juridico" (
    "id" TEXT NOT NULL,
    "franquia_id" TEXT NOT NULL,
    "etapa_id" TEXT NOT NULL,
    "ordem" INTEGER NOT NULL,
    "associado_id" TEXT,
    "titulo" TEXT,
    "descricao" TEXT,
    "responsavel" TEXT,
    "prazo" DATE,
    "etapa_alterada_em" TIMESTAMP(3),
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "atualizado_em" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cards_juridico_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "etapas_juridico_franquia_id_idx" ON "etapas_juridico"("franquia_id");

-- CreateIndex
CREATE INDEX "cards_juridico_franquia_id_idx" ON "cards_juridico"("franquia_id");

-- CreateIndex
CREATE INDEX "cards_juridico_etapa_id_idx" ON "cards_juridico"("etapa_id");

-- CreateIndex
CREATE INDEX "cards_juridico_associado_id_idx" ON "cards_juridico"("associado_id");

-- AddForeignKey
ALTER TABLE "etapas_juridico" ADD CONSTRAINT "etapas_juridico_franquia_id_fkey" FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards_juridico" ADD CONSTRAINT "cards_juridico_franquia_id_fkey" FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards_juridico" ADD CONSTRAINT "cards_juridico_etapa_id_fkey" FOREIGN KEY ("etapa_id") REFERENCES "etapas_juridico"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cards_juridico" ADD CONSTRAINT "cards_juridico_associado_id_fkey" FOREIGN KEY ("associado_id") REFERENCES "associados"("id") ON DELETE CASCADE ON UPDATE CASCADE;
