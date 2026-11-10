import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createOrchestrator } from "./orchestrator.mjs";

const UI_ROOT = fileURLToPath(new URL("../../../products/kratt-prime-console/", import.meta.url));
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};
const STATIC_FILES = new Map([
  ["/", "index.html"],
  ["/index.html", "index.html"],
  ["/styles.css", "styles.css"],
  ["/app.js", "app.js"],
]);

function send(response, status, body, contentType = "application/json; charset=utf-8") {
  response.writeHead(status, {
    "Content-Type": contentType,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(contentType.startsWith("application/json") ? JSON.stringify(body) : body);
}

async function readJson(request, limit = 8192) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new Error("REQUEST_BODY_TOO_LARGE");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createLocalServer({ port = 4174, host = "127.0.0.1" } = {}) {
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new TypeError("LOCAL_SERVER_MUST_BIND_LOOPBACK");
  }

  const orchestrator = createOrchestrator();
  const adapters = [
    ["telegram", "Telegram", "messaging", ["message.read", "channel.read"], true, false],
    ["rss-primary", "RSS / Atom", "feed", ["feed.read", "source.capture"], true, false],
    ["github", "GitHub", "source-control", ["repo.read", "workflow.read"], true, false],
    ["slack", "Slack", "workspace", ["message.read", "channel.read"], true, false],
    ["web-research", "Web research", "research", ["search.read", "page.capture"], true, false],
  ];
  for (const [id, name, kind, capabilities, read, write] of adapters) {
    orchestrator.registerAdapter({
      id,
      name,
      kind,
      capabilities,
      permissions: { read, write },
    });
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.method === "GET" && url.pathname === "/api/health") {
      return send(response, 200, {
        status: "ok",
        mode: "local-development",
        host: "loopback",
        externalConnections: false,
        externalWrites: false,
      });
    }
    if (request.method === "GET" && url.pathname === "/api/state") {
      return send(response, 200, orchestrator.snapshot());
    }
    if (request.method === "GET" && url.pathname === "/api/events") {
      return send(response, 200, { events: orchestrator.snapshot().journal });
    }
    if (request.method === "POST" && url.pathname === "/api/intake") {
      if (!request.headers["content-type"]?.includes("application/json")) {
        return send(response, 415, { error: "JSON_CONTENT_TYPE_REQUIRED" });
      }
      try {
        const body = await readJson(request);
        const result = orchestrator.recordLocalIntake({
          label: body.label,
          sourceType: body.sourceType,
          actor: body.actor ?? "architect",
        });
        return send(response, result.status === "OK" ? 201 : 400, result);
      } catch (error) {
        const reason = error instanceof SyntaxError ? "JSON_INVALID" : error.message;
        return send(response, reason === "REQUEST_BODY_TOO_LARGE" ? 413 : 400, { error: reason });
      }
    }
    if (request.method === "GET" && STATIC_FILES.has(url.pathname)) {
      const filename = STATIC_FILES.get(url.pathname);
      try {
        const content = await readFile(new URL(filename, pathToFileURL(UI_ROOT + "/")));
        const extension = filename.slice(filename.lastIndexOf("."));
        return send(response, 200, content.toString("utf8"), MIME[extension]);
      } catch {
        return send(response, 404, { error: "STATIC_ASSET_NOT_FOUND" });
      }
    }
    return send(response, 404, { error: "NOT_FOUND" });
  });

  return Object.freeze({
    server,
    orchestrator,
    listen() {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.removeListener("error", reject);
          resolve(server.address());
        });
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        if (!server.listening) return resolve();
        server.close(error => error ? reject(error) : resolve());
      });
    },
  });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (invokedPath === import.meta.url) {
  const port = Number(process.env.KRATT_PORT ?? 4174);
  const app = createLocalServer({ port });
  app.listen().then(address => {
    process.stdout.write(`KRATT PRIME local console listening on http://127.0.0.1:${address.port}\n`);
    process.stdout.write("Local development only · no external connectors · no external writes\n");
  }).catch(error => {
    process.stderr.write(`KRATT local server failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
