import { Role, TokenTypes } from "@prisma/client";
import {
  prisma,
  assertDatabaseReachable,
  createTestUser,
  cleanupUsers,
  disconnect,
} from "../helpers/db";
import * as tokenService from "../../src/services/token.service";
import { hashToken } from "../../src/utils/hash";

/**
 * The `tokens` table carries the indexes its queries need.
 *
 * It had none beyond its primary key, so all three of the queries that touch
 * it were sequential scans that degrade with every row ever written:
 * `validateStoredToken`'s lookup by digest, `deleteTokens(userId, type)` on
 * every completed reset, and the nightly `expires < now` sweep. `sessions`
 * already had the equivalents.
 *
 * Asserted against `pg_indexes` rather than by timing a query. A timing
 * assertion needs a large table to be meaningful and is flaky on a small one
 * — and on an empty table Postgres correctly prefers a sequential scan even
 * when the index exists, so a plan assertion would fail for the right
 * reason and look like the wrong one. What is worth pinning is that the
 * migration and the Prisma schema agree, which is the thing that silently
 * drifts when someone edits one and not the other.
 */
describe("tokens table indexes", () => {
  const createdUserIds: string[] = [];

  beforeAll(async () => {
    await assertDatabaseReachable();
  });

  afterAll(async () => {
    await cleanupUsers(createdUserIds);
    await disconnect();
  });

  const indexNames = async (table: string): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = ${table}
    `;
    return rows.map((r) => r.indexname).sort();
  };

  it.each([
    ["tokens_token_key", "validateStoredToken's lookup by digest"],
    ["tokens_user_id_type_idx", "deleteTokens(userId, type)"],
    ["tokens_expires_idx", "the nightly expiry sweep"],
  ])("has %s, for %s", async (index) => {
    expect(await indexNames("tokens")).toContain(index);
  });

  it("refuses two rows holding the same digest", async () => {
    // `token` is UNIQUE, not merely indexed: the column holds a sha256
    // digest of a signed JWT, so two rows with the same value describe the
    // same credential and `validateStoredToken` would have had to pick one.
    const user = await createTestUser(Role.STAFF);
    createdUserIds.push(user.id);

    const digest = hashToken(`spec-duplicate-${Date.now()}`);
    const row = {
      token: digest,
      type: TokenTypes.RESET_PASSWORD,
      expires: new Date(Date.now() + 60_000),
      userId: user.id,
    };

    await prisma.token.create({ data: row });
    await expect(prisma.token.create({ data: row })).rejects.toThrow();
  });

  it("lets the real reset flow mint two tokens back to back", async () => {
    // The constraint above is only safe because every stored token carries a
    // random `jti` (docs/decisions.md §20). Without it, two resets requested
    // inside one whole second produced byte-identical tokens — and this
    // constraint would turn the second into a 500 rather than a duplicate
    // row. This is the spec that would catch the `jti` being removed.
    const user = await createTestUser(Role.STAFF);
    createdUserIds.push(user.id);

    await tokenService.generateResetPasswordToken(user.id);
    await tokenService.generateResetPasswordToken(user.id);

    const rows = await prisma.token.findMany({ where: { userId: user.id } });

    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.token)).size).toBe(2);
  });
});
