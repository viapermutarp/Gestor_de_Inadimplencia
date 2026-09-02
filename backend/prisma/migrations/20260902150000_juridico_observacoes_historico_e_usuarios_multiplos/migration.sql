-- Três ajustes combinados nesta migração (mesmo pedido, ver
-- docs/plano-multi-franquia.md, seção 8, itens 6/7/8):
--
--   1) "observacoes" em cards_juridico — campo livre extra, mesma regra de
--      visibilidade de "descricao" (validada em código, não aqui).
--
--   2) Nova tabela "historico_card_juridico" — log de criação, edição de
--      campo, mudança de etapa e exclusão dos cards do Jurídico. Sem FK pra
--      cards_juridico nem pra usuarios, de propósito (ver docblock do model
--      em schema.prisma) — precisa sobreviver à exclusão do card.
--
--   3) Usuario deixa de ser 1:1 com Franquia (DROP do índice único
--      "usuarios_franquia_id_key") e passa a ter "recursos_permitidos"
--      próprio (movido de franquias.recursos_permitidos) — franquia.
--      recursos_permitidos é mantido como coluna legada (não lida mais pelo
--      código), sem DROP COLUMN.

-- 1) cards_juridico.observacoes
ALTER TABLE "cards_juridico" ADD COLUMN "observacoes" TEXT;

-- 2) historico_card_juridico
CREATE TABLE "historico_card_juridico" (
    "id" TEXT NOT NULL,
    "card_id" TEXT NOT NULL,
    "franquia_id" TEXT NOT NULL,
    "campo_alterado" TEXT NOT NULL,
    "valor_anterior" TEXT,
    "valor_novo" TEXT,
    "usuario_id" TEXT,
    "criado_em" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "historico_card_juridico_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "historico_card_juridico_card_id_idx" ON "historico_card_juridico"("card_id");
CREATE INDEX "historico_card_juridico_franquia_id_idx" ON "historico_card_juridico"("franquia_id");

ALTER TABLE "historico_card_juridico" ADD CONSTRAINT "historico_card_juridico_franquia_id_fkey"
    FOREIGN KEY ("franquia_id") REFERENCES "franquias"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3) usuarios: remove a trava de 1-usuário-por-franquia e ganha
-- "recursos_permitidos" próprio, com backfill a partir da franquia dele
-- (preserva o acesso que cada usuário único já tinha até aqui).
DROP INDEX "usuarios_franquia_id_key";

ALTER TABLE "usuarios" ADD COLUMN "recursos_permitidos" TEXT[] NOT NULL DEFAULT '{}';

UPDATE "usuarios" u
SET "recursos_permitidos" = f."recursos_permitidos"
FROM "franquias" f
WHERE u."franquia_id" = f."id";
