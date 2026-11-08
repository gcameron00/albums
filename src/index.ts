export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  STOREFRONT: string;
}

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...SECURITY_HEADERS },
  });
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS },
  });
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

async function listedCount(env: Env): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM albums WHERE status = 'listed'").first<{ n: number }>();
  return row?.n ?? 0;
}

function homePage(count: number): string {
  const label = count === 1 ? "1 album" : `${count} albums`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>Albums</title>
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/assets/css/styles.css">
  </head>
  <body>
    <h1>Albums</h1>
    <p>Albums worth playing from start to finish.</p>
    <p>${escapeHtml(label)} so far. The list is on its way.</p>
  </body>
</html>
`;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const method = request.method;

    if (url.pathname === "/health" && (method === "GET" || method === "HEAD")) {
      return json({ ok: true });
    }

    if (url.pathname === "/" && (method === "GET" || method === "HEAD")) {
      return html(homePage(await listedCount(env)));
    }

    // Static files under public/ (CSS, favicon) and their 404s.
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
