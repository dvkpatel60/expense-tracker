import { parseFacts } from "./facts.js";
import { providerFor, resolveModel } from "./providers.js";
import type { ProviderId } from "./providers.js";
import type { EnrichmentTransport } from "./types.js";

/**
 * Talks to a provider straight from the page.
 *
 * Only the single-file build uses this: there is no server behind it, so it
 * works where something else supplies credentials and is inert otherwise. The
 * deployed build uses proxyTransport, because an API key cannot live in a
 * browser bundle.
 *
 * Provider-agnostic by construction — it asks the registry how to shape the
 * request and where the text lives, and shares parseFacts with every other path.
 */
export function directTransport(config: {
  provider: ProviderId;
  model?: string;
  apiKey?: string;
  today: string;
  fetchImpl?: typeof fetch;
}): EnrichmentTransport {
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async lookup(keys) {
      const spec = providerFor(config.provider);
      if (!spec) throw new Error(`Unknown provider: ${String(config.provider)}`);
      const model = resolveModel(spec, config.model);
      if (!model) throw new Error(`${spec.label} cannot use the model ${String(config.model)}.`);

      const req = spec.buildRequest(model, keys, config.apiKey ?? "");
      const res = await doFetch(req.url, {
        method: "POST",
        headers: req.headers,
        body: req.body,
      });
      if (!res.ok) throw new Error(`Lookup failed with status ${res.status}`);
      return parseFacts(spec.extractText(await res.json()), config.today);
    },
  };
}
