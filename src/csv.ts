import type { EntityView, FieldView } from './entity';

/**
 * The header a template offers for one field, and every header a file may use
 * for it.
 *
 * A lookup's field name IS its foreign-key column — `currency_id` — and a
 * template saying that invites a spreadsheet full of GUIDs, which is the one
 * value a person filling it in does not have and cannot look up. The importer
 * never needed them: `resolveFk` takes an id *or* any display value of the
 * target, matched case-insensitively, so `AUD` has always worked. Only the
 * template was speaking the database's language.
 *
 * So a template offers the field's LABEL for a lookup — the same word the grid
 * column shows — while both spellings are still read, because files written
 * against the old template must keep importing.
 */
export function templateHeader(f: FieldView): string {
  return f.lookup ? f.label : f.name;
}

/** Every header accepted for a field: its name, plus a lookup's label. */
export function acceptedHeaders(f: FieldView): string[] {
  return f.lookup ? [f.name, f.label] : [f.name];
}

/**
 * CSV for bulk upload, starting with the template a person fills in.
 *
 * The conventions follow the tools people will open these files with:
 * a UTF-8 BOM so Excel detects the encoding, CRLF line endings, RFC-4180
 * quoting, and neutralisation of formula injection — a cell starting with
 * `=`, `+`, `-`, `@`, tab or CR executes as a formula the moment the file is opened
 * in a spreadsheet, so it gets a leading apostrophe unless it is a genuine
 * number.
 */

/** One value, quoted and defused as above. */
export function csvEscape(value: string): string {
  const guarded =
    /^[=+\-@\t\r]/.test(value) && !/^[-+]?\d+(\.\d+)?$/.test(value) ? `'${value}` : value;
  return /[",\r\n]/.test(guarded) ? `"${guarded.replace(/"/g, '""')}"` : guarded;
}

/**
 * The template body: a single header row of the fields a person may supply.
 * No id (the server generates it), no audit columns (the app stamps them), no
 * example row (an example left in the file would be imported as data). A
 * foreign key appears as its column name (`currency_id`); the upload accepts an
 * id or any display value there ("AUD", "Australian Dollar"), case-insensitively.
 *
 * What an import can WRITE, which is create's grant plus update's — not every
 * editable column. An import does both, so either grant earns a column its
 * place; a column in neither is one the importer silently drops, and putting it
 * in the template invites someone to fill in a column that goes nowhere. The
 * same set for the sample schema, whose only exclusions are audit columns that
 * are not editable to begin with.
 */
export function buildTemplate(view: EntityView): string {
  const writable = new Set([...view.creatable, ...view.updatable].map((f) => f.name));
  return (
    view.editable
      .filter((f) => writable.has(f.name))
      .map((f) => csvEscape(templateHeader(f)))
      .join(',') + '\r\n'
  );
}

/** Hand the browser a file to save. The BOM is what makes Excel read UTF-8. */
export function downloadCsv(filename: string, text: string): void {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
