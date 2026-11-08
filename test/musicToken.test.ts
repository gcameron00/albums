import { decodeProtectedHeader, importSPKI, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { musicToken } from "../src/musicToken.ts";

const pem = (label: string, bytes: ArrayBuffer) =>
  `-----BEGIN ${label}-----\n${Buffer.from(bytes).toString("base64").replace(/(.{64})/g, "$1\n")}\n-----END ${label}-----\n`;

async function makeKey() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return {
    privatePem: pem("PRIVATE KEY", (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer),
    publicPem: pem("PUBLIC KEY", (await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer),
  };
}

describe("musicToken", () => {
  it("is null when the key is not configured", async () => {
    expect(await musicToken({})).toBe(null);
    expect(await musicToken({ APPLE_TEAM_ID: "T", APPLE_KEY_ID: "K" })).toBe(null);
  });

  it("is null when the key cannot be read", async () => {
    expect(await musicToken({ APPLE_TEAM_ID: "T", APPLE_KEY_ID: "BAD", APPLE_MUSIC_KEY: "not a key" })).toBe(null);
  });

  it("signs an ES256 developer token and reuses it", async () => {
    const { privatePem, publicPem } = await makeKey();
    const env = { APPLE_TEAM_ID: "TEAM123456", APPLE_KEY_ID: "KEY1234567", APPLE_MUSIC_KEY: privatePem };
    const now = Date.UTC(2026, 10, 8, 18);
    const token = await musicToken(env, now);
    expect(typeof token).toBe("string");
    expect(decodeProtectedHeader(token!)).toEqual({ alg: "ES256", kid: "KEY1234567" });
    const { payload } = await jwtVerify(token!, await importSPKI(publicPem, "ES256"), {
      issuer: "TEAM123456",
      currentDate: new Date(now),
    });
    expect(payload.exp! - payload.iat!).toBe(12 * 60 * 60);
    expect(await musicToken(env, now + 60_000)).toBe(token);
  });
});
