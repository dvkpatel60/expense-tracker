import type { MerchantFacts } from "../core/types.js";
import type { EnrichmentResult, EnrichmentTransport } from "./types.js";

export interface EnrichOptions {
  /** Batch size. Keys are cheap but a 900-merchant first import should not be
   *  one request that either all works or all fails. */
  readonly batchSize?: number;
  readonly onProgress?: (done: number, total: number) => void;
}

/**
 * Enrichment is keyed on merchant, never on transaction. Two thousand rows in a
 * year is typically two hundred distinct merchants, and each one is looked up
 * once, ever. Cache hits never leave the machine.
 */
export async function enrichMerchants(
  transport: EnrichmentTransport,
  merchantKeys: readonly string[],
  cache: Readonly<Record<string, MerchantFacts>>,
  opts: EnrichOptions = {}
): Promise<EnrichmentResult> {
  const unique = [...new Set(merchantKeys)].filter((k) => k && !k.startsWith("etransfer:"));
  const missing = unique.filter((k) => !cache[k]);
  const servedFromCache = unique.length - missing.length;

  if (missing.length === 0) {
    return { facts: [], requested: 0, servedFromCache, failed: false };
  }

  const batchSize = opts.batchSize ?? 60;
  const facts: MerchantFacts[] = [];
  let done = 0;

  for (let i = 0; i < missing.length; i += batchSize) {
    const batch = missing.slice(i, i + batchSize);
    try {
      const result = await transport.lookup(batch);
      facts.push(...result);
    } catch (e) {
      // Partial success is kept. A failed batch leaves those merchants on the
      // local rules rather than discarding the batches that did work.
      return {
        facts,
        requested: missing.length,
        servedFromCache,
        failed: true,
        error: e instanceof Error ? e.message : "Merchant lookup failed",
      };
    }
    done += batch.length;
    opts.onProgress?.(done, missing.length);
  }

  return { facts, requested: missing.length, servedFromCache, failed: false };
}

/**
 * Everything the transport is allowed to see. Amounts, dates, balances,
 * account numbers and counterparty names are structurally absent, not just
 * omitted by convention.
 */
export function redactForLookup(merchantKeys: readonly string[]): readonly string[] {
  return merchantKeys.filter((k) => !k.startsWith("etransfer:"));
}
