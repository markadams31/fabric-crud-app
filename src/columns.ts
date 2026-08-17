import type { Row } from './db';
import { facets, rangeFacets, describeRow, type EntityView, type FieldView } from './entity';
import { LOCALES } from './Field';

/**
 * Column sizing and cell text, measured rather than guessed.
 *
 * Everything here is a plain function of entity metadata and loaded rows —
 * nothing names an entity or a field, and nothing renders. EntityPage draws
 * with these; keeping them out of the component file keeps the component
 * about state and layout.
 */

/** What a cell displays, as text — shared by the cells and the measurer. */
export function cellText(row: Row, field: FieldView, options?: Row[]): string {
  return field.lookup
    ? describeRow(options?.find((o) => o.id === row[field.name]), field)
    : formatValue(row[field.name], field);
}

/**
 * The row as a person recognises it — "AUD · Australian Dollar".
 *
 * Its first couple of display columns, which for reference data is a code and
 * a name. Never the primary key: that is a UUID, and a message naming one
 * tells the reader nothing about what just happened. `limit` trims it for
 * places with less room than a dialog has.
 */
export function rowIdentity(
  row: Row,
  view: EntityView,
  lookups: Record<string, Row[]> = {},
  limit?: number
): string {
  const text = view.columns
    .slice(0, 2)
    .map((f) => cellText(row, f, lookups[f.name]))
    .filter(Boolean)
    .join(' · ');
  if (!limit || text.length <= limit) return text;
  return `${text.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * The provenance cell's one-line text: when first, who second. Both rarely
 * fit, and an ellipsis eats the end of the line — leading with the name meant
 * every row read "p.nakamura@c…" and lost the recency, which is the part
 * being scanned for. The full record is one hover away.
 */
export function provenanceLabel(row: Row, view: EntityView): string {
  const by = view.lastChanged?.by ? row[view.lastChanged.by] : undefined;
  const at = view.lastChanged?.at ? row[view.lastChanged.at] : undefined;
  return by || at ? [at && relative(at), by && String(by)].filter(Boolean).join(' · ') : '—';
}

/**
 * "11 Aug 2026, 10:14 pm (3 days ago)" — the exact moment, with the elapsed
 * form beside it. The cell shows only the relative one, so on hover the
 * absolute answers "when exactly" while the bracket keeps the reader from
 * having to do the subtraction themselves.
 */
export function whenDetailed(value: unknown): string {
  const absolute = when(value);
  const elapsed = relative(value);
  return elapsed ? `${absolute} (${elapsed})` : absolute;
}

/** "11 Aug 2026, 10:14 pm" — the absolute form; cells show the relative one. */
export function when(value: unknown): string {
  const at = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(at.getTime())) return String(value);
  return at.toLocaleString(LOCALES, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "3 minutes ago" — short enough never to squeeze the data beside it. */
function relative(value: unknown): string {
  const at = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(at.getTime())) return '';
  const seconds = Math.round((Date.now() - at.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['second', 60],
    ['minute', 60],
    ['hour', 24],
    ['day', 7],
    ['week', 4.35],
    ['month', 12],
    ['year', Infinity],
  ];
  let amount = seconds;
  for (const [unit, size] of units) {
    if (Math.abs(amount) < size) {
      return new Intl.RelativeTimeFormat(LOCALES, { numeric: 'auto' }).format(
        -Math.round(amount),
        unit
      );
    }
    amount /= size;
  }
  return at.toLocaleDateString(LOCALES);
}

/**
 * Measure what each column actually holds and size it to fit.
 *
 * Canvas text metrics in the grid's own font, read from the element the
 * caller passes (EntityPage passes the grid card — FluentProvider styles its
 * subtree, never document.body, so the body is only a last-resort fallback). Headers are measured
 * semibold, because that is how Fluent renders them, with room reserved for
 * the sort arrow. Cells add 8px padding a side on top of the configured
 * width, so the configured width is text plus a whisker. The cap is what
 * keeps a 320-character email honest: it truncates with its full value on
 * hover instead of pushing every other column off the page.
 */
export function fitWidths(
  view: EntityView,
  rows: Row[],
  lookups: Record<string, Row[]>,
  measureFrom?: Element,
  /**
   * Horizontal room the table may occupy. Given it, leftover width is spent
   * widening the columns that are actually clipping, instead of sitting as
   * blank margin beside truncated text — the two used to be decided
   * independently, so a wide window could show both at once.
   */
  available?: number
): Record<string, number> {
  const ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return {};
  // The caller passes the grid's own element: FluentProvider applies its
  // typography to its own subtree, never to document.body, so measuring the
  // body would measure the browser default — right only by coincidence, and
  // wrong the moment anything styles the body.
  const body = getComputedStyle(measureFrom ?? document.body);
  const cellFont = `${body.fontSize} ${body.fontFamily}`;
  const headerFont = `600 ${body.fontSize} ${body.fontFamily}`;
  const width = (s: string, font: string) => {
    ctx.font = font;
    return ctx.measureText(s).width;
  };
  const SORT_ARROW = 24;
  // Filterable columns carry an icon button in the header's `aside` slot. Not
  // reserving its width clips the label of every column that has one — the
  // same reason the sort arrow is reserved above.
  const FILTER_ICON = 28;
  const clamp = (n: number, lo: number, hi: number) => Math.min(Math.max(Math.ceil(n), lo), hi);

  const out: Record<string, number> = {};
  /** What each column would need to show its longest value in full. */
  const wants: Record<string, number> = {};
  const filterable = new Set([...facets(view), ...rangeFacets(view)].map((f) => f.name));
  for (const f of view.columns) {
    let need = width(f.label, headerFont) + SORT_ARROW + (filterable.has(f.name) ? FILTER_ICON : 0);
    if (f.constraints.type === 'boolean') {
      need = Math.max(need, 24); // a glyph, not text
    } else {
      for (const r of rows) need = Math.max(need, width(cellText(r, f, lookups[f.name]), cellFont));
    }
    wants[f.name] = Math.ceil(need + 4);
    out[f.name] = clamp(need + 4, 48, COLUMN_CAP);
  }
  if (view.lastChanged) {
    let need = width('Last changed', headerFont);
    for (const r of rows) need = Math.max(need, width(provenanceLabel(r, view), cellFont));
    wants.__provenance = Math.ceil(need + 4);
    out.__provenance = clamp(need + 4, 120, PROVENANCE_CAP);
  }
  return available ? spendSurplus(out, wants, available) : out;
}

/** The actions column, and the card border plus the grid's own right gutter. */
const ACTIONS_WIDTH = 84;
const CHROME_WIDTH = 10;
/** Past this a single column starts pushing everything else off the page. */
const COLUMN_CAP = 360;
const PROVENANCE_CAP = 250;

/**
 * Hand leftover width to the columns that are clipping.
 *
 * Only to those: padding a column that already fits would smear blank space
 * through the table, which is what the shrink-wrapped card exists to avoid.
 *
 * Cheapest deficit first, not proportional. Proportional sharing let two
 * columns holding a 193- and a 312-character value — which cannot fit at any
 * plausible width — absorb most of the surplus, leaving nine provenance cells
 * clipped by five pixels each. Satisfying the small deficits first fully fixes
 * as many columns as the room allows and hands only the remainder to the ones
 * that were never going to fit, which is what "use the space well" means here.
 */
function spendSurplus(
  widths: Record<string, number>,
  wants: Record<string, number>,
  available: number
): Record<string, number> {
  const out = { ...widths };
  const used = Object.values(out).reduce((a, b) => a + b, 0) + ACTIONS_WIDTH + CHROME_WIDTH;
  let surplus = available - used;
  if (surplus <= 0) return out;

  const clipped = Object.keys(out)
    .filter((k) => wants[k] > out[k])
    .sort((a, b) => wants[a] - out[a] - (wants[b] - out[b]));
  for (const k of clipped) {
    if (surplus <= 0) break;
    const share = Math.min(wants[k] - out[k], surplus);
    out[k] += share;
    surplus -= share;
  }
  return out;
}

/**
 * A column's width before any rows have arrived, from what its field declares.
 *
 * Only the first paint uses these: real widths are measured from content as
 * soon as the first page lands. Close-enough estimates here keep that settle
 * small. Nothing names a field or an entity: a small `max` is a narrow column
 * whatever it happens to hold.
 */
export function widthFor(f: FieldView): number {
  const c = f.constraints;
  if (f.lookup) return 190;
  switch (c.type) {
    case 'boolean':
      return 90;
    case 'date':
      return 120;
    case 'number':
      return 120;
    case 'enum':
      return 140;
    case 'string':
      return !c.max || c.max > 60 ? 220 : c.max <= 12 ? 100 : 170;
    default:
      return 160;
  }
}

/**
 * Render a value for display, in the shape the field is edited in.
 *
 * A `@date()` column prints as a date, because that is what
 * `<input type="date">` collects — showing `1/6/2020, 11:00:00 AM` for a value
 * the form will only ever let you set to a day is both wrong and twice as wide.
 * Numbers get their thousands separators and the decimal places they declared,
 * so a column of them can be compared down the page.
 */
function formatValue(value: unknown, field: FieldView): string {
  if (value === null || value === undefined || value === '') return '';
  // The grid intercepts boolean fields and draws glyphs; this branch serves
  // cellText's other callers (DeleteDialog's row identity) and any boolean
  // arriving without a boolean field declaration.
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';

  const c = field?.constraints;

  if (c?.type === 'date' || value instanceof Date) {
    const at = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(at.getTime())) return String(value);
    // Date-only values are UTC-midnight-anchored end to end — the wire format,
    // the form's round-trip and the validator all speak UTC. Rendering one in
    // the viewer's zone shows the previous day anywhere west of Greenwich, so
    // pin the zone. (Audit timestamps are real instants and stay local.)
    return c?.type === 'date'
      ? at.toLocaleDateString(LOCALES, { timeZone: 'UTC' })
      : at.toLocaleString(LOCALES);
  }

  if (c?.type === 'number') {
    const n = Number(value);
    if (Number.isNaN(n)) return String(value);
    // The declared scale is the most a column can hold, not what every value
    // should show: a conversion factor stored at scale 9 would print
    // "1,609.344000000". Show up to the scale, and always at least two places
    // so a money column keeps its cents and stays aligned.
    const scale = c.format === 'int' ? 0 : (c.scale ?? 2);
    return n.toLocaleString(LOCALES, {
      minimumFractionDigits: Math.min(scale, 2),
      maximumFractionDigits: scale,
    });
  }

  return String(value);
}
