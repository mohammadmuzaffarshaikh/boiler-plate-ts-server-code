/*
  Warnings:

  - You are about to drop the column `role` on the `users` table. All the data in the column will be lost.
  - You are about to drop the column `status` on the `users` table. All the data in the column will be lost.

*/
-- CreateEnum
CREATE TYPE "OrgUserRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER', 'VIEWER');

-- CreateEnum
CREATE TYPE "OrgUserStatus" AS ENUM ('ACTIVE', 'INVITED', 'INACTIVE');

-- CreateEnum
CREATE TYPE "OrganizationStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "users" DROP COLUMN "role",
DROP COLUMN "status";

-- DropEnum
DROP TYPE "UserRoles";

-- DropEnum
DROP TYPE "UserStatus";

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "colorTheme" TEXT DEFAULT 'zinc',
    "status" "OrganizationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_organizations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "role" "OrgUserRole" NOT NULL DEFAULT 'MEMBER',
    "status" "OrgUserStatus" NOT NULL DEFAULT 'ACTIVE',
    "isPrimary" BOOLEAN NOT NULL DEFAULT false,
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_organizations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_email_key" ON "organizations"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_organizations_userId_organizationId_key" ON "user_organizations"("userId", "organizationId");

-- AddForeignKey
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
