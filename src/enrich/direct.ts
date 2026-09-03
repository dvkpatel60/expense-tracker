import { parseFacts } from "./facts.js";
import {
  buildInsightsPrompt,
  parseInsights,
  temperatureFor,
  validateAnalysisOptions,
} from "./insights.js";
import type { AnalysisOptions, Insight } from "./insights.js";
import type { InsightsDigest } from "../core/digest.js";
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

/** Analysis for the single-file build: straight to the provider, credentials
 *  supplied by whoever hosts the file. Same registry, same shared prompt. */
export async function requestInsightsDirect(config: {
  digest: InsightsDigest;
  provider: ProviderId;
  model?: string;
  options?: AnalysisOptions;
  apiKey?: string;
  fetchImpl?: typeof fetch;
}): Promise<Insight[]> {
  const spec = providerFor(config.provider);
  if (!spec) throw new Error(`Unknown provider: ${String(config.provider)}`);
  const model = resolveModel(spec, config.model);
  if (!model) throw new Error(`${spec.label} cannot use the model ${String(config.model)}.`);

  // The single-file build has no server to re-validate against, so the same
  // registry check the function performs happens here before anything is sent.
  const badOptions = validateAnalysisOptions(config.options);
  if (badOptions) throw new Error(badOptions);
  const options = config.options ?? {};

  const req = spec.buildPromptRequest(
    model,
    buildInsightsPrompt(config.digest, options),
    config.apiKey ?? "",
    { temperature: temperatureFor(options.tone) }
  );
  const doFetch = config.fetchImpl ?? fetch;
  const res = await doFetch(req.url, { method: "POST", headers: req.headers, body: req.body });
  if (!res.ok) throw new Error(`Analysis failed with status ${res.status}`);
  return parseInsights(spec.extractText(await res.json()));
}
