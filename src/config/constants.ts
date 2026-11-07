import {
  AuthProvider,
  Role,
  TokenTypes as PrismaTokenTypes,
} from "@prisma/client";
import config from "./config";
import { FileCategory } from "../utils/detect-file-type";

export { AuthProvider, Role };
export const roles = Object.values(Role) as Role[];

export const tokenTypes = {
  ...PrismaTokenTypes,
  ACCESS: "ACCESS",
  REFRESH: "REFRESH",
} as const;
export type TokenType = keyof typeof tokenTypes;

/**
 * Roles exempt from the email-verification gate.
 *
 * Admin accounts are provisioned deliberately rather than self-registered, so
 * there is no mailbox to prove and no onboarding mail to wait on. Exemption is
 * a *policy* decision evaluated at access time — it never writes
 * `emailVerifiedAt`, which must stay an honest record of a completed
 * round-trip. See `meetsEmailVerificationPolicy` in `utils/email-verification`.
 */
const emailVerificationExemptRoles: readonly Role[] = [Role.ADMIN];

/** Whether an account with this role has to verify its email to be let in. */
export const isEmailVerificationRequired = (role: Role): boolean =>
  !emailVerificationExemptRoles.includes(role);

/**
 * The folders a caller may upload into.
 *
 * This is the one place the set is written down. It is a closed allowlist,
 * and that is the entire security property: the value arrives as a text
 * field in the multipart body, so it is client input, and the only safe way
 * to turn client input into a path is to look it up — never to concatenate
 * it. The sibling api repo concatenates, and sanitises with a
 * non-recursive `.replace(/\.\.\//g, "")` that `....//` collapses straight
 * back through.
 *
 * The strings double as the object-key prefix, so the bucket reads the same
 * way the API does and a key says what it is without a lookup.
 */
export const uploadFolders = [
  "product_images",
  "product_videos",
  "documents",
  "profile_images",
] as const;

export type UploadFolder = (typeof uploadFolders)[number];

/** Narrow an arbitrary value from the request body to a known folder. */
export const isUploadFolder = (value: unknown): value is UploadFolder =>
  typeof value === "string" &&
  (uploadFolders as readonly string[]).includes(value);

/**
 * What each folder accepts.
 *
 * The folder is what decides, not a separate "category" argument, so there
 * is exactly one thing for a caller to get right and no way for the two to
 * disagree. Sending an MP4 to `product_images` is a 415 — the gallery and
 * the video player are different surfaces with different size budgets, and
 * silently accepting either in either folder is how a 95 MB "image" ends up
 * in a product thumbnail.
 *
 * `profile_images` accepts the same formats as `product_images` but is kept
 * separate because the two have different lifecycles: a profile picture is
 * replaced, product media is catalogue content. Giving avatars their own
 * prefix means a retention rule, a cache header or a transform preset can
 * be applied to one without touching the other.
 */
export const folderPolicy: Record<UploadFolder, readonly FileCategory[]> = {
  product_images: ["image"],
  product_videos: ["video"],
  documents: ["document"],
  profile_images: ["image"],
};

/**
 * Object-key prefix for a folder.
 *
 * Identical to the folder name today. It stays a lookup rather than being
 * inlined so the bucket layout can change without the API vocabulary
 * changing with it — and so there is never a line of code that builds a
 * path by interpolating a string that came from a request.
 */
const keyPrefixes: Record<UploadFolder, string> = {
  product_images: "product_images",
  product_videos: "product_videos",
  documents: "documents",
  profile_images: "profile_images",
};

export const keyPrefixFor = (folder: UploadFolder): string =>
  keyPrefixes[folder];

/** Every prefix this app writes under. The orphan sweep walks exactly these. */
export const allKeyPrefixes = (): string[] => Object.values(keyPrefixes);

const MB = 1024 * 1024;

/**
 * Size ceiling for a file of this kind, in bytes.
 *
 * Applied *after* the type is sniffed from the file's bytes, which is the
 * only ordering that works: a 90 MB file named `photo.jpg` must be measured
 * against the image cap it really is, not the video cap it claims.
 */
export const maxBytesFor = (category: FileCategory): number => {
  switch (category) {
    case "image":
      return config.STORAGE.MAX_IMAGE_MB * MB;
    case "video":
      return config.STORAGE.MAX_VIDEO_MB * MB;
    case "document":
      return config.STORAGE.MAX_DOCUMENT_MB * MB;
  }
};

/**
 * The ceiling multer itself enforces while writing to disk.
 *
 * It has to be the largest cap of ANY category, not the one for the folder
 * being written to, because multer is what parses the multipart body — the
 * `folder` field does not exist yet while the bytes are arriving. A 50 MB
 * JPEG sent to `product_images` is therefore spooled in full and then
 * refused by `maxBytesFor` with a 413 naming the real limit. That costs one
 * wasted write to a temp file and keeps the precise limit honest; the
 * alternative is multer rejecting against a cap that has nothing to do with
 * the file's actual type.
 */
export const maxUploadBytes = (): number =>
  Math.max(
    ...(["image", "video", "document"] as FileCategory[]).map(maxBytesFor),
  );

/**
 * Rights are scoped to what exists today. Catalogue, order and refund rights
 * get added alongside those modules rather than invented up front.
 *
 * Every role here is a *staff* role — `users` holds nobody else. Shopper
 * rights are not missing from this table, they belong to a different table,
 * a different token and a different API surface (`/api/store/...`). Adding a
 * CUSTOMER key back here would not grant a shopper anything; it would create
 * a staff account that calls itself a customer. See docs/decisions.md §2.
 *
 * `Record<Role, string[]>` is exhaustive on purpose: the day a role is added
 * to the enum, this object stops compiling until its rights are stated. An
 * index signature would have let it default to silence.
 */
const rolePermissions: Record<Role, string[]> = {
  STAFF: [
    "read:own_profile",
    "update:own_profile",
    "read:users",
    // Product media is staff work, and any staff member may clean up any
    // file — media is shared catalogue content, not personal property.
    "upload:files",
    "read:files",
    "manage:files",
  ],
  ADMIN: [
    "access:admin_panel",
    "read:users",
    "manage:users",
    "read:own_profile",
    "update:own_profile",
    "upload:files",
    "read:files",
    "manage:files",
  ],
};

export const roleRights: Map<Role, string[]> = new Map(
  Object.entries(rolePermissions) as [Role, string[]][],
);
