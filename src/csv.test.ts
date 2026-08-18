import { describe, expect, it } from 'vitest';

import { buildTemplate, csvEscape } from './csv';
import { reference } from './reference.fixture';

describe('csvEscape', () => {
  it('leaves plain values alone', () => {
    expect(csvEscape('Australia')).toBe('Australia');
  });

  it('quotes commas, quotes and newlines per RFC 4180', () => {
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('say "hi"')).toBe('"say ""hi"""');
    expect(csvEscape('two\nlines')).toBe('"two\nlines"');
  });

  it('defuses formula injection but not negative numbers', () => {
    expect(csvEscape('=SUM(A1)')).toBe("'=SUM(A1)");
    expect(csvEscape('@import')).toBe("'@import");
    expect(csvEscape('-5')).toBe('-5');
    expect(csvEscape('+3.14')).toBe('+3.14');
  });
});

describe('buildTemplate', () => {
  const headers = buildTemplate(reference('Currency')).trim().split(',');

  it('offers exactly what the create form offers', () => {
    expect(headers).toEqual(['code', 'name', 'symbol', 'decimalPlaces', 'isActive']);
  });

  it('never asks for the id or the audit columns', () => {
    expect(headers).not.toContain('id');
    expect(headers.filter((h) => /^(created|updated)/.test(h))).toEqual([]);
  });

  it('asks for a lookup by its label, never its id column', () => {
    // The template used to offer `currency_id`, so filling it in meant pasting
    // GUIDs — the one value a person does not have. The importer always took a
    // code or a name; only the template spoke the database's language.
    // Sample-pinned: Country's lookup is Currency.
    const country = buildTemplate(reference('Country')).trim().split(',');
    expect(country).toContain('Currency');
    expect(country.filter((h) => h.endsWith('_id'))).toEqual([]);
  });
});
