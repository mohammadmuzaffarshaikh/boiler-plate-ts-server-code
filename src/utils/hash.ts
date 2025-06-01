import bcrypt from "bcryptjs";

/**
 * Hash a string with optional salt rounds
 * @param {string} text - The plain text to hash
 * @param {number} saltRounds - Optional salt rounds (default 8)
 * @returns {Promise<string>}
 */
export const hashString = async (
  text: string,
  saltRounds = 8
): Promise<string> => {
  return await bcrypt.hash(text, saltRounds);
};

/**
 * Compare a plain string with a hashed string
 * @param {string} text - The raw string to verify
 * @param {string} hash - The hashed string to compare against
 * @returns {Promise<boolean>}
 */
export const compareHash = async (
  text: string,
  hash: string
): Promise<boolean> => {
  return await bcrypt.compare(text, hash);
};
