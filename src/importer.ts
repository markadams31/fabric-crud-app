import Papa from 'papaparse';

import type { Row } from './db';
import { validateDraft } from './validate';
import type { EntityView, FieldView } from './entity';

/**
 * Bulk-import analysis: everything that can be known about a CSV before a
 * single row is written. Pure functions — the dialog owns the fetching and
 * the writing; this file owns the judgement.
 *
 * A file is not just creates. The entity's first unique column is its
 * business key, and a row whose key matches an existing record is an
 * *update* of it; a row identical to what is already stored is *skipped*.
 * That is what makes export–edit–reimport a workflow instead of an error.
 *
 * The platform has no transactions and no bulk mutation, so an import is one
 * request per row. All-or-nothing therefore has to be earned up front: every
 * check that can run before the first write runs here, and the failure modes
 * that remain — races and outages — are compensated by the dialog, which
 * deletes what it created and restores what it updated.
 */

/** Refused outright above this — every row is a metered GraphQL call. */
export const IMPORT_MAX_ROWS = 500;

export interface ImportRow {
  /** 1-based data row — the spreadsheet row minus the header. */
  line: number;
  /** Field values as strings, foreign keys already resolved to ids. */
  draft: Record<string, string>;
  /** What the write would be given, when the row is clean. */
  input: Record<string, unknown>;
  /** Field name → what is wrong with it. Empty means importable. */
  errors: Record<string, string>;
  /** What importing this row will do. */
  op: 'create' | 'update' | 'skip';
  /** The matched existing row, for updates and skips. */
  target?: Row;
}

export interface ImportAnalysis {
  rows: ImportRow[];
  /** Rows with at least one error. */
  errorCount: number;
  /** Labels of required columns absent from the header row — a hard block. */
  missingRequired: string[];
  /** Headers that match no editable field; ignored, but say so. */
  ignoredHeaders: string[];
  /** Rows beyond {@link IMPORT_MAX_ROWS}, refused rather than truncated. */
  overCap: number;
  /** Structural parse damage — a hard block, since no row can be trusted. */
  problems: string[];
  /** What the import would do, by operation. */
  counts: { create: number; update: number; skip: number };
  /** The business key updates are matched on, when the entity has one. */
  keyField?: string;
  /**
   * Columns absent from the file that an update safely leaves untouched:
   * optional fields, plus booleans (an absent column is never written on an
   * update; only a required boolean's blank defers to the column default). A deleted spreadsheet column is not an instruction to
   * clear values on every row — and the dialog says so.
   */
  absentOptional: string[];
}

/** A parsed file: its true header row, and its data rows keyed by it. */
export interface ParsedCsv {
  headers: string[];
  records: Record<string, string>[];
  /** Structural damage found while parsing; a well-formed file has none. */
  problems: string[];
}

/**
 * Parse CSV text. The headers come from the parser's own header list, not
 * from the first record's keys — a row with fewer cells than the header
 * would otherwise read as the whole column being absent, and a header-only
 * file as every column missing.
 */
export function parseCsv(text: string): ParsedCsv {
  const result = Papa.parse<Record<string, string>>(text.replace(/^\ufeff/, ''), {
    header: true,
    skipEmptyLines: 'greedy',
    transformHeader: (h) => h.trim(),
  });
  return {
    headers: result.meta.fields ?? [],
    records: result.data,
    problems: describeParseProblems(result.errors ?? []),
  };
}

/**
 * The parser reports structural damage \u2014 an unclosed quote, a row whose cell
 * count disagrees with the header \u2014 separately from the data it salvages, and
 * it always salvages *something*. Dropping that report turns "this file is not
 * valid CSV" into a misleading complaint about whichever field the wreckage
 * landed in, so translate the codes that matter and let the dialog block on
 * them: if the shape is wrong, no row from the file can be trusted.
 */
function describeParseProblems(errors: readonly Papa.ParseError[]): string[] {
  const described = new Set<string>();
  const problems: string[] = [];
  for (const error of errors) {
    if (described.has(error.code)) continue;
    described.add(error.code);
    const alike = errors.filter((o) => o.code === error.code).length - 1;
    problems.push(
      [
        typeof error.row === 'number' ? `Row ${error.row + 1}: ` : '',
        error.code === 'MissingQuotes' || error.code === 'InvalidQuotes'
          ? 'a quoted value is never closed, so everything after it was read as part of that one cell'
          : error.code === 'TooManyFields'
            ? 'more values than the header has columns'
            : error.code === 'TooFewFields'
              ? 'fewer values than the header has columns'
              : error.message,
        alike > 0 ? ` (and ${alike} more like it)` : '',
      ].join('')
    );
  }
  return problems;
}

/**
 * Resolve one foreign-key cell. An exact id wins; otherwise any display field
 * of the target (a code, a name) matches case-insensitively — the values a
 * person actually has in their spreadsheet. Ambiguity is an error, not a
 * guess.
 */
function resolveFk(
  raw: string,
  options: Row[],
  display: string[]
): { id?: string; error?: string } {
  if (options.some((o) => o.id === raw)) return { id: raw };
  const needle = raw.toLowerCase();
  const matches = options.filter((o) =>
    display.some((d) => String(o[d] ?? '').toLowerCase() === needle)
  );
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length > 1) return { error: `"${raw}" matches more than one row — use the id` };
  return { error: `no match for "${raw}"` };
}

/** Whether an incoming value would change what the row already holds. */
function sameValue(f: FieldView, incoming: unknown, existing: unknown): boolean {
  // An omitted value (blank required-boolean cell) writes nothing, so it
  // changes nothing; a blank OPTIONAL boolean is null and does compare.
  if (incoming === undefined) return true;
  const norm = (v: unknown): unknown => {
    if (v === undefined || v === null || v === '') return null;
    if (f.constraints.type === 'date') {
      const d = v instanceof Date ? v : new Date(String(v));
      return Number.isNaN(d.getTime()) ? String(v) : d.toISOString().slice(0, 10);
    }
    if (f.constraints.type === 'number') return Number(v);
    if (f.constraints.type === 'boolean') return v === true || v === 'true';
    return String(v);
  };
  return Object.is(norm(incoming), norm(existing));
}

/**
 * Analyze parsed records against the entity: header mapping, per-cell
 * validation via the same `validateDraft` the row dialog uses, foreign keys
 * resolved through the loaded lookups, uniqueness pre-checked, and every row
 * classified as a create, an update of the row its key matches, or a skip
 * when nothing would change.
 */
export function analyzeImport(
  view: EntityView,
  { headers, records, problems }: ParsedCsv,
  lookups: Record<string, Row[]>,
  /** The table as it stands: id plus every editable column. */
  existing: Row[]
): ImportAnalysis {
  const known = new Set(view.editable.map((f) => f.name));
  const ignoredHeaders = headers.filter((h) => !known.has(h));
  const present = new Set(headers.filter((h) => known.has(h)));
  const absentOptional = view.editable
    .filter((f) => !present.has(f.name) && (f.constraints.optional || f.constraints.type === 'boolean'))
    .map((f) => f.label);
  const missingRequired =
    records.length === 0
      ? []
      : view.editable
          .filter(
            (f) =>
              !f.constraints.optional &&
              f.constraints.type !== 'boolean' &&
              !headers.includes(f.name)
          )
          .map((f) => f.label);

  const keyField = view.editable.find((f) => f.unique)?.name;
  const byKey = new Map<string, Row>();
  const uniqueOwner: Record<string, Map<string, string>> = {};
  for (const f of view.editable) {
    if (!f.unique) continue;
    const owners = new Map<string, string>();
    for (const r of existing) {
      const v = String(r[f.name] ?? '').toLowerCase();
      if (v) owners.set(v, r.id);
      if (f.name === keyField && v) byKey.set(v, r);
    }
    uniqueOwner[f.name] = owners;
  }

  const overCap = Math.max(0, records.length - IMPORT_MAX_ROWS);
  const seen: Record<string, Map<string, number>> = {};

  const rows = records.slice(0, IMPORT_MAX_ROWS).map((record, i): ImportRow => {
    const draft: Record<string, string> = {};
    const fkErrors: Record<string, string> = {};

    for (const f of view.editable) {
      const raw = (record[f.name] ?? '').trim();
      if (f.lookup && raw) {
        const resolved = resolveFk(raw, lookups[f.name] ?? [], f.lookup.display);
        if (resolved.id) draft[f.name] = resolved.id;
        else {
          draft[f.name] = raw;
          fkErrors[f.name] = resolved.error!;
        }
      } else {
        draft[f.name] = raw;
      }
    }

    const { input, errors } = validateDraft(view, draft);

    // The row this one updates, if its business key matches an existing row.
    const keyValue = keyField ? String(draft[keyField] ?? '').toLowerCase() : '';
    const target = keyValue ? byKey.get(keyValue) : undefined;

    // Unique columns: a value already owned by a DIFFERENT row is a clash —
    // the row being updated owning it is exactly what makes it an update.
    // Duplicates within the file stay errors: two rows aiming at one key
    // would just overwrite each other in file order.
    for (const f of view.editable) {
      if (!f.unique || errors[f.name] || fkErrors[f.name]) continue;
      const value = draft[f.name];
      if (!value) continue;
      const key = value.toLowerCase();
      const owner = uniqueOwner[f.name]?.get(key);
      if (owner && owner !== target?.id) {
        errors[f.name] = `"${value}" already exists`;
        continue;
      }
      const inFile = (seen[f.name] ??= new Map());
      const firstLine = inFile.get(key);
      if (firstLine !== undefined) {
        errors[f.name] = `"${value}" appears twice in the file (first on row ${firstLine})`;
      } else {
        inFile.set(key, i + 1);
      }
    }

    // An update touches only the columns the file actually has: a deleted
    // spreadsheet column must read as "leave it alone", never as "clear it
    // on every row". The skip comparison narrows the same way, or a file
    // missing one column would classify every row as changed.
    // Only columns the update grant permits count towards "changed", and only
    // they are written: a file carrying a locked column (a business key, say)
    // still matches its row and updates the rest, rather than failing on a
    // value the API would refuse.
    const updatable = new Set(view.updatable.map((f) => f.name));
    const creatable = new Set(view.creatable.map((f) => f.name));
    const op: ImportRow['op'] = !target
      ? 'create'
      : view.editable
            .filter((f) => present.has(f.name) && updatable.has(f.name))
            .every((f) => sameValue(f, input[f.name], target[f.name]))
        ? 'skip'
        : 'update';
    const written =
      op === 'update'
        ? Object.fromEntries(
            Object.entries(input).filter(([k]) => present.has(k) && updatable.has(k))
          )
        : Object.fromEntries(Object.entries(input).filter(([k]) => creatable.has(k)));

    return { line: i + 1, draft, input: written, errors: { ...errors, ...fkErrors }, op, target };
  });

  const counts = { create: 0, update: 0, skip: 0 };
  for (const r of rows) if (Object.keys(r.errors).length === 0) counts[r.op]++;

  return {
    rows,
    errorCount: rows.filter((r) => Object.keys(r.errors).length > 0).length,
    missingRequired,
    ignoredHeaders,
    overCap,
    counts,
    keyField,
    absentOptional,
    problems,
  };
}

/** True when there is something to write and nothing blocking it. */
export function isImportable(a: ImportAnalysis): boolean {
  return (
    a.counts.create + a.counts.update > 0 &&
    a.errorCount === 0 &&
    a.missingRequired.length === 0 &&
    a.overCap === 0 &&
    a.problems.length === 0
  );
}
