import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { devApi } from "./dev/api-plugin.js";

/**
 * Two build targets.
 *
 * Default: normal chunked output for Netlify, with merchant lookup going
 * through /api/enrich so the API key stays on the server.
 *
 * SINGLEFILE=1: everything inlined into one HTML file for sharing or opening
 * from disk. That build has no server, so it talks to Anthropic directly and
 * only works where something else supplies credentials.
 */
export default defineConfig(() => {
  const singleFile = process.env["SINGLEFILE"] === "1";
  return {
    // devApi only applies on `serve`, so it costs the production build nothing.
    plugins: [react(), devApi(), ...(singleFile ? [viteSingleFile()] : [])],
    define: {
      "import.meta.env.VITE_ENRICH_MODE": JSON.stringify(singleFile ? "direct" : "proxy"),
    },
    build: {
      target: "es2022",
      // Source maps are not published: the deploy is public and the bundle
      // is the whole app. Build locally with --sourcemap when debugging.
      sourcemap: false,
      cssCodeSplit: !singleFile,
      ...(singleFile ? { assetsInlineLimit: 100_000_000 } : {}),
    },
  };
});
