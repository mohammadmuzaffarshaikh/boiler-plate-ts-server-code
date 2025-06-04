-- AlterTable
ALTER TABLE "tokens" ADD COLUMN     "organizationId" TEXT;

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
