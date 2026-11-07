import type { Config } from "jest";

const config: Config = {
  testEnvironment: "node",
  rootDir: ".",
  roots: ["<rootDir>/tests"],

  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/tsconfig.test.json" }],
  },

  // Runs before the test file (and therefore before `src/config/config.ts`)
  // is imported, which is the only point at which environment variables can
  // still influence it — config reads process.env once, at module load.
  setupFiles: ["<rootDir>/tests/helpers/env.ts"],

  restoreMocks: true,

  // Integration specs share one Postgres database. Running files in parallel
  // makes them race over the same rows, so the `test:integration` script
  // passes --runInBand. Unit specs touch nothing shared and run in parallel.
  testTimeout: 30_000,

  collectCoverageFrom: ["src/**/*.ts"],
  coveragePathIgnorePatterns: ["node_modules", "src/config", "tests"],
  coverageReporters: ["text", "lcov", "clover", "html"],
};

export default config;
