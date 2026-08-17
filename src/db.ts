import type { PrimaryKeyField } from '@microsoft/rayfin-core';

import { AUDIT_FIELDS, AUDIT_IMMUTABLE, type AuditFields } from '@app/shared';
import { entities, type EntityName, type AppSchema } from '@instance';
import { describeEntity } from './entity';
import { client } from './rayfin';

/**
 * The app's data access. **Every read and write goes through here.**
 *
 * Reading is ordinary. Writing stamps the audit columns from the current
 * session, because nothing server-side can: there are no triggers and no
 * deployable server code, so `createdAt`, `createdBy`, `updatedAt` and
 * `updatedBy` are the client's job on every write.
 *
 * Making that a property of the repository rather than a differently-named
 * function means a caller cannot forget it — `db.Currency.create({ … })` reads
 * like an ordinary create and is always stamped. The types then refuse the audit
 * fields as input, so they cannot be supplied or forged here either.
 */

export type Row = Record<string, unknown> & { id: string };

/** Rows per request, for the grid and for {@link Repository.all}. */
export const PAGE_SIZE = 100;

/**
 * The most rows {@link Repository.all} will fetch before refusing.
 *
 * It exists to bound a loop, not to express a policy: a lookup target with a
 * million rows would otherwise issue ten thousand requests while the tab sits
 * there. Reference data is bounded by definition, so this should never be
 * reached — and if it is, the fix is a searchable picker, not a bigger number.
 */
const MAX_ROWS = 2000;

/** What the caller may never supply: the server generates one, the app stamps the rest. */
type Forbidden = PrimaryKeyField | keyof AuditFields;

/**
 * Fields the caller owns: not the key (server-generated), not the audit columns.
 *
 * The `?: never` half is what makes the guarantee survive real code. A bare
 * `Omit` is an inexact type, so it rejects a forged column only through
 * excess-property checking — which applies to fresh object literals and
 * nothing else. Put the same object in a variable first, as every caller here
 * does, and the forgery type-checked cleanly.
 */
export type Writable<K extends EntityName> = Omit<AppSchema[K], Forbidden> & {
  [P in Forbidden]?: never;
};

/**
 * The open input the dynamic repository takes — widened over the ENTITY, which
 * is the widening the metadata-driven UI actually needs, while still refusing
 * the key and the audit columns. Those are separable, and conflating them is
 * what let the guarantee fall out of the only path the app ships.
 */
export type DynamicWrite = Record<string, unknown> & { [P in Forbidden]?: never };

/** One page of rows, and what it takes to ask for the next one. */
export interface Page {
  items: Row[];
  hasNextPage: boolean;
  /** Pass back as `after` to continue from here. */
  endCursor?: string;
}

/**
 * One page's worth of asking. `where` narrows server-side and `order`
 * overrides the entity's default (newest-first); both must stay identical
 * across the pages of one result set — the cursor walks a single ordered,
 * filtered list.
 */
export interface PageRequest {
  size: number;
  /** The previous page's `endCursor`, to continue from it. */
  after?: string;
  where?: Record<string, unknown>;
  order?: Record<string, 'asc' | 'desc'>;
}

export interface Repository<K extends EntityName> {
  page(fields: string[], request: PageRequest): Promise<Page>;
  /**
   * Every row, following the cursor to the end — throws, loudly, if the
   * table exceeds {@link MAX_ROWS}: a partial lookup list is wrong, not short.
   *
   * For lookups, where a partial list is not a shorter list but a wrong one: a
   * row pointing at the 101st currency would show a dash in the grid and be
   * unselectable in the form, with nothing to say why.
   */
  all(fields: string[]): Promise<Row[]>;
  /** Returns the created row — the bulk importer's rollback needs its id. */
  create(data: Writable<K>): Promise<Row>;
  update(id: string, data: Partial<Writable<K>>): Promise<void>;
  /**
   * Deleting a row that is referenced elsewhere fails with the database's
   * FK-constraint error; deleting one that no longer exists succeeds — DAB
   * treats an empty match as done, not as a failure.
   */
  delete(id: string): Promise<void>;
}

/**
 * The data-client surface used here, and the one place entity typing is widened.
 *
 * `client.data.<Entity>` is generic per entity, so indexing it with a *union* of
 * names yields a union of generic signatures that TypeScript cannot call. A
 * metadata-driven app is necessarily generic over entities, so the widening has
 * to happen somewhere; confining it to this file keeps everything else honestly
 * typed and states exactly what is relied on.
 */
interface Cursored {
  /** Continue after a cursor from an earlier page. */
  after(cursor: string): Cursored;
  executePaginated(): Promise<{ items: unknown[]; hasNextPage: boolean; endCursor?: string }>;
}

interface Chain {
  where(conditions: Record<string, unknown>): Chain;
  orderBy(order: Record<string, 'asc' | 'desc'>): Chain;
  first(n: number): Cursored;
}

interface DataClient {
  select(fields: string[]): Chain;
  create(input: Record<string, unknown>): Promise<unknown>;
  update(where: { id: string }, data: Record<string, unknown>): Promise<unknown>;
  delete(where: { id: string }): Promise<unknown>;
}

/**
 * The audit values for one write, restricted to the columns this entity
 * actually declares — an entity that never opted in gets nothing added, so the
 * same code path serves any backend.
 *
 * On create every column is set. On update the origin is left alone, so
 * `createdBy` still answers "who first added this row".
 */
function stamp(present: string[], isNew: boolean): Record<string, unknown> {
  if (present.length === 0) return {};
  const user = client.auth.getSession().user;
  if (!user) throw new Error('Cannot write while signed out.');
  const now = new Date();
  // Keyed positionally from AUDIT_FIELDS so stamping never hardcodes the four
  // names (hardcoding them here once made renames stamp nothing, silently).
  // A rename still reaches into entity.ts, whose provenance display finds the
  // audit columns by name pattern.
  const [createdAt, createdBy, updatedAt, updatedBy] = AUDIT_FIELDS;
  const all: Record<string, unknown> = {
    [createdAt]: now,
    [createdBy]: user.email,
    [updatedAt]: now,
    [updatedBy]: user.email,
  };
  const immutable: readonly string[] = AUDIT_IMMUTABLE;
  const applies = isNew ? present : present.filter((f) => !immutable.includes(f));
  return Object.fromEntries(applies.map((f) => [f, all[f]]));
}

function repository<K extends EntityName>(name: K): Repository<K> {
  const data = client.data[name] as unknown as DataClient;
  const view = describeEntity(name);

  const page: Repository<K>['page'] = async (fields, { size, after, where, order }) => {
    // `.execute()` would return one page and never signal that more exist.
    // The default order is derived from the entity — newest first when it has
    // a date, nothing rather than a guess when it does not. A stable order is
    // what makes the cursor meaningful, so it matters here twice over.
    const effective = order ?? view.orderBy;
    let chain = data.select(fields);
    if (where) chain = chain.where(where);
    if (effective) chain = chain.orderBy(effective);
    const first = chain.first(size);
    const result = await (after ? first.after(after) : first).executePaginated();
    return {
      items: result.items as Row[],
      hasNextPage: result.hasNextPage,
      endCursor: result.endCursor,
    };
  };

  return {
    page,

    async all(fields) {
      const rows: Row[] = [];
      const seen = new Set<string>();
      let cursor: string | undefined;
      do {
        const result = await page(fields, { size: PAGE_SIZE, after: cursor });
        // A page that repeats what the last one gave means the keyset predicate
        // could not separate two rows — a non-unique sort key. Left undetected
        // this loops to the cap and then blames the table's size, which sends
        // the reader to raise MAX_ROWS and make it slower.
        if (result.items.length && result.items.every((r) => seen.has((r as Row).id))) {
          throw new Error(
            `${name}: the cursor stopped advancing — the sort order is not unique. ` +
              `Every page repeated rows already fetched.`
          );
        }
        for (const r of result.items) seen.add((r as Row).id);
        // Respect the cap exactly: a full page pushed past it would return up
        // to a page more than MAX_ROWS promises.
        rows.push(...result.items.slice(0, MAX_ROWS - rows.length));
        // A page claiming a successor but supplying no cursor would restart
        // from the beginning and loop forever, so treat it as the end.
        cursor = result.hasNextPage ? result.endCursor : undefined;
      } while (cursor && rows.length < MAX_ROWS);
      // Truncating silently would make every lookup past the cap a dash in
      // the grid and unselectable in the form — a partial list is not a
      // shorter list but a wrong one (the reason this method exists). Loud
      // beats wrong: fail with the reason and the options.
      if (cursor) {
        throw new Error(
          `${name} has more than ${MAX_ROWS} rows — too many for a full lookup fetch. ` +
            `Raise MAX_ROWS in src/db.ts, or give this relationship a searchable picker.`
        );
      }
      return rows;
    },

    async create(input) {
      return (await data.create({
        ...(input as Record<string, unknown>),
        ...stamp(view.audit, true),
      })) as Row;
    },

    async update(id, input) {
      // The origin fields are absent by type here, and each entity's
      // `@authenticated('update', { exclude: [...AUDIT_IMMUTABLE] })` makes the
      // server reject them too — so a row's origin survives every later edit.
      await data.update(
        { id },
        { ...(input as Record<string, unknown>), ...stamp(view.audit, false) }
      );
    },

    async delete(id) {
      await data.delete({ id });
    },
  };
}

/**
 * Every registered entity, ready to use: `db.Currency.create({ … })`.
 *
 * Built from the registry, so a newly registered entity appears here with no
 * further edit.
 */
export const db = Object.fromEntries(
  (Object.keys(entities) as EntityName[]).map((name) => [name, repository(name)])
) as { [K in EntityName]: Repository<K> };

/**
 * A repository for an entity known only at runtime.
 *
 * The metadata-driven UI picks a table from the registry, so it cannot name a
 * type — and `db[someName]` is a *union* of repositories, whose `create` methods
 * TypeScript will not call. Rather than scatter casts at the call sites, the
 * looser contract lives here and says plainly what it gives up: the input is an
 * open record, checked at runtime by the entity's own validator instead.
 *
 * Code that knows its entity should use `db.Currency.create({ … })` and keep
 * full type checking.
 */
export interface DynamicRepository {
  page(fields: string[], request: PageRequest): Promise<Page>;
  all(fields: string[]): Promise<Row[]>;
  create(data: DynamicWrite): Promise<Row>;
  update(id: string, data: DynamicWrite): Promise<void>;
  delete(id: string): Promise<void>;
}

export const dynamic = (name: EntityName): DynamicRepository =>
  db[name] as unknown as DynamicRepository;

/**
 * Strip transport noise from a failure before showing it to a person.
 *
 * The SDK surfaces DAB problems as "GraphQL errors: A record with the same
 * unique value already exists." The second half is useful; the first is an
 * implementation detail nobody can act on.
 */
export function readable(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const message = raw
    .replace(/^\s*(GraphQL errors?|Error)\s*:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Writing to a row someone else deleted is the one failure a person meets
  // by accident rather than by mistake, and the platform reports it as
  // "Could not find item with <id: 8899a831-…>" — an internal sentence and a
  // UUID, neither of which says what happened or what to do about it.
  return /could not find item/i.test(message)
    ? 'This row no longer exists — someone else deleted it. Close and reload to see the current data.'
    : message;
}
