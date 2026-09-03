import {
  buildEnrichmentPrompt,
  ENRICHMENT_MODEL,
  MAX_MERCHANTS_PER_REQUEST,
} from "../../src/enrich/prompt.js";

/**
 * Merchant identification proxy.
 *
 * The API key stays here. The client sends merchant strings and nothing else,
 * and this function refuses anything that does not look like a merchant list —
 * so the privacy boundary is enforced on the server, not just promised by the
 * client.
 */
export default async (req: Request): Promise<Response> => {
  if (req.method !== "POST") {
    return json({ error: "Use POST." }, 405);
  }

  const key = process.env["ANTHROPIC_API_KEY"];
  if (!key) {
    return json(
      { error: "ANTHROPIC_API_KEY is not set. Merchant identification is disabled." },
      503
    );
  }

  let merchants: unknown;
  try {
    merchants = ((await req.json()) as { merchants?: unknown }).merchants;
  } catch {
    return json({ error: "Body must be JSON." }, 400);
  }

  if (!Array.isArray(merchants) || merchants.length === 0) {
    return json({ error: "Send { merchants: string[] }." }, 400);
  }
  if (merchants.length > MAX_MERCHANTS_PER_REQUEST) {
    return json({ error: `At most ${MAX_MERCHANTS_PER_REQUEST} merchants per request.` }, 413);
  }
  if (!merchants.every((m) => typeof m === "string" && m.length > 0 && m.length <= 120)) {
    return json({ error: "Merchants must be non-empty strings under 120 characters." }, 400);
  }
  // Belt and braces: a counterparty key must never reach the model.
  if (merchants.some((m) => (m as string).startsWith("etransfer:"))) {
    return json({ error: "Counterparty keys are not eligible for lookup." }, 400);
  }

  const upstream = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: ENRICHMENT_MODEL,
      max_tokens: 2000,
      messages: [{ role: "user", content: buildEnrichmentPrompt(merchants as string[]) }],
    }),
  });

  if (!upstream.ok) {
    return json({ error: `Upstream returned ${upstream.status}.` }, 502);
  }
  return json(await upstream.json(), 200);
};

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export const config = { path: "/api/enrich" };
