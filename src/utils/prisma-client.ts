import { PrismaClient } from "@prisma/client";

class PrismaSingleton {
  private static instance: PrismaClient;

  private constructor() {} // Prevent direct instantiation

  public static getInstance(): PrismaClient {
    if (!PrismaSingleton.instance) {
      PrismaSingleton.instance = new PrismaClient({
        log: ["info", "warn", "error"],
      });
    }

    return PrismaSingleton.instance;
  }
}

export const prisma = PrismaSingleton.getInstance();
