-- AlterEnum
ALTER TYPE "AliasSource" ADD VALUE 'PROMOTED';

-- AlterTable
ALTER TABLE "team_aliases" ADD COLUMN     "usos" INTEGER NOT NULL DEFAULT 0;
