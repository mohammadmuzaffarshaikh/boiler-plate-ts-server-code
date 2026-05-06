import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import config from "../config/config";

class PrismaSingleton {
  private static instance: PrismaClient;

  private constructor() {}

  public static getInstance(): PrismaClient {
    if (!PrismaSingleton.instance) {
      const adapter = new PrismaPg({ connectionString: config.DATABASE.URL });
      PrismaSingleton.instance = new PrismaClient({
        adapter,
        log: ["info", "warn", "error"],
      });
    }

    return PrismaSingleton.instance;
  }
}

export const prisma = PrismaSingleton.getInstance();
