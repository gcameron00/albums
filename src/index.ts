import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { handle, type Deps, type Env } from "./app.ts";
import { verifyAccess } from "./auth.ts";
import { mcp, type McpProps } from "./mcp.ts";
import { musicToken } from "./musicToken.ts";

export type { Env };

const deps: Deps = {
  verify: verifyAccess,
  fetch: (input, init) => fetch(input, init),
  musicToken: (e) => musicToken(e),
  now: () => new Date(),
};

/**
 * The OAuth provider sits in front of everything:
 * - /mcp needs a bearer token it issued (owner-approved; see src/oauth.ts);
 * - /oauth/register and /oauth/token, and the /.well-known metadata, are its own;
 * - /admin/authorize is the login/consent page (behind Cloudflare Access);
 * - every other request goes to the site as before.
 * Token and client state live in the OAUTH_KV namespace.
 */
export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: {
    fetch(request: Request, env: Env, ctx: ExecutionContext & { props?: McpProps }) {
      return mcp(request, env, deps, ctx.props);
    },
  } as ExportedHandler<Env>,
  defaultHandler: {
    fetch(request: Request, env: Env) {
      return handle(request, env, deps);
    },
  } as ExportedHandler<Env>,
  authorizeEndpoint: "/admin/authorize",
  tokenEndpoint: "/oauth/token",
  clientRegistrationEndpoint: "/oauth/register",
  scopesSupported: ["albums"],
});
