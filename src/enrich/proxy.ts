import { parseResponse } from "./anthropic.js";
import type { EnrichmentTransport } from "./types.js";

/**
 * Talks to our own serverless function instead of Anthropic directly.
 *
 * This is the shape any real deployment needs: an API key cannot live in a
 * browser bundle, so the key stays on the server and the client posts nothing
 * but a list of merchant strings. The function returns the Anthropic response
 * untouched, so the same defensive parser handles both paths.
 */
export function proxyTransport(config: {
  endpoint?: string;
  today: string;
  fetchImpl?: typeof fetch;
}): EnrichmentTransport {
  const endpoint = config.endpoint ?? "/api/enrich";
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async lookup(keys) {
      const res = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ merchants: keys }),
      });
      if (res.status === 503) {
        throw new Error("Merchant lookup is not configured on this deployment.");
      }
      if (!res.ok) throw new Error(`Lookup failed with status ${res.status}`);
      return parseResponse(await res.json(), config.today);
    },
  };
}
