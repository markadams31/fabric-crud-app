import { describe, expect, it } from 'vitest';

import { analyzeImport, isImportable, parseCsv } from './importer';
import { reference } from './reference.fixture';
import { validateDraft } from './validate';

/**
 * The fuzzy-data rules, each of which exists because the permissive version
 * was observed importing wrong data without complaint: "TRUE" as false,
 * "01/02/2024" as January 2nd, Excel's 45306 as the year 45306, and the
 * impossible 2024-02-30 as March 1st.
 */

const currency = reference('Currency');
const costCentre = reference('CostCentre');

const currencyDraft = (over: Record<string, string>) => ({
  code: 'ZZZ',
  name: 'Probe',
  symbol: '',
  decimalPlaces: '2',
  isActive: 'true',
  ...over,
});
const costCentreDraft = (over: Record<string, string>) => ({
  code: 'CC9999',
  name: 'Probe',
  owner: 'probe@contoso.com',
  openedOn: '2024-01-15',
  closedOn: '',
  annualBudget: '',
  ...over,
});

describe('boolean cells', () => {
  it.each(['true', 'TRUE', 'Yes', 'y', '1'])('"%s" means true', (v) => {
    const { input, errors } = validateDraft(currency, currencyDraft({ isActive: v }));
    expect(errors).toEqual({});
    expect(input.isActive).toBe(true);
  });

  it.each(['false', 'FALSE', 'No', 'n', '0'])('"%s" means false', (v) => {
    const { input, errors } = validateDraft(currency, currencyDraft({ isActive: v }));
    expect(errors).toEqual({});
    expect(input.isActive).toBe(false);
  });

  it('rejects what it cannot read instead of guessing false', () => {
    const { errors } = validateDraft(currency, currencyDraft({ isActive: 'banana' }));
    expect(errors.isActive).toBeTruthy();
  });

  it('a blank cell defers to the column default', () => {
    const { input, errors } = validateDraft(currency, currencyDraft({ isActive: '' }));
    expect(errors).toEqual({});
    expect(input.isActive).toBeUndefined();
  });
});

describe('date cells', () => {
  it('accepts a padded, real ISO date', () => {
    expect(validateDraft(costCentre, costCentreDraft({})).errors).toEqual({});
  });

  it.each([
    ['01/02/2024', 'ambiguous slash format'],
    ['45306', 'an Excel serial'],
    ['2024-02-30', 'an impossible date'],
    ['2024-1-5', 'unpadded parts'],
    ['Jan 15 2024', 'prose'],
  ])('rejects %s (%s)', (value) => {
    const { errors } = validateDraft(costCentre, costCentreDraft({ openedOn: value }));
    expect(errors.openedOn).toMatch(/YYYY-MM-DD/);
  });

  it('a blank optional date stays clear', () => {
    expect(validateDraft(costCentre, costCentreDraft({ closedOn: '' })).errors).toEqual({});
  });
});

describe('create / update / skip classification', () => {
  const existing = [
    { id: 'id-1', code: 'AAA', name: 'Alpha', symbol: null, decimalPlaces: 2, isActive: true },
  ];
  const parsed = (rows: string[]) => ({
    headers: ['code', 'name', 'symbol', 'decimalPlaces', 'isActive'],
    problems: [],
    records: rows.map((r) => {
      const [code, name, symbol, decimalPlaces, isActive] = r.split(',');
      return { code, name, symbol, decimalPlaces, isActive };
    }),
  });

  it('classifies by the business key', () => {
    const a = analyzeImport(
      currency,
      parsed(['BBB,New Row,,2,true', 'AAA,Alpha Renamed,,2,true', 'AAA2,x,,2,true']),
      {},
      existing
    );
    // AAA2 fails the pattern, so it counts as neither.
    expect(a.rows[0].op).toBe('create');
    expect(a.rows[1].op).toBe('update');
    expect(a.rows[1].target?.id).toBe('id-1');
    expect(a.counts).toEqual({ create: 1, update: 1, skip: 0 });
  });

  it('skips a row identical to what is stored', () => {
    const a = analyzeImport(currency, parsed(['AAA,Alpha,,2,true']), {}, existing);
    expect(a.rows[0].op).toBe('skip');
    expect(isImportable(a)).toBe(false); // nothing to write
  });

  it('a unique value owned by the row being updated is not a clash', () => {
    // Case-insensitive key ownership needs an entity whose key permits case
    // variance — Currency's ^[A-Z]{3}$ pattern rejects "aaa" before the
    // ownership logic ever runs. UnitOfMeasure's code has no pattern.
    const uom = reference('UnitOfMeasure');
    const a = analyzeImport(
      uom,
      {
        headers: ['code', 'name', 'dimension', 'factorToBase', 'isBaseUnit'],
        problems: [],
        records: [
          { code: 'kg', name: 'Kilogram Renamed', dimension: 'Mass', factorToBase: '1', isBaseUnit: 'true' },
        ],
      },
      {},
      [{ id: 'id-9', code: 'KG', name: 'Kilogram', dimension: 'Mass', factorToBase: 1, isBaseUnit: true }]
    );
    expect(a.rows[0].errors).toEqual({});
    expect(a.rows[0].op).toBe('update');
    expect(a.rows[0].target?.id).toBe('id-9');
  });

  it('a column absent from the file is left untouched on updates, not cleared', () => {
    const withSymbol = [{ ...existing[0], symbol: '$' }];
    const noSymbolColumn = {
      headers: ['code', 'name', 'decimalPlaces', 'isActive'],
      problems: [],
      records: [{ code: 'AAA', name: 'Alpha Renamed', decimalPlaces: '2', isActive: 'true' }],
    };
    const a = analyzeImport(currency, noSymbolColumn, {}, withSymbol);
    expect(a.rows[0].op).toBe('update');
    expect('symbol' in a.rows[0].input, 'absent column must not be written').toBe(false);
    expect(a.absentOptional).toContain('Symbol');
  });

  it('an identical row still skips when the file has fewer columns', () => {
    const withSymbol = [{ ...existing[0], symbol: '$' }];
    const a = analyzeImport(
      currency,
      {
        headers: ['code', 'name', 'decimalPlaces', 'isActive'],
        problems: [],
        records: [{ code: 'AAA', name: 'Alpha', decimalPlaces: '2', isActive: 'true' }],
      },
      {},
      withSymbol
    );
    // The present columns match; the absent symbol must not count as a change.
    expect(a.rows[0].op).toBe('skip');
  });
});

describe('decimal scale', () => {
  const uom = reference('UnitOfMeasure');
  const draft = (factorToBase: string) => ({
    code: 'ZZ9',
    name: 'Probe',
    dimension: 'Mass',
    factorToBase,
    isBaseUnit: 'false',
  });

  it('accepts a value at the declared scale', () => {
    expect(validateDraft(uom, draft('0.123456789')).errors).toEqual({});
  });

  it('rejects digits the column would silently round away', () => {
    const { errors } = validateDraft(uom, draft('0.123456789123456'));
    expect(errors.factorToBase).toMatch(/silently round/);
  });
});

describe('structurally broken files', () => {
  const header = 'code,name,symbol,decimalPlaces,isActive\r\n';

  it('names the damage instead of blaming whichever field the wreckage landed in', () => {
    // An unclosed quote swallows the rest of the line. The parser salvages
    // something either way, so without this the only complaint a person sees
    // is "Decimal places is required" — true, useless, and the wrong fix.
    const parsed = parseCsv(`${header}ZZZ,"Unclosed,$,2,true\r\n`);
    expect(parsed.problems.join(' ')).toMatch(/quoted value is never closed/);
    expect(isImportable(analyzeImport(currency, parsed, {}, []))).toBe(false);
  });

  it('a well-formed file reports nothing', () => {
    expect(parseCsv(`${header}ZZZ,Fine,,2,true\r\n`).problems).toEqual([]);
  });
});
