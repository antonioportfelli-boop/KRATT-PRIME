import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const htmlUrl = new URL("../../../programs/web/kratt-control-desk/index.html", import.meta.url);
const cssUrl = new URL("../../../programs/web/kratt-control-desk/styles.css", import.meta.url);
const appUrl = new URL("../../../programs/web/kratt-control-desk/app.js", import.meta.url);

const [html, css, app] = await Promise.all([
  readFile(htmlUrl, "utf8"),
  readFile(cssUrl, "utf8"),
  readFile(appUrl, "utf8"),
]);

test("Control Desk HTML loads its colocated stylesheet and module entry", () => {
  assert.match(html, /href="\.\/styles\.css"/);
  assert.match(html, /src="\.\/app\.js"/);
  assert.match(html, /<main id="main">/);
});

test("Control Desk exposes accessible wave and runtime regions", () => {
  assert.match(html, /id="wave-grid"[^>]*aria-label="Wave selection"/);
  assert.match(html, /aria-labelledby="waves-heading"/);
  assert.match(html, /aria-labelledby="runtime-heading"/);
  assert.match(html, /id="runtime-message" role="status"/);
  assert.match(html, /id="operation-list"/);
});

test("Control Desk uses the Industrial Night palette and responsive breakpoints", () => {
  assert.match(css, /--bg:\s*#080d12/);
  assert.match(css, /--cyan:\s*#71d5e6/);
  assert.match(css, /--amber:\s*#eebd70/);
  assert.match(css, /--red:\s*#e16f76/);
  assert.match(css, /@media \(max-width:\s*720px\)/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
});

test("Control Desk has no remote font dependency", () => {
  assert.doesNotMatch(css, /fonts\.googleapis\.com|fonts\.gstatic\.com/i);
});

test("Control Desk reads the shared Wave registry and only calls same-origin GET APIs", () => {
  assert.match(app, /packages\/kratt-core\/src\/wave-progression\.mjs/);
  assert.match(app, /method:\s*"GET"/);
  assert.match(app, /credentials:\s*"same-origin"/);
  assert.match(app, /cache:\s*"no-store"/);
  assert.match(app, /\/observatory\/integrity/);
  assert.match(app, /\/observatory\/modules/);
  assert.match(app, /\/observatory\/operations\?limit=20/);
  assert.doesNotMatch(app, /method:\s*"(POST|PUT|PATCH|DELETE)"/);
});

test("Control Desk explicitly distinguishes denied, unbound and degraded API states", () => {
  assert.match(app, /error\?\.status === 401 \|\| error\?\.status === 403/);
  assert.match(app, /error\?\.status === 404/);
  assert.match(app, /API DEGRADED/);
  assert.match(app, /OBSERVATORY_INTEGRITY_NOT_VERIFIED/);
});
