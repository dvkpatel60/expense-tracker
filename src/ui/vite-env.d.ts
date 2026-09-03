/// <reference types="vite/client" />
declare module "*.csv?raw" {
  const content: string;
  export default content;
}

interface ImportMetaEnv {
  readonly VITE_ENRICH_MODE: "direct" | "proxy";
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
