/**
 * The `reference` instance: the tables this Fabric app manages.
 *
 * Two exports, for two different consumers — this is the whole contract:
 *
 * 1. **Named class exports** are what the Rayfin CLI collects. It imports this
 *    module and scans its exports for `@entity()` classes (an exported ARRAY
 *    works too; an exported OBJECT is invisible to it). These become the tables.
 * 2. **`entities`** is what the frontend reads, as an object literal so its keys
 *    stay literal types and `AppSchema` can be derived rather than maintained.
 *
 * Both must list the same classes. `src/instances.test.ts` fails the build if they drift.
 */
import { CostCentre } from './CostCentre.js';
import { Country } from './Country.js';
import { Currency } from './Currency.js';
import { UnitOfMeasure } from './UnitOfMeasure.js';

export { Currency, Country, UnitOfMeasure, CostCentre };

export const entities = { Currency, Country, UnitOfMeasure, CostCentre } as const;
export type AppSchema = { [K in keyof typeof entities]: InstanceType<(typeof entities)[K]> };
export type EntityName = keyof AppSchema;
