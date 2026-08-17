import { date, text } from '@microsoft/rayfin-core';

/**
 * The audit contract, declared once.
 *
 * Everything else derives from these two constants: which fields the form hides,
 * what a write stamps, and what an entity marks immutable. A fifth audit
 * column means editing this file AND the stamping in src/db.ts, which has to
 * know what value the new column takes.
 */

/** Every audit column. Stamped on write; never typed by a person. */
export const AUDIT_FIELDS = ['createdAt', 'createdBy', 'updatedAt', 'updatedBy'] as const;

/** The subset that must survive every later edit — a row's origin. */
export const AUDIT_IMMUTABLE = ['createdAt', 'createdBy'] as const;

/** The columns {@link Audited} adds. Used for typing, never constructed. */
export interface AuditFields {
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  updatedBy: string;
}

/**
 * Audit columns, opted into with `extends Audited()`.
 *
 * **Note the call.** This is a factory that returns a fresh base class, and that
 * is required for correctness rather than style. TC39 decorator metadata is
 * inherited through the prototype chain, so entities sharing one base class
 * mutate one metadata object: a second entity overwrote the first, one table
 * vanished, and its columns were merged into the other. Silent schema
 * corruption, invisible until a second entity exists.
 */
export function Audited(): new () => AuditFields {
  class AuditedBase {
    @date() createdAt!: Date;
    @text({ max: 320 }) createdBy!: string;
    @date() updatedAt!: Date;
    @text({ max: 320 }) updatedBy!: string;
  }
  return AuditedBase as unknown as new () => AuditFields;
}
