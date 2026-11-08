import type { Identity } from "./auth.ts";
import { escapeHtml as e, page } from "./html.ts";
import { html, readBody, redirect } from "./http.ts";

/**
 * OAuth for the MCP connector. @cloudflare/workers-oauth-provider (wired in
 * src/index.ts) handles client registration, tokens and discovery. Its
 * authorize endpoint is /admin/authorize, behind the Albums admin Access
 * application, so Access does the login (one-time PIN) and this page asks
 * the owner to approve the client before a token is issued.
 */

/** The parts of the provider's helpers (env.OAUTH_PROVIDER) used here. */
export interface AuthRequest {
  responseType: string;
  clientId: string;
  redirectUri: string;
  scope: string[];
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

export interface ClientInfo {
  clientId: string;
  clientName?: string;
  redirectUris: string[];
}

export interface OAuthHelpers {
  parseAuthRequest(request: Request): Promise<AuthRequest>;
  lookupClient(clientId: string): Promise<ClientInfo | null>;
  completeAuthorization(options: {
    request: AuthRequest;
    userId: string;
    metadata: unknown;
    scope: string[];
    props: unknown;
  }): Promise<{ redirectTo: string }>;
}

export interface OAuthEnv {
  OAUTH_PROVIDER?: OAuthHelpers;
}

const headers = { "cache-control": "no-store", "x-robots-tag": "noindex" };
const ROBOTS = `\n    <meta name="robots" content="noindex">`;

function message(title: string, text: string, status: number): Response {
  return html(page(`${title} – Albums`, `      <article class="prose"><h1>${e(title)}</h1><p>${e(text)}</p></article>`, { head: ROBOTS }), status, headers);
}

function consentPage(client: ClientInfo, req: AuthRequest, action: string, owner: string): string {
  const name = client.clientName || "An app";
  const host = new URL(req.redirectUri).host;
  return page(
    "Connect – Albums",
    `      <article class="prose">
        <h1>Connect ${e(name)}?</h1>
        <p><strong>${e(name)}</strong> wants to use your albums list as ${e(owner)}. It will be able to:</p>
        <ul>
          <li>search and read the list, including notes;</li>
          <li>read the private history (removed albums and reasons);</li>
          <li>add albums, edit notes, remove and put back albums.</li>
        </ul>
        <p class="hint">After you choose, you go back to <strong>${e(host)}</strong>. Only approve if you started this from there.</p>
        <form class="consent" method="post" action="${e(action)}">
          <button type="submit" name="decision" value="allow">Allow</button>
          <button type="submit" name="decision" value="deny">Cancel</button>
        </form>
      </article>`,
    { head: ROBOTS, nav: "admin" },
  );
}

/** /admin/authorize: GET shows the consent page, POST records the decision. */
export async function authorize(request: Request, env: OAuthEnv, url: URL, who: Identity): Promise<Response> {
  if (!who.email) return message("Not available", "Connecting an app needs a person signed in, not a service token.", 403);
  const provider = env.OAUTH_PROVIDER;
  if (!provider) return message("Not available", "OAuth is not configured on this deployment.", 500);

  // Parse from the query string for both GET and the POST back to the same URL.
  let req: AuthRequest;
  try {
    req = await provider.parseAuthRequest(new Request(url.toString()));
  } catch {
    return message("Invalid request", "This connection request could not be read. Start again from the app.", 400);
  }
  const client = await provider.lookupClient(req.clientId);
  if (!client || !client.redirectUris.includes(req.redirectUri)) {
    return message("Invalid request", "This app is not registered, or asked to return somewhere it did not register.", 400);
  }

  if (request.method === "GET" || request.method === "HEAD") {
    return html(consentPage(client, req, url.pathname + url.search, who.email), 200, headers);
  }
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "GET, POST" } });

  const body = await readBody(request, url);
  if (body instanceof Response) return body;
  if (body.kind !== "form" || body.fields.decision !== "allow") {
    const back = new URL(req.redirectUri);
    back.searchParams.set("error", "access_denied");
    if (req.state) back.searchParams.set("state", req.state);
    return redirect(back.toString(), 302);
  }
  const { redirectTo } = await provider.completeAuthorization({
    request: req,
    userId: who.email,
    metadata: { label: client.clientName ?? client.clientId },
    scope: req.scope,
    props: { email: who.email },
  });
  return redirect(redirectTo, 302);
}
