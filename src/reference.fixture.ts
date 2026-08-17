import type { EntityClass } from '@microsoft/rayfin-core';

import { entities } from '../instances/reference/src/index';
import { describeEntityClass, type EntityView } from './entity';

/**
 * The reference instance, as a test fixture.
 *
 * Imported directly rather than through `@instance` — deliberately. These
 * tests assert on the sample schema's exact columns ("Currency has a 3-letter
 * code"), so running them against whatever instance happens to be active would
 * fail for a reason that says nothing about the code under test. They cover
 * shared code (the importer, the CSV writer, the validator); the reference
 * schema is only their fixture, so it should be named, not inherited.
 *
 * Not a `.test.ts` file, so vitest does not try to run it as a suite.
 */
export const reference = (name: keyof typeof entities): EntityView =>
  // Indexing a registry with a union of names yields a union of generic class
  // types that the signature cannot accept — the same widening `db.ts` performs
  // for the same reason, and the reason `dynamic()` exists there.
  describeEntityClass(entities[name] as unknown as EntityClass<Record<string, unknown>>, name);
