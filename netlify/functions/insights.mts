import {
  buildInsightsPrompt,
  parseInsights,
  temperatureFor,
  validateAnalysisOptions,
  validateDigest,
} from "../../src/enrich/insights.js";
import type { AnalysisOptions } from "../../src/enrich/insights.js";
import type { InsightsDigest } from "../../src/core/digest.js";
import { PROVIDERS, providerFor, resolveModel } from "../../src/enrich/providers.js";
import type { ProviderSpec } from "../../src/enrich/providers.js";

/**
 * AI spending analysis proxy.
 *
 * The client sends the aggregates-only digest — category totals, deltas,
 * counts, top-merchant totals — and this function refuses anything that is not
 * exactly that shape, so "aggregates only" is enforced on the server rather
 * than merely promised by the client. Individual transactions, day-level
 * dates, balances, accounts and counterparty keys have no field to arrive in
 * and are rejected if smuggled into one that exists.
 *
 * Same posture as /api/enrich: keys stay here, the model is validated against
 * the registry, and the provider's envelope is normalized before replying.
 *
 * The copilot's workflow, tone and category focus ride alongside the digest.
 * None of them is data — they only steer what the model is asked to notice —
 * but they arrive in a request body all the same, so each is resolved against
 * its registry here rather than interpolated into a prompt.
 */
export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  let payload: {
    digest?: unknown;
    provider?: unknown;
    model?: unknown;
    options?: unknown;
  };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  const problem = validateDigest(payload.digest);
  if (problem) return json({ error: problem }, 400);

  const badOptions = validateAnalysisOptions(payload.options);
  if (badOptions) return json({ error: badOptions }, 400);
  const options = (payload.options ?? {}) as AnalysisOptions;

  const spec =
    payload.provider === undefined || payload.provider === null || payload.provider === ""
      ? firstConfigured()
      : providerFor(payload.provider);

  if (!spec) {
    const names = PROVIDERS.map((p) => p.envVar).join(" or ");
    return json(
      {
        error:
          payload.provider === undefined || payload.provider === null || payload.provider === ""
            ? `No provider is configured. Set ${names}. Analysis is disabled.`
            : `Unknown provider: ${String(payload.provider)}.`,
      },
      payload.provider ? 400 : 503
    );
  }

  const key = process.env[spec.envVar];
  if (!key) {
    return json(
      { error: `${spec.envVar} is not set, so ${spec.label} is unavailable here.` },
      503
    );
  }

  const model = resolveModel(spec, payload.model);
  if (!model) {
    return json({ error: `${spec.label} cannot use the model ${String(payload.model)}.` }, 400);
  }

  const prompt = buildInsightsPrompt(payload.digest as InsightsDigest, options);
  const upstream = spec.buildPromptRequest(model, prompt, key, {
    temperature: temperatureFor(options.tone),
  });
  let res: Response;
  try {
    res = await fetch(upstream.url, {
      method: "POST",
      headers: upstream.headers,
      body: upstream.body,
    });
  } catch {
    return json({ error: `Could not reach ${spec.label}.` }, 502);
  }

  if (!res.ok) {
    // The upstream body can carry the key back in an echoed request, so only
    // the status crosses back.
    return json({ error: `${spec.label} returned ${res.status}.` }, 502);
  }

  try {
    const insights = parseInsights(spec.extractText(await res.json()));
    return json({ provider: spec.id, model, insights }, 200);
  } catch (e) {
    return json(
      { error: e instanceof Error ? e.message : `Could not read the ${spec.label} response.` },
      502
    );
  }
};

function firstConfigured(): ProviderSpec | null {
  return PROVIDERS.find((p) => Boolean(process.env[p.envVar])) ?? null;
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const config = { path: "/api/insights" };
