import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * 引き継ぎ中のセッショントークンをDBへ置くときの暗号化（AES-256-GCM・#317）。
 * 鍵は環境変数 `NATIVE_AUTH_ENCRYPTION_KEY`（16進64文字＝32バイト）。`node --test` から読めるよう、
 * 鍵は引数でも渡せる。
 */
const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

function toKey(hex: string | undefined): Buffer {
  if (!hex || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("NATIVE_AUTH_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
  }
  return Buffer.from(hex, "hex");
}

export function encryptSecret(plainText: string, keyHex = process.env.NATIVE_AUTH_ENCRYPTION_KEY): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, toKey(keyHex), iv);
  const encrypted = Buffer.concat([cipher.update(plainText, "utf-8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(cipherText: string, keyHex = process.env.NATIVE_AUTH_ENCRYPTION_KEY): string {
  const [ivB64, tagB64, dataB64] = cipherText.split(":");
  if (!ivB64 || !tagB64 || !dataB64) throw new Error("Invalid cipher text format");
  const decipher = createDecipheriv(ALGORITHM, toKey(keyHex), Buffer.from(ivB64, "base64"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, "base64")), decipher.final()]).toString("utf-8");
}
