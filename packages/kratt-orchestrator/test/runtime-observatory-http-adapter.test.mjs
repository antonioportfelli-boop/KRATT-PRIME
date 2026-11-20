import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeObservatoryApi } from "../src/runtime-observatory-api.mjs";
import { createRuntimeObservatoryHttpAdapter } from "../src/runtime-observatory-http-adapter.mjs";

function store() {
  return {
    async listOperations(options) {
      return [{ operation_id: "operation-01", status: "running", ...options }];
    },
    async getOperation(id) {
      return id === "operation-01" ? { operation_id: id, status: "succeeded" } : null;
    },
    async listEvents(id) {
      return [{ sequence: 1, event_id: "event-01", operation_id: id, event: { status: "queued" }, hash: "private" }];
    },
    async summarizeModules() {
      return [{ module_id: "kratt-core", total: 1 }];
    },
    async verifyChain() {
      return { ok: true, count: 1, operations: 1, head_hash: "private" };
    },
  };
}

function createApi(authorizeRead) {
  return createRuntimeObservatoryApi({ store: store(), authorizeRead });
}

test("unrelated paths are not claimed by the Observatory adapter", async () => {
  const adapter = createRuntimeObservatoryHttpAdapter({
    api: createApi(async () => true),
  });
  assert.equal(await adapter.handle({ method: "GET", url: "/health/ready" }), null);
});

test("missing principal resolver denies read access even if request headers claim an operator", async () => {
  const adapter = createRuntimeObservatoryHttpAdapter({
    api: createApi(async ({ principal }) => principal?.id === "operator-1"),
  });
  const result = await adapter.handle({
    method: "GET",
    url: "/observatory/integrity",
    request: { headers: { "x-user-id": "operator-1", "x-role": "admin" } },
  });
  assert.equal(result.statusCode, 403);
  assert.equal(result.body.reason, "OBSERVATORY_READ_NOT_AUTHORIZED");
});

test("server-owned principal resolution is passed to the API authorizer", async () => {
  const seen = [];
  const request = { auth: { principal: { id: "operator-1", roles: ["observatory:read"] } } };
  const api = createApi(async (context) => {
    seen.push(context);
    return context.principal?.id === "operator-1" &&
      context.principal.roles.includes("observatory:read");
  });
  const adapter = createRuntimeObservatoryHttpAdapter({
    api,
    resolvePrincipal: (incoming) => incoming?.auth?.principal ?? null,
  });
  const result = await adapter.handle({
    request,
    method: "GET",
    url: "/observatory/operations?limit=10",
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data[0].limit, 10);
  assert.equal(seen[0].principal.id, "operator-1");
  assert.equal(Object.getPrototypeOf(seen[0].principal), null);
});

test("resolver failures and accessor-backed principals fail closed without invoking authorization", async () => {
  let authorizerCalls = 0;
  const api = createApi(async () => {
    authorizerCalls++;
    return true;
  });
  const throwing = createRuntimeObservatoryHttpAdapter({
    api,
    resolvePrincipal() {
      throw new Error("session store unavailable");
    },
  });
  const denied = await throwing.handle({ method: "GET", url: "/observatory/modules", request: {} });
  assert.equal(denied.statusCode, 403);

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, "id", {
    enumerable: true,
    get() {
      getterCalls++;
      return "operator-1";
    },
  });
  const hostile = createRuntimeObservatoryHttpAdapter({
    api,
    resolvePrincipal: () => accessor,
  });
  const rejected = await hostile.handle({ method: "GET", url: "/observatory/modules", request: {} });
  assert.equal(rejected.statusCode, 403);
  assert.equal(getterCalls, 0);
  assert.equal(authorizerCalls, 0);
});

test("non-GET Observatory methods are denied and never resolve a principal", async () => {
  let resolverCalls = 0;
  const adapter = createRuntimeObservatoryHttpAdapter({
    api: createApi(async () => true),
    resolvePrincipal: () => {
      resolverCalls++;
      return { id: "operator-1" };
    },
  });
  const result = await adapter.handle({
    method: "POST",
    url: "/observatory/operations",
    request: {},
  });
  assert.equal(result.statusCode, 405);
  assert.equal(resolverCalls, 0);
});

test("duplicate query parameters remain invalid instead of being silently collapsed", async () => {
  const adapter = createRuntimeObservatoryHttpAdapter({
    api: createApi(async () => true),
    resolvePrincipal: () => ({ id: "operator-1" }),
  });
  const result = await adapter.handle({
    method: "GET",
    url: "/observatory/operations?limit=1&limit=200",
    request: {},
  });
  assert.equal(result.statusCode, 400);
  assert.equal(result.body.reason, "QUERY_INVALID");
});

test("operation history omits internal hash-chain material at the HTTP boundary", async () => {
  const adapter = createRuntimeObservatoryHttpAdapter({
    api: createApi(async () => true),
    resolvePrincipal: () => ({ id: "operator-1" }),
  });
  const result = await adapter.handle({
    method: "GET",
    url: "/observatory/operations/operation-01/events",
    request: {},
  });
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.data[0].event.status, "queued");
  assert.equal(Object.hasOwn(result.body.data[0], "hash"), false);
});


test("nested principal claim arrays are copied only from own data properties", async () => {
  let getterCalls = 0;
  const roles = [];
  Object.defineProperty(roles, "0", {
    enumerable: true,
    configurable: true,
    get() {
      getterCalls++;
      return "observatory:read";
    },
  });
  roles.length = 1;
  const adapter = createRuntimeObservatoryHttpAdapter({
    api: createApi(async () => true),
    resolvePrincipal: () => ({ id: "operator-1", roles }),
  });
  const result = await adapter.handle({
    method: "GET",
    url: "/observatory/modules",
    request: {},
  });
  assert.equal(result.statusCode, 403);
  assert.equal(getterCalls, 0);
});
