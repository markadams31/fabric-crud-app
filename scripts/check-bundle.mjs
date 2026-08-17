/**
 * Proves an entity's identity survives minification.
 *
 * An entity's name IS its class name, and the API is addressed by it. A
 * production build minifies class bindings away unless esbuild's `keepNames`
 * is on, and when that happened every lookup column silently degraded to a raw
 * UUID — in the deployed app only. `npm run check`, the dev server and the
 * whole Playwright suite stayed green, because none of them ever reads a
 * production bundle. This script is the one thing that does.
 *
 * It asserts the *lowering*, not the name: `keepNames` emits a static block
 * `__name(this, "Currency")`, which survives minification as `a(this,"Currency")`.
 * Matching the bare name instead would pass on a bundle that merely carries the
 * name as a label string — measured: with `keepNames: false` the name is still
 * present three times, and `this,"<Name>")` drops to zero.
 *
 *   npm run build && node scripts/check-bundle.mjs   # RAYFIN_INSTANCE picks the app
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const instance = process.env.RAYFIN_INSTANCE ?? 'reference';

// The registry is the authority on what names must survive — reading it rather
// than the source keeps this script free of any entity name, like the rest of
// the repo. It resolves through the npm workspace symlink to the tsc build, so
// `tsc -b` (part of `npm run build`) must have run.
let entities;
try {
  ({ entities } = await import(`@instance/${instance}`));
} catch (cause) {
  console.error(`Cannot load the ${instance} registry — run \`npm run build\` first.`);
  throw cause;
}

const dir = join(process.cwd(), 'dist', 'assets');
let bundles;
try {
  bundles = readdirSync(dir).filter((f) => f.endsWith('.js'));
} catch {
  console.error(`No dist/assets — run \`RAYFIN_INSTANCE=${instance} npm run build\` first.`);
  process.exit(1);
}
// Read as one string: Vite may code-split, and which chunk holds a given entity
// is not ours to predict.
const code = bundles.map((f) => readFileSync(join(dir, f), 'utf8')).join('\n');

// Fixed-string search, never a regex: a regex scan over a minified bundle once
// consumed all available memory on this machine.
const lost = Object.keys(entities).filter((name) => !code.includes(`this,"${name}")`));

if (lost.length) {
  console.error(
    `\n✖ ${lost.length} of ${Object.keys(entities).length} entity names did not survive the ` +
      `${instance} production build:\n` +
      lost.map((n) => `    ${n}`).join('\n') +
      `\n\nEvery lookup column would render a raw UUID in the deployed app.\n` +
      `This reads the bundle currently on disk, so first make sure it is this instance's\n` +
      `and current: \`RAYFIN_INSTANCE=${instance} npm run build\`. If it still fails, check\n` +
      `that vite.config.ts sets esbuild.keepNames and that entities reach the UI through\n` +
      `the source aliases rather than a tsc-built dist.\n`
  );
  process.exit(1);
}

console.log(
  `✓ ${Object.keys(entities).length} entity names survive the ${instance} production build ` +
    `(${bundles.length} chunk${bundles.length === 1 ? '' : 's'})`
);
