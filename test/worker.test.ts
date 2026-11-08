import { describe, expect, it } from "vitest";
import worker, { escapeHtml, type Env } from "../src/index";

function fakeEnv(count: number): Env {
  const db = {
    prepare: () => ({ first: async () => ({ n: count }) }),
  } as unknown as D1Database;
  const assets = {
    fetch: async () => new Response("asset", { status: 404 }),
  } as unknown as Fetcher;
  return { DB: db, ASSETS: assets, STOREFRONT: "ch" };
}

const get = (path: string) => new Request(`https://albums.gcameron.com${path}`);

describe("worker", () => {
  it("answers /health", async () => {
    const res = await worker.fetch(get("/health"), fakeEnv(0));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("renders the home page with the album count", async () => {
    const res = await worker.fetch(get("/"), fakeEnv(3));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("3 albums so far");
  });

  it("uses the singular for one album", async () => {
    const res = await worker.fetch(get("/"), fakeEnv(1));
    expect(await res.text()).toContain("1 album so far");
  });

  it("passes other paths to static assets", async () => {
    const res = await worker.fetch(get("/assets/missing.css"), fakeEnv(0));
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("asset");
  });
});

describe("escapeHtml", () => {
  it("escapes markup characters", () => {
    expect(escapeHtml(`<a href="x">Tom & 'Jerry'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;Tom &amp; &#39;Jerry&#39;&lt;/a&gt;",
    );
  });
});
