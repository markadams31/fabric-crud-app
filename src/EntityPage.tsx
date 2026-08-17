import {
  Button,
  Caption1,
  Checkbox,
  Card,
  DataGrid,
  DataGridBody,
  DataGridCell,
  DataGridHeader,
  DataGridHeaderCell,
  DataGridRow,
  MessageBar,
  MessageBarBody,
  Popover,
  PopoverSurface,
  PopoverTrigger,
  SearchBox,
  Spinner,
  Subtitle2,
  Tooltip,
  createTableColumn,
  useDataGridContext_unstable,
  makeStyles,
  mergeClasses,
  shorthands,
  tokens,
} from '@fluentui/react-components';
import {
  AddRegular,
  ArrowUploadRegular,
  CheckmarkRegular,
  DeleteRegular,
  DismissRegular,
  FilterFilled,
  FilterRegular,
  EditRegular,
  TableRegular,
} from '@fluentui/react-icons';
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  cellText,
  fitWidths,
  provenanceLabel,
  rowIdentity,
  whenDetailed,
  widthFor,
} from './columns';
import { DeleteDialog } from './DeleteDialog';
import { dynamic, PAGE_SIZE, readable, type Row } from './db';
import { ImportDialog } from './ImportDialog';
import {
  allEntities,
  facetOptions,
  facets,
  isSearchable,
  PRIMARY_KEY,
  rangeFacets,
  rowFilter,
  type EntityView,
  type FieldView,
  type RangeBounds,
} from './entity';
import { Field } from './Field';
import { RowDialog } from './RowDialog';
import { useAnnounce } from './toast';

const useStyles = makeStyles({
  // Sizes the toolbar, banners and "Load more" to the table itself, so the
  // "New" button sits flush with the card's right edge instead of floating at
  // the page edge past it. The width is stable from first paint: the card
  // renders its header row while loading, and headers set the width.
  fit: { width: 'fit-content', maxWidth: '100%' },
  bar: { marginBottom: '12px' },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: '12px',
    padding: '12px 0',
    minHeight: '32px',
  },
  search: { maxWidth: '260px' },
  // One column's options per block, so a schema with several facets reads as
  // groups rather than one long list.
  facetPanel: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
    minWidth: '200px',
  },
  facetGroup: { display: 'flex', flexDirection: 'column', gap: '2px' },
  // Quiet until it is doing something. A column of always-visible filter icons
  // competes with the data; a filled one says "this column is narrowing what
  // you see", which is the only state worth shouting.
  // Fluent lets the header's sort button grow to fill the cell, which pushes
  // the `aside` filter icon to the far right — 41px from its own label and 8px
  // from the NEXT column's, so it read as belonging to the wrong column
  // (measured). Stop the growth and the icon sits against the label it filters.
  // The slot is a DIV, not a button, despite being the clickable sort target.
  // `flexShrink: 0` matters as much as `flexGrow: 0`: growth alone let the slot
  // collapse to MIN-content, so "Is active" wrapped to two lines inside a cell
  // with 128px spare (measured: label 37px = the width of "active"). Not
  // growing keeps the filter icon beside its own label; not shrinking keeps the
  // label on one line.
  headerCell: {
    '> div:first-child': { flexGrow: 0, flexShrink: 0, width: 'max-content', whiteSpace: 'nowrap' },
  },
  headerAside: { display: 'flex', alignItems: 'center' },
  filterIcon: { color: tokens.colorNeutralForeground4 },
  filterOn: { color: tokens.colorBrandForeground1 },
  // Side by side while there is room; a date picker needs more than half a
  // narrow popover, so they wrap rather than compress to unusability.
  rangeRow: { display: 'flex', gap: '8px', flexWrap: 'wrap' },
  facetLabel: {
    fontSize: '10px',
    lineHeight: '14px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: tokens.colorNeutralForeground3,
    marginBottom: '2px',
  },
  // Active filters stay visible: a filter you cannot see is a filter you forget
  // you set, and then the grid looks wrong for no reason.
  //
  // Their own row, right-aligned so they sit directly under the Filter button
  // that made them — not inside the toolbar on either side of the spacer. That
  // row is width-locked to the table and carries no slack, so chips placed in
  // it move the control you just clicked: measured at 373px of travel after the
  // spacer, and before it the third chip pushes the toolbar out past the table
  // (+74px) or wraps the buttons onto a second line at 900px. Here they wrap as
  // far as they like and nothing above them can move.
  chips: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: '6px',
    flexWrap: 'wrap',
    paddingBottom: '12px',
  },
  spacer: { flexGrow: 1 },
  muted: { color: tokens.colorNeutralForeground3 },
  // The card hugs the table instead of filling the page. Column widths are
  // fixed by content (see `sizing`), and the library's auto-fit cannot
  // distribute a wide container's leftover: it dumps all of it on the last
  // column, which is the 48px edit button — a blank shelf after the pencils.
  // A shrink-wrapped card has no leftover to distribute.
  // Visually flat on purpose: the Fabric portal presents its own lists as rows
  // on the page — hairline separators, no panel, no elevation — so the card
  // keeps only its layout job and paints no chrome of its own.
  card: {
    padding: 0,
    width: 'fit-content',
    maxWidth: '100%',
    overflowX: 'auto',
    backgroundColor: tokens.colorNeutralBackground1,
    boxShadow: 'none',
  },
  // The header row overflows its cells by 8px — the last column's resize
  // divider pokes past them. max-content sizes the grid to its rows; the
  // right padding gives the divider a gutter inside the card, so no table
  // scrolls sideways by 8 phantom pixels.
  grid: { width: 'max-content', paddingRight: '8px' },
  // One line per row, and anything too long for its column ends in an ellipsis
  // with the full value on hover. Wrapping instead would give every row a
  // different height, and letting it overflow puts a 320-character email on top
  // of the column beside it.
  cell: {
    display: 'block',
    width: '100%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  // Digits line up under each other, so a column of numbers can be compared
  // down the page rather than read one at a time.
  number: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' },
  pushRight: { marginLeft: 'auto' },
  // A tick that reads at a glance, and a muted "no" that recedes — a column of
  // Yes/No prose makes every row equally loud. `null` stays an em-dash: absent
  // and false are different answers.
  boolYes: { fontSize: '16px', color: tokens.colorPaletteGreenForeground1 },
  boolNo: { fontSize: '16px', color: tokens.colorNeutralForeground4 },
  more: { display: 'flex', justifyContent: 'center', paddingTop: '16px' },
  // Edit and Delete sat with their hit targets touching — 24px each, 0px
  // between, and one of them destructive. A gap costs nothing here and turns
  // a misclick into a miss.
  rowActions: { display: 'flex', gap: '10px', justifyContent: 'flex-end' },
  // The provenance tooltip. Plain text with newlines collapses to one run-on
  // line in a tooltip, so each event is a block: an eyebrow label, the person,
  // then the moment.
  // Fluent's tooltip root hard-codes `maxWidth: 240px` and `overflow-wrap:
  // break-word`, so a max-width on the CONTENT can never widen the surface —
  // which is why long addresses kept wrapping however wide the inner box was
  // allowed to be. Override the surface: size it to its content, and only
  // start wrapping at a width that would otherwise leave the viewport.
  tip: {
    maxWidth: 'min(90vw, 640px)',
    width: 'max-content',
  },
  history: {
    display: 'flex',
    flexDirection: 'column',
    rowGap: '10px',
    ...shorthands.padding('2px', '0'),
  },
  historyEvent: { display: 'flex', flexDirection: 'column', rowGap: '2px' },
  // Two events were a six-line block with a gap in it; a hairline makes them
  // read as two records at a glance.
  historyNext: {
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: '10px',
  },
  // An eyebrow, not a heading: the label is the least interesting thing here,
  // and rendering it bolder than the name inverted the hierarchy — the answer
  // to "who do I ask" should carry the weight.
  historyLabel: {
    fontSize: '10px',
    lineHeight: '14px',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    color: tokens.colorNeutralForeground3,
  },
  // Emails have no spaces. `break-all` split them at whatever character hit
  // the edge ("data.stewardship.te / am@contoso.com"); `anywhere` takes the
  // natural break points first and only splits a token when nothing else fits.
  historyWho: {
    overflowWrap: 'anywhere',
    fontWeight: tokens.fontWeightSemibold,
    color: tokens.colorNeutralForeground1,
  },
  historyWhen: {
    fontVariantNumeric: 'tabular-nums',
    color: tokens.colorNeutralForeground3,
  },
  // Lives INSIDE the card, under the header row that stays mounted. Replacing
  // the card with a panel made the fit-content wrapper collapse, and the New
  // button jumped from the card's edge to beside the search box the moment a
  // query had no matches — a reflow under the pointer mid-typing.
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '6px',
    ...shorthands.padding('48px', '16px'),
    textAlign: 'center',
  },
  emptyIcon: { fontSize: '32px', color: tokens.colorNeutralForeground4 },
});

/**
 * One entity's table: the first page on mount, "Load more" for the rest,
 * a server-side search, and its three dialogs — edit, delete, import.
 *
 * Server state is TanStack Query's job. Queries are keyed by entity and
 * filter, so a slow response lands in the cache entry it was asked for — the
 * stale-response races this page used to guard by hand (request ids, a keyed
 * remount, then a walk counter — each retired) cannot occur, and revisiting a tab renders
 * from cache instantly. The `key={view.name}` on this component still
 * matters, but only for UI state: search text, dialog, and measured column
 * widths reset with the entity they belong to.
 */
/** What narrows the grid: the search box, ticked facets, and range bounds. */
export interface Filters {
  search: string;
  chosen: Record<string, string[]>;
  ranges: Record<string, RangeBounds>;
}

/** An entity opening with nothing applied. */
export const NO_FILTERS: Filters = { search: '', chosen: {}, ranges: {} };

export function EntityPage({
  view,
  filters,
  onFilters,
}: {
  view: EntityView;
  /**
   * Held by the caller, not here, so it outlives the `key` remount. The remount
   * exists to reset per-mount presentation — dialogs, measured widths — and
   * filters are not that: throwing away what someone narrowed to because they
   * glanced at another tab is work destroyed, not state cleaned up.
   */
  filters: Filters;
  onFilters: (next: Filters) => void;
}) {
  const styles = useStyles();
  const queryClient = useQueryClient();
  const announce = useAnnounce();
  /** "Currency", "Cost centre" — the entity's own label, never a literal. */
  const noun = view.title.toLowerCase();
  /** The open dialog: `row` is the row being edited, or null when creating. */
  const [dialog, setDialog] = useState<{ row: Row | null } | null>(null);
  /** The row a delete is being confirmed for, if any. */
  const [condemned, setCondemned] = useState<Row | null>(null);
  /** Whether the bulk-import dialog is open. */
  const [importing, setImporting] = useState(false);
  /**
   * The control that opened the current dialog, so focus can return to it.
   * The dialogs mount from state rather than through a Fluent `DialogTrigger`,
   * so nothing else remembers where the keyboard was: without this, closing
   * one drops focus on `<body>` and a keyboard or screen-reader user resumes
   * from the top of the page instead of the row they were working on.
   */
  const invoker = useRef<HTMLElement | null>(null);
  const dialogOpen = Boolean(dialog) || Boolean(condemned) || importing;
  useEffect(() => {
    if (dialogOpen) return;
    const opener = invoker.current;
    invoker.current = null;
    // Not a control the close removed: a deleted row takes its buttons with it.
    if (opener?.isConnected) opener.focus();
  }, [dialogOpen]);
  /** What is typed in the box, and the debounced filter derived from it. */
  const { search, chosen, ranges } = filters;
  const setSearch = (value: string) => onFilters({ ...filters, search: value });
  const setChosen = (update: (prev: Record<string, string[]>) => Record<string, string[]>) =>
    onFilters({ ...filters, chosen: update(filters.chosen) });
  const setRanges = (update: (prev: Record<string, RangeBounds>) => Record<string, RangeBounds>) =>
    onFilters({ ...filters, ranges: update(filters.ranges) });
  const [where, setWhere] = useState<Record<string, unknown> | undefined>();
  /** Columns whose header offers a filter — closed sets and ordered ranges. */
  const filterable = useMemo(() => [...facets(view), ...rangeFacets(view)], [view]);

  /** Content-fitted column widths, measured from the loaded rows. */
  const [fit, setFit] = useState<Record<string, number>>();
  /** The user's chosen sort, or null for the entity's newest-first default. */
  const [sort, setSort] = useState<{
    column: string;
    direction: 'ascending' | 'descending';
  } | null>(null);

  /**
   * Sorting is the server's job: a header click re-queries with `orderBy`, so
   * the order covers the whole result set, not just the loaded page — and
   * numbers sort as numbers, dates as dates, by the database's own collation.
   * The id tiebreak matters: a cursor needs a total order, and a non-unique
   * column alone is not one.
   */
  const order = useMemo(() => {
    if (!sort) return undefined; // the entity's own default applies
    const field = sort.column === '__provenance' ? view.lastChanged?.at : sort.column;
    if (!field) return undefined;
    const dir = sort.direction === 'ascending' ? ('asc' as const) : ('desc' as const);
    return field === PRIMARY_KEY
      ? { [field]: dir }
      : { [field]: dir, [PRIMARY_KEY]: 'asc' as const };
  }, [sort, view]);

  // Debounce typing into a server-side filter; snap back instantly on clear.
  // The filter must stay identical across the pages of one result set, which
  // the query key enforces: every page fetched under this key carries this
  // exact `where`.
  useEffect(() => {
    const filter = rowFilter(view, search, chosen, ranges);
    // Typing is debounced; ticking a box is not — a checkbox is a deliberate
    // act and should feel instant, where every keystroke is not.
    const t = setTimeout(() => setWhere(filter), search.trim() ? 250 : 0);
    return () => clearTimeout(t);
  }, [view, search, chosen, ranges]);

  const rowsQuery = useInfiniteQuery({
    queryKey: ['rows', view.name, where ?? null, order ?? null],
    queryFn: ({ pageParam }) =>
      dynamic(view.name).page(
        view.fields.map((f) => f.name),
        { size: PAGE_SIZE, after: pageParam, where, order }
      ),
    initialPageParam: undefined as string | undefined,
    // A page claiming a successor but supplying no cursor has nowhere to
    // continue from — asking anyway would re-fetch page one and show every
    // row twice. Returning undefined withdraws the "Load more" offer.
    getNextPageParam: (last) => (last.hasNextPage && last.endCursor ? last.endCursor : undefined),
    // While a new filter loads, keep showing the previous result set rather
    // than blanking the table on every keystroke.
    placeholderData: keepPreviousData,
  });

  // Foreign keys are only usable if the records they point at can be listed,
  // so fetch each target in full — all of it, not a page. A lookup missing
  // its last rows is not a shorter list but a wrong one: rows pointing at
  // what was left out show a dash and cannot be re-selected.
  const lookupsQuery = useQuery({
    queryKey: ['lookups', view.name],
    queryFn: async () => {
      // The assertions hold by construction: foreignKeys() only emits lookups
      // whose target is a registered entity, so the find cannot miss.
      const views = allEntities();
      const targets = view.fields.filter((f) => f.lookup);
      const loaded = await Promise.all(
        targets.map(async (f) => {
          const target = views.find((e) => e.name === f.lookup!.entity)!;
          const rows = await dynamic(target.name).all([
            ...new Set([PRIMARY_KEY, ...f.lookup!.display]),
          ]);
          return [f.name, rows] as const;
        })
      );
      return Object.fromEntries(loaded);
    },
  });
  const lookups = useMemo(() => lookupsQuery.data ?? {}, [lookupsQuery.data]);

  /** Every ticked value, flattened, so the toolbar can show and remove each. */
  const activeFacets = useMemo(
    () =>
      facets(view).flatMap((field) =>
        (chosen[field.name] ?? []).map((value) => ({
          field,
          value,
          label: facetOptions(field, lookups[field.name]).find(([v]) => v === value)?.[1] ?? value,
        }))
      ),
    [view, chosen, lookups]
  );
  /** Range facets that are actually narrowing something, as removable chips. */
  const activeRanges = useMemo(
    () =>
      rangeFacets(view)
        .map((field) => ({ field, ...(ranges[field.name] ?? {}) }))
        .filter((r) => (r.from ?? '').trim() || (r.to ?? '').trim())
        .map((r) => {
          // Bounds are formatted by the SAME code the cells use — a chip
          // reading "from 60000000" beside a column of "60,000,000" looks like
          // a different number. cellText wants a row, so give it one.
          const shown = (v?: string) =>
            v ? cellText({ id: '', [r.field.name]: v }, r.field) || v : '';
          const from = shown(r.from);
          const to = shown(r.to);
          return {
            ...r,
            // "up to X" / "from X" rather than an em-dash with a blank side,
            // which reads as a broken value instead of an open bound.
            label: from && to ? `${from} – ${to}` : from ? `from ${from}` : `up to ${to}`,
          };
        }),
    [view, ranges]
  );

  const rows = useMemo(() => rowsQuery.data?.pages.flatMap((p) => p.items) ?? [], [rowsQuery.data]);
  const loading = rowsQuery.isPending || rowsQuery.isPlaceholderData;
  const error = rowsQuery.error ?? lookupsQuery.error;

  // Fit columns to what they actually hold. Static widths guessed from field
  // constraints gave a two-letter code the room of a sentence while names
  // truncated beside it. Measured from the first unfiltered page (and widened,
  // never narrowed, as more loads arrive), frozen while a search is active so
  // columns do not dance under the pointer as the result set changes.
  const cardRef = useRef<HTMLDivElement | null>(null);
  /**
   * How much horizontal room the table may use. Watched rather than read once:
   * the app is usually embedded in the Fabric portal, whose pane is a
   * different width from a standalone tab and can change under the user, and
   * a width measured at load would spend the wrong surplus for the rest of the
   * session.
   */
  const [available, setAvailable] = useState<number>();
  /** The room the current widths were computed for. */
  const spentAt = useRef<number | undefined>(undefined);
  useEffect(() => {
    // The page element, not the card's own parent. That parent shrink-wraps
    // the table, so observing it was circular: dragging a column wider grew
    // the container, which reported new room, which re-spent the surplus and
    // overwrote the width the user had just dragged. The page is sized by the
    // window and never by the table.
    const room = cardRef.current?.closest('main');
    if (!room) return;
    const observer = new ResizeObserver(([entry]) =>
      setAvailable(Math.floor(entry.contentRect.width))
    );
    observer.observe(room);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (where || loading || rows.length === 0) return;
    // Measure with the grid's own computed font — the card is inside the
    // FluentProvider, whose typography never reaches document.body.
    const measured = fitWidths(view, rows, lookups, cardRef.current ?? undefined, available);
    setFit((prev) => {
      // Widen as more rows arrive, but take the new numbers wholesale when the
      // room changed: the surplus is re-spent from scratch, and keeping an old
      // width would leave the table wider than the pane it now sits in.
      if (!prev || available !== spentAt.current) {
        spentAt.current = available;
        return measured;
      }
      const widened = { ...prev };
      for (const [k, v] of Object.entries(measured)) widened[k] = Math.max(widened[k] ?? 0, v);
      return widened;
    });
  }, [view, rows, lookups, where, loading, available]);

  const columns = useMemo(
    () => [
      ...view.columns.map((f) =>
        createTableColumn<Row>({
          columnId: f.name,
          // `margin-left: auto` rather than a full-width right-aligned span, so
          // the sort indicator stays beside the label instead of being pushed
          // out of the cell.
          renderHeaderCell: () =>
            f.constraints.type === 'number' && !f.lookup ? (
              <span className={styles.pushRight}>{f.label}</span>
            ) : (
              f.label
            ),
          renderCell: (row) => <Cell row={row} field={f} options={lookups[f.name]} />,
          // Sorting is server-side, so compare never reorders anything — but
          // its PRESENCE is load-bearing: Fluent decides whether a header
          // gets a sort button from the compare function's arity
          // (isColumnSortable checks `compare.length > 0`). An arity-2 no-op
          // marks the column sortable; omitting it (lookups — their column
          // is a UUID nobody can sort by) removes the affordance entirely.
          ...(f.lookup ? {} : { compare: (_a: Row, _b: Row) => 0 }),
        })
      ),
      ...(view.lastChanged
        ? [
            createTableColumn<Row>({
              columnId: '__provenance',
              renderHeaderCell: () => 'Last changed',
              renderCell: (row) => <Provenance row={row} view={view} />,
              // Arity-2 no-op: sortable in the UI, ordered by the server
              // (the `order` memo maps this column to the updated-at field).
              compare: (_a, _b) => 0,
            }),
          ]
        : []),
      ...(view.can.update || view.can.delete
        ? [
            createTableColumn<Row>({
              columnId: '__actions',
              renderHeaderCell: () => '',
              renderCell: (row) => (
                <span className={styles.rowActions}>
                  {/* aria-labels are the buttons' accessible names — the e2e suite
                addresses them as "Edit" and "Delete". */}
                  {view.can.update && (
                    <Tooltip content="Edit" relationship="label">
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<EditRegular />}
                        aria-label="Edit"
                        onClick={(e) => {
                          invoker.current = e.currentTarget;
                          setDialog({ row });
                        }}
                      />
                    </Tooltip>
                  )}
                  {view.can.delete && (
                    <Tooltip content="Delete" relationship="label">
                      <Button
                        appearance="subtle"
                        size="small"
                        icon={<DeleteRegular />}
                        aria-label="Delete"
                        onClick={(e) => {
                          invoker.current = e.currentTarget;
                          setCondemned(row);
                        }}
                      />
                    </Tooltip>
                  )}
                </span>
              ),
            }),
          ]
        : []),
    ],
    [view, lookups, styles]
  );

  /**
   * Measured widths once rows are in; constraint-derived estimates until then,
   * so the first paint is already close and the settle is small.
   *
   * `idealWidth` matters as much as `defaultWidth`: the sizing hook reads
   * `defaultWidth` only when a column is first created and `idealWidth` on
   * every later options update — passing both is what makes the measured
   * widths actually apply. With auto-fit off these widths simply hold: a
   * narrow window scrolls the card instead of compressing every column to
   * unreadability, and a wide one leaves page background showing rather than
   * smearing blank space through the table.
   */
  const sizing = useMemo(
    () => ({
      ...Object.fromEntries(
        view.columns.map((f) => {
          const width = fit?.[f.name] ?? widthFor(f);
          return [
            f.name,
            {
              minWidth: Math.min(width, 64),
              defaultWidth: width,
              idealWidth: width,
            },
          ];
        })
      ),
      __provenance: {
        minWidth: 120,
        defaultWidth: fit?.__provenance ?? 180,
        idealWidth: fit?.__provenance ?? 180,
      },
      // Just wide enough for the two icon buttons, so they never get squeezed
      // under the column beside them.
      __actions: { minWidth: 96, defaultWidth: 96, idealWidth: 96 },
    }),
    [view, fit]
  );

  return (
    <div className={styles.fit}>
      {error && (
        <MessageBar intent="error" className={styles.bar}>
          <MessageBarBody>{readable(error)}</MessageBarBody>
        </MessageBar>
      )}

      <div className={styles.toolbar}>
        {isSearchable(view) && (
          <SearchBox
            className={styles.search}
            placeholder="Search"
            value={search}
            onChange={(_, d) => setSearch(d.value)}
            aria-label={`Search ${view.title.toLowerCase()}`}
          />
        )}
        {/* The only feedback the app gives for a search, a page load or a
            refresh — and as a plain span none of it reached a screen reader.
            Kept mounted (never conditionally rendered) so the region exists
            before its content changes, which is what makes it announce. */}
        <Caption1 className={styles.muted} role="status" aria-live="polite" aria-atomic="true">
          {loading ? (
            <Spinner size="tiny" label="Loading…" labelPosition="after" />
          ) : (
            `${rows.length} ${
              where ? (rows.length === 1 ? 'match' : 'matches') : rows.length === 1 ? 'row' : 'rows'
            }${rowsQuery.hasNextPage ? ' loaded · more available' : ''}`
          )}
        </Caption1>
        <span className={styles.spacer} />
        {/* Not gated on `available`: that is the ResizeObserver's width
            measurement for columns, and filtering does not depend on it. The
            observer only attaches when the card has a <main> ancestor, so an
            EntityPage rendered outside one — which a fork replacing App.tsx
            would do without knowing — left `available` undefined forever and
            lost filtering entirely, with nothing to say why. Everything else
            degrades gracefully without it (widths simply stop spending the
            surplus); this one silently removed a feature. */}
        {(view.can.create || view.can.update) && (
          <Button
            appearance="secondary"
            icon={<ArrowUploadRegular />}
            disabled={loading}
            onClick={(e) => {
              invoker.current = e.currentTarget;
              setImporting(true);
            }}
          >
            Import
          </Button>
        )}
        {view.can.create && (
          <Button
            appearance="primary"
            icon={<AddRegular />}
            onClick={(e) => {
              invoker.current = e.currentTarget;
              setDialog({ row: null });
            }}
            disabled={loading}
          >
            New {view.title.toLowerCase()}
          </Button>
        )}
      </div>

      {activeFacets.length + activeRanges.length > 0 && (
        <span className={styles.chips}>
          {activeFacets.map(({ field, value, label }) => (
            <Button
              key={`${field.name}:${value}`}
              size="small"
              appearance="subtle"
              icon={<DismissRegular />}
              iconPosition="after"
              // The visible text names the filter; the button REMOVES it. Left
              // to its own label a screen reader announced "Is active: Yes,
              // button" — which reads as the control that applies the filter,
              // the opposite of what pressing it does.
              aria-label={`Remove filter ${field.label}: ${label}`}
              onClick={() =>
                setChosen((prev) => ({
                  ...prev,
                  [field.name]: (prev[field.name] ?? []).filter((v) => v !== value),
                }))
              }
            >
              {field.label}: {label}
            </Button>
          ))}
          {activeRanges.map(({ field, label }) => (
            <Button
              key={`range:${field.name}`}
              size="small"
              appearance="subtle"
              icon={<DismissRegular />}
              iconPosition="after"
              aria-label={`Remove filter ${field.label}: ${label}`}
              onClick={() => setRanges((prev) => ({ ...prev, [field.name]: {} }))}
            >
              {field.label}: {label}
            </Button>
          ))}
          <Button
            size="small"
            appearance="subtle"
            onClick={() => {
              onFilters({ ...filters, chosen: {}, ranges: {} });
            }}
          >
            Clear all
          </Button>
        </span>
      )}

      <Card className={styles.card} ref={cardRef}>
        <DataGrid
          className={styles.grid}
          items={rows}
          columns={columns}
          columnSizingOptions={sizing}
          getRowId={(row) => row.id}
          sortable
          sortState={{
            sortColumn: sort?.column,
            sortDirection: sort?.direction ?? 'ascending',
          }}
          onSortChange={(_, s) => {
            const column = String(s.sortColumn);
            // Lookups sort by their UUID column — meaningless to a person —
            // and the actions column by nothing; ignore those clicks. The
            // provenance column maps to its timestamp.
            const sortable =
              column === '__provenance'
                ? Boolean(view.lastChanged?.at)
                : view.columns.some((f) => f.name === column && !f.lookup);
            if (sortable) setSort({ column, direction: s.sortDirection });
          }}
          resizableColumns
          // Auto-fit's expansion is what the shrink-wrapped card exists to
          // avoid; manual resizing works the same without it.
          resizableColumnsOptions={{ autoFitColumns: false }}
          focusMode="composite"
          size="medium"
          aria-label={view.title}
        >
          <DataGridHeader>
            <DataGridRow>
              {(col) => {
                const field = filterable.find((f) => f.name === col.columnId);
                return (
                  <HeaderCell
                    columnId={String(col.columnId)}
                    // The filter goes in `aside`, beside the resize handle, so
                    // it sits OUTSIDE the sort button — no button nested in a
                    // button, and clicking it does not re-sort the table.
                    filter={
                      field && (
                        <ColumnFilter
                          field={field}
                          chosen={chosen[field.name] ?? []}
                          ranges={ranges[field.name] ?? {}}
                          options={lookups[field.name]}
                          onChosen={(values) =>
                            setChosen((prev) => ({ ...prev, [field.name]: values }))
                          }
                          onRange={(bounds) =>
                            setRanges((prev) => ({ ...prev, [field.name]: bounds }))
                          }
                        />
                      )
                    }
                  >
                    {col.renderHeaderCell()}
                  </HeaderCell>
                );
              }}
            </DataGridRow>
          </DataGridHeader>
          <DataGridBody<Row>>
            {({ item, rowId }) => (
              <DataGridRow<Row> key={rowId}>
                {({ renderCell }) => <DataGridCell>{renderCell(item)}</DataGridCell>}
              </DataGridRow>
            )}
          </DataGridBody>
        </DataGrid>
        {rows.length === 0 && !loading && (
          <section className={styles.empty}>
            <TableRegular className={styles.emptyIcon} />
            <Subtitle2 block>{where ? 'No matches' : 'Nothing here yet'}</Subtitle2>
            <Caption1 block className={styles.muted}>
              {where
                ? 'Nothing here matches your search.'
                : `Add the first ${view.title.toLowerCase()} to get started.`}
            </Caption1>
          </section>
        )}
      </Card>

      {/*
        A button rather than a scroll listener: reference tables run to
        hundreds of rows, not millions, and an explicit click never fetches
        something nobody asked for. `hasNextPage` already folds in the
        no-cursor case — see getNextPageParam.
      */}
      {rowsQuery.hasNextPage && (
        <div className={styles.more}>
          <Button
            appearance="secondary"
            // Never `disabled`: this button is the thing the keyboard user is
            // standing on, and disabling a focused control drops focus to
            // <body> — the doctrine the three dialogs already follow. Two
            // clicks are handled instead by cancelRefetch: false (a no-op
            // rather than a restart) and the in-flight guard below.
            onClick={() => {
              if (rowsQuery.isFetchingNextPage || loading) return;
              void rowsQuery.fetchNextPage({ cancelRefetch: false });
            }}
            aria-disabled={rowsQuery.isFetchingNextPage || loading}
          >
            {/* Not "Load 100 more": the last page is whatever is left. */}
            {rowsQuery.isFetchingNextPage ? (
              <Spinner size="tiny" label="Loading…" labelPosition="after" />
            ) : (
              'Load more'
            )}
          </Button>
        </div>
      )}

      {/*
        Mounted only while open, so the form's initial state is the whole
        "reset the dialog" story — and a failed refetch after a save lands in
        the page banner above, not in a dialog nobody can see any more.
      */}
      {dialog && (
        <RowDialog
          view={view}
          row={dialog.row}
          lookups={lookups}
          onClose={() => setDialog(null)}
          onSaved={(saved) => {
            // Name the row, not just its table. After a delete the row is gone
            // from the grid, so the message is the only remaining evidence of
            // WHICH one went, and a mis-clicked trash icon is otherwise
            // silent; naming it on save keeps the three consistent. Trimmed,
            // so one long value cannot inflate the toast.
            const what = rowIdentity(saved, view, lookups, 48);
            announce(dialog.row ? `Saved ${what}` : `Added ${what}`);
            setDialog(null);
            // Everything, not just this entity: a row created in one entity must
            // reach other entities' lookup lists too. Active queries refetch now; the rest
            // are marked stale and refetch when their tab is next opened.
            void queryClient.invalidateQueries();
          }}
        />
      )}

      {importing && (
        <ImportDialog
          view={view}
          lookups={lookups}
          onClose={() => setImporting(false)}
          onRefreshLookups={() => queryClient.refetchQueries({ queryKey: ['lookups', view.name] })}
          onTouched={() => void queryClient.invalidateQueries()}
          onDone={(written: number) => {
            // Verb first, like Saved/Added/Deleted — "5 currency rows imported"
            // and "Saved AUD · Australian Dollar" read as two different apps.
            announce(written === 1 ? `Imported 1 ${noun}` : `Imported ${written} ${noun} rows`);
            setImporting(false);
            void queryClient.invalidateQueries();
          }}
        />
      )}

      {condemned && (
        <DeleteDialog
          view={view}
          row={condemned}
          lookups={lookups}
          onClose={() => setCondemned(null)}
          onDeleted={(identity) => {
            announce(`Deleted ${identity}`);
            setCondemned(null);
            void queryClient.invalidateQueries();
          }}
        />
      )}
    </div>
  );
}


/**
 * A header cell that carries both Fluent's resize handle and our filter.
 *
 * The `aside` slot is not ours to take: `useTableColumnSizing` puts the resize
 * handle there, so passing our own silently removed it and dragging a column
 * stopped working — the e2e canary caught it. Reading the sizing state from
 * context lets us render the handle Fluent would have rendered, plus the
 * filter, instead of replacing one with the other.
 */
function HeaderCell({
  columnId,
  filter,
  children,
}: {
  columnId: string;
  filter?: React.ReactNode;
  children: React.ReactNode;
}) {
  const styles = useStyles();
  const sizing = useDataGridContext_unstable((ctx) => ctx.columnSizing_unstable);
  // `aside` is a Fluent slot shorthand, not a ReactNode, so it can only be
  // composed by nesting it as this span's children.
  const { aside } = sizing.getTableHeaderCellProps(columnId);
  return (
    <DataGridHeaderCell
      className={filter ? styles.headerCell : undefined}
      aside={{
        className: styles.headerAside,
        children: (
          <>
            {filter}
            {aside as React.ReactNode}
          </>
        ),
      }}
    >
      {children}
    </DataGridHeaderCell>
  );
}

/**
 * One column's filter, opened from its header — the affordance enterprise
 * tables have trained people to look for.
 *
 * A single panel listing every facetable column works for four columns and
 * stops working for twenty: the button grows a count nobody can parse and the
 * panel becomes a scrolling list of groups. Per column, the control is beside
 * the data it filters and each popover holds one thing.
 *
 * Lives in the header cell's `aside` slot, and its click has to be stopped
 * there. The slot is not inside a sort *button* — there is no such button.
 * Fluent puts the sort's `onClick` on the header cell `div`, and the aside sits
 * inside that div, so a click on the filter bubbles into the sort and silently
 * reorders the table (measured: clicking "Filter Decimal places" took that
 * column from `aria-sort=none` to `ascending`). An earlier note here reasoned
 * about invalid nested buttons and concluded the opposite — nesting was never
 * the mechanism, bubbling was.
 */
function ColumnFilter({
  field,
  chosen,
  ranges,
  options,
  onChosen,
  onRange,
}: {
  field: FieldView;
  chosen: string[];
  ranges: RangeBounds;
  options?: Row[];
  onChosen: (values: string[]) => void;
  onRange: (bounds: RangeBounds) => void;
}) {
  const styles = useStyles();
  const isRange = field.constraints.type === 'date' || field.constraints.type === 'number';
  const active = isRange ? Boolean(ranges.from || ranges.to) : chosen.length > 0;

  return (
    // The trigger's own handler has already run by the time the click reaches
    // this span, so the popover still opens — the sort never hears it.
    <span onClick={(e) => e.stopPropagation()}>
      <Popover positioning="below-end" trapFocus>
        <PopoverTrigger disableButtonEnhancement>
          <Button
            appearance="transparent"
            size="small"
            icon={active ? <FilterFilled /> : <FilterRegular />}
            className={active ? styles.filterOn : styles.filterIcon}
            aria-label={active ? `Filter ${field.label} (active)` : `Filter ${field.label}`}
          />
        </PopoverTrigger>
        <PopoverSurface>
          <div className={styles.facetPanel}>
            <span className={styles.facetLabel}>{field.label}</span>
            {isRange ? (
              <div className={styles.rangeRow}>
                {(['from', 'to'] as const).map((end) => (
                  // The same `Field` the form uses, so a date bound gets the
                  // locale-aware calendar and a number bound its spin button.
                  // `inlinePopup` keeps the calendar inside this popover; in a
                  // portal it is DOM-outside and dismisses the panel.
                  <Field
                    key={end}
                    field={{
                      ...field,
                      label: end === 'from' ? 'From' : 'To',
                      constraints: { ...field.constraints, optional: true },
                    }}
                    inlinePopup
                    value={ranges[end] ?? ''}
                    onChange={(value) => onRange({ ...ranges, [end]: value })}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.facetGroup}>
                {facetOptions(field, options).map(([value, label]) => (
                  <Checkbox
                    key={value}
                    label={label}
                    checked={chosen.includes(value)}
                    onChange={(_, d) => {
                      const picked = new Set(chosen);
                      if (d.checked) picked.add(value);
                      else picked.delete(value);
                      onChosen([...picked]);
                    }}
                  />
                ))}
              </div>
            )}
            {active && (
              <Button
                size="small"
                appearance="subtle"
                onClick={() => (isRange ? onRange({}) : onChosen([]))}
              >
                Clear
              </Button>
            )}
          </div>
          </PopoverSurface>
      </Popover>
    </span>
  );
}

/**
 * Who last touched the row, with the full history on hover.
 *
 * Four audit columns otherwise outnumber the data they describe. The reason
 * for recording them is having someone to ask, and that is one name — the
 * cell shows `provenanceLabel`, the hover carries the precise record.
 */
function Provenance({ row, view }: { row: Row; view: EntityView }) {
  const styles = useStyles();
  const read = (field?: string) => (field ? row[field] : undefined);
  const by = read(view.lastChanged?.by);
  const at = read(view.lastChanged?.at);
  const firstBy = read(view.firstAdded?.by);
  const firstAt = read(view.firstAdded?.at);

  // A row never edited carries identical created and updated stamps, so a
  // second "Last changed" entry would only repeat the first.
  const untouched = String(firstBy ?? '') === String(by ?? '') && String(firstAt) === String(at);
  const entries = [
    { name: 'Created', by: firstBy, at: firstAt },
    ...(untouched ? [] : [{ name: 'Last changed', by, at }]),
  ].filter((e) => e.by || e.at);

  return (
    <Tooltip
      content={{
        className: styles.tip,
        children:
          entries.length === 0 ? (
            'No history recorded'
          ) : (
            <div className={styles.history}>
              {entries.map((e, i) => (
                <div
                  key={e.name}
                  className={mergeClasses(styles.historyEvent, i > 0 && styles.historyNext)}
                >
                  <span className={styles.historyLabel}>{e.name}</span>
                  {e.by ? (
                    <Caption1 block className={styles.historyWho}>
                      {String(e.by)}
                    </Caption1>
                  ) : null}
                  {e.at ? (
                    <Caption1 block className={styles.historyWhen}>
                      {whenDetailed(e.at)}
                    </Caption1>
                  ) : null}
                </div>
              ))}
            </div>
          ),
      }}
      relationship="description"
      withArrow
    >
      <Caption1 className={mergeClasses(styles.cell, styles.muted)}>
        {provenanceLabel(row, view)}
      </Caption1>
    </Tooltip>
  );
}

function Cell({ row, field, options }: { row: Row; field: FieldView; options?: Row[] }) {
  const styles = useStyles();
  const value = row[field.name];

  // Booleans as glyphs rather than prose — but only real ones; a null stays
  // an em-dash below, because unanswered is not the same as "no".
  if (field.constraints.type === 'boolean' && !field.lookup && value != null) {
    return value ? (
      <span role="img" aria-label="Yes" title="Yes">
        <CheckmarkRegular className={styles.boolYes} />
      </span>
    ) : (
      <span role="img" aria-label="No" title="No">
        <DismissRegular className={styles.boolNo} />
      </span>
    );
  }

  const shown = cellText(row, field, options);
  const numeric = field.constraints.type === 'number' && !field.lookup;
  // The dash for "no value" sits where the value would: right-aligned in a
  // numeric column, not stranded at the left edge of a column of numbers.
  if (!shown) {
    return (
      <span className={mergeClasses(styles.cell, styles.muted, numeric && styles.number)}>—</span>
    );
  }
  return (
    <span className={mergeClasses(styles.cell, numeric && styles.number)} title={shown}>
      {shown}
    </span>
  );
}
