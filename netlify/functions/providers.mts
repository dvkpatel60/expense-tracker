import { describeProviders } from "../../src/enrich/providers.js";

/**
 * What this deployment can actually do.
 *
 * The picker is built from this rather than from a list compiled into the
 * bundle, so a provider appears only where its key is set — configure Gemini
 * and it shows up; remove the key and it stops being offered. Presence of a
 * key is reported, never the key itself or any part of it.
 */
export default async (req: Request): Promise<Response> => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Use GET." }), {
      status: 405,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }

  const providers = describeProviders((spec) => Boolean(process.env[spec.envVar]));

  return new Response(JSON.stringify({ providers }), {
    status: 200,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
};

export const config = { path: "/api/providers" };
