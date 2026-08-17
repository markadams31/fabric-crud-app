import {
  getFieldConstraints,
  getPrimaryKeyField,
  RayfinEntity,
  toStandardSchema,
  type EntityClass,
  type FieldConstraints,
} from '@microsoft/rayfin-core';

import { AUDIT_FIELDS } from '@app/shared';
import { entities, type EntityName } from '@instance';

/**
 * Describe an entity from its own decorator metadata.
 *
 * The UI names no entity, no field, no column heading and no validation rule.
 * Everything below is derived, so the same interface works against any Rayfin
 * backend — including entities that carry no audit columns at all.
 */

/** `'id'`, read from metadata here — though `Row` and the grid glue still assume it. */
export const PRIMARY_KEY: string = getPrimaryKeyField();

/** The shape a lookup row needs for display — `db.ts`'s `Row`, minus the dependency. */
type LookupRow = Record<string, unknown> & { id: string };

export interface FieldView {
  name: string;
  /** `createdBy` → `Created by`. */
  label: string;
  constraints: FieldConstraints;
  /** Stamped by the app on write, so not the user's to type. */
  isAudit: boolean;
  /** Declared `unique: true` — the importer pre-checks these. */
  unique: boolean;
  /**
   * The column's declared default, when it has one. The SDK's constraint
   * objects drop it, so it is read from the raw metadata: a create form that
   * ignores it shows a blank where the schema promised a value — and, for a
   * boolean, shows the opposite of what the write will store.
   */
  defaultValue?: unknown;
  /**
   * Set when this column is a foreign key: the entity it points at, and the
   * columns worth showing a person instead of a UUID.
   */
  lookup?: { entity: EntityName; display: string[] };
}

export interface EntityView {
  /** Registry key, which is also the key into `client.data`. */
  name: EntityName;
  /** `UnitOfMeasure` → `Unit of measure`, for anything a person reads. */
  title: string;
  /** Every readable field, in display order — also the `select()` list. */
  fields: FieldView[];
  /** What a person may type: no key, no audit columns, no relationships. */
  editable: FieldView[];
  /** The audit columns this entity actually has. May be empty. */
  audit: string[];
  /** The entity's own columns — what the table shows. */
  columns: FieldView[];
  /**
   * The write actions the entity's own decorators grant, so the UI offers
   * only what the API will accept. Without this a read-only entity still drew
   * New, Edit and Delete, and the save failed with "The field
   * `updateCurrency` does not exist on the type `Mutation`" — a sentence about
   * a GraphQL schema, shown to someone maintaining reference data.
   */
  can: { create: boolean; update: boolean; delete: boolean };
  /**
   * What a person may supply on a NEW row. Narrower than {@link editable} when
   * a role restricts `create` — a fork can lock a column that only a pipeline
   * should ever set.
   */
  creatable: FieldView[];
  /**
   * What a person may change on a row that already exists. Narrower than
   * {@link editable} when a role restricts `update`: the sample locks the
   * immutable audit columns that way, and a fork can lock a business key the
   * same way. Offering a field the update role excludes means a form that
   * saves nothing and an import that fails on a column it was handed.
   */
  updatable: FieldView[];
  /** Who last touched a row, when the entity records it. */
  lastChanged?: { by?: string; at?: string };
  /** Who first added a row, when the entity records it. */
  firstAdded?: { by?: string; at?: string };
  /**
   * The default order: newest-first when the entity has a date to sort by,
   * always ending in the primary key. Never absent — a cursor walk needs a
   * total order, and the key is the only column guaranteed to provide one.
   */
  orderBy: Record<string, 'asc' | 'desc'>;
  /**
   * Validates the editable fields against the entity's own constraints.
   *
   * `path` is Standard Schema's, whose segments may be keys or objects with a
   * `key`; validate.ts normalises it into per-field messages.
   */
  validate: (input: unknown) => {
    issues?: readonly { message: string; path?: readonly unknown[] }[];
  };
}

/**
 * `UnitOfMeasure` → `Unit of measure`, `createdBy` → `Created by`,
 * `currency_id` → `Currency`. Sentence case: only the first word is
 * capitalised, so multi-word names read as prose rather than a class name.
 */
const labelFor = (name: string, isForeignKey = false) =>
  name
    // A foreign key reads as the thing it points at, not as a key — but ONLY
    // a real foreign key. A plain field that happens to end in `_id` (an
    // external-system reference, say) keeps its suffix, or its label, its CSV
    // header and its validation messages would all disagree about its name.
    .replace(isForeignKey ? /_id$/i : /$^/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/\s+/)
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w.toLowerCase()))
    .join(' ');

/** Describe one registered entity. */
export function describeEntity(name: EntityName): EntityView {
  const entity = entities[name];
  // Reads as "Cannot read properties of undefined" three frames down otherwise,
  // which says nothing about the actual mistake: a name that this instance does
  // not register. Easy to hit when several instances register different tables.
  if (!entity) {
    throw new Error(
      `"${String(name)}" is not registered in this instance — it lists ` +
        `${Object.keys(entities).join(', ') || 'nothing'}.`
    );
  }
  // Typed as an open record so field names are plain strings; the per-entity
  // types come back through `AppSchema` at the call sites.
  return describeEntityClass(entity as unknown as EntityClass<Record<string, unknown>>, name);
}

/**
 * The derivation itself, over a class rather than a registry key.
 *
 * Exported for tests: this is where the fork promise is actually kept or
 * broken — the guards, the ordering, the grants, the labels — and taking only
 * a registry key meant it could never be run against a schema the samples do
 * not have. Application code should call {@link describeEntity}.
 */
export function describeEntityClass(
  entity: EntityClass<Record<string, unknown>>,
  /**
   * Plain `string`, not `EntityName`: the whole point of this seam is running
   * against schemas the active instance does not register — its own tests, and
   * every other instance's entities. Typing it to the active registry made the
   * seam unusable for the job it exists to do.
   */
  name: string
): EntityView {
  // A raw metadata read, deliberately: the SDK's `getEntityMetadata()` is
  // marked @internal and *creates* metadata when missing, so on a class that
  // is not an entity it would silently mint an empty one instead of failing.
  const meta = entity[Symbol.metadata]?.[RayfinEntity];
  if (!meta) throw new Error(`${String(name)} is not a Rayfin @entity() class.`);

  const present = Object.keys(meta.fields);
  const lookups = foreignKeys(meta.fields);
  // A @one relationship only reaches the UI through its foreign-key COLUMN,
  // and the SDK does not add that column to the metadata by itself — the
  // sample entities declare it explicitly. Undeclared, the relationship would
  // silently have no grid column, no form picker and no CSV template column,
  // and a required FK would make the entity un-creatable with no error. Fail
  // at describe-time instead, with the fix in the message.
  for (const fk of Object.keys(lookups)) {
    if (!present.includes(fk)) {
      throw new Error(
        `${String(name)} has a @one relationship but does not declare its ${fk} column. ` +
          `Add "@uuid() ${fk}!: string;" beside the relationship field.`
      );
    }
  }
  // `Row`, the grid's `getRowId`, and every update/delete signature assume this
  // column exists. The SDK's deploy-time analyzer injects one when it is
  // missing, so the database works while the UI silently does not: identical
  // React keys, Edit opening the wrong row, delete sent with `undefined`.
  // Fail here instead, with the fix in the message — same shape as the
  // relationship guard above.
  if (!present.includes(PRIMARY_KEY)) {
    throw new Error(
      `${String(name)} does not declare its ${PRIMARY_KEY} column. ` +
        `Add "@uuid() ${PRIMARY_KEY}!: string;" as its first field.`
    );
  }
  // Only the audit columns this entity really declares — an entity that never
  // opted in simply has none, and everything below still works.
  const audit = AUDIT_FIELDS.filter((f) => present.includes(f));

  const fields: FieldView[] = present
    .map((field): FieldView | null => {
      const constraints = getFieldConstraints(entity, field);
      // Relationship navigations are not columns and cannot be typed into a
      // form — their foreign key is, and it carries the lookup. A field with no
      // readable constraints is not renderable either.
      if (!constraints || constraints.type === 'relationship') return null;
      return {
        name: field,
        label: labelFor(field, Boolean(lookups[field])),
        constraints,
        isAudit: (audit as string[]).includes(field),
        unique: Boolean(meta.fields[field]?.isUnique),
        defaultValue: meta.fields[field]?.default,
        lookup: lookups[field],
      };
    })
    .filter((f): f is FieldView => f !== null)
    // Inherited fields arrive first through the prototype chain, which would put
    // the audit columns ahead of the data they describe.
    .sort((a, b) => Number(a.isAudit) - Number(b.isAudit));

  // The same set today, kept as two names because they answer different
  // questions — what the grid shows, and what a person may type — and a
  // read-only-but-visible field would legitimately split them.
  const own = fields.filter((f) => f.name !== PRIMARY_KEY && !f.isAudit);

  return {
    name: name as EntityName,
    title: labelFor(name),
    fields,
    editable: own,
    creatable: permittedFields(own, meta.roles, 'create'),
    updatable: permittedFields(own, meta.roles, 'update'),
    audit,
    columns: own,
    can: grantedWrites(meta.roles),
    lastChanged: pick(audit, 'updated'),
    firstAdded: pick(audit, 'created'),
    orderBy: newestFirst(fields),
    // The key is dropped by toStandardSchema itself; audit columns are stamped
    // from the session, so neither is the caller's to supply.
    validate: toStandardSchema(entity, { omit: audit }).validate,
  };
}

/**
 * The fields a write grant actually permits, unioned across the roles that
 * grant that action. `includedFields` is an allow-list — anything unlisted is
 * excluded — and `excludedFields` a deny-list. No role granting the action at
 * all means no restriction to apply, matching the platform's fail-open default.
 *
 * Both actions, not just update: a create grant can restrict fields the same
 * way, and honouring only one produced exactly the failure the action-level
 * `can` was built to prevent — a form offering a column whose write the API
 * then refuses.
 */
function permittedFields(
  fields: FieldView[],
  roles: readonly { actions?: readonly string[]; includedFields?: readonly string[]; excludedFields?: readonly string[] }[] | undefined,
  action: 'create' | 'update'
): FieldView[] {
  const granting = (roles ?? []).filter((r) =>
    (r.actions ?? []).some((a) => a === action || a === '*')
  );
  if (!granting.length) return fields;
  const allowed = new Set<string>();
  for (const role of granting) {
    for (const f of fields) {
      const included = role.includedFields ? role.includedFields.includes(f.name) : true;
      if (included && !(role.excludedFields ?? []).includes(f.name)) allowed.add(f.name);
    }
  }
  return fields.filter((f) => allowed.has(f.name));
}

/**
 * Which write actions the decorators grant, unioned across declared roles.
 *
 * The union is right for this app because the session is always signed in and
 * Rayfin has exactly two roles: a grant to either is reachable here. An entity
 * with no permission decorator at all gets everything, because that is what
 * the platform does — it fails open, injecting full CRUD (`instances.test.ts`
 * fails the build on one, so it should never arrive, but the UI should not
 * claim a restriction the API is not enforcing).
 */
function grantedWrites(
  roles: readonly { actions?: readonly string[] }[] | undefined
): EntityView['can'] {
  if (!roles?.length) return { create: true, update: true, delete: true };
  const granted = new Set(roles.flatMap((r) => r.actions ?? []));
  const may = (action: string) => granted.has('*') || granted.has(action);
  return { create: may('create'), update: may('update'), delete: may('delete') };
}

/**
 * Map each foreign-key column to the entity it points at.
 *
 * `@one(() => Currency) currency` generates a `currency_id` column, and the
 * relationship's `target` is a lazy `() => Currency`. Resolving it turns a UUID
 * box into a list of real records, which is the difference between a form a
 * person can fill in and one they cannot.
 */
function foreignKeys(
  fields: Record<string, unknown>
): Record<string, { entity: EntityName; display: string[] }> {
  const out: Record<string, { entity: EntityName; display: string[] }> = {};
  for (const [field, meta] of Object.entries(fields)) {
    const rel = (meta as { relationship?: { target?: () => unknown; type?: string } }).relationship;
    if (rel?.type !== 'one' || typeof rel.target !== 'function') continue;

    const target = rel.target() as EntityClass<Record<string, unknown>>;
    const name = target?.[Symbol.metadata]?.[RayfinEntity]?.name as EntityName | undefined;
    // Only entities this app registered can be listed; anything else has no
    // client to read it with.
    if (!name || !(name in entities)) continue;

    out[`${field}_${PRIMARY_KEY}`] = { entity: name, display: displayFields(target) };
  }
  return out;
}

/**
 * The columns that identify a record to a person. Prefers a short code and a
 * name, which is what reference data almost always has, and otherwise falls
 * back to the first readable text column.
 */
function displayFields(entity: EntityClass<Record<string, unknown>>): string[] {
  const meta = entity[Symbol.metadata]?.[RayfinEntity];
  const names = Object.keys(meta?.fields ?? {}).filter((f) => {
    if (f === PRIMARY_KEY || (AUDIT_FIELDS as readonly string[]).includes(f)) return false;
    const c = getFieldConstraints(entity, f);
    return c?.type === 'string' || c?.type === 'enum';
  });
  const preferred = names.filter((n) => /^(code|name|title|label)$/i.test(n));
  // A target with no text or enum column at all (keyed numerically, say) still
  // needs SOME identity in pickers and cells — the primary key is ugly but
  // honest, and beats a list of blank, indistinguishable options.
  if (!names.length) return [PRIMARY_KEY];
  return (preferred.length ? preferred : names.slice(0, 1)).slice(0, 2);
}

/** The by/at pair for one half of the audit contract, if the entity has it. */
function pick(audit: string[], prefix: string) {
  const by = audit.find((f) => f.startsWith(prefix) && /by$/i.test(f));
  const at = audit.find((f) => f.startsWith(prefix) && /at$/i.test(f));
  return by || at ? { by, at } : undefined;
}

/**
 * Sort newest first when the entity gives us a way to. Prefers a creation
 * timestamp, falls back to any date field, and gives up rather than guessing —
 * an entity with no date is returned in whatever order the API supplies.
 */
function newestFirst(fields: FieldView[]): Record<string, 'asc' | 'desc'> {
  const dates = fields.filter((f) => f.constraints.type === 'date');
  const chosen = dates.find((f) => f.isAudit && /created/i.test(f.name)) ?? dates[0];
  // The key tiebreak is not decoration: a cursor needs a TOTAL order, and a
  // date column is not one — `scripts/seed.mjs` stamps every row from a single
  // `new Date()`, so a seeded table can tie on this key from end to end. The
  // user-sort path in EntityPage has always added it; the default did not, and
  // the default is what the first page, every `Load more` before a header
  // click, and every `all()` lookup walk use.
  return chosen ? { [chosen.name]: 'desc', [PRIMARY_KEY]: 'asc' } : { [PRIMARY_KEY]: 'asc' };
}

/** A record as a person recognises it — "AUD · Australian Dollar", not a UUID. */
export function describeRow(row: LookupRow | undefined, field: FieldView): string {
  if (!row) return '';
  const parts = (field.lookup?.display ?? [])
    .map((f) => row[f])
    .filter((v) => v !== null && v !== undefined && v !== '')
    .map(String);
  return parts.join(' · ') || String(row.id);
}

/** Every registered entity, described. */
export const allEntities = (): EntityView[] =>
  (Object.keys(entities) as EntityName[]).map(describeEntity);

/**
 * The server-side filter for a search box, from the entity's own fields.
 *
 * Searches every human-readable text column — strings that are not keys, plus
 * enums — with a case-insensitive `contains`, OR-ed together. Audit columns are
 * excluded: "who edited this" is what the provenance column is for, and a
 * search for "an" matching half the emails in `updatedBy` reads as broken.
 *
 * Returns `undefined` when there is nothing to search, so the box can be
 * withheld rather than shown dead.
 */
export function searchFilter(
  view: EntityView,
  query: string
): Record<string, unknown> | undefined {
  const q = query.trim();
  const targets = view.fields.filter(
    (f) =>
      !f.isAudit &&
      !f.lookup &&
      ((f.constraints.type === 'string' && f.constraints.format !== 'uuid') ||
        f.constraints.type === 'enum')
  );
  if (!targets.length || !q) return undefined;
  return { or: targets.map((f) => ({ [f.name]: { contains: q } })) };
}

/** Whether {@link searchFilter} would ever return anything for this entity. */
export const isSearchable = (view: EntityView): boolean =>
  searchFilter(view, 'x') !== undefined;

/**
 * The columns worth offering as facets: those whose values are a closed set.
 *
 * Enums, booleans and foreign keys. A free-text column has as many values as
 * it has rows, so a checkbox list of them is a worse search box, and ordered
 * columns get {@link rangeFacets} instead.
 *
 * A foreign key qualifies because its options are already loaded for the form,
 * and because the filter needs no relationship traversal: the FK column is an
 * ordinary uuid column, so `{ currency_id: { in: [...] } }` answers it — same
 * result as filtering through the relationship, verified against the running
 * backend, without the join.
 */
export function facets(view: EntityView): FieldView[] {
  return view.columns.filter(
    (f) => f.lookup || f.constraints.type === 'enum' || f.constraints.type === 'boolean'
  );
}

/**
 * The columns worth offering as a RANGE rather than a list: dates and numbers.
 *
 * A closed set gets checkboxes ({@link facets}); an ordered one gets two bounds.
 * Listing every distinct population would be a worse search box, but "between
 * 5M and 70M" is exactly what someone wants — and the server can answer it:
 * `gte`/`lte` are DAB operators, verified against the running backend on dates
 * and numbers alike, so the filtering happens in the database and not over a
 * page of loaded rows.
 */
export function rangeFacets(view: EntityView): FieldView[] {
  return view.columns.filter(
    (f) => !f.lookup && (f.constraints.type === 'date' || f.constraints.type === 'number')
  );
}

/** One range facet's bounds, as the strings its inputs hold. */
export interface RangeBounds {
  from?: string;
  to?: string;
}

/**
 * A bound as the API wants it: a `Date` for date columns, a number for numeric
 * ones. Returns undefined for anything unparseable, so a half-typed bound
 * filters nothing rather than filtering wrongly.
 */
function bound(field: FieldView, raw: string | undefined): unknown {
  const value = (raw ?? '').trim();
  if (!value) return undefined;
  if (field.constraints.type === 'date') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? undefined : d;
  }
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Which values a facet offers, as `[value, label]` pairs.
 *
 * A foreign key's values are the target's ids and its labels are the rows a
 * person recognises, so it needs those rows passed in — the caller already
 * holds them for the form's dropdown, and this deliberately does not fetch.
 */
export function facetOptions(field: FieldView, rows?: LookupRow[]): [string, string][] {
  if (field.lookup) {
    return (rows ?? [])
      .map((r): [string, string] => [String(r.id), describeRow(r, field)])
      .sort((a, b) => a[1].localeCompare(b[1]));
  }
  const c = field.constraints;
  if (c.type === 'enum') return c.values.map((v) => [v, v]);
  // A boolean's third state is only reachable when the column is nullable, and
  // the grid renders it as an em-dash — so it is offered under that name.
  return c.optional
    ? [
        ['true', 'Yes'],
        ['false', 'No'],
        ['', 'Not set'],
      ]
    : [
        ['true', 'Yes'],
        ['false', 'No'],
      ];
}

/**
 * Combine the search box and the chosen facets into one server-side filter.
 *
 * Facets AND together (region Europe AND active) while the values inside one
 * facet OR (Europe or Africa), which is what a person means by ticking two
 * boxes in the same group. `in` is DAB's own operator — verified against the
 * running server, not assumed from the type.
 */
export function rowFilter(
  view: EntityView,
  query: string,
  chosen: Record<string, string[]>,
  ranges: Record<string, RangeBounds> = {}
): Record<string, unknown> | undefined {
  const clauses: Record<string, unknown>[] = [];
  const search = searchFilter(view, query);
  if (search) clauses.push(search);

  for (const f of facets(view)) {
    const picked = chosen[f.name];
    if (!picked?.length) continue;
    if (f.constraints.type === 'boolean') {
      const values = picked.filter((v) => v !== '').map((v) => v === 'true');
      const wantsNull = picked.includes('');
      const parts: Record<string, unknown>[] = [];
      if (values.length) parts.push({ [f.name]: { in: values } });
      if (wantsNull) parts.push({ [f.name]: { isNull: true } });
      clauses.push(parts.length === 1 ? parts[0] : { or: parts });
    } else {
      // Also the foreign-key case: `picked` holds target ids, and the FK column
      // is a plain uuid column, so `in` needs no relationship traversal.
      clauses.push({ [f.name]: { in: picked } });
    }
  }
  for (const f of rangeFacets(view)) {
    const from = bound(f, ranges[f.name]?.from);
    const to = bound(f, ranges[f.name]?.to);
    // Both bounds in ONE clause: `{ gte, lte }` on a single field is a range,
    // where two separate clauses would still AND correctly but read as two
    // filters in the chips and cost an extra predicate.
    const range = { ...(from !== undefined && { gte: from }), ...(to !== undefined && { lte: to }) };
    if (Object.keys(range).length) clauses.push({ [f.name]: range });
  }
  if (!clauses.length) return undefined;
  return clauses.length === 1 ? clauses[0] : { and: clauses };
}
