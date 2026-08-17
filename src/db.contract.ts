import { db, dynamic, type DynamicWrite, type Writable } from './db';

/**
 * Compile-time contract checks for the typed data API. Never imported at
 * runtime — `npm run check` (tsc) is what executes it, and a violated
 * expectation fails the build via `@ts-expect-error`.
 *
 * Without this file the repository's central claim — audit columns and the key
 * cannot be supplied or forged by a caller — would be enforced by types nobody
 * compiles against.
 *
 * The cases below deliberately go past an annotated object literal. An earlier
 * version of this file tested only literals, and excess-property checking made
 * that pass while the same forgery, put in a variable first, type-checked
 * clean — which is what every real caller does, since `importer.ts` and
 * `RowDialog.tsx` both build a payload before writing it.
 */

/** A well-formed create input: the caller's fields, nothing else. */
export const good: Writable<'Currency'> = {
  code: 'USD',
  name: 'United States Dollar',
  symbol: '$',
  decimalPlaces: 2,
  isActive: true,
};

// @ts-expect-error — audit columns are stamped from the session, never supplied.
export const forgedAudit: Writable<'Currency'> = { ...good, createdBy: 'mallory@contoso.com' };

// @ts-expect-error — the primary key is the server's to generate.
export const forgedKey: Writable<'Currency'> = { ...good, id: '00000000-0000-0000-0000-000000000000' };

// @ts-expect-error — only registered entities have repositories.
export const unknownEntity: Writable<'NoSuchEntity'> = {};

/** The shape a real caller builds: a variable, not a literal at the call site. */
const escaped = { ...good, createdBy: 'mallory@contoso.com' };

// @ts-expect-error — forgery must not survive being assigned to a variable first.
export const forgedViaVariable: Writable<'Currency'> = escaped;

// @ts-expect-error — nor survive crossing a function boundary.
void db.Currency.create(escaped);

// @ts-expect-error — nor reach the typed update path.
void db.Currency.update('some-id', escaped);

/**
 * The dynamic seam widens the ENTITY, not the field set. It is the only path
 * the running UI writes through, so a guarantee it does not carry is a
 * guarantee the app does not have.
 */
// @ts-expect-error — a forged audit column is refused through `dynamic()` too.
void dynamic('Currency').create(escaped);

// @ts-expect-error — and on update.
void dynamic('Currency').update('some-id', { updatedBy: 'mallory@contoso.com' });

/** What the UI legitimately passes: values derived from `view.editable`. */
export const dynamicOk: DynamicWrite = { code: 'AUD', name: 'Australian Dollar' };
