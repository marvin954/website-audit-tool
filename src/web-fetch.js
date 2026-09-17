// web-fetch.js — fallback fetcher using the Hermes web_extract tool
// Used when Node native fetch fails (TLS/network restrictions on this host)

let cache;

async function webFetch(url) {
  // Lazy-load the Hermes tools module (only available inside Hermes runtime)
  if (!cache) {
    try {
      const mod = await import("hermes_tools");
      cache = mod;
    } catch {
      // Not running inside Hermes — native fetch is the only option
      return null;
    }
  }
  try {
    const r = await cache.web_extract([url], 200_000);
    const result = r.results?.[0];
    if (result && result.content) {
      return { content: result.content, error: result.error };
    }
    return null;
  } catch {
    return null;
  }
}

export { webFetch };
