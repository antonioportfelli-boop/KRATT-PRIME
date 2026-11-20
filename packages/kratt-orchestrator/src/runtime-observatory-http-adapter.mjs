function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length === 0 || keys.some((key) => typeof key !== "string")) return false;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
  }
  return true;
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
        const candidate = await resolvePrincipal(request);
        if (isPlainRecord(candidate)) {
          const snapshot = Object.create(null);
          for (const key of Reflect.ownKeys(candidate)) {
            const descriptor = Object.getOwnPropertyDescriptor(candidate, key);
            snapshot[key] = descriptor.value;
          }
          principal = Object.freeze(snapshot);
        }
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
