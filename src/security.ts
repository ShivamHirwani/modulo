import { randomBytes, scrypt, timingSafeEqual, createHash } from "node:crypto";

const N = 16384;
const run = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) =>
    scrypt(pw, salt, 64, { N, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? rej(e) : res(k))),
  );

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${N}$${salt.toString("base64")}$${(await run(pw, salt)).toString("base64")}`;
}

const DUMMY = `scrypt$${N}$${Buffer.alloc(16).toString("base64")}$${Buffer.alloc(64).toString("base64")}`;

// Always does the same work, even for unknown users (no timing hint about which emails exist).
export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  const [, , salt, hash] = (stored ?? DUMMY).split("$");
  const got = await run(pw, Buffer.from(salt, "base64"));
  const want = Buffer.from(hash, "base64");
  return stored !== null && got.length === want.length && timingSafeEqual(got, want);
}

export const hashToken = (t: string) => createHash("sha256").update(t).digest();
export function newToken() {
  const token = "mod_" + randomBytes(32).toString("base64url");
  return { token, hash: hashToken(token) };
}
