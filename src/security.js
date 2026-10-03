const crypto = require("node:crypto");

const KEY_LENGTH = 64;
const SALT_BYTES = 16;

function hashPassword(password) {
  if (typeof password !== "string" || password.length < 8) {
    throw new Error("Panel password must be at least 8 characters long.");
  }

  const salt = crypto.randomBytes(SALT_BYTES).toString("hex");
  const hash = crypto.scryptSync(password, salt, KEY_LENGTH).toString("hex");
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== "string" || typeof stored !== "string") return false;

  const parts = stored.split(":");
  if (parts.length !== 2) return false;

  const [salt, expectedHex] = parts;
  if (!/^[0-9a-f]+$/i.test(salt) || salt.length !== SALT_BYTES * 2) return false;
  if (!/^[0-9a-f]+$/i.test(expectedHex) || expectedHex.length !== KEY_LENGTH * 2) return false;

  try {
    const actual = crypto.scryptSync(password, salt, KEY_LENGTH);
    const expected = Buffer.from(expectedHex, "hex");
    if (actual.length !== expected.length) return false;
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
