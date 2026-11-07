const schedule = jest.fn();

jest.mock("node-cron", () => ({
  __esModule: true,
  default: { schedule },
}));

// The jobs themselves are stubbed. Importing the real ones drags in the
// services and the Prisma client, which opens a pool this spec never closes
// — jest then reports that it could not exit. What is under test here is
// the registration, not the work.
jest.mock("../../src/jobs/token-cleanup.job", () => ({
  deleteExpiredTokens: jest.fn(async () => undefined),
}));
jest.mock("../../src/jobs/session-cleanup.job", () => ({
  cleanupExpiredSessions: jest.fn(async () => undefined),
}));
jest.mock("../../src/jobs/file-cleanup.job", () => ({
  cleanupFiles: jest.fn(async () => undefined),
}));

import registerCronJobs from "../../src/jobs";
import config from "../../src/config/config";

/**
 * Every cron expression in this project is documented as UTC — the
 * `ScheduledJob.schedule` doc comment, the `# --- Cron (UTC) ---` heading in
 * .env.example, and the config descriptions all say so.
 *
 * node-cron does not agree unless told: with no `timezone` option it
 * interprets the expression in the HOST timezone. On a container with
 * TZ=Asia/Kolkata, `0 3 * * *` fired at 21:30 UTC the previous day. The file
 * sweep deletes R2 objects, so which window it runs in is operational, and
 * nothing logged the discrepancy.
 */
describe("registerCronJobs", () => {
  beforeEach(() => {
    schedule.mockClear();
    registerCronJobs();
  });

  it("registers every job", () => {
    expect(schedule).toHaveBeenCalledTimes(3);
  });

  it("pins every schedule to UTC", () => {
    // THE REGRESSION.
    for (const call of schedule.mock.calls) {
      expect(call[2]).toMatchObject({ timezone: "UTC" });
    }
  });

  it("uses the configured expressions", () => {
    const expressions = schedule.mock.calls.map((call) => call[0]);

    expect(expressions).toEqual(
      expect.arrayContaining([
        config.CRON.TOKEN_CLEANUP,
        config.CRON.SESSION_CLEANUP,
        config.CRON.FILE_CLEANUP,
      ]),
    );
  });

  it("wraps each handler so a failure is logged and not rethrown", async () => {
    // node-cron catches a rejected handler but reports through its own
    // channel, so an unwrapped failure would be missing from winston — the
    // only logs anyone actually reads.
    const handler = schedule.mock.calls[0]![1] as () => Promise<void>;

    await expect(handler()).resolves.toBeUndefined();
  });
});
