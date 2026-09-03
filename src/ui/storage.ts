import { MemoryStore } from "../store/store.js";
import type { KeyValueStore } from "../store/store.js";

/**
 * localStorage is unavailable in some embedded contexts and throws rather than
 * returning null. Probe once, fall back to memory, and let the app keep working
 * without persistence rather than failing to start.
 */
export function browserStore(): KeyValueStore {
  try {
    const probe = "__split_ledger_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
  } catch {
    return new MemoryStore();
  }
  return {
    async get(key) {
      return window.localStorage.getItem(key);
    },
    async set(key, value) {
      window.localStorage.setItem(key, value);
    },
    async remove(key) {
      window.localStorage.removeItem(key);
    },
  };
}
