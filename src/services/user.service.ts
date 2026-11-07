import httpStatus from "http-status";
import { prisma } from "../config/prisma-client";
import ApiError from "../utils/api-error";
import { hashString } from "../utils/hash";
import { isEmailTakenUser } from "../utils/helpers";
import { normalizeEmail } from "../utils/normalize-email";
import { Prisma, Role, User } from "@prisma/client";

/**
 * What a caller may set when creating an account.
 *
 * Named explicitly rather than taken as `User`, and the difference is a
 * privilege boundary rather than a typing preference. The previous signature
 * was `(userBody: User)` spread straight into Prisma — `data: { ...userBody,
 * password }` — which means every column, `role` among them. Nothing was
 * exploitable, because the only caller is `POST /auth/register` and its Joi
 * schema denies unknown keys. But the guard lived two layers up, in a schema,
 * and `validations/user.validation.ts` already carries unwired `createUser`
 * and `inviteUser` schemas that DO accept `role` — so the first admin or
 * invite route wired to one of those would have handed the client a role
 * field straight through to the database.
 *
 * A service that never reads a client-supplied role cannot escalate. That is
 * the shape docs/decisions.md §3 asks for in so many words: "enforce it in
 * the service, not in the Joi schema. A schema that forbids a `role` field is
 * one `allowUnknown` change away from being a privilege escalation."
 */
export interface CreateUserInput {
  email: string;
  password: string;
  firstName?: string | null;
  lastName?: string | null;
  /**
   * Omitted means STAFF — the least privilege `users` can hold.
   *
   * Deliberately a parameter rather than something read off an input object,
   * so granting ADMIN is a line of code at the call site that a reader can
   * see, not a field that arrived in a request body. The column has the same
   * default in the schema; this restates it where the decision is made.
   */
  role?: Role;
}

/**
 * Every write and every lookup below folds the address through
 * `normalizeEmail` first. `users.email` is a case-sensitive unique index, so
 * one mailbox written in two casings is two accounts — see the util for the
 * full list of what that breaks. The rule lives here, in the service, rather
 * than in the Joi schema because `validate` discards Joi's coerced value and
 * can therefore reject but never transform.
 */
export const createUser = async (input: CreateUserInput): Promise<User> => {
  const email = normalizeEmail(input.email);

  if (await isEmailTakenUser(email)) {
    throw new ApiError(
      httpStatus.BAD_REQUEST,
      "User already exists with this email"
    );
  }

  // Listed field by field, never spread. A spread is what let an unknown key
  // reach Prisma in the first place, and it would do so again the moment
  // `CreateUserInput` grew a field somebody forgot was client-controlled.
  return prisma.user.create({
    data: {
      email,
      password: await hashString(input.password),
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      role: input.role ?? Role.STAFF,
    },
  });
};

export const getUserById = async (id: string) => {
  return prisma.user.findUnique({ where: { id } });
};

export const getUserByGoogleId = async (googleId: string) => {
  return prisma.user.findUnique({ where: { googleId } });
};

/**
 * Record that this mailbox has been proven, if it is not recorded already.
 *
 * Idempotent, and never moves an existing timestamp — the column is meant to
 * be an honest record of when the round-trip completed, so re-stamping it on
 * every login would turn it into "last verified login" instead.
 *
 * Deliberately does NOT touch `authProvider`. Accounts are only ever created
 * by local registration (`resolveGoogleUser` rejects an unknown email rather
 * than creating one), so LOCAL is accurate even for a user who later links
 * Google and signs in with it. Flipping it to GOOGLE would claim the account
 * originated there and imply it has no password, neither of which is true.
 */
export const markEmailVerified = async (user: User): Promise<User> => {
  if (user.emailVerifiedAt) return user;

  return prisma.user.update({
    where: { id: user.id },
    data: { emailVerifiedAt: new Date() },
  });
};

/** Attach a Google identity to an existing account (first Google sign-in). */
export const linkGoogleId = async (userId: string, googleId: string) => {
  return prisma.user.update({
    where: { id: userId },
    data: { googleId },
  });
};

export const getUserByEmail = async (email: string) => {
  return prisma.user.findUnique({ where: { email: normalizeEmail(email) } });
};

/**
 * What `updateUserById` is allowed to change.
 *
 * Everything omitted here is omitted on purpose:
 *
 * - **`emailVerifiedAt`** is a claim about a round-trip that happened. It is
 *   stamped by `markEmailVerified`, from a verification flow or a Google
 *   sign-in that asserted `email_verified`, and nowhere else.
 * - **`googleId` / `authProvider`** belong to `linkGoogleId`, which owns the
 *   uniqueness check that goes with them.
 * - **`id`, `createdAt`, `updatedAt`** are not anybody's to set.
 *
 * `role` stays settable: promotion is a real operation. The gate for it is
 * `auth("manage:users")` plus an explicit schema on the route, which is
 * where a reader looks for it — not an accident of this signature.
 */
export interface UpdateUserInput {
  email?: string;
  password?: string;
  firstName?: string | null;
  lastName?: string | null;
  role?: Role;
  /**
   * Lockout state. Written by `auth.service` on a failed login and cleared
   * by a completed password reset.
   */
  loginAttempts?: number;
  lockUntil?: Date | null;
  lastFailedLoginAt?: Date | null;
}

/**
 * Update a user from a named, bounded input.
 *
 * This took `Partial<User>` and spread it into Prisma — the exact shape
 * `createUser` carries an explicit input type to avoid. No route reached it
 * with client data, so nothing was exploitable; what made it worth closing
 * anyway is that `validations/user.validation.ts` already holds unwired
 * `updateUser` and `updateUserRole` schemas keyed on `:userId`. The first
 * route wired to one of those would have inherited a privilege-escalation
 * primitive by default, and nothing at the call site would have looked
 * wrong — `docs/decisions.md` §23.
 */
export const updateUserById = async (
  userId: string,
  input: UpdateUserInput
): Promise<User> => {
  const user = await getUserById(userId);
  if (!user) throw new ApiError(httpStatus.NOT_FOUND, "User not found.");

  // Listed field by field, never spread — the same rule as `createUser`, for
  // the same reason. A spread would re-admit every key the interface above
  // deliberately leaves out the moment someone passes a wider object.
  const data: Prisma.UserUpdateInput = {};

  if (input.email !== undefined) {
    const email = normalizeEmail(input.email);

    if (await isEmailTakenUser(email, userId)) {
      throw new ApiError(
        httpStatus.BAD_REQUEST,
        "User already exists with this email"
      );
    }

    data.email = email;
  }

  if (input.password !== undefined) {
    data.password = await hashString(input.password);
  }

  if (input.firstName !== undefined) data.firstName = input.firstName;
  if (input.lastName !== undefined) data.lastName = input.lastName;
  if (input.role !== undefined) data.role = input.role;

  // `!== undefined` rather than truthiness throughout, and these three are
  // why: `loginAttempts: 0`, `lockUntil: null` and `lastFailedLoginAt: null`
  // are the values a completed password reset writes to clear a lockout. A
  // truthy check would silently drop all three and leave the account locked
  // after a successful reset.
  if (input.loginAttempts !== undefined) data.loginAttempts = input.loginAttempts;
  if (input.lockUntil !== undefined) data.lockUntil = input.lockUntil;
  if (input.lastFailedLoginAt !== undefined) {
    data.lastFailedLoginAt = input.lastFailedLoginAt;
  }

  return prisma.user.update({
    where: { id: userId },
    data,
  });
};

export const deleteUserById = async (userId: string): Promise<User> => {
  return prisma.user.delete({ where: { id: userId } });
};
