import path from "node:path";
import dotenv from "dotenv";
import { defineConfig } from "prisma/config";

dotenv.config({ path: path.join(__dirname, ".env") });

export default defineConfig({
  schema: path.join("prisma", "schema"),
  // Required: do NOT remove. With a multi-file schema folder, Prisma's default
  // migrations path is derived from the schema dir (-> "prisma/schema/migrations"),
  // which does not exist. Dropping this line makes Prisma see zero applied
  // migrations and attempt to recreate the whole schema from scratch.
  migrations: {
    path: path.join("prisma", "migrations"),
  },
  datasource: {
    url: process.env.DATABASE_URL,
  },
});
