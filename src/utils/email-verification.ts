import { Role } from "@prisma/client";
import { isEmailVerificationRequired } from "../config/constants";

/** The subset of a user these checks need. */
interface VerifiableUser {
  role: Role;
  emailVerifiedAt: Date | null;
}

/**
 * Has this account actually proven control of its mailbox?
 *
 * Strictly a question about evidence. Use this — never the policy gate below —
 * when the answer authorises something tied to the address itself, such as
 * claiming guest orders placed with that email. An ADMIN that never completed
 * a round-trip returns `false` here, which is correct: exemption from a login
 * gate is not proof of ownership.
 */
export const hasVerifiedEmail = (user: VerifiableUser): boolean =>
  user.emailVerifiedAt !== null;

/**
 * May this account proceed, as far as email verification is concerned?
 *
 * The access-control question, which folds in the role exemption: admins pass
 * without a round-trip. Use this to gate login or protected routes.
 */
export const meetsEmailVerificationPolicy = (user: VerifiableUser): boolean =>
  !isEmailVerificationRequired(user.role) || hasVerifiedEmail(user);
