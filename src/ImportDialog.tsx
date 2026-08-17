import {
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field as FluentField,
  MessageBar,
  MessageBarBody,
  ProgressBar,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { ArrowDownloadRegular, ArrowUploadRegular } from '@fluentui/react-icons';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';

import { buildTemplate, downloadCsv } from './csv';
import { dynamic, readable, type Row } from './db';
import { PRIMARY_KEY, type EntityView } from './entity';
import {
  analyzeImport,
  isImportable,
  parseCsv,
  IMPORT_MAX_ROWS,
  type ParsedCsv,
} from './importer';

const useStyles = makeStyles({
  body: { display: 'flex', flexDirection: 'column', gap: '12px' },
  pickRow: { display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  errors: {
    maxHeight: '200px',
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  fileInput: { display: 'none' },
});

const ERROR_LIST_LIMIT = 50;

/**
 * "Imported 40 of 200 rows…", moving in ten steps rather than every row.
 *
 * The text it produces is announced, so it has to change rarely enough to be
 * followed in speech; the progress bar beside it carries the fine-grained
 * motion. Rounding down keeps it honest — it never claims a row that has not
 * been written.
 */
function progressLabel(done: number, total: number): string {
  const step = Math.max(1, Math.ceil(total / 10));
  const reached = Math.floor(done / step) * step;
  const rows = `${total} ${total === 1 ? 'row' : 'rows'}`;
  return reached === 0 ? `Importing ${rows}…` : `Imported ${reached} of ${rows}…`;
}

type Phase =
  | { kind: 'pick' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'rolling'; total: number }
  | { kind: 'failed'; line: number; message: string; leftovers: Row[] };

/**
 * Bulk import: template, file, verdict, then all-or-nothing execution.
 *
 * The platform has no transactions, so atomicity is earned in two halves.
 * Before: nothing is written until every row passes the same validation the
 * form uses, foreign keys resolve, and unique values clash neither with the
 * table nor with each other. After: rows are created one at a time, and if
 * any write fails, creates are deleted and updates restored, newest first.
 * What that cannot promise is invisibility — other users can see the changes
 * for the seconds before a rollback — or survival of a closed tab, which is
 * why closing is disabled while the import runs.
 */
export function ImportDialog({
  view,
  lookups,
  onClose,
  onDone,
  onRefreshLookups,
  onTouched,
}: {
  view: EntityView;
  lookups: Record<string, Row[]>;
  onClose: () => void;
  /** Called after a fully successful import, with the number of rows written. */
  onDone: (written: number) => void;
  /** Re-read the lookup lists before writing, so FK resolution is not stale. */
  onRefreshLookups?: () => Promise<unknown>;
  /** Called when a failed import leaves the table different from the cache. */
  onTouched?: () => void;
}) {
  const styles = useStyles();
  const fileRef = useRef<HTMLInputElement>(null);
  /**
   * A ref, not state: two clicks in one tick both read the old state, so state
   * alone cannot stop a genuine double-click — and two interleaved imports
   * would each trip the other's unique checks.
   */
  const importing = useRef(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });

  // The table as it stands — id plus every editable column. This one fetch
  // serves three jobs: uniqueness pre-checks, matching file rows to the
  // records they update, and capturing originals so a failed import can put
  // updated rows back. Past `all()`'s row cap the fetch throws, this query
  // errors, and no import can start — refused, never half-checked.
  const existingQuery = useQuery({
    queryKey: ['import-existing', view.name],
    queryFn: () =>
      dynamic(view.name).all([...new Set([PRIMARY_KEY, ...view.editable.map((f) => f.name)])]),
  });

  const analysis = useMemo(
    () =>
      parsed && existingQuery.data
        ? analyzeImport(view, parsed, lookups, existingQuery.data)
        : null,
    [parsed, existingQuery.data, view, lookups]
  );

  const labelOf = (name: string) => view.editable.find((f) => f.name === name)?.label ?? name;

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setParsed(parseCsv(await file.text()));
    setPhase({ kind: 'pick' });
  };

  const run = async () => {
    if (!analysis || !isImportable(analysis) || importing.current) return;
    importing.current = true;
    // Flip the phase BEFORE the first await. `busy` is derived from it, and
    // `busy` is what blocks Escape and Cancel — so while this sat after the
    // pre-flight refetch the dialog could be dismissed mid-flight, unmounting
    // the component while this function carried on writing rows. Measured: two
    // rows landed with no dialog on screen, and a failure would have rolled
    // back into a component nobody could see.
    setPhase({ kind: 'running', done: 0, total: 0 });
    // Shrink the concurrent-writer window from "however long this dialog sat
    // open" to about a second: re-fetch the table and re-judge the file
    // immediately before writing anything. The fresh plan is then the one
    // EXECUTED, not merely a gate — a concurrent create can turn a planned
    // create into an update, and a concurrent delete can invalidate an
    // update's target; running the stale plan against either raced. If the
    // fresh judgement finds errors, the refetch has already updated the
    // rendered analysis with the reasons.
    let fresh;
    try {
      // Lookups too, not just the rows. FK resolution is decided entirely by
      // this array, and it was resolved once at mount — so a currency a
      // colleague added an hour ago read as "no match", blocking a valid file
      // with a false reason that no amount of re-picking would clear.
      await onRefreshLookups?.();
      fresh = await existingQuery.refetch();
    } catch {
      // Leaving the ref set would kill the button for the dialog's lifetime.
      importing.current = false;
      setPhase({ kind: 'pick' });
      return;
    }
    // A failed refetch resolves with the *previous* snapshot still in
    // `fresh.data` — building a plan from it would execute against stale
    // truth, the exact race this refetch exists to close. Bail instead.
    const plan =
      parsed && fresh.data && !fresh.isError
        ? analyzeImport(view, parsed, lookups, fresh.data)
        : null;
    if (!plan || !isImportable(plan)) {
      importing.current = false;
      setPhase({ kind: 'pick' });
      return;
    }
    const work = plan.rows.filter((r) => r.op !== 'skip');
    /** What has been written so far, in order — the rollback ledger. */
    const done: (
      | { kind: 'create'; row: Row }
      | { kind: 'update'; id: string; original: Record<string, unknown> }
    )[] = [];
    try {
      for (let i = 0; i < work.length; i++) {
        setPhase({ kind: 'running', done: i, total: work.length });
        const r = work[i];
        if (r.op === 'update' && r.target) {
          // Capture the editable originals first: restoring them is the only
          // rollback an update can have.
          const original = Object.fromEntries(
            Object.keys(r.input).map((f) => [f, r.target![f]])
          );
          await dynamic(view.name).update(r.target.id, r.input);
          done.push({ kind: 'update', id: r.target.id, original });
        } else {
          done.push({ kind: 'create', row: await dynamic(view.name).create(r.input) });
        }
      }
      onDone(work.length);
    } catch (e) {
      // Roll back newest-first: later rows are the likeliest to reference
      // earlier ones, so this order never trips a dependency error of its
      // own. Creates are deleted; updates are written back to what they
      // held — though their updatedAt/updatedBy will show this restore.
      setPhase({ kind: 'rolling', total: done.length });
      const leftovers: Row[] = [];
      for (const entry of [...done].reverse()) {
        try {
          if (entry.kind === 'create') await dynamic(view.name).delete(entry.row.id);
          else await dynamic(view.name).update(entry.id, entry.original);
        } catch {
          if (entry.kind === 'create') leftovers.push(entry.row);
          else leftovers.push({ id: entry.id });
        }
      }
      // Rows were written and then undone (or not undone). Either way the grid
      // is still rendering the cache captured before the import, while the
      // dialog is about to tell the user to review the table.
      onTouched?.();
      setPhase({ kind: 'failed', line: done.length + 1, message: readable(e), leftovers });
    } finally {
      importing.current = false;
    }
  };

  const busy = phase.kind === 'running' || phase.kind === 'rolling';

  return (
    <Dialog open onOpenChange={(_, d) => !d.open && !busy && onClose()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>Import {view.title.toLowerCase()} rows</DialogTitle>
          <DialogContent className={styles.body}>
            <Caption1 className={styles.muted}>
              Fill in the template and choose the file. Nothing is written until every row
              checks out, and if any write fails the ones already made are undone — a
              finished import is all or nothing.
              {analysis?.keyField &&
                ` Rows whose ${labelOf(analysis.keyField).toLowerCase()} matches an existing ` +
                  `row update it; blank cells clear optional values on an update.`}
            </Caption1>
            {/*
              No unique column means no business key: nothing to match rows
              against, so imports can only add. Said out loud because the
              silent version of this is a doubled table after a re-import.
            */}
            {analysis && !analysis.keyField && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  This table has no unique column, so imported rows cannot be matched to
                  existing ones — every import adds new rows, and importing the same file twice
                  adds its rows twice.
                </MessageBarBody>
              </MessageBar>
            )}

            <div className={styles.pickRow}>
              <Button
                appearance="subtle"
                icon={<ArrowDownloadRegular />}
                onClick={() => downloadCsv(`${view.name}-template.csv`, buildTemplate(view))}
              >
                Download template
              </Button>
              <Button
                appearance="secondary"
                icon={<ArrowUploadRegular />}
                disabled={busy}
                onClick={() => fileRef.current?.click()}
              >
                {fileName ? 'Choose a different file' : 'Choose file'}
              </Button>
              {fileName && <Caption1 className={styles.muted}>{fileName}</Caption1>}
              <input
                ref={fileRef}
                className={styles.fileInput}
                type="file"
                accept=".csv,text/csv"
                aria-label="CSV file"
                onChange={(e) => {
                  void onFile(e.target.files?.[0]);
                  e.target.value = ''; // re-picking the same file re-triggers
                }}
              />
            </div>

            {analysis && phase.kind === 'pick' && (
              <>
                {analysis.problems.length > 0 && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      This file is not valid CSV, so its rows cannot be trusted:{' '}
                      {analysis.problems.join('; ')}. Re-export it and try again.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {analysis.overCap > 0 && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      {analysis.rows.length + analysis.overCap} rows is over the{' '}
                      {IMPORT_MAX_ROWS}-row limit — split the file.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {analysis.missingRequired.length > 0 && (
                  <MessageBar intent="error">
                    <MessageBarBody>
                      Missing required columns: {analysis.missingRequired.join(', ')}. Start from
                      the template.
                    </MessageBarBody>
                  </MessageBar>
                )}
                {analysis.ignoredHeaders.length > 0 && (
                  <Caption1 className={styles.muted}>
                    Ignored unknown columns: {analysis.ignoredHeaders.join(', ')}
                  </Caption1>
                )}
                {analysis.counts.update > 0 && analysis.absentOptional.length > 0 && (
                  <Caption1 className={styles.muted}>
                    Not in the file, left unchanged on updates:{' '}
                    {analysis.absentOptional.join(', ')}
                  </Caption1>
                )}
                {analysis.rows.length === 0 && analysis.missingRequired.length === 0 && (
                  <MessageBar intent="warning">
                    <MessageBarBody>No data rows in the file — only a header.</MessageBarBody>
                  </MessageBar>
                )}
                {analysis.errorCount > 0 ? (
                  <FluentField
                    validationState="error"
                    validationMessage={`${analysis.errorCount} of ${analysis.rows.length} rows need fixing`}
                  >
                    <div className={styles.errors}>
                      {analysis.rows
                        .flatMap((r) =>
                          Object.entries(r.errors).map(([field, message]) => (
                            <Caption1 key={`${r.line}-${field}`}>
                              Row {r.line} · {labelOf(field)}: {message}
                            </Caption1>
                          ))
                        )
                        .slice(0, ERROR_LIST_LIMIT)}
                      {analysis.errorCount > ERROR_LIST_LIMIT && (
                        <Caption1 className={styles.muted}>…and more</Caption1>
                      )}
                    </div>
                  </FluentField>
                ) : analysis.rows.length > 0 ? (
                  <Caption1>
                    {isImportable(analysis)
                      ? [
                          analysis.counts.create && `${analysis.counts.create} to add`,
                          analysis.counts.update && `${analysis.counts.update} to update`,
                          analysis.counts.skip && `${analysis.counts.skip} unchanged`,
                        ]
                          .filter(Boolean)
                          .join(' · ') + '.'
                      : 'Everything in the file matches the table — nothing to import.'}
                  </Caption1>
                ) : null}
              </>
            )}

            {/*
              The label is the live region, so a screen reader follows the
              import instead of watching a silent bar. It reports in steps
              while the bar itself still advances every row: one message per
              row is unreadable on screen and unusable in speech at 500 of
              them. `total` is 0 until the pre-flight returns — that phase is
              re-checking the file, not writing, and saying so beats the
              "row 1 of 0" and NaN-width bar it replaces.
            */}
            {phase.kind === 'running' && (
              <FluentField
                label={{
                  children: phase.total
                    ? progressLabel(phase.done, phase.total)
                    : 'Re-checking the file against the table…',
                  role: 'status',
                  'aria-live': 'polite',
                  'aria-atomic': true,
                }}
              >
                <ProgressBar value={phase.total ? phase.done / phase.total : undefined} />
              </FluentField>
            )}
            {phase.kind === 'rolling' && (
              // role=alert, not the polite region above: this interrupts,
              // because what it reports is a failure already in hand.
              <FluentField
                label={{
                  children: `A write failed — undoing the ${phase.total} already made…`,
                  role: 'alert',
                }}
              >
                <ProgressBar />
              </FluentField>
            )}
            {/* role=alert: Fluent's MessageBar is role="group", which announces
                nothing. This is the outcome of the whole import. */}
            {phase.kind === 'failed' && (
              <div role="alert">
                <MessageBar intent="error">
                  <MessageBarBody>
                    {phase.leftovers.length === 0
                      ? `Write ${phase.line} failed: ${phase.message}. Everything written before it was undone — ` +
                        `though a write can fail after the server applied it, so re-check that row before retrying.`
                      : `Import failed at write ${phase.line} (${phase.message}) and the rollback ` +
                        `could not undo ${phase.leftovers.length} of the changes already made — ` +
                        `review the table before retrying.`}
                  </MessageBarBody>
                </MessageBar>
              </div>
            )}
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={onClose} disabled={busy}>
              {phase.kind === 'failed' ? 'Close' : 'Cancel'}
            </Button>
            <Button
              appearance="primary"
              onClick={() => void run()}
              // Never disabled by `busy`: the ref guard handles re-clicks and
              // disabling the focused primary drops focus to <body> — the
              // doctrine all three dialogs share.
              disabled={phase.kind === 'failed' || !analysis || !isImportable(analysis)}
            >
              {analysis && isImportable(analysis)
                ? `Import ${analysis.counts.create + analysis.counts.update} ${
                    analysis.counts.create + analysis.counts.update === 1 ? 'row' : 'rows'
                  }`
                : 'Import'}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}
