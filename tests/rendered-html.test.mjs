import assert from "node:assert/strict";
import test from "node:test";
import { Miniflare } from "miniflare";
import { fileURLToPath } from "node:url";

test("server renders the route drawing platform", async () => {
  const runtime = new Miniflare({
    modules: true,
    scriptPath: fileURLToPath(new URL("../dist/server/index.js", import.meta.url)),
    modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }],
    compatibilityDate: "2026-05-15",
    compatibilityFlags: ["nodejs_compat"],
    d1Databases: ["DB"],
    serviceBindings: { ASSETS: () => new Response("Not found", { status: 404 }) },
  });
  try {
    const response = await runtime.dispatchFetch("http://localhost/", { headers: { accept: "text/html" } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
    const html = await response.text();
    assert.match(html, /路绘 · 公交线路可视化制图台/);
    assert.match(html, /公交线路地图画布/);
    assert.match(html, /工具面板/);
    assert.doesNotMatch(html, /codex-preview|Your site is taking shape|SkeletonPreview/);
  } finally {
    await runtime.dispose();
  }
});
