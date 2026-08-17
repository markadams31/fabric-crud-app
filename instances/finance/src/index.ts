/**
 * The `finance` instance. See instances/reference/src/index.ts for the contract.
 *
 * Shares no table with `reference` — the two instances are independent apps
 * that happen to be built from one codebase, which is the point.
 */
import { CostCode } from './CostCode.js';
import { Invoice } from './Invoice.js';

export { Invoice, CostCode };

export const entities = { Invoice, CostCode } as const;
export type AppSchema = { [K in keyof typeof entities]: InstanceType<(typeof entities)[K]> };
export type EntityName = keyof AppSchema;
