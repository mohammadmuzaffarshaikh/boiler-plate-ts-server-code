/*
  Warnings:

  - The primary key for the `user_organizations` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `id` on the `user_organizations` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "TokenTypes" AS ENUM ('REFRESH', 'RESET_PASSWORD', 'INVITE_USER', 'MFA');

-- DropIndex
DROP INDEX "user_organizations_userId_organizationId_key";

-- AlterTable
ALTER TABLE "user_organizations" DROP CONSTRAINT "user_organizations_pkey",
DROP COLUMN "id",
ADD CONSTRAINT "user_organizations_pkey" PRIMARY KEY ("userId", "organizationId");

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "isMfaEnabled" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "tokens" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "type" "TokenTypes" NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "tokens_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "tokens" ADD CONSTRAINT "tokens_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
