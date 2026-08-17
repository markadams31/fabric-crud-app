import { fileURLToPath } from 'node:url';

/**
 * Which instance's tables this build manages.
 *
 * One variable selects it everywhere: here for the UI, and in `rayfin.yml`
 * (`services.data.path`, `id`) for the deployed schema and the Fabric item —
 * so the app and its database can never disagree about which instance is
 * being worked on. Unset means `reference`, so the default needs no ceremony.
 */
export const INSTANCE = process.env.RAYFIN_INSTANCE || 'reference';

/**
 * What the app calls itself: the instance name, sentence-cased.
 *
 * Derived here rather than in the UI because two places need it and they must
 * agree — the `<h1>` in the app bar, and the `<title>` in `index.html`, which
 * is substituted at build time so the browser tab is right before any script
 * runs. `index.html` shipped one hard-coded name, so every instance's tab read
 * the same, which is the defect the heading already had.
 */
export const INSTANCE_TITLE = INSTANCE.replace(/[-_]+/g, ' ').replace(/^./, (c) =>
  c.toUpperCase()
);

/**
 * `@instance` → the active instance's barrel, shared by Vite and Vitest.
 *
 * Resolved to the package SOURCE rather than its built `dist`: Vite compiles
 * the TC39 decorators itself, and a stale `dist` would silently serve metadata
 * from an older version of the schema — the tables would be right and the UI
 * wrong, which is the hardest kind of mismatch to see.
 */
export const instanceAlias = {
  '@instance': fileURLToPath(new URL(`./instances/${INSTANCE}/src/index.ts`, import.meta.url)),
  // Source, not the package's built `dist`, and this one is load-bearing.
  // An entity's NAME is its class name, and the two compilers disagree about
  // how to keep it: esbuild's decorator lowering writes the name as a string
  // literal, tsc's refers to the class binding — which the bundler then
  // minifies. So a shared entity that reached the UI through `dist` arrived
  // with a mangled name, `name in entities` failed in foreignKeys(), and every
  // lookup column silently degraded to a raw UUID with an "…id" heading.
  // Measured: dev server correct, production build broken. Source everywhere
  // keeps one compiler in charge of the classes the UI reads.
  '@app/shared': fileURLToPath(new URL('./packages/shared/src/index.ts', import.meta.url)),
};
