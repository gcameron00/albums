import { createRemoteJWKSet, jwtVerify } from "jose";

export interface AuthEnv {
  /** e.g. "grahamcameron.cloudflareaccess.com" */
  ACCESS_TEAM_DOMAIN: string;
  /** Application Audience (AUD) tag of the Access application. */
  ACCESS_AUD: string;
}

/** Who Access let in: a person (email) or a service token (client id). */
export interface Identity {
  email: string | null;
  serviceToken: string | null;
}

const keySets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/**
 * Verifies the Cloudflare Access JWT on the request. Fails closed: if the team
 * domain or audience is not configured, or the token is missing or invalid,
 * the result is null.
 */
export async function verifyAccess(request: Request, env: AuthEnv): Promise<Identity | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  if (!team || !env.ACCESS_AUD) return null;

  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;

  const issuer = `https://${team}`;
  let keys = keySets.get(issuer);
  if (!keys) {
    keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    keySets.set(issuer, keys);
  }
  try {
    const { payload } = await jwtVerify(token, keys, { issuer, audience: env.ACCESS_AUD });
    const email = typeof payload.email === "string" ? payload.email : null;
    const serviceToken = typeof payload.common_name === "string" ? payload.common_name : null;
    return { email, serviceToken };
  } catch {
    return null;
  }
}
