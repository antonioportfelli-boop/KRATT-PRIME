function snapshotPrincipal(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0 || keys.length > 32 || keys.some((key) => typeof key !== "string")) return null;
  const snapshot = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return null;
    const field = descriptor.value;
    if (field === null || typeof field === "string" && field.length <= 4096 ||
        typeof field === "boolean" || typeof field === "number" && Number.isFinite(field)) {
      snapshot[key] = field;
      continue;
    }
    if (!Array.isArray(field) || field.length > 256) return null;
    const arrayKeys = Reflect.ownKeys(field);
    if (arrayKeys.length !== field.length + 1 || !arrayKeys.includes("length") ||
        arrayKeys.some((arrayKey) => typeof arrayKey !== "string" ||
          arrayKey !== "length" && !/^(?:0|[1-9][0-9]*)$/.test(arrayKey))) return null;
    const copied = [];
    for (let index = 0; index < field.length; index++) {
      const item = Object.getOwnPropertyDescriptor(field, String(index));
      if (!item || !("value" in item) || !item.enumerable ||
          typeof item.value !== "string" || item.value.length > 256) return null;
      copied.push(item.value);
    }
    snapshot[key] = Object.freeze(copied);
  }
  return Object.freeze(snapshot);
}
function queryObject(searchParams) {
  const query = Object.create(null);
  for (const [key, value] of searchParams) {
    if (Object.hasOwn(query, key)) {
      const existing = query[key];
      query[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    } else {
      query[key] = value;
    }
  }
  return query;
}

/**
 * Translates Node HTTP request metadata into the existing protected Observatory API.
 *
 * The principal resolver must be supplied by the hosting application's authenticated
 * server-side session middleware. This adapter never reads identity, role, or
 * authorization claims from caller-controlled headers, query parameters, or cookies.
 * Missing or throwing resolvers produce an anonymous principal and the API's default deny.
 */
export function createRuntimeObservatoryHttpAdapter({ api, resolvePrincipal } = {}) {
  if (!api || typeof api.handle !== "function") {
    throw new TypeError("OBSERVATORY_HTTP_API_REQUIRED");
  }
  if (resolvePrincipal !== undefined && typeof resolvePrincipal !== "function") {
    throw new TypeError("OBSERVATORY_PRINCIPAL_RESOLVER_INVALID");
  }

  async function handle({ request, method = request?.method, url = request?.url } = {}) {
    let parsed;
    try {
      parsed = new URL(url ?? "/", "http://localhost");
    } catch {
      return { statusCode: 400, body: { status: "INVALID", reason: "URL_INVALID" } };
    }

    const path = parsed.pathname;
    if (path !== "/observatory" && !path.startsWith("/observatory/")) return null;

    let principal = null;
    if (method === "GET" && typeof resolvePrincipal === "function") {
      try {
        principal = snapshotPrincipal(await resolvePrincipal(request));
      } catch {
        principal = null;
      }
    }

    return api.handle({
      method,
      path,
      principal,
      query: queryObject(parsed.searchParams),
    });
  }

  return Object.freeze({ handle });
}
