import app from "./app";
import config from "./config/config";
import logger from "./config/logger";
import { Server } from "http";
import { prisma } from "./utils/prisma-client";

let server: Server | undefined;

logger.info(`Node Environment => ${config.env}`);

async function startServer() {
  try {
    // Try connecting to the DB using Prisma
    await prisma.$connect();
    logger.info(
      `Connected to PostgreSQL (via Prisma) => ${config.database.url}`
    );

    server = app.listen(config.port, () => {
      logger.info(`Node server listening on port => ${config.port}`);
    });
  } catch (error) {
    logger.error("Failed to connect to database", error);
    process.exit(1);
  }
}

// Start the app
startServer();

const exitHandler = async () => {
  if (server) {
    server.close(async () => {
      logger.info("Server closed");

      // Gracefully disconnect Prisma
      await prisma.$disconnect();
      process.exit(1);
    });
  } else {
    process.exit(1);
  }
};

const unexpectedErrorHandler = (error: Error) => {
  logger.error("Unexpected error:", error);
  exitHandler();
};

process.on("uncaughtException", unexpectedErrorHandler);
process.on("unhandledRejection", unexpectedErrorHandler);

process.on("SIGTERM", async () => {
  logger.info("SIGTERM received");

  if (server) {
    server.close(async () => {
      logger.info("Server closed due to SIGTERM");
      await prisma.$disconnect();
    });
  }
});
