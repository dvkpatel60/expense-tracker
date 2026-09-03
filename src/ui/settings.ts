import type { KeyValueStore } from "../store/store.js";
import type { ProviderAvailability, ProviderId } from "../enrich/providers.js";

/**
 * Which provider and model to ask. Kept out of LedgerState deliberately: this
 * is a preference about how the app talks to the outside, not part of the
 * ledger, and folding it in would mean a store migration every time the
 * catalogue changes.
 */
export interface EnrichmentSettings {
  readonly provider: ProviderId;
  readonly model: string;
}

const KEY = "split-ledger:enrichment";

export async function loadSettings(store: KeyValueStore): Promise<EnrichmentSettings | null> {
  try {
    const raw = await store.get(KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    const provider = (parsed as { provider?: unknown })?.provider;
    const model = (parsed as { model?: unknown })?.model;
    if (typeof provider !== "string" || typeof model !== "string") return null;
    return { provider: provider as ProviderId, model };
  } catch {
    return null;
  }
}

export async function saveSettings(
  store: KeyValueStore,
  settings: EnrichmentSettings
): Promise<void> {
  try {
    await store.set(KEY, JSON.stringify(settings));
  } catch {
    /* A preference that cannot be saved is not worth failing an import over. */
  }
}

/**
 * Reconcile a stored choice against what the deployment currently offers.
 * A provider whose key was removed, or a model dropped from the catalogue,
 * falls back instead of failing the next lookup.
 */
export function reconcile(
  stored: EnrichmentSettings | null,
  available: readonly ProviderAvailability[]
): EnrichmentSettings | null {
  const usable = available.filter((p) => p.configured);
  if (usable.length === 0) return null;

  const chosen =
    (stored && usable.find((p) => p.id === stored.provider)) ?? usable[0]!;
  const model =
    stored && stored.provider === chosen.id && chosen.models.some((m) => m.id === stored.model)
      ? stored.model
      : chosen.defaultModel;

  return { provider: chosen.id, model };
}
