import { MAX_MERCHANTS_PER_REQUEST } from "../../src/enrich/prompt.js";
import { parseFacts } from "../../src/enrich/facts.js";
import { PROVIDERS, providerFor, resolveModel } from "../../src/enrich/providers.js";
import type { ProviderSpec } from "../../src/enrich/providers.js";

/**
 * Merchant identification proxy.
 *
 * API keys stay here. The client sends merchant strings plus which provider to
 * ask, and this function refuses anything that does not look like a merchant
 * list — so the privacy boundary is enforced on the server, not just promised
 * by the client.
 *
 * It also normalizes the provider's response before replying, which is what
 * keeps provider envelopes out of the browser entirely.
 */
export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  let payload: { merchants?: unknown; provider?: unknown; model?: unknown };
  try {
    payload = (await req.json()) as typeof payload;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }
  const { merchants } = payload;

  if (!Array.isArray(merchants) || merchants.length === 0) {
    return json({ error: "Send { merchants: string[] }." }, 400);
  }
  if (merchants.length > MAX_MERCHANTS_PER_REQUEST) {
    return json({ error: `At most ${MAX_MERCHANTS_PER_REQUEST} merchants per request.` }, 413);
  }
  if (!merchants.every((m) => typeof m === "string" && m.length > 0 && m.length <= 120)) {
    return json({ error: "Merchants must be non-empty strings under 120 characters." }, 400);
  }
  // Belt and braces: a counterparty key must never reach a model.
  if (merchants.some((m) => (m as string).startsWith("etransfer:"))) {
    return json({ error: "Counterparty keys are not eligible for lookup." }, 400);
  }

  // No provider named means "whatever this deployment has a key for", so the
  // client works before it has fetched the catalogue.
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
            ? `No provider is configured. Set ${names}. Merchant identification is disabled.`
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

  const upstream = spec.buildRequest(model, merchants as string[], key);
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
    const facts = parseFacts(spec.extractText(await res.json()), today());
    return json({ provider: spec.id, model, facts }, 200);
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

const today = (): string => new Date().toISOString().slice(0, 10);

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const config = { path: "/api/enrich" };
