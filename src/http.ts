export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

const MAX_BODY_BYTES = 8192;

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY_HEADERS, ...extra },
  });
}

export function html(body: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS, ...extra },
  });
}

export const redirect = (location: string, status = 303) =>
  new Response(null, { status, headers: { location, "cache-control": "no-store", ...SECURITY_HEADERS } });

/** A request body: JSON (Shortcut, curl, MCP) or a form posted from this site. */
export interface Body {
  kind: "json" | "form";
  fields: Record<string, unknown>;
}

/**
 * Browsers mark cross-site requests in Sec-Fetch-Site. JSON clients (the
 * Shortcut, curl) send no such header; a JSON body from another site would
 * also need a CORS preflight, which this Worker never grants.
 */
function crossSite(request: Request): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  return site !== null && site !== "same-origin" && site !== "none";
}

/**
 * Forms must come from this site: the browser marks the POST same-origin
 * (Sec-Fetch-Site) or, in older browsers, sends a matching Origin. Anything
 * else is refused, which is what stops cross-site form posts.
 */
function sameOrigin(request: Request, url: URL): boolean {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site !== null) return site === "same-origin";
  return request.headers.get("Origin") === url.origin;
}

export async function readBody(request: Request, url: URL): Promise<Body | Response> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  const isJson = type.startsWith("application/json");
  const isForm = type.startsWith("application/x-www-form-urlencoded");
  if (!isJson && !isForm) return json({ error: "Send JSON (Content-Type: application/json)." }, 415);
  if (isJson ? crossSite(request) : !sameOrigin(request, url)) {
    return json({ error: "Cross-site requests are not allowed." }, 403);
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return json({ error: "Request body too large." }, 413);
  if (isForm) return { kind: "form", fields: Object.fromEntries(new URLSearchParams(text)) };
  try {
    const body: unknown = JSON.parse(text);
    if (typeof body === "object" && body !== null && !Array.isArray(body)) {
      return { kind: "json", fields: body as Record<string, unknown> };
    }
  } catch {
    // fall through
  }
  return json({ error: "The body must be a JSON object." }, 400);
}
