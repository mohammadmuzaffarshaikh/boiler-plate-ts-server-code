import { Role } from "@prisma/client";
import {
  hasVerifiedEmail,
  meetsEmailVerificationPolicy,
} from "../../src/utils/email-verification";
import { isEmailVerificationRequired } from "../../src/config/constants";

/**
 * Two questions that look alike and must never be conflated:
 *
 *   hasVerifiedEmail            — is there EVIDENCE the mailbox is controlled?
 *   meetsEmailVerificationPolicy — may this account PROCEED?
 *
 * ADMIN is exempt from the second and not from the first. Collapsing them
 * would let an admin's unproven address authorise something that genuinely
 * depends on owning it — claiming guest orders placed with that email, say.
 */
const user = (role: Role, emailVerifiedAt: Date | null) => ({
  role,
  emailVerifiedAt,
});

const VERIFIED = new Date("2026-01-01T00:00:00.000Z");

describe("hasVerifiedEmail", () => {
  it("is a question about evidence, not about role", () => {
    expect(hasVerifiedEmail(user(Role.STAFF, VERIFIED))).toBe(true);
    expect(hasVerifiedEmail(user(Role.STAFF, null))).toBe(false);
  });

  it("is false for an unstamped ADMIN, despite the policy exemption", () => {
    // The distinction this file exists for. `prisma/seed.ts` leaves the
    // admin unstamped deliberately, and that must keep reading as "not
    // proven" wherever proof is what is being asked for.
    expect(hasVerifiedEmail(user(Role.ADMIN, null))).toBe(false);
  });
});

describe("isEmailVerificationRequired", () => {
  it("exempts ADMIN and requires it of STAFF", () => {
    expect(isEmailVerificationRequired(Role.ADMIN)).toBe(false);
    expect(isEmailVerificationRequired(Role.STAFF)).toBe(true);
  });
});

describe("meetsEmailVerificationPolicy", () => {
  it("lets a verified STAFF account through", () => {
    expect(meetsEmailVerificationPolicy(user(Role.STAFF, VERIFIED))).toBe(true);
  });

  it("stops an unverified STAFF account", () => {
    expect(meetsEmailVerificationPolicy(user(Role.STAFF, null))).toBe(false);
  });

  it("lets an unverified ADMIN through", () => {
    // Admins are provisioned rather than self-registered, so there is no
    // onboarding mail to wait on and no mailbox to prove.
    expect(meetsEmailVerificationPolicy(user(Role.ADMIN, null))).toBe(true);
  });

  it("never writes anything — exemption is evaluated, not recorded", () => {
    const admin = user(Role.ADMIN, null);
    meetsEmailVerificationPolicy(admin);

    expect(admin.emailVerifiedAt).toBeNull();
  });
});
