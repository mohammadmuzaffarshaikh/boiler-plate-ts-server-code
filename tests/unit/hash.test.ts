import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import config from "../../src/config/config";
import {
  hashString,
  compareHash,
  hashToken,
  needsRehash,
} from "../../src/utils/hash";

/** The cost field of a bcrypt string: `$2b$12$...` -> 12. */
const costOf = (hash: string): number =>
  Number(/^\$2[aby]\$(\d{2})\$/.exec(hash)![1]);

describe("hashString / compareHash", () => {
  it("does not store the plaintext", async () => {
    const hash = await hashString("hunter2");
    expect(hash).not.toContain("hunter2");
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  it("accepts the right password and refuses the wrong one", async () => {
    const hash = await hashString("hunter2");
    await expect(compareHash("hunter2", hash)).resolves.toBe(true);
    await expect(compareHash("hunter3", hash)).resolves.toBe(false);
  });

  it("salts, so the same password hashes differently every time", async () => {
    // Two accounts with the same password must not be visibly the same in
    // the table, and a precomputed table must not match either.
    const [a, b] = await Promise.all([
      hashString("hunter2"),
      hashString("hunter2"),
    ]);

    expect(a).not.toBe(b);
    await expect(compareHash("hunter2", a)).resolves.toBe(true);
    await expect(compareHash("hunter2", b)).resolves.toBe(true);
  });

  it("is case and whitespace sensitive", async () => {
    const hash = await hashString("hunter2");
    await expect(compareHash("Hunter2", hash)).resolves.toBe(false);
    await expect(compareHash("hunter2 ", hash)).resolves.toBe(false);
  });

  it("returns false rather than throwing on a malformed hash", async () => {
    // A row corrupted by a bad migration must fail the login, not 500 it.
    await expect(compareHash("hunter2", "not-a-bcrypt-hash")).resolves.toBe(
      false,
    );
  });
});

describe("the work factor", () => {
  /**
   * It was a hard-coded 8 — roughly 2016-era, and 16x cheaper to attack than
   * 12. It is now `BCRYPT_ROUNDS`, with a Joi floor of 10 (OWASP's current
   * recommendation) so it cannot be turned down from the environment to make
   * something feel faster.
   */
  it("uses the configured cost, not a literal", async () => {
    expect(costOf(await hashString("hunter2"))).toBe(config.AUTH.BCRYPT_ROUNDS);
  });

  it("is at least 10 whatever the environment says", () => {
    // Pinning the floor itself. `config.ts` refuses to start below it, so
    // removing that `.min(10)` fails the whole suite at import rather than
    // quietly weakening every password in the database.
    expect(config.AUTH.BCRYPT_ROUNDS).toBeGreaterThanOrEqual(10);
  });
});

describe("needsRehash", () => {
  /**
   * Raising the work factor does nothing to rows that already exist: a bcrypt
   * string carries its own cost, so an account created at 8 stays at 8 for
   * life. Without this, bumping the number is a change that looks like a fix
   * and is not one.
   */
  it("is true for a hash weaker than the configured cost", async () => {
    const old = await bcrypt.hash("hunter2", 8);

    expect(costOf(old)).toBe(8);
    expect(needsRehash(old)).toBe(true);
  });

  it("is false for a hash already at the configured cost", async () => {
    expect(needsRehash(await hashString("hunter2"))).toBe(false);
  });

  it("is false for a hash stronger than configured", async () => {
    // Rehashing downward on login would be worse than leaving it alone.
    const stronger = await bcrypt.hash(
      "hunter2",
      config.AUTH.BCRYPT_ROUNDS + 1,
    );

    expect(needsRehash(stronger)).toBe(false);
  });

  it("is false for anything it cannot parse", () => {
    // A corrupt row is for `compareHash` to fail on. Rewriting it on a guess
    // would destroy the only evidence of what went wrong.
    expect(needsRehash("not-a-bcrypt-hash")).toBe(false);
    expect(needsRehash("")).toBe(false);
    expect(needsRehash("$2b$xx$abc")).toBe(false);
  });

  it("reads every bcrypt prefix variant", () => {
    // `$2a$` is what older libraries wrote; rows from a previous codebase
    // carry it, and they are exactly the ones most likely to be weak.
    const body = "x".repeat(53);

    for (const prefix of ["2a", "2b", "2y"]) {
      expect(needsRehash("$" + prefix + "$04$" + body)).toBe(true);
    }
  });
});

describe("hashToken", () => {
  const TOKEN = "eyJhbGciOiJIUzI1NiJ9.payload.signature";

  it("is a sha256 hex digest", () => {
    expect(hashToken(TOKEN)).toBe(
      crypto.createHash("sha256").update(TOKEN).digest("hex"),
    );
    expect(hashToken(TOKEN)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not contain the token", () => {
    // The point of the whole exercise: a leaked `tokens` or `sessions` row
    // must not be a usable credential.
    expect(hashToken(TOKEN)).not.toContain("payload");
    expect(hashToken(TOKEN)).not.toContain("signature");
  });

  it("is deterministic, which is what makes the lookup an index hit", () => {
    // Unlike bcrypt. Both callers look a token up by exact match on an
    // indexed column, so a per-row salt would mean scanning the table.
    expect(hashToken(TOKEN)).toBe(hashToken(TOKEN));
  });

  it("separates tokens that differ by one character", () => {
    expect(hashToken(TOKEN)).not.toBe(hashToken(`${TOKEN}x`));
  });

  it("handles an empty string without throwing", () => {
    expect(hashToken("")).toMatch(/^[0-9a-f]{64}$/);
  });
});
