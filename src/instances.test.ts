import {
  getFieldConstraints,
  isRayfinEntity,
  RayfinEntity,
  type EntityClass,
} from '@microsoft/rayfin-core';
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { AUDIT_FIELDS, AUDIT_IMMUTABLE } from '@app/shared';
import { describeEntityClass } from './entity';
import type { EntityName } from '@instance';

/** Any registered class, widened — these tests run against instances the app never loads. */
type AnyEntity = EntityClass<Record<string, unknown>>;

/**
 * Guards for the mistakes that are silent — a green deploy and a broken app, or
 * a table that simply never appears. No backend, no credentials, no Docker.
 *
 * Runs over EVERY instance, not just the one this build renders. Only the
 * active instance reaches the UI, so without this a second instance could
 * break and nothing would notice until its own deploy — which is exactly the
 * failure multi-instance makes easy. `describeEntityClass` takes a class
 * rather than a registry key, which is what lets it run against instances the
 * running app has never loaded.
 */

// Eager glob rather than a computed import(): Vite cannot analyse the latter.
const barrels = import.meta.glob<Record<string, unknown>>('../instances/*/src/index.ts', {
  eager: true,
});

const instances = Object.entries(barrels).map(([path, mod]) => ({
  name: path.split('/')[2],
  entities: mod.entities as Record<string, AnyEntity>,
  exported: Object.entries(mod)
    .filter(([, v]) => isRayfinEntity(v))
    .map(([k]) => k),
}));

/** [instanceName, entityName, entityClass] for every entity in every instance. */
const every = instances.flatMap((i) =>
  Object.entries(i.entities).map(([name, entity]) => [i.name, name, entity] as const)
);

it('finds at least one instance', () => {
  expect(instances.length).toBeGreaterThan(0);
});

it('type-checks every instance', () => {
  // `tsc -b` only builds projects the root tsconfig REFERENCES, and TypeScript
  // has no glob for that. So an instance added without one is invisible to the
  // type checker: `npm run check` goes green while the instance has type
  // errors — measured, not theorised. The tests below would still run over it
  // (they glob), which makes the gap easy to miss.
  const root = JSON.parse(
    readFileSync(new URL('../tsconfig.json', import.meta.url), 'utf8').replace(
      /^\s*\/\/.*$/gm,
      ''
    )
  ) as { references?: { path: string }[] };
  const referenced = new Set((root.references ?? []).map((r) => r.path.replace(/^\.\//, '')));
  for (const { name } of instances) {
    expect(referenced, `instances/${name} is not referenced in tsconfig.json`).toContain(
      `instances/${name}`
    );
  }
});

describe.each(instances.map((i) => [i.name, i] as const))('%s', (_name, instance) => {
  it('exports the same classes it registers', () => {
    // The barrel has two consumers that read it differently: the CLI collects
    // NAMED CLASS exports (an exported object is invisible to it), the frontend
    // reads the `entities` object. Drift means a table that deploys but never
    // appears in the UI, or a tab whose table does not exist.
    expect(instance.exported.sort()).toEqual(Object.keys(instance.entities).sort());
  });

  it('keys the registry by the entity name the API uses', () => {
    for (const [key, entity] of Object.entries(instance.entities)) {
      expect(entity[Symbol.metadata]?.[RayfinEntity]?.name).toBe(key);
    }
  });
});

describe('entity invariants', () => {
  it.each(every)('%s/%s: every @text() sets max', (_i, _name, entity) => {
    const meta = entity[Symbol.metadata]?.[RayfinEntity];
    for (const field of Object.keys(meta!.fields)) {
      const c = getFieldConstraints(entity, field);
      if (c?.type !== 'string' || c.format === 'uuid') continue;
      // Without `max` the column becomes NVARCHAR(MAX), which Data API Builder
      // cannot build a schema over: the deploy succeeds and every later request
      // fails with a generic internal error.
      expect(c.max, `${_name}.${field} has no max`).toBeGreaterThan(0);
    }
  });

  it.each(every)('%s/%s: the UI offers exactly the writes the entity grants', (_i, _name, entity) => {
    // The grid's New/Edit/Delete come from these declarations. A read-only
    // entity that still drew them failed the save with "The field
    // `updateX` does not exist on the type `Mutation`".
    const roles = entity[Symbol.metadata]?.[RayfinEntity]?.roles ?? [];
    const granted = new Set(roles.flatMap((r) => r.actions ?? []));
    const can = describeEntityClass(entity, _name as EntityName).can;
    for (const action of ['create', 'update', 'delete'] as const) {
      expect(can[action], `${_name}.can.${action}`).toBe(granted.has('*') || granted.has(action));
    }
  });

  it.each(every)('%s/%s: every @decimal() declares its scale', (_i, _name, entity) => {
    // Undeclared, the column is still DECIMAL(18,2) — so 0.001 stores as 0.00,
    // silently, on write. The sibling of the @text max trap, named in the same
    // CLAUDE.md table.
    const fields = entity[Symbol.metadata]?.[RayfinEntity]?.fields ?? {};
    for (const [field, meta] of Object.entries(fields)) {
      const m = meta as { format?: string; scale?: number };
      if (m.format !== 'decimal') continue;
      expect(m.scale, `${_name}.${field} is @decimal() with no scale`).toBeGreaterThan(0);
    }
  });

  it.each(every)('%s/%s: declares permissions', (_i, _name, entity) => {
    // An entity with no permission decorator fails OPEN — the generator injects
    // full CRUD for any signed-in user.
    const roles = entity[Symbol.metadata]?.[RayfinEntity]?.roles;
    expect(roles?.length, `${_name} has no permission decorator`).toBeGreaterThan(0);
  });

  it.each(every)('%s/%s: audit columns come as a full set or not at all', (_i, _name, entity) => {
    const fields = Object.keys(entity[Symbol.metadata]?.[RayfinEntity]?.fields ?? {});
    const carried = AUDIT_FIELDS.filter((f) => fields.includes(f));
    // Auditing is opt-in per entity — the UI handles an entity with none —
    // but a partial set is a mistake: `createdAt` without `createdBy` records
    // a when with no who, and the stamping helper would half-fill rows.
    if (carried.length === 0) return;
    expect(carried, `${_name} carries only part of the audit contract`).toEqual([...AUDIT_FIELDS]);
  });

  it.each(every)('%s/%s: makes the row origin immutable', (_i, _name, entity) => {
    // Field-level `exclude` is what stops a hand-crafted mutation rewriting who
    // created a row — the strongest guarantee available, since only two roles exist.
    const meta = entity[Symbol.metadata]?.[RayfinEntity];
    const audited = AUDIT_FIELDS.some((f) => f in (meta?.fields ?? {}));
    if (!audited) return;
    const update = (meta?.roles ?? []).find((r) => r.actions.includes('update'));
    if (!update) return;
    expect(update.excludedFields ?? [], `${_name} allows its origin to be rewritten`).toEqual(
      expect.arrayContaining([...AUDIT_IMMUTABLE])
    );
  });
});
