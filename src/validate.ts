import type { EntityView, FieldView } from './entity';

/**
 * Turning what a person typed into what an entity accepts — shared by the row
 * dialog and the bulk importer, so a CSV cell cannot pass or fail differently
 * from the same value typed into the form.
 *
 * The SDK's own validator (entity.ts wires `toStandardSchema`) remains the
 * authority; this layer feeds it coerced values, adds the gates it lacks, and
 * rewrites its messages into words a person can act on.
 */

/**
 * Form inputs and CSV cells are strings; convert to what the entity declared.
 *
 * A blank optional field is absent, not empty. Sending `''` made the validator
 * reject every optional date — `''` is not a date, so "Closed on must be a
 * valid date" appeared on a field nobody had touched, and the row could not be
 * created at all. `null` rather than `undefined` so that clearing a value while
 * editing reaches the server as "set this to nothing" instead of being dropped
 * from the request and silently left as it was.
 */
function coerce(raw: string | undefined, field: FieldView): unknown {
  const { type, optional } = field.constraints;
  const value = (raw ?? '').trim();
  if (type === 'boolean') {
    // Spreadsheets write booleans a dozen ways, and the one thing worse than
    // rejecting "TRUE" is silently importing it as false — which is what a
    // bare equality check did. Unrecognised text passes through as a string
    // so the validator rejects it loudly instead.
    // Blank: an optional boolean's blank is its third answer — null, the
    // em-dash the grid renders — while a required one's blank defers to the
    // column default.
    if (value === '') return optional ? null : undefined;
    if (/^(true|t|yes|y|1)$/i.test(value)) return true;
    if (/^(false|f|no|n|0)$/i.test(value)) return false;
    return value;
  }
  if (value === '') return optional ? null : type === 'number' ? undefined : value;
  if (field.constraints.type === 'enum') {
    // A spreadsheet says "europe"; the entity says "Europe". A unique
    // case-insensitive match is canonicalised; anything else passes through
    // for the validator to reject with the list of allowed values.
    const values = field.constraints.values;
    return (
      values.find((v) => v === value) ??
      values.find((v) => v.toLowerCase() === value.toLowerCase()) ??
      value
    );
  }
  return type === 'number' ? Number(value) : value;
}

/**
 * Strictly ISO, strictly real. JavaScript's own date parsing is exactly what
 * an importer must not use: "01/02/2024" reads as January 2nd in a country
 * where it means February 1st, Excel's serial 45306 becomes the year 45306,
 * and the impossible 2024-02-30 rolls quietly over to March 1st. Every one
 * of those was observed importing without complaint before this check.
 */
function isIsoDate(value: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const parsed = new Date(Date.UTC(y, mo - 1, d));
  return (
    parsed.getUTCFullYear() === y && parsed.getUTCMonth() === mo - 1 && parsed.getUTCDate() === d
  );
}

/**
 * Group validation issues by field, with the message rewritten for a person.
 *
 * The validator says "Field 'code' does not match required pattern" — which
 * field is fixable, but the pattern stays a secret. The constraints are right
 * there in the metadata, so say more when it can be said briefly: an email
 * field gets prose, a short regex is shown verbatim. A two-hundred-character
 * pattern helps nobody and stays unsaid.
 */
function issuesByField(
  issues: readonly { message: string; path?: readonly unknown[] }[] = [],
  fields: FieldView[] = []
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const issue of issues) {
    const head = issue.path?.[0];
    const key =
      typeof head === 'object' && head !== null && 'key' in head
        ? String((head as { key: unknown }).key)
        : String(head ?? '');
    if (!key || errors[key]) continue;
    const field = fields.find((f) => f.name === key);
    // An issue about a field this draft does not cover — the entity schema
    // still requires it, but the caller is not editing it (a column locked
    // by the update grant). Keeping it would block the save behind an error
    // message with no field on screen to show it.
    if (!field) continue;
    const label = field.label;
    let message = issue.message.replace(/^Field '[^']+'/, label);
    if (field && /does not match required pattern/i.test(message)) {
      const c = field.constraints;
      if (c.type === 'string' && c.format === 'email') {
        message = `${label} must be a valid email address`;
      } else if (c.type === 'string' && c.regex && c.regex.source.length <= 24) {
        message = `${label} must match the pattern ${c.regex.source}`;
      }
    }
    errors[key] = message;
  }
  return errors;
}

/**
 * Validate one draft — the strings a form or a CSV row supplies — and coerce
 * it to the shape the entity declares.
 *
 * The validator reports the first problem it finds per field, so an empty
 * draft would otherwise complain about one thing at a time; every missing
 * required value is flagged up front instead, saying "is required" rather
 * than quoting a length rule at a field nobody has filled in yet.
 */
export function validateDraft(
  view: EntityView,
  draft: Record<string, string>,
  /** Which fields the draft covers — narrower than `editable` when editing a
   *  row whose update grant excludes some of them. */
  fields: FieldView[] = view.editable
): { input: Record<string, unknown>; errors: Record<string, string> } {
  const input = Object.fromEntries(fields.map((f) => [f.name, coerce(draft[f.name], f)]));
  const missing = Object.fromEntries(
    fields
      .filter(
        (f) =>
          !f.constraints.optional &&
          f.constraints.type !== 'boolean' &&
          !String(draft[f.name] ?? '').trim()
      )
      .map((f) => [f.name, `${f.label} is required`])
  );
  const errors = { ...issuesByField(view.validate(input).issues, fields), ...missing };

  // Two gates the validator lacks. Dates: only a padded, provably-real
  // YYYY-MM-DD passes — the form's date input emits exactly that, so this
  // bites only hand-written values; see isIsoDate for the silent misreads it
  // stops. Decimals: digits beyond the declared scale would be rounded away
  // by the database without a word from any layer (0.123456789123456 stored
  // as 0.123456789, observed), so count them while they are still text.
  for (const f of fields) {
    if (errors[f.name]) continue;
    const value = String(draft[f.name] ?? '').trim();
    if (!value) continue;
    if (f.constraints.type === 'date' && !isIsoDate(value)) {
      errors[f.name] = `${f.label} must be a real date in YYYY-MM-DD format`;
    }
    // `scale` is only present when the entity DECLARED one, but an undeclared
    // @decimal() is still DECIMAL(18,2) in SQL — so the bare spelling, the one
    // CLAUDE.md names as a silent-truncation trap, was the exact case this
    // gate skipped. An @int is scale 0: "1e3" and "0x1F" are not integers a
    // spreadsheet should smuggle past as 1000 and 31.
    const declaredScale =
      f.constraints.type === 'number'
        ? f.constraints.format === 'int'
          ? 0
          : (f.constraints.scale ?? 2)
        : undefined;
    if (declaredScale != null) {
      // The digit count only means anything for plain decimal notation. What
      // else arrives in practice: Excel writes small numbers to CSV in
      // scientific notation ("1.23E-07"), people type ".575" — both used to
      // sail past this gate at "0 decimals" and get silently rounded by the
      // database, the exact miss this gate exists to stop. Require the
      // notation the gate can actually count.
      const plain = /^[-+]?\d+(\.(\d+))?$/.exec(value);
      if (!plain) {
        errors[f.name] =
          `${f.label} must be in plain decimal notation, like 0.125 — ` +
          `not scientific notation or a bare fraction`;
      } else if ((plain[2]?.length ?? 0) > declaredScale) {
        errors[f.name] =
          `${f.label} has ${plain[2]?.length} decimal places; the column keeps ` +
          `${declaredScale} and would silently round the rest away`;
      } else if (value.replace(/[-+.]/g, '').replace(/^0+/, '').length > 15) {
        // Past ~15 significant digits the JavaScript double mangles the value
        // before it ever reaches the wire — the string survives this gate but
        // the number sent is a different number.
        errors[f.name] = `${f.label} has more digits than can be sent exactly (15 max)`;
      }
    }
  }
  return { input, errors };
}
