import type { MerchantFacts } from "../core/types.js";

/** The enrichment transport is injected. The core never knows whether the
 *  facts came from a model, a fixture, or a file the user imported. */
export interface EnrichmentTransport {
  lookup(merchantKeys: readonly string[]): Promise<readonly MerchantFacts[]>;
}

export interface EnrichmentResult {
  readonly facts: readonly MerchantFacts[];
  readonly requested: number;
  readonly servedFromCache: number;
  readonly failed: boolean;
  readonly error?: string;
}
