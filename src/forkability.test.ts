import { describe, expect, it } from 'vitest';

import { analyzeImport, isImportable } from './importer';
import {
  facetOptions,
  facets,
  rangeFacets,
  rowFilter,
  searchFilter,
  isSearchable,
  type EntityView,
  type FieldView,
} from './entity';
import { validateDraft } from './validate';

/**
 * The fork contract, tested with hostile schemas.
 *
 * This repo's promise is that src/ works against ANY schema a forker writes —
 * but the sample entities are friendly: every table has a unique code, text
 * columns to search, audit fields. Each test here builds a synthetic
 * EntityView the samples would never produce and pins how the generic code
 * behaves against it, because every shape below was (or plausibly is) a
 * latent bug the friendly samples could not surface.
 *
 * These views are hand-built plain objects, not registry entities, so this
 * file stays fork-safe: delete the sample schema and it still runs.
 */

const field = (name: string, constraints: Record<string, unknown>, unique = false): FieldView => ({
  name,
  label: name[0].toUpperCase() + name.slice(1),
  constraints: constraints as unknown as FieldView['constraints'],
  isAudit: false,
  unique,
});

const view = (fields: FieldView[]): EntityView => ({
  name: 'Synthetic' as EntityView['name'],
  title: 'Synthetic',
  fields,
  editable: fields,
  creatable: fields,
  updatable: fields,
  audit: [],
  columns: fields,
  can: { create: true, update: true, delete: true },
  orderBy: { id: 'asc' },
  // The SDK validator is not under test here; these gates are validate.ts's own.
  validate: () => ({}),
});

describe('an entity with no unique field', () => {
  const v = view([
    field('label', { type: 'string', max: 50 }),
    field('amount', { type: 'number' }),
  ]);
  const parsed = {
    headers: ['label', 'amount'],
    problems: [],
    records: [{ label: 'existing row', amount: '1' }],
  };
  const existing = [{ id: 'row-1', label: 'existing row', amount: 1 }];

  it('has no business key, so identical rows still classify as create', () => {
    const a = analyzeImport(v, parsed, {}, existing);
    expect(a.keyField).toBeUndefined();
    // This is the behaviour the import dialog warns about: without a key,
    // re-importing a file duplicates it. The warning only renders when
    // keyField is undefined — this pin is what keeps that contract honest.
    expect(a.rows[0].op).toBe('create');
    expect(isImportable(a)).toBe(true);
  });
});

describe('an entity with nothing searchable', () => {
  const v = view([
    field('year', { type: 'number' }),
    field('active', { type: 'boolean' }),
    field('openedOn', { type: 'date' }),
  ]);

  it('withholds the search box instead of rendering a dead one', () => {
    expect(searchFilter(v, 'anything')).toBeUndefined();
    expect(isSearchable(v)).toBe(false);
  });
});

describe('decimal input that is not plain notation', () => {
  const v = view([field('factor', { type: 'number', scale: 3 })]);

  it.each([
    ['1.23E-07', 'scientific notation (Excel writes this to CSV)'],
    ['1e5', 'scientific notation, lower case'],
    ['.575', 'bare fraction'],
  ])('rejects %s (%s) instead of counting zero decimals', (value) => {
    const { errors } = validateDraft(v, { factor: value });
    expect(errors.factor).toMatch(/plain decimal/);
  });

  it('rejects more significant digits than a double can carry', () => {
    const { errors } = validateDraft(v, { factor: '123456789123456.7' });
    expect(errors.factor).toMatch(/digits/);
  });

  it('still accepts a value at the declared scale', () => {
    const { input, errors } = validateDraft(v, { factor: '0.125' });
    expect(errors).toEqual({});
    expect(input.factor).toBe(0.125);
  });
});

describe('optional boolean blanks', () => {
  const v = view([
    field('verified', { type: 'boolean', optional: true }),
    field('active', { type: 'boolean' }),
  ]);

  it('optional blank is null (the third answer), required blank defers to the default', () => {
    const { input, errors } = validateDraft(v, { verified: '', active: '' });
    expect(errors).toEqual({});
    expect(input.verified).toBeNull();
    expect(input.active).toBeUndefined();
  });
});

describe('an entity whose update grant locks a column', () => {
  // A business key immutable after creation — `@authenticated('update',
  // { exclude: ['code'] })` — which is a normal reference-data shape and the
  // one the sample never exercises, since its only exclusions are audit
  // columns the form does not offer anyway.
  const code = field('code', { type: 'string', max: 10 }, true);
  const label = field('label', { type: 'string', max: 50 });
  const v: EntityView = { ...view([code, label]), updatable: [label] };
  const existing = [{ id: 'row-1', code: 'AAA', label: 'Original' }];
  const parsed = (rows: string[]) => ({
    headers: ['code', 'label'],
    problems: [],
    records: rows.map((r) => ({ code: r.split(',')[0], label: r.split(',')[1] })),
  });

  it('updates the columns it may and never writes the locked one', () => {
    const a = analyzeImport(v, parsed(['AAA,Renamed']), {}, existing);
    expect(a.rows[0].op).toBe('update');
    expect('code' in a.rows[0].input, 'a locked column must not be written').toBe(false);
    expect(a.rows[0].input.label).toBe('Renamed');
  });

  it('a file changing only the locked column has nothing to do', () => {
    // The key still has to match its row, so the column must be readable
    // without being writable — otherwise the row could not be found at all.
    const a = analyzeImport(v, parsed(['AAA,Original']), {}, existing);
    expect(a.rows[0].op).toBe('skip');
    expect(isImportable(a)).toBe(false);
  });
});

describe('an entity whose CREATE grant locks a column', () => {
  // The mirror of the update case above, and the one the sample never
  // exercises: a column only a pipeline should ever set.
  const code = field('code', { type: 'string', max: 10 }, true);
  const owner = field('owner', { type: 'string', max: 50 });
  const v: EntityView = { ...view([code, owner]), creatable: [code] };
  const parsed = {
    headers: ['code', 'owner'],
    problems: [],
    records: [{ code: 'NEW', owner: 'someone@contoso.com' }],
  };

  it('creates without the locked column instead of failing on it', () => {
    const a = analyzeImport(v, parsed, {}, []);
    expect(a.rows[0].op).toBe('create');
    expect('owner' in a.rows[0].input, 'a create-locked column must not be written').toBe(false);
    expect(a.rows[0].input.code).toBe('NEW');
  });
});

describe('range facets', () => {
  const dated = view([field('opened', { type: 'date' }), field('size', { type: 'number' })]);

  it('offers ordered columns as ranges, not as checkbox lists', () => {
    expect(rangeFacets(dated).map((f) => f.name)).toEqual(['opened', 'size']);
  });

  it('sends one clause per column, with only the bounds that were given', () => {
    expect(rowFilter(dated, '', {}, { size: { from: '5' } })).toEqual({ size: { gte: 5 } });
    expect(rowFilter(dated, '', {}, { size: { from: '5', to: '9' } })).toEqual({
      size: { gte: 5, lte: 9 },
    });
    expect(rowFilter(dated, '', {}, { size: { to: '9' } })).toEqual({ size: { lte: 9 } });
  });

  it('ignores a blank or half-typed bound rather than filtering wrongly', () => {
    // A partially typed number must not become NaN and match nothing.
    expect(rowFilter(dated, '', {}, { size: { from: '' } })).toBeUndefined();
    expect(rowFilter(dated, '', {}, { size: { from: '-' } })).toBeUndefined();
    expect(rowFilter(dated, '', {}, { opened: { from: 'not a date' } })).toBeUndefined();
  });

  it('sends dates as Date objects, which is what the operators take', () => {
    const f = rowFilter(dated, '', {}, { opened: { from: '2023-01-01' } }) as {
      opened: { gte: Date };
    };
    expect(f.opened.gte).toBeInstanceOf(Date);
    expect(f.opened.gte.toISOString().slice(0, 10)).toBe('2023-01-01');
  });
});

describe('lookup facets', () => {
  const fk: FieldView = {
    ...field('currency_id', { type: 'string', format: 'uuid' }),
    label: 'Currency',
    lookup: { entity: 'Currency' as never, display: ['code', 'name'] },
  };
  const withFk = view([fk]);

  it('offers a foreign key as a facet', () => {
    expect(facets(withFk).map((f) => f.name)).toEqual(['currency_id']);
  });

  it('labels the options with what a person recognises, sorted', () => {
    const rows = [
      { id: 'b', code: 'GBP', name: 'Pound Sterling' },
      { id: 'a', code: 'AUD', name: 'Australian Dollar' },
    ];
    expect(facetOptions(fk, rows)).toEqual([
      ['a', 'AUD · Australian Dollar'],
      ['b', 'GBP · Pound Sterling'],
    ]);
  });

  it('offers nothing rather than throwing before the lookup rows arrive', () => {
    expect(facetOptions(fk)).toEqual([]);
  });

  it('filters on the FK column itself, needing no relationship traversal', () => {
    expect(rowFilter(withFk, '', { currency_id: ['a', 'b'] })).toEqual({
      currency_id: { in: ['a', 'b'] },
    });
  });
});
