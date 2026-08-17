/**
 * Entity-side code shared by every instance.
 *
 * The audit contract lives here because it is used by entity classes in every
 * instance AND by `src/db.ts`, so it can belong to no single instance.
 *
 * Entity CLASSES can be shared the same way — an instance re-exports what it
 * wants and gets its own table with its own rows. Proven and measured (see
 * docs/platform-constraints.md), but deliberately not demonstrated: the case
 * where it earns its place is a table whose SHAPE is standardised while each
 * domain owns its ROWS, so the instances' analytics endpoints stay joinable
 * downstream. Reference data with one rightful owner is the opposite — that
 * wants a single owning instance and a connector, not a copy per database.
 */
export { Audited, AUDIT_FIELDS, AUDIT_IMMUTABLE, type AuditFields } from './audit.js';
