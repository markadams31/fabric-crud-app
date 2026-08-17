// Seed the ACTIVE instance with a small deterministic dataset.
//
// Two consumers: CI's e2e job (a fresh backend has zero rows, and the
// data-dependent tests time out instead of skipping — measured on the first
// pipeline run), and a rebuilt local environment after `local:purge`.
// Idempotent: rows are matched by their unique code and skipped when present,
// so re-running is always safe.
//
// Local backends only, in practice: it signs in with the password fixture
// account, and password auth does not function on deployed apps (measured) —
// they are Entra-SSO-only — deployed Test data is
// disposable by decision (docs/operations.md, pipeline flow step 2), restored
// through the CSV importer if ever wanted.
//
// This file is the MECHANISM only. The rows live with the instance they fill,
// in `instances/<name>/seed.mjs`, because a fixture naming a table is useless
// to an instance that does not have it — a fork rewrites those, not this.

import { readFileSync } from 'node:fs';

import { RayfinClient } from '@microsoft/rayfin-client';

/** Which instance's fixtures to load — the same variable the app and rayfin.yml use. */
const INSTANCE = process.env.RAYFIN_INSTANCE || 'reference';

const env = Object.fromEntries(
  readFileSync('rayfin/.env', 'utf8')
    .split('\n')
    .filter((l) => l.includes('=') && !l.startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
);

const baseUrl = env.RAYFIN_PUBLIC_API_URL?.endsWith('/')
  ? env.RAYFIN_PUBLIC_API_URL
  : `${env.RAYFIN_PUBLIC_API_URL}/`;

const client = new RayfinClient({
  baseUrl,
  publishableKey: env.RAYFIN_PUBLIC_PUBLISHABLE_KEY,
  authStorage: false, // Node has no localStorage; keep the session in memory
});

const credentials = { email: 'dev@contoso.com', password: 'LocalDev!Pass123' };
try {
  await client.auth.signIn(credentials);
} catch (err) {
  if (err?.code !== 'INVALID_GRANT') throw err;
  await client.auth.signUp(credentials);
  await client.auth.signIn(credentials);
}

const who = credentials.email;
const now = new Date();
const stamp = { createdAt: now, createdBy: who, updatedAt: now, updatedBy: who };

/** Insert rows that are not already there, matching on a unique column. */
async function ensure(entity, uniqueField, rows) {
  const data = client.data[entity];
  // Walk every page: matching against only the first page would re-create
  // rows already present beyond it, silently breaking the idempotency claim.
  const have = new Set();
  let cursor;
  for (;;) {
    const query = data.select([uniqueField]).first(500);
    const page = await (cursor ? query.after(cursor) : query).executePaginated();
    for (const r of page.items) have.add(r[uniqueField]);
    if (!page.hasNextPage || !page.endCursor) break;
    cursor = page.endCursor;
  }
  let created = 0;
  for (const row of rows) {
    if (have.has(row[uniqueField])) continue;
    await data.create({ ...row, ...stamp });
    created++;
  }
  console.log(`${entity}: ${created} created, ${rows.length - created} already present`);
  return data;
}

const { default: seed } = await import(`../instances/${INSTANCE}/seed.mjs`);
await seed({ ensure, client });

console.log(`Seed complete (${INSTANCE}).`);
// The client keeps a session-refresh handle alive; without this, CI hangs.
process.exit(0);
