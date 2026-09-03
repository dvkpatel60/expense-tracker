import type { Plugin } from "vite";
import { createMerchantCache } from "./merchant-cache.js";
import type { MerchantCache } from "./merchant-cache.js";
import type { MerchantFacts } from "../src/core/types.js";

/**
 * Serves the Netlify functions during `npm run dev`.
 *
 * Without this, `/api/enrich` 404s locally and merchant identification can only
 * be exercised by deploying — so the one part of the app that talks to a
 * provider would be the one part never tried before it ships. The handlers are
 * loaded through Vite's module graph, so they are the same source Netlify
 * bundles, not a reimplementation.
 *
 * An in-memory SQLite cache sits in front of the enrich handler: a dev session
 * is dozens of reloads, and every reload would otherwise re-buy the same
 * merchant identifications.
 */
export function devApi(): Plugin {
  let cache: MerchantCache | null = null;

  return {
    name: "split-ledger:dev-api",
    apply: "serve",

    configureServer(server) {
      cache ??= createMerchantCache();

      const load = async (file: string): Promise<(req: Request) => Promise<Response>> => {
        const mod = await server.ssrLoadModule(`/netlify/functions/${file}`);
        return mod["default"] as (req: Request) => Promise<Response>;
      };

      server.middlewares.use("/api/providers", (req, res, next) => {
        void (async () => {
          try {
            const handler = await load("providers.mts");
            await send(res, await handler(toRequest(req, "/api/providers")));
          } catch (e) {
            next(e as Error);
          }
        })();
      });

      server.middlewares.use("/api/enrich", (req, res, next) => {
        void (async () => {
          try {
            const raw = await readBody(req);
            const body = raw ? (JSON.parse(raw) as { merchants?: unknown }) : {};
            const merchants = Array.isArray(body.merchants) ? (body.merchants as string[]) : [];

            const { hits, misses } = cache!.get(merchants);
            if (misses.length === 0 && merchants.length > 0) {
              log(`cache hit for all ${hits.length} merchants`);
              return await sendJson(res, 200, { provider: "cache", model: "cache", facts: hits });
            }

            // Only the misses cross the network; the handler re-validates them.
            const handler = await load("enrich.mts");
            const upstream = await handler(
              toRequest(req, "/api/enrich", JSON.stringify({ ...body, merchants: misses }))
            );

            if (!upstream.ok) {
              if (hits.length > 0) log(`upstream ${upstream.status}, ${hits.length} served from cache`);
              return await send(res, upstream);
            }

            const payload = (await upstream.json()) as {
              provider?: string;
              model?: string;
              facts?: MerchantFacts[];
            };
            const fresh = payload.facts ?? [];
            cache!.put(fresh);
            log(
              `${hits.length} cached + ${fresh.length} fetched via ${payload.provider ?? "?"} (${cache!.size()} held)`
            );
            await sendJson(res, 200, { ...payload, facts: [...hits, ...fresh] });
          } catch (e) {
            next(e as Error);
          }
        })();
      });

      // Insights carry no cache: the digest changes with every edit to the
      // ledger, and the client already remembers answers per digest hash.
      server.middlewares.use("/api/insights", (req, res, next) => {
        void (async () => {
          try {
            const handler = await load("insights.mts");
            await send(res, await handler(toRequest(req, "/api/insights", await readBody(req))));
          } catch (e) {
            next(e as Error);
          }
        })();
      });

      server.httpServer?.once("listening", () => {
        log("/api/enrich, /api/insights and /api/providers are live");
      });
    },
  };
}

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(`  [36m[dev-api][0m ${msg}`);
};

/* ------------------------------------------------------------------ */
/* Node request/response <-> web Request/Response                      */
/* ------------------------------------------------------------------ */

interface NodeReq {
  method?: string | undefined;
  headers: Record<string, string | string[] | undefined>;
  on(event: string, cb: (chunk?: unknown) => void): void;
}

interface NodeRes {
  statusCode: number;
  setHeader(name: string, value: string): void;
  end(body?: string): void;
}

function toRequest(req: NodeReq, path: string, body?: string): Request {
  const method = req.method ?? "GET";
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers.set(k, v);
  }
  return new Request(`http://localhost${path}`, {
    method,
    headers,
    ...(method === "GET" || method === "HEAD" ? {} : { body: body ?? "" }),
  });
}

async function readBody(req: NodeReq): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (chunk) => {
      data += String(chunk);
    });
    req.on("end", () => resolve(data));
  });
}

async function send(res: NodeRes, response: Response): Promise<void> {
  res.statusCode = response.status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(await response.text());
}

async function sendJson(res: NodeRes, status: number, body: unknown): Promise<void> {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
