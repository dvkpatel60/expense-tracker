import { CATEGORIES } from "../core/categorize.js";

/** Shared by the browser transport and the serverless function so the two can
 *  never drift apart. */
export function buildEnrichmentPrompt(keys: readonly string[]): string {
  return `These are normalized merchant strings from Canadian bank card statements. Identify the real business behind each.

Respond with ONLY a JSON array, no preamble and no code fences. Each element:
{"key":"<the input string verbatim>","name":"<proper business name>","note":"<max 12 words: what they are and where>","category":"<one of: ${CATEGORIES.join(", ")}>","commonlyShared":<true|false>}

commonlyShared is true when this is the kind of purchase people typically split with friends.
If you cannot identify a string, return it with the name unchanged and category "Uncategorized".

Strings:
${keys.map((k) => "- " + k).join("\n")}`;
}

/** Server-side cap. The client batches well below this; the ceiling exists so
 *  one request cannot be inflated into an expensive one. */
export const MAX_MERCHANTS_PER_REQUEST = 120;
