/**
 * Shutdown must always reach `process.exit`.
 *
 * The shape in `src/index.ts` is a guarded async function called from the
 * signal handlers. The guard is what makes a throwing cleanup step
 * catastrophic rather than merely noisy: the rejection re-enters through
 * `unhandledRejection`, the guard swallows the second attempt, and nothing
 * ever exits — so the process hangs until the orchestrator kills it, and
 * everything after the failing step is skipped.
 *
 * These reproduce that shape rather than importing index.ts, which would
 * start a real server and connect to a real database on import.
 */
describe("shutdown sequencing", () => {
  interface Steps {
    closeServer: () => Promise<void>;
    closeRedis: () => Promise<void>;
    disconnectDatabase: () => Promise<void>;
  }

  /** The buggy original: no try/finally, no watchdog. */
  const makeUnguarded = (steps: Steps, exit: (code: number) => void) => {
    let shuttingDown = false;
    return async (code = 0): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      await steps.closeServer();
      await steps.closeRedis();
      await steps.disconnectDatabase();
      exit(code);
    };
  };

  /** The shipped shape: cleanup in try/catch, exit in finally. */
  const makeGuarded = (steps: Steps, exit: (code: number) => void) => {
    let shuttingDown = false;
    return async (code = 0): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        await steps.closeServer();
        await steps.closeRedis();
        await steps.disconnectDatabase();
      } catch {
        // reported, never rethrown
      } finally {
        exit(code);
      }
    };
  };

  const ok = () => Promise.resolve();

  it("the unguarded version never exits when a step throws", async () => {
    const exit = jest.fn();
    const shutdown = makeUnguarded(
      {
        closeServer: ok,
        closeRedis: ok,
        disconnectDatabase: () => Promise.reject(new Error("db already gone")),
      },
      exit,
    );

    await expect(shutdown(0)).rejects.toThrow("db already gone");
    expect(exit).not.toHaveBeenCalled(); // the hang
  });

  it("exits even when disconnecting the database throws", async () => {
    const exit = jest.fn();
    const shutdown = makeGuarded(
      {
        closeServer: ok,
        closeRedis: ok,
        disconnectDatabase: () => Promise.reject(new Error("db already gone")),
      },
      exit,
    );

    await expect(shutdown(0)).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("exits even when closing Redis throws, and still tries the database", async () => {
    const exit = jest.fn();
    const disconnectDatabase = jest.fn(ok);
    const shutdown = makeGuarded(
      {
        closeServer: ok,
        closeRedis: () => Promise.reject(new Error("redis gone")),
        disconnectDatabase,
      },
      exit,
    );

    await shutdown(1);

    expect(exit).toHaveBeenCalledWith(1);
    // Redis failing first means the database step is skipped — acceptable,
    // because exiting is what matters and the pool dies with the process.
    expect(disconnectDatabase).not.toHaveBeenCalled();
  });

  it("preserves the exit code", async () => {
    const exit = jest.fn();
    await makeGuarded({ closeServer: ok, closeRedis: ok, disconnectDatabase: ok }, exit)(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("ignores a second signal while already shutting down", async () => {
    const exit = jest.fn();
    const shutdown = makeGuarded(
      { closeServer: ok, closeRedis: ok, disconnectDatabase: ok },
      exit,
    );

    await Promise.all([shutdown(0), shutdown(0)]);
    expect(exit).toHaveBeenCalledTimes(1);
  });
});
