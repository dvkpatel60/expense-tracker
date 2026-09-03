import rbc from "../parsers/__fixtures__/rbc-chequing.csv?raw";
import scotia from "../parsers/__fixtures__/scotia-visa.csv?raw";
import ws from "../parsers/__fixtures__/wealthsimple-cash.csv?raw";
import type { FiId } from "../core/types.js";

/** The same fixtures the parser tests run against, so the demo exercises the
 *  real code path rather than a hand-written happy case. */
export const SAMPLES: readonly { label: string; fi: FiId; text: string }[] = [
  { label: "RBC Chequing", fi: "rbc", text: rbc },
  { label: "Scotia Visa", fi: "scotiabank", text: scotia },
  { label: "Wealthsimple Cash", fi: "wealthsimple", text: ws },
];
