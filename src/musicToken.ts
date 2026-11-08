import { importPKCS8, SignJWT } from "jose";

/**
 * Apple Music API developer token: an ES256 JWT signed with a MusicKit key.
 * Not secret: APPLE_TEAM_ID and APPLE_KEY_ID. Secret: APPLE_MUSIC_KEY, the
 * contents of the downloaded AuthKey_<keyid>.p8 file.
 */
export interface MusicKeyEnv {
  APPLE_TEAM_ID?: string;
  APPLE_KEY_ID?: string;
  APPLE_MUSIC_KEY?: string;
}

const LIFETIME_S = 12 * 60 * 60;
let cached: { token: string; expires: number; kid: string } | null = null;

/** A cached token, refreshed an hour before it expires; null if not configured. */
export async function musicToken(env: MusicKeyEnv, nowMs = Date.now()): Promise<string | null> {
  const team = env.APPLE_TEAM_ID?.trim();
  const kid = env.APPLE_KEY_ID?.trim();
  const pem = env.APPLE_MUSIC_KEY?.trim();
  if (!team || !kid || !pem) return null;

  const now = Math.floor(nowMs / 1000);
  if (cached && cached.kid === kid && cached.expires - 3600 > now) return cached.token;
  try {
    const key = await importPKCS8(pem, "ES256");
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256", kid })
      .setIssuer(team)
      .setIssuedAt(now)
      .setExpirationTime(now + LIFETIME_S)
      .sign(key);
    cached = { token, expires: now + LIFETIME_S, kid };
    return token;
  } catch (error) {
    console.error("Apple Music key could not be used", String(error));
    return null;
  }
}
