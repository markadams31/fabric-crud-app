/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** All of these are generated into `.env.local` by `rayfin env --framework vite`. */
  readonly VITE_RAYFIN_API_URL: string;
  readonly VITE_RAYFIN_PUBLISHABLE_KEY: string;
  readonly VITE_FABRIC_WORKSPACE_ID: string;
  readonly VITE_FABRIC_ITEM_ID: string;
  readonly VITE_FABRIC_PORTAL_URL: string;
  /** Used to pin the broker to the right tenant — see `portalUrlForTenant`. */
  readonly VITE_FABRIC_TENANT_ID: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
