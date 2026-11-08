export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface PageOptions {
  description?: string;
  /** Which nav item is current. */
  nav?: "albums" | "about";
  /** Extra tags for <head>, already escaped. */
  head?: string;
  script?: string;
}

const DEFAULT_DESCRIPTION = "Albums worth playing from start to finish.";

/** Full HTML document with the site header and footer. `body` must already be escaped. */
export function page(title: string, body: string, opts: PageOptions = {}): string {
  const current = (name: PageOptions["nav"]) => (opts.nav === name ? ' aria-current="page"' : "");
  return `<!doctype html>
<html lang="en-GB">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="color-scheme" content="light dark">
    <title>${escapeHtml(title)}</title>
    <meta name="description" content="${escapeHtml(opts.description ?? DEFAULT_DESCRIPTION)}">
    <link rel="icon" href="/assets/favicon.svg" type="image/svg+xml">
    <link rel="stylesheet" href="/assets/css/styles.css">${opts.head ?? ""}${
      opts.script ? `\n    <script defer src="${escapeHtml(opts.script)}"></script>` : ""
    }
  </head>
  <body>
    <header class="site">
      <a class="brand" href="/">Albums</a>
      <nav>
        <a href="/"${current("albums")}>List</a>
        <a href="/about"${current("about")}>About</a>
      </nav>
    </header>
    <main>
${body}
    </main>
    <footer class="site">
      <p>Albums worth playing from start to finish. Listen on Apple Music.</p>
    </footer>
  </body>
</html>
`;
}
