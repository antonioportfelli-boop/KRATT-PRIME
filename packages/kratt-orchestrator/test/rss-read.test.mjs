import test from "node:test";
import assert from "node:assert/strict";
import { createRssReadAdapter, registerRssReadAdapter } from "../src/adapters/rss-read.mjs";
import { createOrchestrator } from "../src/orchestrator.mjs";

const observedAt = "2026-11-10T12:00:00.000Z";
const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>Example Research</title>
<item><title>Infrastructure outlook &amp; capacity</title><link>https://publisher.example/story/1</link>
<pubDate>Mon, 09 Nov 2026 10:00:00 GMT</pubDate>
<description><![CDATA[Capacity rose <b>materially</b> in the latest quarter.]]></description></item>
</channel></rss>`;
const atom = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Research</title>
<entry><title>Policy update</title><link href="https://publisher.example/policy/2" rel="alternate"/>
<updated>2026-11-09T09:00:00Z</updated><summary>Updated eligibility guidance.</summary></entry>
</feed>`;

function adapterFor(body, options = {}) {
  return createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    now:() => observedAt,
    fetchImpl:async () => new Response(body, {
      status:200,
      headers:{ "Content-Type":"application/rss+xml; charset=utf-8" },
    }),
    ...options,
  });
}

test("RSS reader parses items and preserves source provenance without write capability", async () => {
  const adapter = adapterFor(rss);
  assert.deepEqual(adapter.permissions, { read:true, write:false });
  const result = await adapter.read({
    capability:"feed.read",
    input:{ url:"https://feeds.example.com/news.xml" },
  });
  assert.equal(result.format, "rss");
  assert.equal(result.publisher, "Example Research");
  assert.equal(result.itemCount, 1);
  assert.equal(result.items[0].title, "Infrastructure outlook & capacity");
  assert.equal(result.items[0].content, "Capacity rose materially in the latest quarter.");
  assert.equal(result.items[0].publishedAt, "2026-11-09T10:00:00.000Z");
  assert.equal(result.items[0].observedAt, observedAt);
  assert.equal(result.items[0].rightsStatus, "unknown");
  assert.match(result.items[0].contentDigest, /^sha256:[0-9a-f]{64}$/);
});

test("Atom reader parses alternate links and updated timestamps", async () => {
  const adapter = createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    now:() => observedAt,
    fetchImpl:async () => new Response(atom, {
      status:200,
      headers:{ "Content-Type":"application/atom+xml" },
    }),
  });
  const result = await adapter.read({
    capability:"source.capture",
    input:{ url:"https://feeds.example.com/atom.xml" },
  });
  assert.equal(result.format, "atom");
  assert.equal(result.itemCount, 1);
  assert.equal(result.items[0].sourceUrl, "https://publisher.example/policy/2");
  assert.equal(result.items[0].publishedAt, "2026-11-09T09:00:00.000Z");
});

test("host allowlist is exact and checked before any network request", async () => {
  let calls = 0;
  const adapter = createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    fetchImpl:async () => { calls += 1; return new Response(rss); },
  });
  await assert.rejects(
    adapter.read({ capability:"feed.read", input:{ url:"https://evil.example.com/rss" } }),
    /FEED_HOST_NOT_ALLOWLISTED/
  );
  await assert.rejects(
    adapter.read({ capability:"feed.read", input:{ url:"http://feeds.example.com/rss" } }),
    /FEED_URL_NOT_ALLOWED/
  );
  await assert.rejects(
    adapter.read({ capability:"feed.read", input:{ url:"https://127.0.0.1/rss" } }),
    /FEED_HOST_NOT_ALLOWLISTED/
  );
  assert.equal(calls, 0);
});

test("redirects, HTML responses and DTD/entity declarations are rejected", async () => {
  const redirect = createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    fetchImpl:async () => new Response("", { status:302, headers:{ location:"https://other.example/rss" } }),
  });
  await assert.rejects(redirect.read({ capability:"feed.read", input:{ url:"https://feeds.example.com/rss" } }), /FEED_REDIRECT_REJECTED/);

  const html = createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    fetchImpl:async () => new Response("<html></html>", { headers:{ "Content-Type":"text/html" } }),
  });
  await assert.rejects(html.read({ capability:"feed.read", input:{ url:"https://feeds.example.com/rss" } }), /FEED_CONTENT_TYPE_REJECTED/);

  const dtd = createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    fetchImpl:async () => new Response("<!DOCTYPE rss [<!ENTITY x SYSTEM 'file:///etc/passwd'>]><rss/>", { headers:{ "Content-Type":"application/xml" } }),
  });
  await assert.rejects(dtd.read({ capability:"feed.read", input:{ url:"https://feeds.example.com/rss" } }), /FEED_XML_DTD_REJECTED/);
});

test("response size, invalid capabilities and invalid allowlists fail closed", async () => {
  const large = createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    maxBytes:1024,
    fetchImpl:async () => new Response("x".repeat(2048), { headers:{ "Content-Type":"application/xml" } }),
  });
  await assert.rejects(large.read({ capability:"feed.read", input:{ url:"https://feeds.example.com/rss" } }), /FEED_RESPONSE_TOO_LARGE/);
  await assert.rejects(adapterFor(rss).read({ capability:"feed.write", input:{ url:"https://feeds.example.com/rss" } }), /RSS_CAPABILITY_NOT_GRANTED/);
  assert.throws(() => createRssReadAdapter({ allowedHosts:["localhost"] }), /RSS_HOST_ALLOWLIST_REQUIRED/);
  assert.throws(() => createRssReadAdapter({ allowedHosts:[] }), /RSS_HOST_ALLOWLIST_REQUIRED/);
});

test("invalid feed timestamps and missing fetch implementations are rejected", () => {
  assert.throws(() => createRssReadAdapter({ allowedHosts:["feeds.example.com"], fetchImpl:null }), /RSS_FETCH_IMPLEMENTATION_REQUIRED/);
  const adapter = createRssReadAdapter({
    allowedHosts:["feeds.example.com"],
    now:() => "not-a-time",
    fetchImpl:async () => new Response(rss, { headers:{ "Content-Type":"application/rss+xml" } }),
  });
  return assert.rejects(adapter.read({ capability:"feed.read", input:{ url:"https://feeds.example.com/rss" } }), /RSS_TRUSTED_CLOCK_UNAVAILABLE/);
});


test("RSS adapter is registered as discovered and runs only after trusted promotion", async () => {
  let calls = 0;
  const orchestrator = createOrchestrator({
    now:() => observedAt,
    verifyAdapterEvidence:(artifact, binding) =>
      artifact?.signedByHostVerifier === true && artifact?.adapterId === binding.adapterId,
  });
  const registered = registerRssReadAdapter(orchestrator, {
    allowedHosts:["feeds.example.com"],
    now:() => observedAt,
    fetchImpl:async () => {
      calls += 1;
      return new Response(rss, { headers:{ "Content-Type":"application/rss+xml" } });
    },
  });
  assert.equal(registered.descriptor.state, "DISCOVERED");
  assert.equal(registered.descriptor.permissions.write, false);

  const blocked = await orchestrator.executeRead({
    adapterId:"rss-primary",
    capability:"feed.read",
    input:{ url:"https://feeds.example.com/news.xml" },
  });
  assert.equal(blocked.status, "BLOCKED");
  assert.equal(calls, 0);

  assert.equal(orchestrator.transitionAdapter("rss-primary", "CONNECTED_UNVERIFIED").status, "OK");
  assert.equal(orchestrator.transitionAdapter("rss-primary", "VERIFIED_READ_ONLY", {
    verifierId:"host-feed-policy",
    adapterId:"rss-primary",
    signedByHostVerifier:true,
  }).status, "OK");

  const result = await orchestrator.executeRead({
    adapterId:"rss-primary",
    capability:"feed.read",
    input:{ url:"https://feeds.example.com/news.xml" },
  });
  assert.equal(result.status, "OK");
  assert.equal(result.output.itemCount, 1);
  assert.equal(calls, 1);
});
